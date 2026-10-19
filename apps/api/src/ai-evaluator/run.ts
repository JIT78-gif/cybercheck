import { AI_PROFILE_LIMITS, type AiApplicability, type AiCaseSample, type AiComponentInventory, type AiDatasetCase, type AiEvaluationCase, type AiEvaluationPolicyInput, type AiEvaluationTarget, type AiExecutionMode, type ProjectDossier } from "@cybercheck/contracts";
import { buildIdentities, prepareApp } from "../security/proofs/run.ts";
import { planWorkspaces } from "../testing/adapters.ts";
import { bootGraph, planBoot } from "../testing/agents.ts";
import { seededAccounts, verifyTarget } from "../testing/fixtures.ts";
import type { FixtureNode } from "../testing/plan.ts";
import { runHarness, type HarnessAiCase, type HarnessAiSpec } from "../testing/probes.ts";
import type { Ctx } from "../testing/runtime.ts";
import { endpointKeys } from "../testing/scenarios.ts";
import type { SnapshotSource } from "../understanding/source.ts";
import { builtinCases, type CaseSpec } from "./catalog.ts";
import { compileCases, fromDataset, type CompiledCase } from "./compiler.ts";
import { aggregateSamples, citationsOf, grade, promptTextsFrom, replyText, select, toolTraceOf, type Observation, type ObservedTurn } from "./graders.ts";
import { extractRepositoryCases } from "./repository.ts";
import { comparePairwise, judgeCase, type Calibration, type JudgeProvider, type PairwiseSummary } from "./judge.ts";
import { liveGatewayStatus, type GatewayStatus } from "./gateway.ts";
import { redactText } from "./redact.ts";

// Runs the AI Evaluator's compiled cases against the project's own app, booted once inside the sandbox with the
// Testing runtime (the single execution authority), network off. A component whose model traffic goes through a
// configurable base URL is pointed at the harness's loopback replay model; a component with no model is called directly.
// Nothing reaches a real provider, so no model credit is used.

export const REPLAY_PORT = 8098;
const REPLAY_KEY = "cc-replay-key-not-a-secret";

export type ComponentPlan = { component: AiComponentInventory; target: AiEvaluationTarget; mode: AiExecutionMode | null; reason: string };

/** How each bound component can be exercised in this run (null mode: it cannot be, with the reason). */
export function planComponents(a: AiApplicability, policy: Pick<AiEvaluationPolicyInput, "modelMode">, gateway: GatewayStatus): ComponentPlan[] {
  return a.targets.map(({ target }) => {
    const component = a.components.find((c) => c.id === target.componentId)!;
    if (component.kind === "local_logic") {
      if (policy.modelMode === "live") return { component, target, mode: null, reason: "The component calls no model provider, so there is no model traffic for the live gateway to carry." };
      return { component, target, mode: "direct", reason: "The component calls no model provider, so its route is called directly." };
    }
    const routable = component.provider.interceptable && component.provider.family === "openai_compatible" && component.provider.baseUrlEnv.length > 0;
    if (!routable) return { component, target, mode: null, reason: component.provider.reason ?? `The ${component.provider.name ?? "model provider"} traffic cannot be routed through cybercheck (it needs an OpenAI-compatible client with a configurable base URL).` };
    const through = `through ${component.provider.baseUrlEnv.join(", ")}`;
    if (policy.modelMode === "replay") return { component, target, mode: "replay", reason: `Model calls go to cybercheck's replay model ${through}.` };
    if (policy.modelMode === "live") return gateway.available ? { component, target, mode: "live", reason: `Model calls go through cybercheck's live gateway to ${gateway.model} ${through}.` } : { component, target, mode: null, reason: gateway.reason };
    // auto: live when the gateway is available, otherwise replay with the limit disclosed.
    return gateway.available ? { component, target, mode: "live", reason: `Model calls go through cybercheck's live gateway to ${gateway.model} ${through}.` } : { component, target, mode: "replay", reason: `No live gateway is available, so model calls go to cybercheck's replay model ${through}. ${gateway.reason}` };
  });
}

