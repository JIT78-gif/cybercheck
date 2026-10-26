import { AD_PROFILE_LIMITS, type AdversarialCampaign, type AiComponentInventory, type AiEvaluationTarget, type Evidence, type ProjectDossier, type RulesOfEngagement } from "@cybercheck/contracts";
import { prepareApp } from "../security/proofs/run.ts";
import { CANARY } from "../security/proofs/catalog.ts";
import { planWorkspaces } from "../testing/adapters.ts";
import { bootGraph, type BootApp } from "../testing/agents.ts";
import { verifyTarget } from "../testing/fixtures.ts";
import type { FixtureNode } from "../testing/plan.ts";
import { runHarness, type HarnessAiCase, type HarnessAiSpec } from "../testing/probes.ts";
import type { Ctx } from "../testing/runtime.ts";
import type { SnapshotSource } from "../understanding/source.ts";
import { redactSecrets } from "../understanding/source.ts";
import type { CatalogCampaign } from "./catalog.ts";
import type { PlannedStep } from "./compiler.ts";
import { judgeCampaign, type CampaignObservation, type CampaignVerdict } from "./oracle.ts";

export type SetupResult = { name: string; kind: "identity" | "fixture"; ok: boolean; detail: string };
export type RunResult = { records: AdversarialCampaign[]; verdicts: Map<string, CampaignVerdict>; appBooted: boolean; bootNote: string; executionIds: string[]; setup: SetupResult[]; attempted: number };

/** The synthetic identity sign-ins the harness attempted, so a blocked campaign can name its real cause. Captured from
 *  the first run that produced them; the note is sanitized runtime text, never a raw credential. */
function safeDetail(value: string | null | undefined, fallback: string): string {
  return redactSecrets(value ?? fallback).text.replace(/\s+/g, " ").slice(0, 300);
}

function setupFrom(out: { identities?: Array<{ name: string; kind: string; ok: boolean; note: string | null }>; fixtures?: Array<{ id: string; kind: string; ok: boolean; note: string }> } | null | undefined): SetupResult[] {
  const identities = new Map((out?.identities ?? []).map((i) => [i.name, { name: i.name, kind: "identity" as const, ok: i.ok, detail: safeDetail(i.note, i.ok ? "signed in" : "sign-in failed") }]));
  const fixtures = (out?.fixtures ?? []).filter((f) => !identities.has(f.id)).map((f) => ({ name: f.id, kind: "fixture" as const, ok: f.ok, detail: safeDetail(f.note, f.ok ? "created" : "setup failed") }));
  return [...fixtures, ...identities.values()];
}
const REPLAY_PORT = 8098;
const REPLAY_KEY = "cc-adversarial-replay-key";

export function campaignRecord(c: CatalogCampaign, verdict: CampaignVerdict, seq: number): AdversarialCampaign {
  const result = verdict.status === "failed" ? "crossed" : verdict.status === "passed" ? "held" : verdict.status === "blocked" ? "blocked" : "inconclusive";
  const executionId = verdict.executionIds[0] ?? null;
  return {
    id: c.id,
    seq,
    lane: c.lane,
    techniqueId: c.techniqueId,
    priority: c.priority,
    title: c.title,
    target: c.target,
    attacker: c.attacker,
    resetStrategy: c.resetStrategy,
    steps: c.steps.map((s, i) => ({ seq: i + 1, operation: s.operation, inputClass: s.inputClass, asIdentity: s.asIdentity, target: s.target, expected: verdict.expected, executionId, observed: verdict.observed.slice(0, 1000), result, redacted: true })),
    status: verdict.status,
    reason: verdict.detail,
    executionIds: verdict.executionIds,
    findingIds: [],
    limitations: verdict.status === "inconclusive" || verdict.status === "blocked" ? [verdict.detail] : [],
    source: c.source,
  };
}

const parse = (s: string): unknown => {
  try { return JSON.parse(s); } catch { return s; }
};

const at = (value: unknown, path: string | undefined): unknown => {
  if (!path) return undefined;
  let cur = value;
  for (const part of path.replace(/^\$\.?/, "").split(".").filter(Boolean)) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
};

const replyOf = (body: unknown, target: AiEvaluationTarget) => {
  const selected = at(body, target.responseSelector);
  return typeof selected === "string" ? selected : typeof body === "string" ? body : JSON.stringify(selected ?? body ?? "");
};

