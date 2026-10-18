import { AI_PROFILE_LIMITS, AiDatasetCase, AiGraderId, type AiComponentInventory, type AiDatasetExpected, type AiEvaluationProfile, type AiEvaluationTarget, type AiExecutionMode, type AiReplayTurn } from "@cybercheck/contracts";
import { pathMatchesRoute } from "../security/proofs/compiler.ts";
import type { CaseSpec, GraderSpec } from "./catalog.ts";
import { contentProblems } from "./datasets.ts";

// The AI Evaluator case compiler and safety validator. Every case (built-in or uploaded) becomes a short, typed
// conversation with ONE bound target route, sent as a known identity, graded only by catalogued graders. A case that
// breaks a rule is refused with its reasons and never sent. Nothing here trusts the dataset or the project: the
// endpoint, identity, tool and selectors must all be known, there are no commands, callbacks or real secrets, turns
// and tool loops are bounded, and the answer key never reaches the application.

export const AI_CASE_LIMITS = { maxTurns: 11, maxRequestsPerCase: 11, maxTimeoutMs: 60_000 };

/** Hygiene graders run passively on every reply of every case (they read the reply; nothing extra is sent). */
export const HYGIENE: GraderSpec[] = [
  { id: "no_credential", hard: true },
  { id: "no_prompt_echo", hard: true },
  { id: "no_canary", hard: true },
  { id: "no_pii", hard: true },
];

/** Graders that read the answer's content. In replay without a scripted answer they cannot decide anything. */
export const CONTENT_GRADERS = new Set<GraderSpec["id"]>(["answer_match", "contains", "excludes", "regex", "json_schema", "number", "refusal", "citation_context", "answer_support", "tool_name"]);

export type CompiledTurn = { as: string | null; method: "GET" | "POST"; path: string; json?: Record<string, unknown>; replay: AiReplayTurn[] | null; timeoutMs: number; capture?: { name: string; path: string } };

export type CompiledCase = {
  spec: CaseSpec;
  seq: number;
  componentId: string;
  endpoint: string;
  mode: AiExecutionMode;
  turns: CompiledTurn[];
  graders: GraderSpec[];
  /** Where the final answer comes from: scripted by the case, the replay default, or the component itself (direct). */
  answerSource: "scripted" | "replay_default" | "component";
  samples: number;
  reset: "fresh_conversation";
  limitations: string[];
};

export type CaseRejection = { id: string; reasons: string[] };
export type CompileResult = { cases: CompiledCase[]; rejected: CaseRejection[]; overBudget: Array<{ id: string; spec: CaseSpec; reason: string }>; skipped: Array<{ id: string; reason: string }> };

export type CompileContext = {
  target: AiEvaluationTarget;
  component: AiComponentInventory;
  mode: AiExecutionMode;
  profile: AiEvaluationProfile;
  /** Route keys of the project ("POST /api/assistant"). */
  endpoints: Set<string>;
  /** Identity names the run can sign in as. */
  identities: string[];
  /** The target's auth fixture resolved to one of `identities` (null: the route needs no sign-in). */
  identity: string | null;
  /** Seeded identity roles resolved to names: "a"/"b" two distinct members, "admin" an admin. */
  roleMap?: { a?: string; b?: string; admin?: string };
  /** Auxiliary read endpoints a safety case may probe (from the bound target's auxiliary routes). */
  auxPaths?: { history?: string; orders?: string };
};

const SELECTOR = /^\$?\.?[\w-]+(\.[\w-]+|\[\d+\])*$/;
const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 } as const;

/**
 * How many times to run a case. A deterministic replay or direct case runs once (its answer is scripted or the
 * component is local, so repeats are identical). A subjective case (one a judge would settle, such as a semantic
 * answer match) run live uses the profile's sample count, because a real model's answer varies between calls.
 */
export function samplesFor(mode: AiExecutionMode, subjective: boolean, profile: AiEvaluationProfile): number {
  return mode === "live" && subjective ? AI_PROFILE_LIMITS[profile].samples : 1;
}