/** The identity a target's auth fixture stands for. */
function resolveIdentity(fixture: string | undefined, names: string[]): string | null {
  if (!fixture) return null;
  if (names.includes(fixture)) return fixture;
  const members = names.filter((n) => n !== "admin");
  if (/(^|-)a$|^user$|^customer$/.test(fixture)) return members[0] ?? null;
  if (/(^|-)b$/.test(fixture)) return members[1] ?? null;
  if (/admin/.test(fixture)) return names.includes("admin") ? "admin" : null;
  return members[0] ?? null;
}

export type AiRunResult = {
  cases: AiEvaluationCase[];
  plans: ComponentPlan[];
  appBooted: boolean;
  bootNote: string;
  /** Things that were not tested, with the reason. */
  untested: Array<{ what: string; reason: string }>;
  executionIds: string[];
  modes: AiExecutionMode[];
  /** Seeded identities the run could sign in as (for the isolation lane requirement). */
  identities: number;
  /** Extra limitations gathered during the run (e.g. repository-derived case provenance). */
  limitations: string[];
  /** The judge's activity this run (null when the judge was not used). */
  judge: { calls: number; scored: number; provider: string | null; model: string | null } | null;
  /** Whether cybercheck's live gateway could run. */
  gateway: GatewayStatus;
  /** Pairwise regression against a baseline run, or null when none was compared. */
  pairwise: (PairwiseSummary & { baselineRunId: string; note: string }) | null;
  /** The bound target's selectors checked against a real response, or null when nothing answered. */
  targetValidation: { endpoint: string; boundBy: "user" | "single_route"; probed: boolean; selectors: Array<{ name: string; path: string; resolved: boolean; detail: string }> } | null;
  /** Set when the live gateway's upstream provider failed every call (e.g., out of credits); live cases could not run. */
  liveProviderError: string | null;
};

/** Check each selector of the bound target against one real 2xx response. */
export function validateTarget(target: AiEvaluationTarget, boundBy: "user" | "single_route", turn: ObservedTurn | undefined): AiRunResult["targetValidation"] {
  const endpoint = `${target.method ?? "POST"} ${target.path}`;
  if (!turn) return { endpoint, boundBy, probed: false, selectors: [] };
  const body = (() => {
    try {
      return JSON.parse(turn.body);
    } catch {
      return undefined;
    }
  })();
  const selectors: Array<{ name: string; path: string; resolved: boolean; detail: string }> = [];
  const reply = replyText(turn, target);
  selectors.push({ name: "responseSelector", path: target.responseSelector, resolved: reply !== null && reply.trim().length > 0, detail: reply === null ? "did not resolve to a value in the response" : reply.trim() ? "resolved to the reply text" : "resolved to an empty value" });
  if (target.citationSelector) {
    const v = select(body, target.citationSelector);
    const c = citationsOf(turn, target);
    const ok = v !== undefined && Array.isArray(c);
    selectors.push({ name: "citationSelector", path: target.citationSelector, resolved: ok, detail: ok ? `resolved to a list of ${c!.length}` : "the field is not present in the response; citation cases cannot run" });
  }
  if (target.conversationSelector) {
    const v = select(body, target.conversationSelector);
    selectors.push({ name: "conversationSelector", path: target.conversationSelector, resolved: v !== undefined, detail: v !== undefined ? "resolved; multi-turn conversations can be continued" : "did not resolve; multi-turn cases cannot be linked" });
  }
  if (target.toolTraceSelector) {
    const v = select(body, target.toolTraceSelector);
    selectors.push({ name: "toolTraceSelector", path: target.toolTraceSelector, resolved: v !== undefined, detail: v !== undefined ? "resolved to a tool trace" : "the field is not present in the response; tool-use cases cannot be observed here" });
  }
  if (target.retrievalTraceSelector) {
    const v = select(body, target.retrievalTraceSelector);
    selectors.push({ name: "retrievalTraceSelector", path: target.retrievalTraceSelector, resolved: v !== undefined, detail: v !== undefined ? "resolved to a retrieval trace" : "did not resolve" });
  }
  return { endpoint, boundBy, probed: true, selectors };
}

