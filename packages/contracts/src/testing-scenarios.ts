import { z } from "zod";
import { Evidence } from "./dossier.ts";

// Behaviour-first Testing (the 9+/10 plan, sections 2 to 4): what the product must do (requirements), the typed
// scenarios that check it (requests, fixture bindings, semantic assertions), the proof each assertion leaves, and
// where the browser opens the screens. AI proposes requirements and scenarios; only compiled scenarios run.

// ---------------------------------------------------------------- requirements

/**
 * Where an expected behaviour comes from. Documentation, the project's own tests, protocol rules, policy and the
 * user may define correct behaviour; implementation code may only suggest what to test (it cannot prove that
 * its current behaviour is the right one).
 */
export const RequirementSourceKind = z.enum(["documentation", "existing_test", "protocol", "policy", "user", "implementation"]);
export type RequirementSourceKind = z.infer<typeof RequirementSourceKind>;

/** What kind of proof a requirement needs before it counts as tested. */
export const RequiredProof = z.enum([
  "response", // the response itself carries the behaviour (a computed total, a refusal with a reason)
  "state", // a later read shows the change (stock went down by three, the order is now paid)
  "journey", // a person can complete it in the browser
  "integrity", // related records stay consistent (no orphan after a delete)
  "measurement", // a number is measured (latency, throughput), not judged without a threshold
]);
export type RequiredProof = z.infer<typeof RequiredProof>;

/** Deterministic behaviour templates: checks cybercheck knows how to build with a trustworthy oracle. */
export const BehaviorTemplate = z.enum([
  "calculation", // quantity, price, total, inventory and balance arithmetic
  "pagination", // page boundaries; consecutive pages neither skip nor overlap
  "state_transition", // allowed forward transitions, refused backward or skipping ones
  "date_boundary", // dates, time zones and expiry compared as dates, at discriminating values
  "idempotency", // a repeated submission does not act twice
  "crud_persistence", // create, read, update and delete persist
  "referential_integrity", // a parent and its children stay consistent
  "isolation", // one role, user or tenant cannot see or change another's records
  "recovery_after_load", // the app answers normally after functional load
]);
export type BehaviorTemplate = z.infer<typeof BehaviorTemplate>;

export const TestRequirement = z.object({
  id: z.string().min(1).max(120),
  /** The product capability (user goal) it belongs to, e.g. "Orders". */
  capability: z.string().min(1).max(120),
  source: z.object({ kind: RequirementSourceKind, path: z.string().optional(), line: z.number().int().positive().optional(), quote: z.string().max(400).optional() }),
  expectedBehavior: z.string().min(1).max(600),
  /** Inventory asset ids this requirement touches (endpoints, screens, entities). */
  affectedAssets: z.array(z.string()).max(40),
  requiredProof: RequiredProof,
  priority: z.enum(["critical", "high", "medium", "low"]),
  template: BehaviorTemplate.optional(),
});
export type TestRequirement = z.infer<typeof TestRequirement>;

/** Only these sources may define what correct behaviour is; implementation can only suggest a test. */
export const canDefineOracle = (r: Pick<TestRequirement, "source">) => r.source.kind !== "implementation";

// ---------------------------------------------------------------- inventory

/** Everything discovered, so a missing asset cannot drop out of the denominator. */
export const InventoryAssetKind = z.enum(["module", "function", "endpoint", "screen", "entity", "relationship", "integration", "job"]);
export const InventoryAsset = z.object({
  id: z.string(),
  kind: InventoryAssetKind,
  label: z.string(),
  location: Evidence.nullable(),
  /** How it was found, e.g. "express route", "express.static public/index.html", "CommonJS export". */
  discoveredBy: z.string(),
  /** At least one check ran against it with a verdict. Null until the run ends. */
  executed: z.boolean().nullable(),
});
export type InventoryAsset = z.infer<typeof InventoryAsset>;

// ---------------------------------------------------------------- values and fixture symbols

/** A fixture symbol: a dotted name a producer fills, e.g. "customer.id", "admin.token", "order.total". */
export const FixtureSymbol = z.string().regex(/^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/, "A symbol is a dotted name like customer.id.");
export type FixtureSymbol = z.infer<typeof FixtureSymbol>;

