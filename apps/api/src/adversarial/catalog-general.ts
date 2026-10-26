import type { AdversarialAttacker, AdversarialLane, AdversarialPriority, AdversarialSeverity, EntryPoint } from "@cybercheck/contracts";
import type { CatalogCampaign, OracleSpec } from "./catalog.ts";
import type { PlannedStep } from "./compiler.ts";
import { resetStrategyFor } from "./fixtures.ts";
import { AD_CANARY } from "./fixtures.ts";
import { findingsFor, unexpectedAccess, type SecurityFacts } from "./security-facts.ts";
import { semanticCampaignId } from "./campaign-plan.ts";

// The general attacker catalogue (non-AI). It turns the app's routes, the run's synthetic identities, and the
// weaknesses the Security check already proved into bounded, typed campaigns that chain toward four objectives: access
// control / data theft, account / auth takeover, business-logic / money abuse, and injection -> system reach. Every
// campaign carries an HTTP/state oracle; the safety compiler decides whether it may run. It never re-proves a Security
// weakness it can cite; it sequences weaknesses into attack paths.

const ADMIN = /admin|superuser|root|owner|staff|internal|manage|dashboard/i;
const MONEY = /order|payment|invoice|charge|refund|balance|wallet|credit|coupon|cart|checkout|stock|inventory|transfer|price|amount|quantity/i;
const LOGIN = /log-?in|sign-?in|auth|session|token|authenticate/i;
const PARAM = /:[\w-]+|\{[\w-]+\}|\[[\w-]+\]/;
const owaspFor: Record<AdversarialLane, string[]> = {
  broken_access: ["API1:2023 BOLA", "API5:2023 BFLA", "CWE-285"],
  auth_takeover: ["API2:2023 Broken Authentication", "CWE-287"],
  business_logic: ["API6:2023 Unrestricted Business Flows", "CWE-840"],
  injection_pivot: ["API8:2023", "CWE-89"],
  data_exposure: ["API3:2023", "CWE-213"],
  resource_abuse: ["API4:2023 Unrestricted Resource Consumption", "CWE-770"],
  identity_tenant: ["API1:2023 BOLA", "CWE-639"],
  recon: [],
  prompt: [],
  leakage: [],
  rag_memory: [],
  tools_approval: [],
  mcp_agent: [],
  output_handling: [],
  resource_concurrency: [],
  multi_stage: [],
};

export type GeneralCatalogInput = {
  routes: EntryPoint[];
  attackers: Record<AdversarialAttacker, string | null>;
  identities: Array<{ name: string; role: string | null; tenant?: string | null }>;
  security: SecurityFacts | null;
  endpoints: Set<string>;
  /** Values captured by the boot/setup graph (cafe_id, order_id, table_id, ...). */
  fixtureSymbols?: string[];
  /** Valid control bodies derived from the analyzer's request models, keyed by "METHOD /route". */
  requestBodies?: Record<string, Record<string, unknown>>;
};

const ep = (e: EntryPoint) => `${e.method} ${e.path}`;
const concrete = (path: string, id: string) => path.replace(PARAM, id);
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
/** Fill a route parameter only from a value the setup graph really captures. No literal fallback ids. */
function fixtureTarget(ref: string, symbols: string[] = []): string | null {
  const match = ref.match(PARAM);
  if (!match) return ref;
  const wanted = norm(match[0].replace(/[:{}\[\]]/g, ""));
  const exact = symbols.filter((s) => norm(s) === wanted || norm(s) === `${wanted}id` || `${norm(s)}id` === wanted);
  const related = symbols.filter((s) => norm(s).length >= 4 && wanted.length >= 4 && (norm(s).includes(wanted) || wanted.includes(norm(s))));
  const chosen = exact.length === 1 ? exact[0] : related.length === 1 ? related[0] : null;
  return chosen ? concrete(ref, `{{${chosen}}}`) : null;
}