type DatasetIn = { id: string; name: string; version: number; digest: string; cases: AiDatasetCase[] };

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]! : null);
const estTokens = (s: string) => Math.ceil(s.length / 4);

/** Case ids are unique within a run (the same id from two datasets or two components gets the component or sequence). */
export function uniqueIds(cases: AiEvaluationCase[]): void {
  const multi = new Set(cases.map((c) => c.target.componentId)).size > 1;
  const seen = new Set<string>();
  for (const c of cases) {
    let id = multi ? `${c.target.componentId}/${c.id}` : c.id;
    if (seen.has(id)) id = `${id}#${c.seq}`;
    seen.add(id);
    c.id = id;
  }
}

/** A case record for something that was never sent. */
export function unsentCase(spec: CaseSpec, seq: number, plan: { componentId: string; endpoint: string; mode: AiExecutionMode }, profile: AiEvaluationPolicyInput["profile"], reason: string, evidence: AiEvaluationCase["sourceEvidence"]): AiEvaluationCase {
  return {
    id: spec.id,
    seq,
    category: spec.category,
    priority: spec.priority,
    tags: spec.tags,
    title: spec.title,
    target: { componentId: plan.componentId, endpoint: plan.endpoint },
    source: spec.source,
    inputClass: spec.inputClass,
    conversationSetup: spec.conversation.length ? `${spec.conversation.length} earlier turn(s) in the same conversation` : "A fresh conversation, one turn",
    preconditions: [],
    reset: "fresh_conversation",
    oracle: { type: spec.graders.filter((g) => g.hard).map((g) => g.id).join(", "), expected: spec.expectedText },
    samplesPlanned: 1,
    profile,
    mode: plan.mode,
    graders: [],
    judge: [],
    samples: [],
    measurements: { medianMs: null, maxMs: null, tokensIn: 0, tokensOut: 0, costUsd: null, modelRequests: 0 },
    executionIds: [],
    sourceEvidence: evidence,
    verdict: "blocked",
    evaluator: "deterministic",
    reason,
    limitations: [],
    redacted: true,
    findingIds: [],
  };
}

/** Grade one sample of a case: the graded results plus the stored sample record. */
function gradeSample(c: CompiledCase, out: HarnessAiCase, o: { target: AiEvaluationTarget; systemPrompts: string[] }, index: number) {
  const sentText = c.turns.map((t) => JSON.stringify(t.json)).join("\n");
  const obs: Observation = { turns: out.turns, alive: out.alive, appExited: out.appExited, target: o.target, sentText, message: c.spec.message, context: c.spec.context, systemPrompts: o.systemPrompts, answerSource: c.answerSource };
  const graded = grade(obs, c.graders);
  const chat = out.turns.flatMap((t) => t.model.filter((m) => /\/chat\/completions$/.test(m.path)));
  const sample: AiCaseSample = {
    sample: index + 1,
    mode: c.mode,
    turns: out.turns.map((t, i) => {
      const reply = replyText(t, o.target);
      return { as: c.turns[i]?.as ?? null, request: `${c.turns[i]?.method ?? "POST"} ${c.turns[i]?.path ?? ""} (${i === out.turns.length - 1 ? c.spec.inputClass : "earlier turn"})`, status: t.status, ms: t.ms, reply: reply === null ? null : redactText(reply, [REPLAY_KEY], 2000), error: t.error };
    }),
    modelRequests: chat.length,
    tokens: c.mode === "live" ? { input: chat.reduce((n, m) => n + (m.inputTokens ?? 0), 0), output: chat.reduce((n, m) => n + (m.outputTokens ?? 0), 0) } : { input: chat.reduce((n, m) => n + estTokens(m.body), 0), output: out.turns.reduce((n, t) => n + estTokens(replyText(t, o.target) ?? ""), 0) },
    costUsd: c.mode === "replay" ? 0 : c.mode === "live" ? chat.reduce((n, m) => n + (m.costUsd ?? 0), 0) : null,
    toolCalls: (toolTraceOf(out.turns.at(-1), o.target) ?? []).map((x) => ({ name: x.name, args: redactText(x.args, [], 300) })),
    citations: (citationsOf(out.turns.at(-1), o.target) ?? []).map((x) => redactText(x, [], 200)),
  };
  // Whether this sample's model traffic actually reached the real provider (live mode): the gateway marks each
  // request "forwarded" on a 2xx from upstream, or "upstream <code>" / "budget" / "error ..." on a failure.
  const forwarded = chat.filter((m) => m.served === "forwarded").length;
  const failDetail = chat.find((m) => m.served && m.served !== "forwarded")?.served ?? null;
  return { graded, sample, ms: out.turns.filter((t) => t.status != null).map((t) => t.ms), modelCalls: chat.length, forwarded, failDetail };
}