/** A case needs a judge (is subjective) when its only answer check is a semantic match, not a literal one. */
function isSubjective(graders: GraderSpec[]): boolean {
  const content = graders.filter((g) => CONTENT_GRADERS.has(g.id));
  return content.length > 0 && content.every((g) => g.id === "answer_match" || g.id === "answer_support");
}

/** Every grader an uploaded case's expectations call for. */
export function gradersFor(e: AiDatasetExpected, context: string[]): GraderSpec[] {
  const out: GraderSpec[] = [{ id: "reply_present", hard: true }];
  if (e.answer !== null) out.push({ id: "answer_match", hard: false, params: { answer: e.answer } });
  if (e.contains.length) out.push({ id: "contains", hard: true, params: { values: e.contains } });
  if (e.excludes.length) out.push({ id: "excludes", hard: true, params: { values: e.excludes } });
  if (e.regex !== null) out.push({ id: "regex", hard: true, params: { pattern: e.regex } });
  if (e.jsonSchema) out.push({ id: "json_schema", hard: true, params: { schema: e.jsonSchema } });
  if (e.number) out.push({ id: "number", hard: true, params: e.number });
  if (e.refusal !== null) out.push({ id: "refusal", hard: true, params: { expected: e.refusal } });
  if (e.citations.length) out.push({ id: "citation_context", hard: true, params: { indexes: e.citations } });
  if (context.length && (e.answer !== null || e.citations.length)) out.push({ id: "answer_support", hard: false });
  if (e.tool !== null) out.push({ id: "tool_name", hard: true, params: { name: e.tool } });
  return out;
}

/** An uploaded dataset case as a case spec. */
export function fromDataset(c: AiDatasetCase, ds: { id: string; version: number; digest: string; name: string }): CaseSpec {
  const { message, ...extra } = c.input;
  const what = [c.expected.contains.length && "contains the expected text", c.expected.excludes.length && "avoids the excluded text", c.expected.regex && "matches the expected pattern", c.expected.jsonSchema && "matches the JSON schema", c.expected.number && "gives the expected number", c.expected.refusal === true && "declines or says it does not know", c.expected.refusal === false && "answers instead of declining", c.expected.citations.length && "cites the expected passages", c.expected.tool && `uses the ${c.expected.tool} tool`, c.expected.answer && "gives the expected answer"].filter(Boolean);
  return {
    id: c.id,
    category: c.category,
    priority: c.priority,
    tags: c.tags,
    title: `${ds.name}: ${c.id}`,
    inputClass: `uploaded ${c.category.replace("_", " ")} case${c.conversation.length ? ` after ${c.conversation.length} earlier turn(s)` : ""}`,
    source: { kind: "uploaded", datasetId: ds.id, version: String(ds.version), digest: ds.digest },
    message,
    extra,
    conversation: c.conversation.map((t) => t.content),
    context: c.context,
    replay: c.replay,
    expected: c.expected,
    expectedText: what.length ? `The reply ${what.join(", ")}.` : "The reply is present.",
    graders: gradersFor(c.expected, c.context),
    modes: ["replay", "live", "direct"],
    profiles: ["quick", "standard", "deep"],
    requires: [],
    timeoutMs: 30_000,
  };
}

const strings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v && typeof v === "object" ? Object.values(v).flatMap(strings) : []);

/** The request body of one turn: the target's template with {{message}} replaced, plus the case's extra fields. */
function body(target: AiEvaluationTarget, message: string, extra: Record<string, unknown>): Record<string, unknown> {
  const sub = (v: unknown): unknown => (v === "{{message}}" ? message : typeof v === "string" ? v.split("{{message}}").join(message) : Array.isArray(v) ? v.map(sub) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sub(x)])) : v);
  return { ...(sub(target.requestTemplate) as Record<string, unknown>), ...extra };
}