/** Fresh values made when the scenario runs, so repeated runs and parallel scenarios never collide. */
export const GeneratedValue = z.enum(["unique_email", "unique_name", "uuid", "today", "days_from_today"]);

/**
 * A JSON value whose leaves may be references: {"$symbol": "customer.id"}, {"$generated": "unique_email"}, or a
 * computed value {"$expr": {"op": "mul", "args": [...]}} (an expected total is price times quantity).
 */
export type JsonTemplate = null | boolean | number | string | JsonTemplate[] | { [key: string]: JsonTemplate };
export const JsonTemplate: z.ZodType<JsonTemplate> = z.lazy(() => z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(JsonTemplate), z.record(z.string(), JsonTemplate)]));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const EXPR_OPS = ["add", "sub", "mul", "div", "min", "max"] as const;

/** Every fixture symbol a template refers to, including inside computed values. */
export function symbolsIn(t: unknown): string[] {
  if (Array.isArray(t)) return t.flatMap(symbolsIn);
  if (!isRecord(t)) return [];
  if (typeof t.$symbol === "string") return [t.$symbol];
  return Object.values(t).flatMap(symbolsIn);
}

/** Template references that are malformed: an unknown generator or operator, or a reference with extra keys. */
export function badReferences(t: unknown, at = "$"): string[] {
  if (Array.isArray(t)) return t.flatMap((x, i) => badReferences(x, `${at}[${i}]`));
  if (!isRecord(t)) return [];
  const keys = Object.keys(t);
  if (keys.some((k) => k.startsWith("$"))) {
    if (keys.length === 1 && "$symbol" in t) return FixtureSymbol.safeParse(t.$symbol).success ? [] : [`${at}: "${String(t.$symbol)}" is not a symbol name`];
    if ("$generated" in t && keys.every((k) => k === "$generated" || k === "days")) return GeneratedValue.safeParse(t.$generated).success ? [] : [`${at}: unknown generated value "${String(t.$generated)}"`];
    if (keys.length === 1 && isRecord(t.$expr)) {
      const e = t.$expr as { op?: unknown; args?: unknown };
      if (!EXPR_OPS.includes(e.op as never)) return [`${at}: unknown operator "${String(e.op)}"`];
      return Array.isArray(e.args) && e.args.length >= 2 ? badReferences(e.args, `${at}.args`) : [`${at}: an operator needs at least two arguments`];
    }
    return [`${at}: a reference has exactly one of $symbol, $generated (with an optional days) or $expr`];
  }
  return Object.entries(t).flatMap(([k, v]) => badReferences(v, `${at}.${k}`));
}

/**
 * Where a symbol's value comes from. A setting must be one the analysis discovered (or one cybercheck generated
 * for a synthetic account); invented names such as ALICE_PASSWORD are refused when the scenario is compiled.
 */
export const SymbolProducer = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixture"), nodeId: z.string(), jsonPath: z.string() }),
  z.object({ kind: z.literal("capture"), requestId: z.string(), jsonPath: z.string() }),
  z.object({ kind: z.literal("setting"), name: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }),
  z.object({ kind: z.literal("generated_credential"), identity: z.string() }),
  // A fresh value made when the scenario runs (the same key sent twice in an idempotency check).
  z.object({ kind: z.literal("generated"), value: GeneratedValue }),
]);
export type SymbolProducer = z.infer<typeof SymbolProducer>;

export const FixtureBinding = z.object({
  symbol: FixtureSymbol,
  producer: SymbolProducer,
  type: z.enum(["string", "number", "boolean", "id", "token", "secret"]),
  /** run: shared by every scenario (a signed-in admin) · scenario: made fresh inside this scenario's namespace. */
  scope: z.enum(["run", "scenario"]),
});
export type FixtureBinding = z.infer<typeof FixtureBinding>;

// ---------------------------------------------------------------- requests

export const HttpMethod = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

/**
 * One request. The path is a route template whose placeholders ({id}) are whole segments filled from pathParams;
 * query values are kept apart and encoded when sent, so "<script>", colons and braces arrive unchanged.
 */