const endpoint = (ref: string) => {
  const [method, ...rest] = ref.trim().split(/\s+/);
  return { method: method || "GET", path: rest.join(" ") || "/" };
};

const concrete = (path: string, id: string) => path.replace(/:\w+|\{[^}]*\}/, encodeURIComponent(id));

function requestJson(target: AiEvaluationTarget, message: string): Record<string, unknown> {
  const fill = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return typeof v === "string" ? v.replace(/\{\{message\}\}/g, message) : v;
  };
  const out = fill(target.requestTemplate) as Record<string, unknown>;
  return Object.keys(out).length ? out : { message };
}

function stateRead(c: CatalogCampaign, endpoints: Set<string>): { method: string; path: string } | null {
  if (c.oracle.kind !== "state_unchanged" && c.oracle.kind !== "no_privileged_action") return null;
  const match = [...endpoints].find((e) => /^GET\s+\/.*orders?\//i.test(e));
  return match ? (() => { const e = endpoint(match); return { ...e, path: concrete(e.path, c.oracle.id) }; })() : null;
}

function replayFor(c: CatalogCampaign, s: CatalogCampaign["steps"][number]): unknown[] | null {
  if (!["send_message", "send_indirect_content", "invoke_known_tool", "repeat_bounded", "run_parallel_bounded"].includes(s.operation)) return null;
  if (s.operation === "invoke_known_tool") return [{ content: null, toolCalls: [{ name: s.target, arguments: s.toolArgs ?? {} }] }, { content: "The requested synthetic operation completed." }];
  if (c.oracle.kind === "leak_marker") return [{ content: `Protected value: ${c.oracle.marker}`, toolCalls: [] }];
  if (c.oracle.kind === "no_cross_tenant_read") return [{ content: `Retrieved confidential record ${c.oracle.marker}`, toolCalls: [] }];
  if (c.oracle.kind === "no_file_escape") return [{ content: c.oracle.marker, toolCalls: [] }];
  if (c.oracle.kind === "citation_grounded") return [{ content: `Answer [${c.oracle.fakeId}]`, toolCalls: [] }];
  if (c.oracle.kind === "bounded_tool_calls") return [{ content: null, toolCalls: Array.from({ length: c.oracle.max + 1 }, () => ({ name: s.target || "get_order", arguments: {} })) }];
  return [{ content: "The adversarial request was accepted.", toolCalls: [] }];
}

function toHarnessCase(c: CatalogCampaign, target: AiEvaluationTarget, appReadyPath: string, endpoints: Set<string>, replay: boolean): HarnessAiSpec["aiCases"][number] | null {
  if (c.steps.some((s) => s.operation === "open_known_page")) return null;
  const turns: HarnessAiSpec["aiCases"][number]["turns"] = [];
  for (const s of c.steps) {
    const who = s.asIdentity === "anonymous" ? null : s.asIdentity;
    if (["send_message", "send_indirect_content", "repeat_bounded", "run_parallel_bounded"].includes(s.operation)) {
      const e = endpoint(c.target.endpoint);
      turns.push({ ...e, json: requestJson(target, s.message ?? s.content ?? ""), as: who, replay: replay ? replayFor(c, s) : null, timeoutMs: 15_000 });
    } else if (s.operation === "invoke_known_tool") {
      const e = endpoint(c.target.endpoint);
      turns.push({ ...e, json: requestJson(target, s.message ?? `[[TOOL:${s.target} ${JSON.stringify(s.toolArgs ?? {})}]]`), as: who, replay: replay ? replayFor(c, s) : null, timeoutMs: 15_000 });
    } else if (s.operation === "upload_synthetic_document") {
      const e = endpoint(s.target);
      turns.push({ ...e, json: { title: "Cybercheck synthetic document", body: s.content ?? "", tenant: "synthetic" }, as: who, replay: null, timeoutMs: 15_000 });
    } else if (["retrieve_synthetic_document", "inspect_known_state", "compare_identity_response"].includes(s.operation)) {
      const e = endpoint(s.target);
      turns.push({ ...e, as: who, replay: null, timeoutMs: 15_000 });
    }
  }
  const read = stateRead(c, endpoints);
  if (read) turns.push({ ...read, as: c.steps.at(-1)?.asIdentity === "anonymous" ? null : (c.steps.at(-1)?.asIdentity ?? null), replay: null, timeoutMs: 15_000 });
  if (!turns.length) return null;
  const needs = [...new Set(turns.map((t) => t.as).filter((x): x is string => Boolean(x)))];
  return { id: c.id, needs, alivePath: appReadyPath, turns };
}

function observation(c: CatalogCampaign, out: HarnessAiCase | undefined, target: AiEvaluationTarget, executionId: string, evidence: Evidence[], canaryHits: string[], booted: boolean): CampaignObservation {
  const bodies = (out?.turns ?? []).map((t) => parse(t.body));
  const turns = (out?.turns ?? []).map((t, i) => ({ as: c.steps[Math.min(i, c.steps.length - 1)]?.asIdentity ?? null, status: t.status, reply: replyOf(bodies[i], target), body: bodies[i], ms: t.ms }));
  const lastAssistant = bodies.findLast((b) => Boolean(at(b, target.responseSelector))) ?? bodies.at(-1);
  const toolRaw = at(lastAssistant, target.toolTraceSelector) ?? at(lastAssistant, "toolCalls");
  const citationRaw = at(lastAssistant, target.citationSelector) ?? at(lastAssistant, "citations");
  const toolCalls = Array.isArray(toolRaw) ? toolRaw.map((x) => ({ name: String((x as Record<string, unknown>)?.name ?? "tool"), args: (x as Record<string, unknown>)?.args ?? {} })) : [];
  const citations = Array.isArray(citationRaw) ? citationRaw.map(String) : [];
  const read = c.oracle.kind === "state_unchanged" || c.oracle.kind === "no_privileged_action" ? bodies.at(-1) : undefined;
  const rec = read && typeof read === "object" ? read as Record<string, unknown> : null;
  const stateAfter: CampaignObservation["stateAfter"] = {};
  if (c.oracle.kind === "state_unchanged" || c.oracle.kind === "no_privileged_action") {
    stateAfter[c.oracle.id] = rec ? { status: rec.status === "refunded" || rec.refunded === true ? "refunded" : typeof rec.status === "string" ? rec.status : "unchanged" } : null;
  }
  const reached = Boolean(out && !out.blocked && out.turns.some((t) => t.status != null));
  const answered = Boolean(out?.turns.some((t) => t.status != null && t.status >= 200 && t.status < 300));
  const uploadIndexes = c.steps.map((s, i) => s.operation === "upload_synthetic_document" ? i : -1).filter((i) => i >= 0);
  const fixtureReady = uploadIndexes.every((i) => { const s = out?.turns[i]?.status; return s != null && s >= 200 && s < 300; });
  const retrievalReached = Boolean(at(lastAssistant, target.retrievalTraceSelector) ?? at(lastAssistant, "usedDocs") ?? (c.oracle.kind !== "no_cross_tenant_read" && c.oracle.kind !== "citation_grounded"));
  const oracleReady = c.oracle.kind === "state_unchanged" || c.oracle.kind === "no_privileged_action" ? stateAfter[c.oracle.id] != null : c.oracle.kind === "refused_or_owned" ? reached : c.oracle.kind === "citation_grounded" ? answered && Array.isArray(citationRaw) : answered;
  const fileEscapeMarker = c.oracle.kind === "no_file_escape" ? c.oracle.marker : null;
  return {
    ran: Boolean(out && !out.blocked),
    blockedReason: out?.blocked ? `${out.blocked.node}: ${safeDetail(out.blocked.note, "required setup failed")}` : null,
    preconditions: { appBooted: booted, targetReached: reached, fixtureReady, oracleReady },
    turns,
    toolCalls,
    citations,
    canaryHits: canaryHits.includes("cc-adv-canary") ? 1 : 0,
    xssExecuted: false,
    xssReflected: false,
    retrievalReached,
    toolSurfaceReached: reached && (
      toolCalls.length > 0
      || canaryHits.includes("cc-adv-canary")
      || (fileEscapeMarker != null && turns.some((t) => t.reply.includes(fileEscapeMarker)))
      || c.steps.some((s) => (s.operation === "invoke_known_tool" || s.operation === "repeat_bounded") && turns.some((t) => t.reply.toLowerCase().includes(s.target.toLowerCase())))
    ),
    responseOwned: null,
    stateAfter,
    reset: true, // each campaign receives a fresh disposable app container from the prepared image
    resetRequired: !["none", "new_conversation", "fresh_browser"].includes(c.resetStrategy),
    executionIds: [executionId],
    evidence,
  };
}

// The orchestrator supplies the one boot plan chosen for this run. Preparation never rediscovers accounts from test
// literals, so seed/activation/setup nodes and the identities that depend on them cannot drift between planning and run.
export type PreparedAttack = { image: string; app: BootApp; graph: FixtureNode[] };
export type SetupPreflight = { appBooted: boolean; bootNote: string; executionIds: string[]; setup: SetupResult[]; byNode: Map<string, SetupResult> };

export async function prepareAdversarialAttack(ctx: Ctx, input: { dossier: ProjectDossier; src: SnapshotSource; archive: Buffer; app: BootApp; graph?: FixtureNode[] }): Promise<{ ok: true; prepared: PreparedAttack } | { ok: false; note: string }> {
  const workspaces = planWorkspaces(input.dossier, input.src);
  const app = input.app;
  const ws = workspaces.find((w) => w.dir === app.workspace);
  const image = await prepareApp(ctx, input.archive, app.prepare.length || ws?.install ? { dir: app.workspace, command: ws?.install?.command ?? "npm install" } : null, undefined, "adversarial_app");
  if (!image) return { ok: false, note: "The application could not be prepared in the sandbox." };
  const graph: FixtureNode[] = input.graph ?? bootGraph(app, (applies) => verifyTarget(input.dossier, applies));
  return { ok: true, prepared: { image, app, graph } };
}

/** Execute and record the setup graph once before any campaign fan-out. Campaign sandboxes still replay this same
 * validated graph for isolation, but a broken identity or fixture is discovered only once and blocks dependants early. */
export async function preflightAdversarialSetup(ctx: Ctx, prepared: PreparedAttack, timeoutSec: number): Promise<SetupPreflight> {
  const r = await runHarness(ctx, prepared.image, prepared.app, prepared.graph, [], "Adversarial test setup preflight", null, {}, [], CANARY.port, undefined, "adversarial_fixture");
  const setup = setupFrom(r.out);
  const appBooted = Boolean(r.out?.boot.ok);
  const bootNote = safeDetail(r.out?.boot.reason, appBooted ? "The application started and the setup graph was checked." : "The application did not start during setup preflight.");
  void timeoutSec;
  const byNode = new Map(setup.map((s) => [s.name, s]));
  // Captured symbols are aliases for their producing setup node, so a campaign that uses {{order_id}} is blocked when
  // the order fixture failed and is allowed when that exact real id was captured.
  for (const node of prepared.graph) {
    const result = byNode.get(node.id);
    if (!result) continue;
    for (const name of [...(node.exports ?? []), ...(node.steps ?? []).flatMap((s) => s.capture ? [s.capture.name] : [])]) byNode.set(name, result);
  }
  return { appBooted, bootNote, executionIds: [r.exec.id], setup, byNode };
}

export function campaignFixtureDependencies(c: CatalogCampaign): string[] {
  const deps = new Set(c.fixtureDependencies ?? []);
  const local = new Set(c.steps.flatMap((s) => s.capture ? [s.capture.name] : []));
  for (const s of c.steps) {
    const identity = s.asIdentity?.replace(/#(?:forged|tampered)$/, "");
    if (identity && identity !== "anonymous") deps.add(identity);
    for (const m of JSON.stringify({ target: s.target, body: s.body, query: s.query, toolArgs: s.toolArgs }).matchAll(/\{\{([\w.-]+)\}\}/g)) {
      const name = m[1]!;
      if (name === "$uid" || local.has(name)) continue;
      deps.add(name.includes(".") ? name.split(".")[0]! : name);
    }
  }
  return [...deps];
}

function blockedObservation(c: CatalogCampaign, preflight: SetupPreflight, evidence: Evidence[], reason?: string): CampaignObservation {
  const failed = campaignFixtureDependencies(c).map((id) => preflight.byNode.get(id)).find((x) => !x?.ok);
  const detail = reason ?? (failed ? `${failed.name}: ${failed.detail}` : !preflight.appBooted ? preflight.bootNote : "The campaign could not establish its required setup.");
  return { ran: false, blockedReason: detail, preconditions: { appBooted: preflight.appBooted, targetReached: false, fixtureReady: false, oracleReady: false }, turns: [], toolCalls: [], citations: [], canaryHits: 0, xssExecuted: false, xssReflected: false, retrievalReached: false, toolSurfaceReached: false, responseOwned: null, stateAfter: {}, reset: false, resetRequired: c.resetStrategy !== "none", executionIds: preflight.executionIds, evidence };
}

function dependencyFailure(c: CatalogCampaign, preflight: SetupPreflight): SetupResult | null {
  if (!preflight.appBooted) return { name: "application boot", kind: "fixture", ok: false, detail: preflight.bootNote };
  for (const id of campaignFixtureDependencies(c)) {
    const result = preflight.byNode.get(id);
    if (!result?.ok) return result ?? { name: id, kind: "fixture", ok: false, detail: `Required setup node "${id}" was not produced by the boot plan.` };
  }
  return null;
}

// How many HTTP turns a bounded repeat/parallel step expands into. The harness runs aiCase turns sequentially (it has
// no concurrency primitive), so a race / parallel campaign is approximated as a bounded burst; the rate-limit and
// logic oracles read the burst's statuses. Kept small to stay inside the sandbox and the run's time budget.
const burstOf = (s: PlannedStep) => Math.min(Math.max(s.operation === "run_parallel_bounded" ? (s.parallel ?? 4) : (s.repeat ?? 8), 2), 20);

/** Translate a general (non-AI) campaign into plain HTTP harness turns: method+path+body as an identity, with capture
 *  wiring. No model target, no replay. `{{name}}` is filled from an identity's own id or an earlier turn's capture. */
function toGeneralCase(c: CatalogCampaign, appReadyPath: string): HarnessAiSpec["aiCases"][number] | null {
  const turns: HarnessAiSpec["aiCases"][number]["turns"] = [];
  const turnFor = (s: PlannedStep, parallelGroup?: string) => {
    const who = !s.asIdentity || s.asIdentity === "anonymous" ? null : s.asIdentity;
    const e = endpoint(s.target);
    return { method: e.method, path: e.path, json: s.body, as: who, replay: null, timeoutMs: 15_000, ...(s.capture ? { capture: s.capture } : {}), ...(parallelGroup ? { parallelGroup } : {}) };
  };
  for (const s of c.steps) {
    if (s.operation === "send_request" || s.operation === "capture") turns.push(turnFor(s));
    else if (s.operation === "repeat_bounded" || s.operation === "run_parallel_bounded") for (let i = 0; i < burstOf(s); i++) turns.push(turnFor(s, s.operation === "run_parallel_bounded" ? `parallel-${c.id}` : undefined));
  }
  if (!turns.length) return null;
  // Sign in every identity a turn acts as, plus every identity whose own id is templated as {{name.id}} (an IDOR read
  // uses another user's captured id), so the harness has that value to fill. An undefined identity blocks the case.
  const ids = new Set<string>();
  const scan = (s: string) => { for (const m of s.matchAll(/\{\{([\w-]+)\.id\}\}/g)) ids.add(m[1]!); };
  for (const t of turns) { scan(t.path); if (t.json) scan(JSON.stringify(t.json)); }
  const needs = [...new Set([...turns.map((t) => t.as).filter((x): x is string => Boolean(x)), ...ids])];
  return { id: c.id, needs, alivePath: appReadyPath, turns };
}

/** Map harness turns (a burst step produces several) back to their source step, for per-turn identity attribution. */
function stepIndexForTurns(c: CatalogCampaign): number[] {
  const out: number[] = [];
  c.steps.forEach((s, si) => {
    const n = s.operation === "repeat_bounded" || s.operation === "run_parallel_bounded" ? burstOf(s) : s.operation === "send_request" || s.operation === "capture" ? 1 : 0;
    for (let k = 0; k < n; k++) out.push(si);
  });
  return out;
}

function generalObservation(c: CatalogCampaign, out: HarnessAiCase | undefined, executionId: string, evidence: Evidence[], canaryHits: string[], booted: boolean): CampaignObservation {
  const raw = out?.turns ?? [];
  const idx = stepIndexForTurns(c);
  const turns = raw.map((t, i) => {
    const body = parse(t.body);
    return { as: c.steps[idx[i] ?? Math.min(i, c.steps.length - 1)]?.asIdentity ?? null, status: t.status, reply: typeof body === "string" ? body : JSON.stringify(body ?? ""), body, ms: t.ms };
  });
  const statuses = turns.map((t) => t.status).filter((s): s is number => s != null);
  const reached = Boolean(out && !out.blocked && statuses.length > 0);
  // A single response decides access_denied, logic_rejected and field_unchanged: a refusal (401/403/404) is as decisive
  // as a 2xx (the privileged field was simply not accepted). Only the differential oracles need two responses.
  const oracleReady = c.oracle.kind === "rate_limited" || c.oracle.kind === "injection_inert" ? statuses.length >= 2 : reached;
  return {
    ran: Boolean(out && !out.blocked),
    blockedReason: out?.blocked ? `${out.blocked.node}: ${safeDetail(out.blocked.note, "required setup failed")}` : null,
    preconditions: { appBooted: booted, targetReached: reached, fixtureReady: true, oracleReady },
    turns,
    toolCalls: [],
    citations: [],
    canaryHits: canaryHits.includes("cc-adv-canary") ? 1 : 0,
    xssExecuted: false,
    xssReflected: false,
    retrievalReached: false,
    toolSurfaceReached: canaryHits.includes("cc-adv-canary"),
    responseOwned: null,
    stateAfter: {},
    reset: true, // each campaign receives a fresh disposable app container from the prepared image
    resetRequired: !["none", "new_conversation", "fresh_browser"].includes(c.resetStrategy),
    executionIds: [executionId],
    evidence,
  };
}

export async function runGeneralCampaigns(ctx: Ctx, input: { prepared: PreparedAttack; preflight: SetupPreflight; campaigns: CatalogCampaign[]; rules: RulesOfEngagement; profile: keyof typeof AD_PROFILE_LIMITS; evidence: Evidence[]; onEvent: (message: string) => Promise<void> }): Promise<RunResult> {
  const { image, app, graph } = input.prepared;
  const records: AdversarialCampaign[] = [];
  const verdicts = new Map<string, CampaignVerdict>();
  const executionIds: string[] = [...input.preflight.executionIds];
  let attempted = 0;
  let seq = 0;
  for (const c of input.campaigns) {
    const dependency = dependencyFailure(c, input.preflight);
    if (dependency) {
      const verdict = judgeCampaign(c, blockedObservation(c, input.preflight, input.evidence.slice(0, 4), `${dependency.name}: ${dependency.detail}`));
      verdicts.set(c.id, verdict);
      records.push(campaignRecord(c, verdict, ++seq));
      await input.onEvent(`${c.title}: blocked by ${dependency.name} (${dependency.detail})`);
      continue;
    }
    const specCase = toGeneralCase(c, app.readyPath ?? "/");
    if (!specCase) {
      const verdict = judgeCampaign(c, blockedObservation(c, input.preflight, input.evidence.slice(0, 4), "The campaign has no executable HTTP turn after compilation."));
      verdicts.set(c.id, verdict);
      records.push(campaignRecord(c, verdict, ++seq));
      continue;
    }
    await input.onEvent(`Running ${c.title} in a fresh isolated application`);
    const ai: HarnessAiSpec = { aiCases: [specCase], replay: null, timeoutSec: Math.min(180, input.rules.limits.timeoutSec), deadlineMs: Math.min(180_000, input.rules.limits.timeoutSec * 1000), maxModelRequests: Math.max(1, input.rules.limits.toolCalls) };
    const r = await runHarness(ctx, image, app, graph, [], `Adversarial campaign: ${c.title}`, null, {}, [], CANARY.port, ai, "adversarial_campaign");
    executionIds.push(r.exec.id);
    const campaignOut = r.out?.aiCases?.find((x) => x.id === c.id);
    if (campaignOut && !campaignOut.blocked && campaignOut.turns.length) attempted++;
    const obs = generalObservation(c, campaignOut, r.exec.id, input.evidence.slice(0, 4), r.out?.canaryHits ?? [], Boolean(r.out?.boot.ok));
    const verdict = judgeCampaign(c, obs);
    verdicts.set(c.id, verdict);
    records.push(campaignRecord(c, verdict, ++seq));
  }
  return { records, verdicts, appBooted: input.preflight.appBooted, bootNote: attempted ? `${attempted} campaign(s) sent attack requests in isolated application instances.` : input.preflight.bootNote, executionIds, setup: input.preflight.setup, attempted };
}

export async function runAdversarialCampaigns(ctx: Ctx, input: { prepared: PreparedAttack; preflight: SetupPreflight; target: AiEvaluationTarget; component: AiComponentInventory; campaigns: CatalogCampaign[]; endpoints: Set<string>; rules: RulesOfEngagement; profile: keyof typeof AD_PROFILE_LIMITS; onEvent: (message: string) => Promise<void> }): Promise<RunResult> {
  const providerBacked = input.component.kind !== "local_logic";
  const replay = providerBacked && input.component.provider.interceptable && input.component.provider.family === "openai_compatible" && input.component.provider.baseUrlEnv.length > 0;
  if (providerBacked && !replay) return { records: [], verdicts: new Map(), appBooted: input.preflight.appBooted, bootNote: input.component.provider.reason ?? "The model provider cannot be redirected to the sandbox-local replay model, so its campaigns were not executed.", executionIds: [...input.preflight.executionIds], setup: input.preflight.setup, attempted: 0 };
  const { image, app, graph } = input.prepared;
  const records: AdversarialCampaign[] = [];
  const verdicts = new Map<string, CampaignVerdict>();
  const executionIds: string[] = [...input.preflight.executionIds];
  let attempted = 0;
  let seq = 0;
  const extra: Record<string, string> = {};
  if (replay) {
    for (const name of input.component.provider.baseUrlEnv) extra[name] = `http://127.0.0.1:${REPLAY_PORT}/v1`;
    for (const name of input.component.provider.apiKeyEnv) extra[name] = REPLAY_KEY;
  }
  for (const c of input.campaigns) {
    const dependency = dependencyFailure(c, input.preflight);
    if (dependency) {
      const verdict = judgeCampaign(c, blockedObservation(c, input.preflight, input.component.evidence.slice(0, 4), `${dependency.name}: ${dependency.detail}`));
      verdicts.set(c.id, verdict);
      records.push(campaignRecord(c, verdict, ++seq));
      await input.onEvent(`${c.title}: blocked by ${dependency.name} (${dependency.detail})`);
      continue;
    }
    const specCase = toHarnessCase(c, input.target, app.readyPath ?? "/", input.endpoints, replay);
    if (!specCase) {
      const verdict = judgeCampaign(c, blockedObservation(c, input.preflight, input.component.evidence.slice(0, 4), "The campaign has no executable API turn after compilation."));
      verdicts.set(c.id, verdict);
      records.push(campaignRecord(c, verdict, ++seq));
      continue;
    }
    await input.onEvent(`Running ${c.title} in a fresh isolated application`);
    const ai: HarnessAiSpec = { aiCases: [specCase], replay: replay ? { port: REPLAY_PORT } : null, timeoutSec: Math.min(180, input.rules.limits.timeoutSec), deadlineMs: Math.min(180_000, input.rules.limits.timeoutSec * 1000), maxModelRequests: Math.max(1, input.rules.limits.toolCalls) };
    const r = await runHarness(ctx, image, app, graph, [], `Adversarial campaign: ${c.title}`, null, extra, [], CANARY.port, ai, "adversarial_campaign");
    executionIds.push(r.exec.id);
    const out = r.out?.aiCases?.find((x) => x.id === c.id);
    if (out && !out.blocked && out.turns.length) attempted++;
    const obs = observation(c, out, input.target, r.exec.id, input.component.evidence.slice(0, 4), r.out?.canaryHits ?? [], Boolean(r.out?.boot.ok));
    const verdict = judgeCampaign(c, obs);
    verdicts.set(c.id, verdict);
    records.push(campaignRecord(c, verdict, ++seq));
  }
  return { records, verdicts, appBooted: input.preflight.appBooted, bootNote: attempted ? `${attempted} campaign(s) sent attack requests in isolated application instances.` : input.preflight.bootNote, executionIds, setup: input.preflight.setup, attempted };
}
