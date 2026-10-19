import { AD_PROFILE_LIMITS, type AdversarialCampaign, type AiComponentInventory, type AiEvaluationTarget, type Evidence, type ProjectDossier, type RulesOfEngagement } from "@cybercheck/contracts";
import { prepareApp, buildIdentities } from "../security/proofs/run.ts";
import { CANARY } from "../security/proofs/catalog.ts";
import { planWorkspaces } from "../testing/adapters.ts";
import { bootGraph, planBoot } from "../testing/agents.ts";
import { seededAccounts, verifyTarget } from "../testing/fixtures.ts";
import type { FixtureNode } from "../testing/plan.ts";
import { runHarness, type HarnessAiCase, type HarnessAiSpec } from "../testing/probes.ts";
import type { Ctx } from "../testing/runtime.ts";
import type { SnapshotSource } from "../understanding/source.ts";
import type { CatalogCampaign } from "./catalog.ts";
import { judgeCampaign, type CampaignObservation, type CampaignVerdict } from "./oracle.ts";

type RunResult = { records: AdversarialCampaign[]; verdicts: Map<string, CampaignVerdict>; appBooted: boolean; bootNote: string; executionIds: string[] };
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
  const turns = (out?.turns ?? []).map((t, i) => ({ as: c.steps[Math.min(i, c.steps.length - 1)]?.asIdentity ?? null, status: t.status, reply: replyOf(bodies[i], target), body: bodies[i] }));
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
  return {
    ran: Boolean(out && !out.blocked),
    preconditions: { appBooted: booted, targetReached: reached, fixtureReady, oracleReady },
    turns,
    toolCalls,
    citations,
    canaryHits: canaryHits.includes("cc-adv-canary") ? 1 : 0,
    xssExecuted: false,
    xssReflected: false,
    retrievalReached,
    toolSurfaceReached: reached && (toolCalls.length > 0 || canaryHits.includes("cc-adv-canary") || c.steps.some((s) => (s.operation === "invoke_known_tool" || s.operation === "repeat_bounded") && turns.some((t) => t.reply.toLowerCase().includes(s.target.toLowerCase())))),
    responseOwned: null,
    stateAfter,
    reset: true, // each campaign receives a fresh disposable app container from the prepared image
    resetRequired: !["none", "new_conversation", "fresh_browser"].includes(c.resetStrategy),
    executionIds: [executionId],
    evidence,
  };
}

export async function runAdversarialCampaigns(ctx: Ctx, input: { dossier: ProjectDossier; src: SnapshotSource; archive: Buffer; target: AiEvaluationTarget; component: AiComponentInventory; campaigns: CatalogCampaign[]; endpoints: Set<string>; rules: RulesOfEngagement; profile: keyof typeof AD_PROFILE_LIMITS; onEvent: (message: string) => Promise<void> }): Promise<RunResult> {
  const providerBacked = input.component.kind !== "local_logic";
  const replay = providerBacked && input.component.provider.interceptable && input.component.provider.family === "openai_compatible" && input.component.provider.baseUrlEnv.length > 0;
  if (providerBacked && !replay) return { records: [], verdicts: new Map(), appBooted: false, bootNote: input.component.provider.reason ?? "The model provider cannot be redirected to the sandbox-local replay model, so its campaigns were not executed.", executionIds: [] };
  const workspaces = planWorkspaces(input.dossier, input.src);
  const boot = await planBoot(null, input.dossier, input.src, workspaces);
  const app = boot.apps[0];
  if (!app) return { records: [], verdicts: new Map(), appBooted: false, bootNote: "No startable app was found.", executionIds: [] };
  const ws = workspaces.find((w) => w.dir === app.workspace);
  const image = await prepareApp(ctx, input.archive, app.prepare.length || ws?.install ? { dir: app.workspace, command: ws?.install?.command ?? "npm install" } : null, undefined, "adversarial_app");
  if (!image) return { records: [], verdicts: new Map(), appBooted: false, bootNote: "The application could not be prepared in the sandbox.", executionIds: [] };

  const loginEp = input.dossier.entryPoints.find((e) => /(^|\/)(log-?in|sign-?in|auth\/login|session)(\/|$)/i.test(e.path) && e.method === "POST");
  const accounts = seededAccounts(input.src);
  const login = loginEp && accounts.length ? { method: loginEp.method, path: loginEp.path, accountField: accounts[0]!.accountField, passwordField: accounts[0]!.passwordField } : null;
  const { nodes: idNodes } = login ? buildIdentities(input.src, login, input.dossier) : { nodes: [] };
  const graph: FixtureNode[] = [...bootGraph(app, (applies) => verifyTarget(input.dossier, applies)), ...idNodes];
  const records: AdversarialCampaign[] = [];
  const verdicts = new Map<string, CampaignVerdict>();
  const executionIds: string[] = [];
  let seq = 0;
  const extra: Record<string, string> = {};
  if (replay) {
    for (const name of input.component.provider.baseUrlEnv) extra[name] = `http://127.0.0.1:${REPLAY_PORT}/v1`;
    for (const name of input.component.provider.apiKeyEnv) extra[name] = REPLAY_KEY;
  }
  for (const c of input.campaigns) {
    const specCase = toHarnessCase(c, input.target, app.readyPath ?? "/", input.endpoints, replay);
    if (!specCase) continue;
    await input.onEvent(`Running ${c.title} in a fresh isolated application`);
    const ai: HarnessAiSpec = { aiCases: [specCase], replay: replay ? { port: REPLAY_PORT } : null, timeoutSec: Math.min(180, input.rules.limits.timeoutSec), deadlineMs: Math.min(180_000, input.rules.limits.timeoutSec * 1000), maxModelRequests: Math.max(1, input.rules.limits.toolCalls) };
    const r = await runHarness(ctx, image, app, graph, [], `Adversarial campaign: ${c.title}`, null, extra, [], CANARY.port, ai, "adversarial_campaign");
    executionIds.push(r.exec.id);
    const out = r.out?.aiCases?.find((x) => x.id === c.id);
    const obs = observation(c, out, input.target, r.exec.id, input.component.evidence.slice(0, 4), r.out?.canaryHits ?? [], Boolean(r.out?.boot.ok));
    const verdict = judgeCampaign(c, obs);
    verdicts.set(c.id, verdict);
    records.push(campaignRecord(c, verdict, ++seq));
  }
  return { records, verdicts, appBooted: records.length > 0, bootNote: records.length ? `${records.length} campaign(s) ran in isolated application instances.` : "No API campaign could be executed.", executionIds };
}