export const TypedRequest = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    /** setup: creates what the scenario needs (its failure makes the scenario inconclusive, never failed) · action: the behaviour under test · readback: reads the changed state. */
    role: z.enum(["setup", "action", "readback"]),
    method: HttpMethod,
    path: z.string().regex(/^\/[^?#\s]*$/, "A path starts with / and has no query or fragment; put query values in query."),
    pathParams: z.record(z.string(), JsonTemplate).default({}),
    query: z.array(z.object({ name: z.string().min(1), value: JsonTemplate })).default([]),
    headers: z.record(z.string(), JsonTemplate).default({}),
    body: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("json"), value: JsonTemplate }),
        z.object({ kind: z.literal("form"), fields: z.record(z.string(), JsonTemplate) }),
        z.object({ kind: z.literal("raw"), text: z.string().max(20000), contentType: z.string() }),
      ])
      .nullable()
      .default(null),
    /** The identity it is sent as (a fixture identity node), or null for no credentials. */
    as: z.string().nullable(),
    captures: z.array(z.object({ symbol: FixtureSymbol, jsonPath: z.string() })).default([]),
    /** A 4xx answer (other than a sign-in refusal) is itself the correct outcome and ends the scenario as passed: deleting a parent that still has children may be refused. */
    endsIfRefused: z.boolean().default(false),
  })
  .superRefine((r, ctx) => {
    const placeholders = [...r.path.matchAll(/\{([^}/]+)\}/g)].map((m) => m[1]!);
    for (const seg of r.path.split("/")) if (seg.includes("{") && !/^\{[^{}/]+\}$/.test(seg)) ctx.addIssue({ code: "custom", message: `Placeholder must be a whole path segment: "${seg}".`, path: ["path"] });
    for (const p of placeholders) if (!(p in r.pathParams)) ctx.addIssue({ code: "custom", message: `Path placeholder {${p}} has no value in pathParams.`, path: ["pathParams"] });
    for (const k of Object.keys(r.pathParams)) if (!placeholders.includes(k)) ctx.addIssue({ code: "custom", message: `pathParams.${k} has no {${k}} in the path.`, path: ["pathParams", k] });
    for (const bad of [...badReferences(r.pathParams, "pathParams"), ...badReferences(r.query, "query"), ...badReferences(r.headers, "headers"), ...badReferences(r.body, "body")]) ctx.addIssue({ code: "custom", message: bad });
    if (r.body && ["GET", "HEAD"].includes(r.method)) ctx.addIssue({ code: "custom", message: `${r.method} requests carry no body.`, path: ["body"] });
  });
export type TypedRequest = z.infer<typeof TypedRequest>;

// ---------------------------------------------------------------- assertions

/** What an assertion reads from a response. */
export const AssertionTarget = z.discriminatedUnion("from", [
  z.object({ from: z.literal("status") }),
  z.object({ from: z.literal("body"), jsonPath: z.string() }),
  z.object({ from: z.literal("header"), name: z.string() }),
]);
export type AssertionTarget = z.infer<typeof AssertionTarget>;

export const AssertionOp = z.enum(["equals", "not_equals", "gt", "gte", "lt", "lte", "one_of", "contains", "not_contains", "length", "exists", "absent", "changed_by"]);

/**
 * One check on one response. Status checks prove availability (or a refusal) only; a semantic assertion reads the
 * body or a header. changed_by compares with the same field of an earlier request (stock before and after).
 */
export const SemanticAssertion = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    requirementId: z.string(),
    requestId: z.string(),
    target: AssertionTarget,
    op: AssertionOp,
    expected: JsonTemplate.optional(),
    /** changed_by: the earlier request whose value at the same target is the baseline. */
    baselineRequestId: z.string().optional(),
    /** In plain words, for the report: "the total is price times quantity". */
    says: z.string().min(1).max(300),
  })
  .superRefine((a, ctx) => {
    const needsExpected = !["exists", "absent"].includes(a.op);
    if (needsExpected && a.expected === undefined) ctx.addIssue({ code: "custom", message: `"${a.op}" needs an expected value.`, path: ["expected"] });
    if (a.op === "changed_by" && !a.baselineRequestId) ctx.addIssue({ code: "custom", message: "changed_by needs the baseline request.", path: ["baselineRequestId"] });
    if (a.target.from === "status" && !["equals", "not_equals", "one_of", "lt", "gte"].includes(a.op)) ctx.addIssue({ code: "custom", message: `A status cannot be checked with "${a.op}".`, path: ["op"] });
    for (const bad of badReferences(a.expected ?? null, "expected")) ctx.addIssue({ code: "custom", message: bad });
  });