/**
 * Turn the harness's observation of one compiled case into a graded case record. A case may have several samples
 * (for a stochastic live case); they are graded independently and aggregated (any hard failure fails, otherwise a
 * majority, and disagreement is inconclusive).
 */
export function gradeCase(c: CompiledCase, outs: Array<HarnessAiCase | undefined>, o: { profile: AiEvaluationPolicyInput["profile"]; target: AiEvaluationTarget; systemPrompts: string[]; signedIn: Set<string>; executionIds: string[]; replayUp: boolean; evidence: AiEvaluationCase["sourceEvidence"] }): AiEvaluationCase {
  const base = unsentCase(c.spec, c.seq, { componentId: c.componentId, endpoint: c.endpoint, mode: c.mode }, o.profile, "", o.evidence);
  const who = c.turns[0]?.as ?? null;
  const preconditions = [...(who ? [{ what: `Signed in as ${who}`, met: o.signedIn.has(who) }] : []), ...(c.mode === "replay" ? [{ what: "The replay model was listening", met: o.replayUp }] : [])];
  const common = { ...base, seq: c.seq, samplesPlanned: c.samples, preconditions, limitations: c.limitations, oracle: { type: c.graders.filter((g) => g.hard && !["no_credential", "no_prompt_echo", "no_canary", "no_pii"].includes(g.id)).map((g) => g.id).join(", "), expected: c.spec.expectedText } };
  const ran = outs.filter((x): x is HarnessAiCase => Boolean(x) && !x!.blocked);
  if (!ran.length) {
    const first = outs.find(Boolean);
    return { ...common, reason: first?.blocked ? `Not sent: ${first.blocked.note}.` : "The harness did not return a result for this case (the run stopped early)." };
  }
  const graded = ran.map((out, i) => gradeSample(c, out, o, i));
  const agg = aggregateSamples(graded.map((g) => g.graded));
  const samples = graded.map(({ sample }) => sample);
  const allMs = graded.flatMap((g) => g.ms);
  const stability = c.samples > 1 ? [`Ran ${ran.length} of ${c.samples} sample(s)${agg.stable ? ", which agreed" : "; the samples did not all agree"}.`] : [];
  // A live case whose model calls all failed at the gateway's upstream (for example the provider is out of credits)
  // could not be exercised: that is an environment problem, not an app defect, so the case is blocked, never graded as
  // an AI-quality failure against the app.
  const modelCalls = graded.reduce((n, g) => n + g.modelCalls, 0);
  const forwarded = graded.reduce((n, g) => n + g.forwarded, 0);
  const providerFailed = c.mode === "live" && modelCalls > 0 && forwarded === 0;
  const failDetail = graded.map((g) => g.failDetail).find(Boolean) ?? "no response";
  return {
    ...common,
    graders: agg.graders.map(({ id: _id, hygiene: _h, ...g }) => ({ ...g, detail: redactText(g.detail, [], 500) })),
    samples,
    measurements: { medianMs: median(allMs), maxMs: allMs.length ? Math.max(...allMs) : null, tokensIn: samples.reduce((n, s) => n + s.tokens.input, 0), tokensOut: samples.reduce((n, s) => n + s.tokens.output, 0), costUsd: c.mode === "replay" ? 0 : c.mode === "live" ? samples.reduce((n, s) => n + (s.costUsd ?? 0), 0) : null, modelRequests: samples.reduce((n, s) => n + s.modelRequests, 0) },
    executionIds: o.executionIds,
    verdict: providerFailed ? "blocked" : agg.verdict,
    reason: providerFailed ? `The live model provider did not answer (${failDetail}), so the case could not be exercised and no conclusion is drawn about the app.` : agg.reason,
    limitations: [...c.limitations, ...stability, ...(providerFailed ? ["The live model provider returned an error for this case, so it was left blocked."] : [])],
  };
}

