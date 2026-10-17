import type { AiApplicability, AiCaseSample, AiComponentInventory, AiDatasetCase, AiEvaluationCase, AiEvaluationPolicyInput, AiEvaluationTarget, AiExecutionMode, ProjectDossier } from "@cybercheck/contracts";
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
import { citationsOf, grade, promptTextsFrom, replyText, toolTraceOf, verdictOf, type Observation } from "./graders.ts";
import { redactText } from "./redact.ts";

// Runs the AI Evaluator's compiled cases against the project's own app, booted once inside the sandbox with the
// Testing runtime (the single execution authority), network off. A component whose model traffic goes through a
// configurable base URL is pointed at the harness's loopback replay model; a component with no model is called directly.
// Nothing reaches a real provider, so no model credit is used.

export const REPLAY_PORT = 8098;
const REPLAY_KEY = "cc-replay-key-not-a-secret";

export type ComponentPlan = { component: AiComponentInventory; target: AiEvaluationTarget; mode: AiExecutionMode | null; reason: string };

/** How each bound component can be exercised in this run (null mode: it cannot be, with the reason). */
export function planComponents(a: AiApplicability, policy: Pick<AiEvaluationPolicyInput, "modelMode">): ComponentPlan[] {
  return a.targets.map(({ target }) => {
    const component = a.components.find((c) => c.id === target.componentId)!;
    if (component.kind === "local_logic") return { component, target, mode: "direct", reason: "The component calls no model provider, so its route is called directly." };
    if (policy.modelMode === "live") return { component, target, mode: null, reason: "Live mode needs cybercheck's restricted model gateway, which is not available in this engine version." };
    if (!component.provider.interceptable || component.provider.family !== "openai_compatible" || !component.provider.baseUrlEnv.length) {
      return { component, target, mode: null, reason: component.provider.reason ?? `The ${component.provider.name ?? "model provider"} traffic cannot be routed to the replay model (it needs an OpenAI-compatible client with a configurable base URL).` };
    }
    return { component, target, mode: "replay", reason: `Model calls go to cybercheck's replay model through ${component.provider.baseUrlEnv.join(", ")}.` };
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
};

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

/** Turn the harness's observation of one compiled case into a graded case record. */
export function gradeCase(c: CompiledCase, out: HarnessAiCase | undefined, o: { profile: AiEvaluationPolicyInput["profile"]; target: AiEvaluationTarget; systemPrompts: string[]; signedIn: Set<string>; executionIds: string[]; replayUp: boolean; evidence: AiEvaluationCase["sourceEvidence"] }): AiEvaluationCase {
  const base = unsentCase(c.spec, c.seq, { componentId: c.componentId, endpoint: c.endpoint, mode: c.mode }, o.profile, "", o.evidence);
  const who = c.turns[0]?.as ?? null;
  const preconditions = [...(who ? [{ what: `Signed in as ${who}`, met: o.signedIn.has(who) }] : []), ...(c.mode === "replay" ? [{ what: "The replay model was listening", met: o.replayUp }] : [])];
  const common = { ...base, seq: c.seq, preconditions, limitations: c.limitations, oracle: { type: c.graders.filter((g) => g.hard && !["no_credential", "no_prompt_echo", "no_canary", "no_pii"].includes(g.id)).map((g) => g.id).join(", "), expected: c.spec.expectedText } };
  if (!out) return { ...common, reason: "The harness did not return a result for this case (the run stopped early)." };
  if (out.blocked) return { ...common, reason: `Not sent: ${out.blocked.note}.` };
  const sentText = c.turns.map((t) => JSON.stringify(t.json)).join("\n");
  const obs: Observation = { turns: out.turns, alive: out.alive, appExited: out.appExited, target: o.target, sentText, message: c.spec.message, context: c.spec.context, systemPrompts: o.systemPrompts, answerSource: c.answerSource };
  const graders = grade(obs, c.graders);
  const { verdict, reason } = verdictOf(graders);
  const chat = out.turns.flatMap((t) => t.model.filter((m) => /\/chat\/completions$/.test(m.path)));
  const ms = out.turns.filter((t) => t.status != null).map((t) => t.ms);
  const sample: AiCaseSample = {
    sample: 1,
    mode: c.mode,
    turns: out.turns.map((t, i) => {
      const reply = replyText(t, o.target);
      return { as: c.turns[i]?.as ?? null, request: `${c.turns[i]?.method ?? "POST"} ${c.turns[i]?.path ?? ""} (${i === out.turns.length - 1 ? c.spec.inputClass : "earlier turn"})`, status: t.status, ms: t.ms, reply: reply === null ? null : redactText(reply, [REPLAY_KEY], 2000), error: t.error };
    }),
    modelRequests: chat.length,
    tokens: { input: chat.reduce((n, m) => n + estTokens(m.body), 0), output: out.turns.reduce((n, t) => n + estTokens(replyText(t, o.target) ?? ""), 0) },
    costUsd: c.mode === "replay" ? 0 : null,
    toolCalls: (toolTraceOf(out.turns.at(-1), o.target) ?? []).map((x) => ({ name: x.name, args: redactText(x.args, [], 300) })),
    citations: (citationsOf(out.turns.at(-1), o.target) ?? []).map((x) => redactText(x, [], 200)),
  };
  return {
    ...common,
    graders: graders.map(({ id: _id, hygiene: _h, ...g }) => ({ ...g, detail: redactText(g.detail, [], 500) })),
    samples: [sample],
    measurements: { medianMs: median(ms), maxMs: ms.length ? Math.max(...ms) : null, tokensIn: sample.tokens.input, tokensOut: sample.tokens.output, costUsd: sample.costUsd, modelRequests: chat.length },
    executionIds: o.executionIds,
    verdict,
    reason,
  };
}

export async function runAiCases(ctx: Ctx, input: { d: ProjectDossier; src: SnapshotSource; archive: Buffer; applicability: AiApplicability; policy: AiEvaluationPolicyInput; datasets: DatasetIn[]; onlyCaseIds?: string[]; onEvent: (msg: string) => Promise<void> }): Promise<AiRunResult> {
  const { d, src, applicability, policy } = input;
  const plans = planComponents(applicability, policy);
  const untested: AiRunResult["untested"] = [];
  const cases: AiEvaluationCase[] = [];
  const result = (extra: Partial<AiRunResult>): AiRunResult => (cases.sort((a, b) => a.seq - b.seq), uniqueIds(cases), { cases, plans, appBooted: false, bootNote: "", untested, executionIds: [], modes: [...new Set(plans.map((p) => p.mode).filter((m): m is AiExecutionMode => Boolean(m)))], ...extra });
  for (const p of plans) if (!p.mode) untested.push({ what: `${p.component.name} (${p.target.method ?? "POST"} ${p.target.path})`, reason: p.reason });
  untested.push({ what: "Repository-derived cases", reason: "Cases from the project's own tests, examples and documentation are not built in this engine version." });
  untested.push({ what: "Prompt injection, extraction, cross-tenant and tool-permission cases", reason: "The adversarial built-in catalogue is not part of this engine version; uploaded cases in those categories still run." });

  // Identities from the project's seeded accounts, signed in through its own login route.
  const loginEp = d.entryPoints.find((e) => /(^|\/)(log-?in|sign-?in|auth\/login|session)(\/|$)/i.test(e.path) && e.method === "POST");
  const accounts = seededAccounts(src);
  const login = loginEp && accounts.length ? { method: loginEp.method, path: loginEp.path, accountField: accounts[0]!.accountField, passwordField: accounts[0]!.passwordField } : null;
  const { identities, nodes: idNodes } = login ? buildIdentities(src, login, d) : { identities: [], nodes: [] };
  const names = identities.map((i) => i.name);

  // Compile every runnable component's cases.
  const endpoints = endpointKeys(d);
  const compiled: Array<{ plan: ComponentPlan; c: CompiledCase; prompts: string[] }> = [];
  let seq = 0;
  for (const p of plans) {
    if (!p.mode) continue;
    const endpoint = `${p.target.method ?? "POST"} ${p.target.path}`;
    const built = builtinCases({ mode: p.mode, profile: policy.profile, hasCitations: Boolean(p.target.citationSelector) });
    for (const s of built.skipped) untested.push({ what: `${s.id} (${p.component.name})`, reason: s.reason });
    let specs: CaseSpec[] = [...built.cases, ...input.datasets.flatMap((ds) => ds.cases.map((c) => fromDataset(c, ds)))];
    // A rerun sends only the chosen cases (ids as stored: maybe prefixed by the component, maybe suffixed by #seq).
    if (input.onlyCaseIds) {
      const want = new Set(input.onlyCaseIds.map((id) => id.replace(/^ai:\d+\//, "").replace(/#\d+$/, "")));
      specs = specs.filter((s) => want.has(s.id));
    }
    const identity = resolveIdentity(p.target.authFixture, names);
    const r = compileCases(specs, { target: p.target, component: p.component, mode: p.mode, profile: policy.profile, endpoints, identities: names, identity });
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
  const image = await prepareApp(ctx, input.archive, app.prepare.length || ws?.install ? { dir: app.workspace, command: ws?.install?.command ?? "npm install" } : null);
  if (!image) return notRun("The app could not be prepared in the sandbox.");

  const extra: Record<string, string> = {};
  for (const p of plans) {
    if (p.mode !== "replay") continue;
    for (const n of p.component.provider.baseUrlEnv) extra[n] = `http://127.0.0.1:${REPLAY_PORT}/v1`;
    for (const n of p.component.provider.apiKeyEnv) extra[n] = REPLAY_KEY;
  }
  const usesReplay = compiled.some((x) => x.c.mode === "replay");
  const aiSpec: HarnessAiSpec = {
    aiCases: compiled.map(({ c }) => ({ id: c.spec.id + `#${c.seq}`, needs: [...new Set(c.turns.map((t) => t.as).filter((x): x is string => Boolean(x)))], alivePath: app.readyPath ?? "/", turns: c.turns.map((t) => ({ method: t.method, path: t.path, json: t.json, as: t.as, replay: t.replay, timeoutMs: t.timeoutMs, ...(t.capture ? { capture: t.capture } : {}) })) })),
    replay: usesReplay ? { port: REPLAY_PORT } : null,
    timeoutSec: Math.min(3600, 120 + Math.ceil(compiled.reduce((n, x) => n + x.c.turns.reduce((m, t) => m + t.timeoutMs, 0), 0) / 1000)),
  };
  const graph: FixtureNode[] = [...bootGraph(app, (applies) => verifyTarget(d, applies)), ...idNodes];
  await input.onEvent(`Booting the app and running ${compiled.length} case(s)${usesReplay ? " against the replay model" : ""} as ${names.length ? names.join(", ") : "an anonymous user"} (network off)`);
  const r = await runHarness(ctx, image, app, graph, [], `Run ${compiled.length} AI evaluation case(s) against the running app`, null, extra, [], undefined, aiSpec);
  const signedIn = new Set((r.out?.identities ?? []).filter((x) => x.ok).map((x) => x.name));
  const byId = new Map((r.out?.aiCases ?? []).map((x) => [x.id, x]));
  for (const { plan, c, prompts } of compiled) {
    cases.push(gradeCase(c, byId.get(c.spec.id + `#${c.seq}`), { profile: policy.profile, target: plan.target, systemPrompts: prompts, signedIn, executionIds: [r.exec.id], replayUp: Boolean(r.out) && !r.out?.replayError, evidence: plan.component.evidence.slice(0, 3) }));
  }
  const bootNote = !r.out ? "The app did not boot." : !r.out.boot.ok ? `The app did not start: ${r.out.boot.reason ?? "no reason given"}.` : `The app started; signed in: ${[...signedIn].join(", ") || "nobody"}.${r.out.replayError ? ` The replay model could not listen (${r.out.replayError}).` : ""}`;
  return result({ appBooted: Boolean(r.out?.boot.ok), bootNote, executionIds: [r.exec.id] });
}