export type SemanticAssertion = z.infer<typeof SemanticAssertion>;

/** A semantic assertion reads what the product did, not only whether it answered. */
export const isSemantic = (a: Pick<SemanticAssertion, "target">) => a.target.from !== "status";

// ---------------------------------------------------------------- scenarios

export const CompiledScenario = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_:-]*$/),
    requirementIds: z.array(z.string()).min(1),
    /** isolated: runs in its own data namespace, so counts and pages are not disturbed by other scenarios. */
    fixtureScope: z.enum(["shared", "isolated"]),
    requests: z.array(TypedRequest).min(1).max(20),
    assertions: z.array(SemanticAssertion).min(1).max(40),
    bindings: z.array(FixtureBinding).max(40),
  })
  .superRefine((s, ctx) => {
    const ids = s.requests.map((r) => r.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "Request ids must be unique.", path: ["requests"] });
    const aids = s.assertions.map((a) => a.id);
    if (new Set(aids).size !== aids.length) ctx.addIssue({ code: "custom", message: "Assertion ids must be unique.", path: ["assertions"] });
    if (!s.requests.some((r) => r.role === "action")) ctx.addIssue({ code: "custom", message: "A scenario needs an action request: the behaviour under test.", path: ["requests"] });
    // Symbols must be bound before use: by a binding, or captured by an earlier request.
    const known = new Set(s.bindings.map((b) => b.symbol));
    s.requests.forEach((r, i) => {
      for (const sym of symbolsIn([r.pathParams, r.query, r.headers, r.body])) if (!known.has(sym)) ctx.addIssue({ code: "custom", message: `Request ${r.id} uses ${sym} before anything produces it.`, path: ["requests", i] });
      for (const c of r.captures) known.add(c.symbol);
    });
    s.assertions.forEach((a, i) => {
      const at = ids.indexOf(a.requestId);
      if (at < 0) ctx.addIssue({ code: "custom", message: `Assertion ${a.id} reads request ${a.requestId}, which the scenario does not send.`, path: ["assertions", i] });
      if (a.baselineRequestId && !(ids.indexOf(a.baselineRequestId) >= 0 && ids.indexOf(a.baselineRequestId) < at)) ctx.addIssue({ code: "custom", message: `Assertion ${a.id}: the baseline request must be sent before ${a.requestId}.`, path: ["assertions", i] });
      if (!s.requirementIds.includes(a.requirementId)) ctx.addIssue({ code: "custom", message: `Assertion ${a.id} cites ${a.requirementId}, which is not one of the scenario's requirements.`, path: ["assertions", i] });
      for (const sym of symbolsIn(a.expected ?? null)) if (!known.has(sym)) ctx.addIssue({ code: "custom", message: `Assertion ${a.id} expects ${sym}, which nothing produces.`, path: ["assertions", i] });
    });
    for (const b of s.bindings) if (b.producer.kind === "capture" && !ids.includes(b.producer.requestId)) ctx.addIssue({ code: "custom", message: `Binding ${b.symbol} is captured from request ${b.producer.requestId}, which the scenario does not send.`, path: ["bindings"] });
  });
export type CompiledScenario = z.infer<typeof CompiledScenario>;

/**
 * The strongest proof a scenario can give a requirement, from its structure alone (before it runs):
 * - availability: only status assertions; it shows the endpoint answered, nothing about the behaviour.
 * - response: a semantic assertion on the action's response.
 * - state: a semantic assertion on a readback that reads the changed record (a symbol the action captured or
 *   used, or a later read of the same path), or a changed_by against an earlier read.
 */