export async function runAiCases(ctx: Ctx, input: { d: ProjectDossier; src: SnapshotSource; archive: Buffer; applicability: AiApplicability; policy: AiEvaluationPolicyInput; datasets: DatasetIn[]; onlyCaseIds?: string[]; judge?: { provider: JudgeProvider; calibration: Calibration } | null; baseline?: { runId: string; byId: Map<string, { reply: string | null }> } | null; onEvent: (msg: string) => Promise<void> }): Promise<AiRunResult> {
  const { d, src, applicability, policy } = input;
  const gatewayStatus = liveGatewayStatus();
  const plans = planComponents(applicability, policy, gatewayStatus);
  const untested: AiRunResult["untested"] = [];
  const cases: AiEvaluationCase[] = [];
  const runLimitations: string[] = [];
  let identityCount = 0;
  const result = (extra: Partial<AiRunResult>): AiRunResult => (cases.sort((a, b) => a.seq - b.seq), uniqueIds(cases), { cases, plans, appBooted: false, bootNote: "", untested, executionIds: [], identities: identityCount, limitations: runLimitations, judge: null, gateway: gatewayStatus, pairwise: null, targetValidation: null, liveProviderError: null, modes: [...new Set(plans.map((p) => p.mode).filter((m): m is AiExecutionMode => Boolean(m)))], ...extra });
  for (const p of plans) if (!p.mode) untested.push({ what: `${p.component.name} (${p.target.method ?? "POST"} ${p.target.path})`, reason: p.reason });

  // Identities from the project's seeded accounts, signed in through its own login route.
  const loginEp = d.entryPoints.find((e) => /(^|\/)(log-?in|sign-?in|auth\/login|session)(\/|$)/i.test(e.path) && e.method === "POST");
  const accounts = seededAccounts(src);
  const login = loginEp && accounts.length ? { method: loginEp.method, path: loginEp.path, accountField: accounts[0]!.accountField, passwordField: accounts[0]!.passwordField } : null;
  const { identities, nodes: idNodes } = login ? buildIdentities(src, login, d) : { identities: [], nodes: [] };
  const names = identities.map((i) => i.name);
  identityCount = names.length;
  const isAdmin = (r: string | null) => /admin|superuser|root|owner|staff/i.test(r ?? "");
  const members = identities.filter((i) => !isAdmin(i.role));
  const admins = identities.filter((i) => isAdmin(i.role));
  const roleMap = { a: members[0]?.name, b: members[1]?.name, admin: admins[0]?.name };
  const roles = { a: Boolean(members[0]), b: Boolean(members[1]), admin: Boolean(admins[0]) };

  // Compile every runnable component's cases.
  const endpoints = endpointKeys(d);
  const compiled: Array<{ plan: ComponentPlan; c: CompiledCase; prompts: string[] }> = [];
  let seq = 0;
  for (const p of plans) {
    if (!p.mode) continue;
    const endpoint = `${p.target.method ?? "POST"} ${p.target.path}`;
    const aux = applicability.targets.find((tt) => tt.target.componentId === p.component.id)?.auxiliary;
    const historyPath = p.target.historyPath ?? aux?.historyPath ?? undefined;
    const ordersPath = aux?.listPaths?.[0] ?? undefined;
    const built = builtinCases({ mode: p.mode, profile: policy.profile, hasCitations: Boolean(p.target.citationSelector), hasHistory: Boolean(historyPath), hasOrders: Boolean(ordersPath), hasTools: p.component.tools.length + p.component.messageTriggers.length > 0, roles });
    for (const s of built.skipped) untested.push({ what: `${s.id} (${p.component.name})`, reason: s.reason });
    const repo = extractRepositoryCases(src, { target: p.target, routePaths: [p.target.path, ...p.component.endpoints.map((e) => e.split(" ").pop() ?? "")] });
    for (const l of repo.limitations) if (!runLimitations.includes(l)) runLimitations.push(l);
    if (!repo.cases.length) untested.push({ what: `Repository-derived cases (${p.component.name})`, reason: "No message-and-expectation pair that calls the AI route was found in the project's tests or documentation." });
    let specs: CaseSpec[] = [...built.cases, ...repo.cases, ...input.datasets.flatMap((ds) => ds.cases.map((c) => fromDataset(c, ds)))];
    // A rerun sends only the chosen cases (ids as stored: maybe prefixed by the component, maybe suffixed by #seq).
    if (input.onlyCaseIds) {
      const want = new Set(input.onlyCaseIds.map((id) => id.replace(/^ai:\d+\//, "").replace(/#\d+$/, "")));
      specs = specs.filter((s) => want.has(s.id));
    }
    const identity = resolveIdentity(p.target.authFixture, names);
    const r = compileCases(specs, { target: p.target, component: p.component, mode: p.mode, profile: policy.profile, endpoints, identities: names, identity, roleMap, auxPaths: { history: historyPath, orders: ordersPath } });
    const prompts = promptTextsFrom(src, p.component.systemPrompts);
    for (const x of r.skipped) untested.push({ what: `${x.id} (${p.component.name})`, reason: x.reason });
    const ev = p.component.evidence.slice(0, 3);
    for (const x of r.rejected) cases.push(unsentCase(specs.find((s) => s.id === x.id)!, ++seq, { componentId: p.component.id, endpoint, mode: p.mode }, policy.profile, `Refused by the safety gate: ${x.reasons.join("; ")}.`, ev));
    for (const x of r.overBudget) cases.push(unsentCase(x.spec, ++seq, { componentId: p.component.id, endpoint, mode: p.mode }, policy.profile, x.reason, ev));
    for (const c of r.cases) compiled.push({ plan: p, c: { ...c, seq: ++seq }, prompts });
    if (r.rejected.length) await input.onEvent(`${r.rejected.length} case(s) for ${p.component.name} were refused by the safety gate: ${r.rejected[0]!.reasons[0]}`);
  }
  if (!compiled.length) return result({ bootNote: "No case could be compiled for any component." });

  // Boot the app once and run every case in one sandbox, network off.
  const workspaces = planWorkspaces(d, src);
  const boot = await planBoot(null, d, src, workspaces);
  const app = boot.apps[0];
  const notRun = (why: string) => {
    for (const x of compiled) cases.push(unsentCase(x.c.spec, x.c.seq, { componentId: x.c.componentId, endpoint: x.c.endpoint, mode: x.c.mode }, policy.profile, why, x.plan.component.evidence.slice(0, 3)));
    return result({ bootNote: why });
  };
  if (!app) return notRun("No startable app was found.");
  const ws = workspaces.find((w) => w.dir === app.workspace);
  const image = await prepareApp(ctx, input.archive, app.prepare.length || ws?.install ? { dir: app.workspace, command: ws?.install?.command ?? "npm install" } : null, undefined, "ai_eval_app");
  if (!image) return notRun("The app could not be prepared in the sandbox.");

  const extra: Record<string, string> = {};
  const usesReplay = compiled.some((x) => x.c.mode === "replay");
  for (const p of plans) {
    const to = p.mode === "replay" ? `http://127.0.0.1:${REPLAY_PORT}/v1` : null;
    if (!to) continue;
    for (const n of p.component.provider.baseUrlEnv) extra[n] = to;
    for (const n of p.component.provider.apiKeyEnv) extra[n] = REPLAY_KEY;
  }
  // One harness case per sample; each sample gets its own conversation (a fresh $uid in the harness).
  const sampleId = (c: CompiledCase, i: number) => `${c.spec.id}#${c.seq}.${i}`;
  const limits = AI_PROFILE_LIMITS[policy.profile];
  const aiCaseSpecs = compiled.flatMap(({ c }) =>
    Array.from({ length: c.samples }, (_v, i) => ({ id: sampleId(c, i), needs: [...new Set(c.turns.map((t) => t.as).filter((x): x is string => Boolean(x)))], alivePath: app.readyPath ?? "/", turns: c.turns.map((t) => ({ method: t.method, path: t.path, json: t.json, as: t.as, replay: t.replay, timeoutMs: t.timeoutMs, ...(t.capture ? { capture: t.capture } : {}) })) })),
  );
  const aiSpec: HarnessAiSpec = {
    aiCases: aiCaseSpecs,
    replay: usesReplay ? { port: REPLAY_PORT } : null,
    // The profile's time budget bounds the whole run; the harness stops starting new cases once it is reached.
    timeoutSec: Math.min(limits.timeoutSec, 120 + Math.ceil(aiCaseSpecs.reduce((n, x) => n + x.turns.reduce((m, t) => m + t.timeoutMs, 0), 0) / 1000)),
    deadlineMs: limits.timeoutSec * 1000,
    maxModelRequests: Math.max(50, limits.cases * limits.samples * 6),
  };
  const graph: FixtureNode[] = [...bootGraph(app, (applies) => verifyTarget(d, applies)), ...idNodes];
  await input.onEvent(`Booting the app and running ${compiled.length} case(s)${usesReplay ? " against the replay model" : ""} as ${names.length ? names.join(", ") : "an anonymous user"} (network off)`);
  const r = await runHarness(ctx, image, app, graph, [], `Run ${compiled.length} AI evaluation case(s) against the running app`, null, extra, [], undefined, aiSpec);
  const signedIn = new Set((r.out?.identities ?? []).filter((x) => x.ok).map((x) => x.name));
  const byId = new Map((r.out?.aiCases ?? []).map((x) => [x.id, x]));
  const graded = compiled.map(({ plan, c, prompts }) => {
    const outs = Array.from({ length: c.samples }, (_v, i) => byId.get(sampleId(c, i)));
    return { c, record: gradeCase(c, outs, { profile: policy.profile, target: plan.target, systemPrompts: prompts, signedIn, executionIds: [r.exec.id], replayUp: Boolean(r.out) && !r.out?.replayError, evidence: plan.component.evidence.slice(0, 3) }) };
  });
  // The judge settles cases the deterministic checks left inconclusive (and only those), after they have run.
  let judgeInfo: AiRunResult["judge"] = null;
  if (input.judge) {
    let calls = 0;
    let scored = 0;
    const samples = AI_PROFILE_LIMITS[policy.profile].samples;
    for (const { c, record } of graded) {
      if (record.verdict !== "inconclusive" || !record.samples.length) continue;
      const out = await judgeCase({ case: record, expected: c.spec.expected.answer ?? c.spec.expectedText, context: c.spec.context, samples }, input.judge.provider, input.judge.calibration.passed);
      if (!out.results.length) continue;
      calls += out.results.length;
      scored++;
      record.judge = out.results;
      // The judge never overrides a deterministic pass or fail; it only settles an inconclusive case, and only when
      // calibrated. An uncalibrated judge is informational and the case stays inconclusive.
      if (input.judge.calibration.passed && out.judgePass !== null) {
        record.evaluator = "judge";
        record.verdict = out.judgePass ? "passed" : "failed";
        record.reason = `Judged by a calibrated model (median score ${out.medianScore} of 4 over ${out.results.length} sample(s)): ${out.judgePass ? "meets the criterion" : "does not meet the criterion"}.`;
      } else {
        record.limitations = [...record.limitations, input.judge.calibration.passed ? "The judge could not settle this case (its samples were missing or disagreed)." : "The judge is not calibrated for this run, so its scores are informational and the case stays inconclusive."];
      }
    }
    judgeInfo = { calls, scored, provider: input.judge.provider.name, model: input.judge.provider.model };
  }
  // Pairwise regression: compare each case's answer with the same case in a baseline run (a calibrated judge only).
  let pairwiseInfo: AiRunResult["pairwise"] = null;
  if (input.baseline && input.judge?.calibration.passed) {
    const compiledById = new Map(graded.map(({ c, record }) => [record.id, c]));
    const cmp = await comparePairwise(graded.map((g) => g.record), input.baseline.byId, input.judge.provider, { expectedOf: (rc) => compiledById.get(rc.id)?.spec.expected.answer ?? rc.oracle.expected, contextOf: (rc) => compiledById.get(rc.id)?.spec.context ?? [] });
    for (const { record } of graded) {
      const pw = cmp.byCase.get(record.id);
      if (pw) record.judge = [...record.judge, pw];
    }
    pairwiseInfo = { ...cmp.summary, baselineRunId: input.baseline.runId, note: `Compared ${cmp.summary.compared} case(s) with the baseline run; ${cmp.summary.better} better, ${cmp.summary.worse} worse, ${cmp.summary.tie} tied.` };
  } else if (input.baseline) {
    pairwiseInfo = { better: 0, worse: 0, tie: 0, undecided: 0, compared: 0, baselineRunId: input.baseline.runId, note: "A baseline was chosen but no calibrated judge was available, so a pairwise comparison could not be made." };
  }
  for (const { record } of graded) cases.push(record);
  if (r.out?.aiBudget?.overBudget) untested.push({ what: "Cases stopped for the profile budget", reason: `The ${policy.profile} profile's time or model-request budget was reached (${r.out.aiBudget.modelRequests} model request(s)); completed cases were kept and the rest left blocked.` });
  const bootNote = !r.out ? "The app did not boot." : !r.out.boot.ok ? `The app did not start: ${r.out.boot.reason ?? "no reason given"}.` : `The app started; signed in: ${[...signedIn].join(", ") || "nobody"}.${r.out.replayError ? ` The replay model could not listen (${r.out.replayError}).` : ""}`;
  // Validate the bound target's selectors against a real response: the first case whose last turn answered 2xx.
  const boundTarget = applicability.targets[0];
  let targetValidation: AiRunResult["targetValidation"] = null;
  if (boundTarget) {
    // The first turn that reached the target route and answered 2xx is the live probe for selector validation.
    const okTurn = compiled
      .flatMap((x) => (byId.get(sampleId(x.c, 0))?.turns ?? []).filter((t) => t.status != null && t.status >= 200 && t.status < 300))
      .find((t) => replyText(t, boundTarget.target) !== null) ?? compiled.flatMap((x) => byId.get(sampleId(x.c, 0))?.turns ?? []).find((t) => t.status != null && t.status >= 200 && t.status < 300);
    targetValidation = validateTarget(boundTarget.target, boundTarget.boundBy, okTurn);
  }
  // If every live model call failed at the gateway's upstream (for example the provider is out of credits), the live
  // run could not exercise the model: that is an environment block, not evidence about the app.
  const liveModel = compiled
    .filter((x) => x.c.mode === "live")
    .flatMap((x) => Array.from({ length: x.c.samples }, (_v, i) => byId.get(sampleId(x.c, i))))
    .filter((o): o is HarnessAiCase => Boolean(o))
    .flatMap((o) => o.turns.flatMap((t) => t.model.filter((m) => /\/chat\/completions$/.test(m.path))));
  const liveFailDetail = liveModel.find((m) => m.served !== "forwarded")?.served ?? "no response";
  const liveProviderError = liveModel.length > 0 && !liveModel.some((m) => m.served === "forwarded") ? `cybercheck's gateway reached the live provider but every model call failed (${liveFailDetail}); the live cases could not be exercised` : null;
  if (liveProviderError) untested.push({ what: "Live model cases", reason: `The live model provider did not answer any call (${liveFailDetail}), typically because it is out of credits. The gateway handled it cleanly as a server error and no case was graded against the app.` });
  return result({ appBooted: Boolean(r.out?.boot.ok), bootNote, executionIds: [r.exec.id], targetValidation, judge: judgeInfo, pairwise: pairwiseInfo, liveProviderError });
}