export function buildGeneralCampaigns(i: GeneralCatalogInput): CatalogCampaign[] {
  const out: CatalogCampaign[] = [];
  const attackable = i.routes.filter((e) => e.kind === "http" || e.kind === "webhook" || e.kind === "graphql");
  const user = i.attackers.user;
  const other = i.attackers.cross_user ?? i.attackers.cross_tenant;
  const step = (over: Partial<PlannedStep> & { target: string }): PlannedStep => ({ operation: "send_request", asIdentity: user, inputClass: "synthetic attack request", ...over });
  const add = (lane: AdversarialLane, techniqueId: string, priority: AdversarialPriority, severity: AdversarialSeverity, title: string, endpoint: string, steps: PlannedStep[], oracle: OracleSpec, asset: string, boundary: string, attacker: AdversarialAttacker = "user") => {
    out.push({ id: semanticCampaignId("gen", techniqueId, endpoint, attacker, oracle), track: "general", lane, techniqueId, priority, title, target: { componentId: "app", endpoint }, attacker, resetStrategy: resetStrategyFor(lane), steps, source: "catalogue", oracle, severity, owasp: owaspFor[lane] ?? [], asset, boundary });
  };

  // ---- Access control / data theft: function authorization (a member reaches an admin-only route).
  // A public HTML shell named `/admin` is not by itself proof of privileged-function access.  Only API/action
  // routes or routes with an explicit role requirement get an authorization campaign.
  const adminRoutes = attackable.filter((e) => e.control.kind === "role_required" || (ADMIN.test(e.path) && (/^\/api\//i.test(e.path) || e.mutates)));
  if (user && i.attackers.admin) for (const e of adminRoutes.slice(0, 4)) {
    const target = fixtureTarget(ep(e), i.fixtureSymbols);
    if (target) add("broken_access", "function-authz", "critical", "high", `A non-admin cannot call ${ep(e)}`, ep(e), [step({ target, asIdentity: i.attackers.admin, inputClass: "authorized control request" }), step({ target, asIdentity: user })], { kind: "access_denied", marker: undefined }, "an administrator-only function", "function authorization");
  }

  // ---- Access control: object authorization / IDOR (read another party's record), preferring Security-proven holes.
  const proven = unexpectedAccess(i.security);
  const paramGets = attackable.filter((e) => e.method === "GET" && PARAM.test(e.path));
  if (user && other) {
    for (const hole of proven.slice(0, 3)) add("broken_access", "object-authz", "critical", "high", `Reproduce and chain the proven access-control hole at ${hole.endpoint}`, hole.endpoint, [step({ target: hole.endpoint.replace(PARAM, `{{${other}.id}}`), asIdentity: other, inputClass: "authorized owner control request" }), step({ target: hole.endpoint.replace(PARAM, `{{${other}.id}}`), asIdentity: user })], { kind: "access_denied" }, "another user's record", "object authorization", "cross_user");
    for (const e of paramGets.filter((e) => !proven.some((p) => p.endpoint.endsWith(e.path))).slice(0, 2)) {
      const base = e.path.replace(/\/[^/]*$/, "");
      const list = attackable.find((l) => l.method === "GET" && l.path === base && !PARAM.test(l.path));
      if (list) add("broken_access", "object-authz", "high", "high", `${user} cannot read ${other}'s record via ${ep(e)}`, ep(e), [step({ operation: "capture", target: ep(list), asIdentity: other, capture: { name: "victim", path: "0.id" }, inputClass: "capture a victim record id" }), step({ target: concrete(ep(e), "{{victim}}"), asIdentity: other, inputClass: "authorized owner control request" }), step({ target: concrete(ep(e), "{{victim}}"), asIdentity: user })], { kind: "access_denied" }, "another user's record", "object authorization", "cross_user");
    }
  }

  // ---- Access control: mass assignment (set a field the caller may not).
  const mutators = attackable.filter((e) => e.mutates && (e.method === "POST" || e.method === "PUT" || e.method === "PATCH"));
  if (user) for (const e of mutators.slice(0, 3)) {
    const target = fixtureTarget(ep(e), i.fixtureSymbols);
    const valid = i.requestBodies?.[ep(e)];
    if (target && valid && Object.keys(valid).length) add("broken_access", "mass-assignment", "high", "medium", `${ep(e)} ignores a privileged field from the caller`, ep(e), [step({ target, body: valid, inputClass: "valid mutation control from the analyzed request model" }), step({ target, body: { ...valid, role: "admin", isAdmin: true } }), step({ target: target.replace(/^(POST|PUT|PATCH)/, "GET"), inputClass: "read back the mutated record" })], { kind: "field_unchanged", field: "role", value: "admin" }, "a privileged attribute", "property authorization");
  }

  // ---- Auth takeover: forged token and login throttling.
  if (user && adminRoutes.length) {
    const target = fixtureTarget(ep(adminRoutes[0]!), i.fixtureSymbols);
    if (target) add("auth_takeover", "token-forgery", "critical", "high", `A forged session cannot reach ${ep(adminRoutes[0]!)}`, ep(adminRoutes[0]!), [step({ target, asIdentity: user, inputClass: "valid session control" }), step({ target, asIdentity: `${user}#forged` })], { kind: "access_denied" }, "an admin function via a forged token", "authentication");
  }
  const loginRoute = attackable.find((e) => e.method === "POST" && LOGIN.test(e.path));
  if (loginRoute) add("auth_takeover", "login-throttling", "high", "medium", `Repeated failed logins at ${ep(loginRoute)} are throttled`, ep(loginRoute), [step({ operation: "repeat_bounded", target: ep(loginRoute), asIdentity: "anonymous", repeat: 12, body: { email: "attacker@example.test", password: "wrong-guess" }, inputClass: "repeated failed sign-ins" })], { kind: "rate_limited" }, "the authentication boundary", "rate limiting", "anonymous");

  // ---- Business logic / money abuse.
  const moneyMutators = mutators.filter((e) => MONEY.test(e.path));
  if (user) for (const e of moneyMutators.slice(0, 3)) {
    const target = fixtureTarget(ep(e), i.fixtureSymbols);
    const valid = i.requestBodies?.[ep(e)];
    if (!target || !valid || !Object.keys(valid).length) continue;
    add("business_logic", "invalid-quantity", "high", "medium", `${ep(e)} rejects a negative or oversized amount`, ep(e), [step({ target, body: valid, inputClass: "valid business-operation control from the analyzed request model" }), step({ target, body: { ...valid, quantity: -5, amount: -100, price: 0, count: 1_000_000 } })], { kind: "logic_rejected" }, "money or inventory state", "business logic");
    add("business_logic", "duplicate-action", "high", "medium", `${ep(e)} does not apply a duplicated consequential action twice`, ep(e), [step({ target, body: { ...valid, idempotencyKey: "cc-dup-1" }, inputClass: "valid initial action from the analyzed request model" }), step({ target, body: { ...valid, idempotencyKey: "cc-dup-1" } })], { kind: "logic_rejected" }, "money state", "business logic");
  }
  // Race condition on a money route (bounded parallelism).
  const raceTarget = moneyMutators.find((e) => /transfer|balance|wallet|withdraw|debit/i.test(e.path));
  if (user && other && raceTarget) {
    const target = fixtureTarget(ep(raceTarget), i.fixtureSymbols);
    if (target) add("business_logic", "race-condition", "high", "high", `Concurrent requests to ${ep(raceTarget)} preserve non-negative balances`, ep(raceTarget), [step({ target, body: { amount: 1, toUserId: `{{${other}.id}}` }, inputClass: "valid initial-state control" }), step({ operation: "run_parallel_bounded", target, parallel: 4, body: { amount: 60, toUserId: `{{${other}.id}}` }, inputClass: "concurrent money operations" })], { kind: "numeric_nonnegative", fields: ["from", "balance", "remaining", "credit"] }, "a balance or inventory count", "business logic");
  }

  // ---- Injection -> pivot (seed from Security's proven injection; else a differential on a query route).
  const injFindings = findingsFor(i.security, /inject|sqli|nosql|CWE-89|CWE-78/i);
  const queryGets = attackable.filter((e) => e.method === "GET" && (e.inputs?.query || /search|filter|query|find|list/i.test(e.path)));
  if (user) {
    for (const f of injFindings.slice(0, 2)) if (f.location) add("injection_pivot", "injection-differential", "critical", "high", `Confirm and pivot from the Security-reported injection at ${f.location.path}`, queryGets[0] ? ep(queryGets[0]) : "GET /", [step({ target: queryGets[0] ? `${ep(queryGets[0])}?q=cybercheck-control` : "GET /", inputClass: "valid query control" }), step({ target: queryGets[0] ? `${ep(queryGets[0])}?q=1'%20OR%20'1'='1` : "GET /", inputClass: "true-clause injection probe" }), step({ target: queryGets[0] ? `${ep(queryGets[0])}?q=1'%20AND%20'1'='2` : "GET /", inputClass: "false-clause injection probe" })], { kind: "injection_inert" }, "the database", "injection");
    for (const e of queryGets.filter((e) => !injFindings.length).slice(0, 2)) add("injection_pivot", "injection-differential", "high", "high", `${ep(e)} parameterises query input`, ep(e), [step({ target: `${ep(e)}?q=cybercheck-control`, inputClass: "valid query control" }), step({ target: `${ep(e)}?q=x'%20OR%20'1'='1`, inputClass: "true-clause injection probe" }), step({ target: `${ep(e)}?q=x'%20AND%20'1'='2`, inputClass: "false-clause injection probe" })], { kind: "injection_inert" }, "the database", "injection");
  }

  // ---- Resource abuse: unbounded repeats on an expensive route.
  const heavy = attackable.find((e) => e.method === "GET" && /report|export|search|list|all|aggregate|stats|analytics/i.test(e.path));
  if (user && heavy) { const target = fixtureTarget(ep(heavy), i.fixtureSymbols); if (target) add("resource_abuse", "unbounded-requests", "medium", "low", `${ep(heavy)} bounds repeated expensive requests`, ep(heavy), [step({ operation: "repeat_bounded", target, repeat: 15, inputClass: "repeated expensive requests" })], { kind: "rate_limited" }, "server resources", "rate limiting"); }

  // ---- Multi-stage: a function-authz foothold into a mutating admin action.
  const adminMutator = mutators.find((e) => e.control.kind === "role_required" || ADMIN.test(e.path));
  if (user && i.attackers.admin && adminMutator) { const target = fixtureTarget(ep(adminMutator), i.fixtureSymbols); if (target) add("multi_stage", "escalate-to-admin-action", "critical", "high", `Chain to a privileged change via ${ep(adminMutator)}`, ep(adminMutator), [step({ target, asIdentity: i.attackers.admin, body: { role: "admin" }, inputClass: "authorized administrator control" }), step({ target, body: { role: "admin" } })], { kind: "access_denied" }, "a privileged state change", "privilege"); }

  return out;
}

// The general attacker techniques an optional AI attacker may propose against a specific endpoint. The model never
// emits operations, payloads, URLs, or ids: it only picks a technique + a known endpoint + a known identity, and this
// deterministic builder turns that into the same typed, bounded, oracle-carrying campaign the catalogue would, which
// then passes the same safety compiler. Anything referencing an unknown endpoint or identity is dropped here or later
// rejected by the compiler.
export const GENERAL_TECHNIQUES = ["function-authz", "object-authz", "mass-assignment", "token-forgery", "login-throttling", "invalid-quantity", "duplicate-action", "race-condition", "injection-differential", "unbounded-requests", "escalate-to-admin-action"] as const;
export type GeneralTechnique = (typeof GENERAL_TECHNIQUES)[number];
export type AttackHypothesis = { technique: GeneralTechnique; endpoint: string; asIdentity: string; crossIdentity?: string | null };

const laneFor: Record<GeneralTechnique, AdversarialLane> = {
  "function-authz": "broken_access", "object-authz": "broken_access", "mass-assignment": "broken_access", "token-forgery": "auth_takeover", "login-throttling": "auth_takeover",
  "invalid-quantity": "business_logic", "duplicate-action": "business_logic", "race-condition": "business_logic", "injection-differential": "injection_pivot", "unbounded-requests": "resource_abuse", "escalate-to-admin-action": "multi_stage",
};

/** Translate validated AI attacker hypotheses into typed catalogue campaigns against known endpoints and identities. */
export function campaignsFromHypotheses(hyps: AttackHypothesis[], i: { routes: EntryPoint[]; attackers: Record<AdversarialAttacker, string | null>; fixtureSymbols?: string[]; requestBodies?: Record<string, Record<string, unknown>> }): CatalogCampaign[] {
  const out: CatalogCampaign[] = [];
  const byEp = new Map(i.routes.map((e) => [ep(e), e] as const));
  for (const h of hyps) {
    const r = byEp.get(h.endpoint);
    if (!r) continue;
    const e = ep(r);
    const lane = laneFor[h.technique];
    const as = h.asIdentity;
    const other = (h.crossIdentity || i.attackers.cross_user || i.attackers.cross_tenant) ?? null;
    const step = (over: Partial<PlannedStep> & { target: string }): PlannedStep => ({ operation: "send_request", asIdentity: as, inputClass: "AI-proposed attack request", ...over });
    const push = (priority: AdversarialPriority, severity: AdversarialSeverity, title: string, steps: PlannedStep[], oracle: OracleSpec, asset: string, boundary: string, attacker: AdversarialAttacker = "user") =>
      out.push({ id: semanticCampaignId("ai", h.technique, e, attacker, oracle), track: "general", lane, techniqueId: h.technique, priority, title, target: { componentId: "app", endpoint: e }, attacker, resetStrategy: resetStrategyFor(lane), steps, source: "attacker_model", oracle, severity, owasp: owaspFor[lane] ?? [], asset, boundary });
    const target = fixtureTarget(e, i.fixtureSymbols);
    const valid = i.requestBodies?.[e];
    switch (h.technique) {
      case "function-authz": if (target && i.attackers.admin) push("critical", "high", `A non-admin cannot call ${e}`, [step({ target, asIdentity: i.attackers.admin, inputClass: "authorized control request" }), step({ target })], { kind: "access_denied" }, "an administrator-only function", "function authorization"); break;
      case "object-authz": if (other) push("critical", "high", `${as} cannot read ${other}'s record via ${e}`, [step({ target: concrete(e, `{{${other}.id}}`), asIdentity: other, inputClass: "authorized owner control request" }), step({ target: concrete(e, `{{${other}.id}}`), asIdentity: as })], { kind: "access_denied" }, "another user's record", "object authorization", "cross_user"); break;
      case "mass-assignment": if (target && valid && Object.keys(valid).length) push("high", "medium", `${e} ignores a privileged field from the caller`, [step({ target, body: valid, inputClass: "valid mutation control from the analyzed request model" }), step({ target, body: { ...valid, role: "admin", isAdmin: true } }), step({ target: target.replace(/^(POST|PUT|PATCH)/, "GET"), inputClass: "read back the mutated record" })], { kind: "field_unchanged", field: "role", value: "admin" }, "a privileged attribute", "property authorization"); break;
      case "token-forgery": if (target) push("critical", "high", `A forged session cannot reach ${e}`, [step({ target, inputClass: "valid session control" }), step({ target, asIdentity: `${as}#forged` })], { kind: "access_denied" }, "an admin function via a forged token", "authentication"); break;
      case "login-throttling": push("high", "medium", `Repeated failed logins at ${e} are throttled`, [step({ operation: "repeat_bounded", target: e, asIdentity: "anonymous", repeat: 12, body: { email: "attacker@example.test", password: "wrong-guess" }, inputClass: "repeated failed sign-ins" })], { kind: "rate_limited" }, "the authentication boundary", "rate limiting", "anonymous"); break;
      case "invalid-quantity": if (target && valid && Object.keys(valid).length) push("high", "medium", `${e} rejects a negative or oversized amount`, [step({ target, body: valid, inputClass: "valid business-operation control from the analyzed request model" }), step({ target, body: { ...valid, quantity: -5, amount: -100, price: 0, count: 1_000_000 } })], { kind: "logic_rejected" }, "money or inventory state", "business logic"); break;
      case "duplicate-action": if (target && valid && Object.keys(valid).length) push("high", "medium", `${e} does not apply a duplicated consequential action twice`, [step({ target, body: { ...valid, idempotencyKey: "cc-dup-1" }, inputClass: "valid initial action from the analyzed request model" }), step({ target, body: { ...valid, idempotencyKey: "cc-dup-1" } })], { kind: "logic_rejected" }, "money state", "business logic"); break;
      case "race-condition": if (other && target) push("high", "high", `Concurrent requests to ${e} preserve non-negative balances`, [step({ target, body: { amount: 1, toUserId: `{{${other}.id}}` }, inputClass: "valid initial-state control" }), step({ operation: "run_parallel_bounded", target, parallel: 4, body: { amount: 60, toUserId: `{{${other}.id}}` }, inputClass: "concurrent money operations" })], { kind: "numeric_nonnegative", fields: ["from", "balance", "remaining", "credit"] }, "a balance or inventory count", "business logic"); break;
      case "injection-differential": push("high", "high", `${e} parameterises query input`, [step({ target: `${e}?q=cybercheck-control`, inputClass: "valid query control" }), step({ target: `${e}?q=x'%20OR%20'1'='1`, inputClass: "true-clause injection probe" }), step({ target: `${e}?q=x'%20AND%20'1'='2`, inputClass: "false-clause injection probe" })], { kind: "injection_inert" }, "the database", "injection"); break;
      case "unbounded-requests": if (target) push("medium", "low", `${e} bounds repeated expensive requests`, [step({ operation: "repeat_bounded", target, repeat: 15, inputClass: "repeated expensive requests" })], { kind: "rate_limited" }, "server resources", "rate limiting"); break;
      case "escalate-to-admin-action": if (target && i.attackers.admin) push("critical", "high", `Chain to a privileged change via ${e}`, [step({ target, asIdentity: i.attackers.admin, body: { role: "admin" }, inputClass: "authorized administrator control" }), step({ target, body: { role: "admin" } })], { kind: "access_denied" }, "a privileged state change", "privilege"); break;
    }
  }
  return out;
}