/** Rule violations of one case against this target; empty means it may be sent. */
export function validateCase(spec: CaseSpec, turns: CompiledTurn[], ctx: CompileContext): string[] {
  const out: string[] = [];
  const t = ctx.target;
  const method = t.method ?? "POST";
  if (!pathMatchesRoute(method, t.path, ctx.endpoints)) out.push(`the target ${method} ${t.path} is not a route of this project`);
  for (const [name, sel] of Object.entries({ responseSelector: t.responseSelector, conversationSelector: t.conversationSelector, citationSelector: t.citationSelector, toolTraceSelector: t.toolTraceSelector, retrievalTraceSelector: t.retrievalTraceSelector })) {
    if (sel !== undefined && !SELECTOR.test(sel)) out.push(`${name} "${sel}" is not a plain JSON path`);
  }
  if (t.authFixture && !ctx.identity && !spec.asRole) out.push(`the route needs the sign-in "${t.authFixture}", which this project's seeded accounts cannot provide`);
  for (const turn of turns) if (turn.as !== null && !ctx.identities.includes(turn.as)) out.push(`unknown identity "${turn.as}"`);
  // Every turn goes to a route of this project (the target or an auxiliary read endpoint).
  for (const turn of turns) if (!pathMatchesRoute(turn.method, turn.path, ctx.endpoints)) out.push(`a turn targets ${turn.method} ${turn.path}, which is not a route of this project`);
  if (turns.length > AI_CASE_LIMITS.maxTurns) out.push(`${turns.length} turns; at most ${AI_CASE_LIMITS.maxTurns} are allowed`);
  if (spec.timeoutMs > AI_CASE_LIMITS.maxTimeoutMs) out.push(`a ${spec.timeoutMs} ms timeout is over the ${AI_CASE_LIMITS.maxTimeoutMs} ms limit`);
  for (const g of spec.graders) if (!AiGraderId.safeParse(g.id).success) out.push(`unsupported grader "${g.id}"`);
  if (!spec.graders.some((g) => g.hard)) out.push("no hard grader: a case cannot be decided by a status code alone");
  // Tools: only tools the component defines.
  const known = new Set(ctx.component.tools.map((x) => x.name).filter((x): x is string => Boolean(x)));
  const tools = [spec.expected.tool, ...spec.replay.flatMap((r) => r.toolCalls.map((c) => c.name))].filter((x): x is string => Boolean(x));
  for (const name of new Set(tools)) if (!known.has(name)) out.push(`unknown tool "${name}" (the component defines ${known.size ? [...known].join(", ") : "no tools"})`);
  // A script that ends in a tool call repeats it forever: an unbounded tool loop unless the case checks the loop limit.
  if (spec.replay.at(-1)?.toolCalls.length && !spec.graders.some((g) => g.id === "tool_loop")) out.push("the replay script ends with a tool call, which would repeat without bound");
  // Content rules (commands, external hosts, secrets, personal data) on everything the case sends or scripts, and the
  // target's own template.
  const asUpload = AiDatasetCase.safeParse({ id: spec.id.slice(0, 80).replace(/[^\w.-]/g, "-"), category: spec.category, input: { message: spec.message.trim() ? spec.message : "(blank)", ...spec.extra }, conversation: spec.conversation.map((content) => ({ role: "user", content })), context: spec.context, expected: { ...spec.expected, refusal: spec.expected.refusal ?? false }, replay: spec.replay });
  if (!asUpload.success) out.push(`the case does not match the dataset schema: ${asUpload.error.issues[0]?.message ?? "invalid"}`);
  else out.push(...contentProblems(asUpload.data).filter((p) => !/expected defines no behaviour/.test(p)));
  for (const s of strings(t.requestTemplate)) if (/\b(?:https?|ftp|wss?):\/\//i.test(s) && !/\/\/(localhost|127\.0\.0\.1)\b/.test(s)) out.push("the request template contains an external URL");
  // The answer key never reaches the application.
  const sent = JSON.stringify(turns.map((x) => x.json)).toLowerCase();
  for (const k of [spec.expected.answer, ...spec.expected.contains].filter((x): x is string => typeof x === "string" && x.length >= 4)) if (sent.includes(k.toLowerCase())) out.push("the expected answer would be sent to the application");
  return [...new Set(out)];
}

/** Compile and gate every case; critical cases are kept first when the profile's budget runs out. */
export function compileCases(specs: CaseSpec[], ctx: CompileContext): CompileResult {
  const limits = AI_PROFILE_LIMITS[ctx.profile];
  const t = ctx.target;
  const method = (t.method ?? "POST") as "GET" | "POST";
  const endpoint = `${method} ${t.path}`;
  const convField = t.conversationSelector?.replace(/^\$\.?/, "").split(/[.[]/).pop() ?? null;
  const out: CompileResult = { cases: [], rejected: [], overBudget: [], skipped: [] };
  const ordered = specs.map((s, i) => ({ s, i })).sort((a, b) => PRIORITY_ORDER[a.s.priority] - PRIORITY_ORDER[b.s.priority] || a.i - b.i);
  for (const { s } of ordered) {
    if (!s.modes.includes(ctx.mode)) {
      out.skipped.push({ id: s.id, reason: `Means nothing in ${ctx.mode} mode.` });
      continue;
    }
    // The identity that sends the message turns: a chosen role, or the target's own auth identity.
    const sender = s.asRole ? (ctx.roleMap?.[s.asRole] ?? null) : ctx.identity;
    const messages = [...s.conversation, s.message];
    const turns: CompiledTurn[] = messages.map((m, i) => {
      const last = i === messages.length - 1;
      const json = body(t, m, s.extra);
      if (i > 0 && convField) json[convField] = `{{cc_conversation}}`;
      return {
        as: sender,
        method,
        path: t.path,
        json,
        replay: ctx.mode === "replay" && last && s.replay.length ? s.replay : null,
        timeoutMs: last ? s.timeoutMs : 30_000,
        ...(i === 0 && convField && messages.length > 1 ? { capture: { name: "cc_conversation", path: t.conversationSelector! } } : {}),
      };
    });
    // Probe turns: a read as another identity, used by isolation and consequential-action cases.
    const auxPath = (to: "history" | "orders") => (to === "history" ? ctx.auxPaths?.history : ctx.auxPaths?.orders);
    const probeReasons: string[] = [];
    for (const pr of s.probes ?? []) {
      const who = ctx.roleMap?.[pr.role];
      const path = auxPath(pr.to);
      if (!who) probeReasons.push(`the case probes as "${pr.role}", which has no seeded account`);
      else if (!path) probeReasons.push(`the case probes the ${pr.to} endpoint, which this project does not expose`);
      else turns.push({ as: who, method: "GET", path, replay: null, timeoutMs: 10_000 });
    }
    const reasons = [...probeReasons, ...validateCase(s, turns, ctx)];
    if (reasons.length) {
      out.rejected.push({ id: s.id, reasons });
      continue;
    }
    if (messages.length > 1 && !convField) {
      out.rejected.push({ id: s.id, reasons: ["the case has earlier turns but the target has no conversation selector, so they could not be linked"] });
      continue;
    }
    if (out.cases.length >= limits.cases) {
      out.overBudget.push({ id: s.id, spec: s, reason: `The ${ctx.profile} profile runs at most ${limits.cases} cases; higher-priority cases ran first.` });
      continue;
    }
    const answerSource = ctx.mode === "direct" ? "component" : s.replay.length ? "scripted" : "replay_default";
    const limitations: string[] = [];
    if (ctx.mode === "replay") limitations.push("Replay mode: the model's answer was scripted, so this checks the application's handling, not the real model's quality, latency or cost.");
    if (answerSource === "replay_default" && s.graders.some((g) => CONTENT_GRADERS.has(g.id))) limitations.push("No frozen answer was given for this case, so its answer checks cannot be decided in replay mode; add replay turns or run it live.");
    if (ctx.mode === "direct" && s.replay.length) limitations.push("The component calls no model, so the case's replay turns were not used.");
    const graders = [...s.graders, ...(ctx.mode === "replay" && !s.graders.some((g) => g.id === "model_received_message") ? [{ id: "model_received_message" as const, hard: false }] : []), ...HYGIENE];
    out.cases.push({ spec: s, seq: out.cases.length + 1, componentId: ctx.component.id, endpoint, mode: ctx.mode, turns, graders, answerSource, samples: samplesFor(ctx.mode, isSubjective(s.graders), ctx.profile), reset: "fresh_conversation", limitations });
  }
  return out;
}