export type ProofLevel = "availability" | "response" | "state";
export function scenarioProofLevel(s: CompiledScenario, requirementId: string): ProofLevel {
  const byId = new Map(s.requests.map((r) => [r.id, r]));
  const same = (x: TypedRequest, y: TypedRequest) => x.method === y.method && x.path === y.path && JSON.stringify([x.pathParams, x.query, x.body]) === JSON.stringify([y.pathParams, y.query, y.body]);
  // A 4xx expected for an exact repeat of an action asserted as accepted is behaviour (a duplicate refused), not availability.
  const repeatRefused = (a: SemanticAssertion) => {
    const r = byId.get(a.requestId);
    if (!r || r.role !== "action" || a.target.from !== "status" || !/\b4\d\d\b/.test(JSON.stringify(a.expected ?? null))) return false;
    return s.requests.slice(0, s.requests.indexOf(r)).some((p) => same(p, r) && s.assertions.some((b) => b.requestId === p.id && b.target.from === "status" && b.op === "lt" && b.expected === 400));
  };
  const mine = s.assertions.filter((a) => a.requirementId === requirementId && (isSemantic(a) || repeatRefused(a)));
  if (!mine.length) return "availability";
  const actions = s.requests.filter((r) => r.role === "action");
  const touched = new Set(actions.flatMap((r) => [...r.captures.map((c) => c.symbol), ...symbolsIn([r.pathParams, r.body])]));
  const readsChanged = (r: TypedRequest) => r.role === "readback" && (symbolsIn([r.pathParams, r.query]).some((x) => touched.has(x)) || actions.some((a) => a.path === r.path));
  // A read of a list counts when the assertion picks the changed record out of it ($.items[id={{order.id}}].status).
  const picksChanged = (a: SemanticAssertion) => a.target.from === "body" && [...a.target.jsonPath.matchAll(/\{\{([^}]+)\}\}/g)].some((m) => touched.has(m[1]!));
  if (mine.some((a) => (byId.get(a.requestId) && readsChanged(byId.get(a.requestId)!)) || (byId.get(a.requestId)?.role === "readback" && picksChanged(a)) || a.op === "changed_by")) return "state";
  return mine.some((a) => byId.get(a.requestId)?.role === "action") ? "response" : "availability";
}

/** Whether a proof level is enough for what the requirement needs. Journeys, integrity and measurements are proven by their own workers. */
export function proofSuffices(level: ProofLevel, required: RequiredProof): boolean {
  if (required === "response") return level === "response" || level === "state";
  if (required === "state" || required === "integrity") return level === "state";
  return false;
}

// ---------------------------------------------------------------- proof

/** What one assertion showed when it ran: the evidence behind a pass or a finding. */
export const AssertionProof = z.object({
  requirementId: z.string(),
  assertionId: z.string(),
  scenarioId: z.string(),
  executionId: z.string(),
  passed: z.boolean(),
  expected: z.unknown(),
  observed: z.unknown(),
  /** The request reached the code it targets (not stopped by a guard, validation or an unknown id). */
  targetReached: z.boolean(),
  /** A later read showed the change. */
  stateVerified: z.boolean(),
  /** A short, secret-redacted part of the response it read. */
  excerpt: z.string().max(600).nullable(),
});
export type AssertionProof = z.infer<typeof AssertionProof>;

// ---------------------------------------------------------------- browser targets

/**
 * Where the browser opens the screens: a separate frontend that is built and started, or pages the backend
 * serves itself (express.static, res.sendFile, server-rendered routes), which need no frontend build.
 */
export const BrowserTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("frontend"), workspace: z.string(), port: z.number().int(), build: z.array(z.string()), start: z.string() }),
  z.object({ kind: z.literal("backend_served"), appWorkspace: z.string(), port: z.number().int() }),
]);
export type BrowserTarget = z.infer<typeof BrowserTarget>;

/** How a screen was found. */
export const ScreenSource = z.enum(["static_html", "send_file", "server_route", "next_page", "react_router", "other_router"]);
export const BrowserScreen = z.object({ path: z.string().regex(/^\//), source: ScreenSource, location: Evidence.nullable(), target: z.enum(["frontend", "backend_served"]) });
export type BrowserScreen = z.infer<typeof BrowserScreen>;

// ---------------------------------------------------------------- database strategy

/**
 * How the database lane checks integrity. direct: a separate process inspects the schema and constraints (file
 * SQLite, sandbox Postgres). api_level: an in-memory database lives inside the app process, so integrity is
 * checked through the running app (create a parent and child, delete the parent, read the child) and nothing
 * claims to have inspected it directly.
 */
export const DatabaseStrategy = z.enum(["direct_sqlite_file", "direct_postgres", "api_level", "none"]);
export type DatabaseStrategy = z.infer<typeof DatabaseStrategy>;
