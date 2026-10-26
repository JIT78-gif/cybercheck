import { describe, expect, it } from "vitest";
import type { EntryPoint, ProjectDossier } from "@cybercheck/contracts";
import { buildGeneralCampaigns, campaignsFromHypotheses, type AttackHypothesis } from "../src/adversarial/catalog-general.ts";
import { clampRules, compilePlan } from "../src/adversarial/compiler.ts";
import { endpointKeys } from "../src/testing/scenarios.ts";
import { assessAdversarialApplicability } from "../src/adversarial/applicability.ts";
import { generalLaneReadiness } from "../src/adversarial/readiness.ts";
import { judgeCampaign, type CampaignObservation } from "../src/adversarial/oracle.ts";
import { correlateChains } from "../src/adversarial/chains.ts";
import { classifyAttackers } from "../src/adversarial/fixtures.ts";
import type { CatalogCampaign } from "../src/adversarial/catalog.ts";
import type { CampaignVerdict } from "../src/adversarial/oracle.ts";

// The general (non-AI) attacker: applicability over any HTTP app, the catalogue it builds from routes and identities,
// the HTTP/state oracles that decide a campaign, lane readiness, and the general chain templates.

const ev = { path: "src/app.js", line: 1 };
function route(method: string, path: string, over: Partial<EntryPoint> = {}): EntryPoint {
  return {
    id: `${method} ${path}`,
    status: "observed",
    kind: "http",
    method,
    path,
    framework: "express",
    handler: ev,
    control: { kind: over.control?.kind ?? "session_required", reason: "requireUser hook", via: ["requireUser"], evidence: [ev] },
    requestSchema: null,
    inputs: { params: null, query: null, body: null, files: false },
    mutates: method !== "GET",
    sideEffects: method !== "GET" ? ["writes database"] : [],
    ...over,
  };
}

const ROUTES: EntryPoint[] = [
  route("POST", "/api/login", { control: { kind: "public_intentional", reason: "login", via: [], evidence: [ev] }, mutates: true }),
  route("GET", "/api/notes"),
  route("GET", "/api/notes/:id"),
  route("PATCH", "/api/notes/:id", { mutates: true }),
  route("POST", "/api/orders", { mutates: true }),
  route("POST", "/api/transfers", { mutates: true }),
  route("GET", "/api/admin/users", { control: { kind: "role_required", reason: "requireRole admin", via: ["requireRole"], evidence: [ev] } }),
  route("GET", "/api/notes/search", { inputs: { params: null, query: "q", body: null, files: false } }),
];

const IDENTITIES = [
  { name: "customer", role: "user", tenant: "tenant-a" },
  { name: "customer-2", role: "user", tenant: "tenant-b" },
  { name: "admin", role: "admin", tenant: "tenant-admin" },
];

function dossier(entryPoints: EntryPoint[]): ProjectDossier {
  return { meta: { contentDigest: "digest-1" }, entryPoints, aiComponents: [] } as unknown as ProjectDossier;
}

const obs = (over: Partial<CampaignObservation> & Pick<CampaignObservation, "turns">): CampaignObservation => ({
  ran: true,
  preconditions: { appBooted: true, targetReached: true, fixtureReady: true, oracleReady: true },
  toolCalls: [], citations: [], canaryHits: 0, xssExecuted: false, xssReflected: false, retrievalReached: false, toolSurfaceReached: false,
  responseOwned: null, stateAfter: {}, reset: true, resetRequired: false, executionIds: ["x1"], evidence: [ev],
  ...over,
});
const turn = (status: number, body: unknown = {}, as: string | null = "customer") => ({ as, status, reply: typeof body === "string" ? body : JSON.stringify(body), body });

describe("general attacker applicability", () => {
  it("applies the general track to a non-AI app with HTTP routes", () => {
    const a = assessAdversarialApplicability({ dossier: dossier(ROUTES), src: { files: new Map() } as never, contentDigest: "digest-1" });
    expect(a.ownershipOk).toBe(true);
    expect(a.tracks).toContain("general");
    expect(a.tracks).not.toContain("ai");
    expect(a.applicability.status).toBe("applicable");
    expect(a.entryPoints).toBeGreaterThan(0);
  });
  it("is not applicable with no reachable endpoints and no AI", () => {
    const a = assessAdversarialApplicability({ dossier: dossier([]), src: { files: new Map() } as never, contentDigest: "digest-1" });
    expect(a.tracks).toHaveLength(0);
    expect(a.applicability.status).toBe("not_applicable");
  });
  it("fails ownership when the analysis does not match the snapshot", () => {
    const a = assessAdversarialApplicability({ dossier: dossier(ROUTES), src: { files: new Map() } as never, contentDigest: "other-digest" });
    expect(a.ownershipOk).toBe(false);
    expect(a.tracks).toHaveLength(0);
  });
});

describe("general attacker catalogue", () => {
  const attackers = classifyAttackers(IDENTITIES);
  const endpoints = new Set(ROUTES.map((e) => `${e.method} ${e.path}`));
  const campaigns = buildGeneralCampaigns({ routes: ROUTES, attackers, identities: IDENTITIES, security: null, endpoints });

  it("builds campaigns across the four objectives", () => {
    const lanes = new Set(campaigns.map((c) => c.lane));
    expect(lanes.has("broken_access")).toBe(true);
    expect(lanes.has("auth_takeover")).toBe(true);
    expect(lanes.has("business_logic")).toBe(true);
    expect(lanes.has("injection_pivot")).toBe(true);
  });
  it("targets the admin route with a function-authz campaign carrying an access_denied oracle", () => {
    const fa = campaigns.find((c) => c.techniqueId === "function-authz");
    expect(fa).toBeTruthy();
    expect(fa!.target.endpoint).toContain("/api/admin/users");
    expect(fa!.oracle.kind).toBe("access_denied");
    expect(fa!.owasp.length).toBeGreaterThan(0);
  });
  it("only emits bounded HTTP/capture operations and known identities", () => {
    for (const c of campaigns) for (const s of c.steps) {
      expect(["send_request", "capture", "repeat_bounded", "run_parallel_bounded"]).toContain(s.operation);
      if (s.asIdentity && s.asIdentity !== "anonymous") expect(["customer", "customer-2", "admin"]).toContain(s.asIdentity.replace(/#forged$/, ""));
    }
  });
  it("throttles repeated logins with a bounded, rate_limited campaign", () => {
    const lt = campaigns.find((c) => c.techniqueId === "login-throttling");
    expect(lt).toBeTruthy();
    expect(lt!.oracle.kind).toBe("rate_limited");
    expect(lt!.steps[0]!.operation).toBe("repeat_bounded");
    expect(lt!.steps[0]!.repeat).toBeGreaterThan(1);
  });
  it("builds a bounded parallel transfer campaign with a state invariant oracle", () => {
    const race = campaigns.find((c) => c.techniqueId === "race-condition");
    expect(race?.target.endpoint).toBe("POST /api/transfers");
    expect(race?.steps.find((s) => s.operation === "run_parallel_bounded")).toMatchObject({ operation: "run_parallel_bounded", parallel: 4 });
    expect(race?.oracle.kind).toBe("numeric_nonnegative");
  });
  it("produces campaigns that all pass the safety compiler with normalized route keys", () => {
    const keys = endpointKeys(dossier(ROUTES));
    const rules = clampRules(null, "standard", { allowedEndpoints: [...keys], allowedIdentities: ["anonymous", "customer", "customer-2", "admin"], allowedTools: [], allowedFiles: [], allowedDataClasses: [], allowedMutationTypes: [], canaries: [] });
    const compiled = compilePlan(campaigns, { roe: rules, endpoints: keys, identities: new Set(["customer", "customer-2", "admin"]), tools: new Set(), files: new Set(), maxCampaigns: 24 });
    expect(compiled.rejected).toHaveLength(0);
  });
});

describe("general oracles decide from observed behaviour only", () => {
  const base = { id: "c", seq: 1, lane: "broken_access", techniqueId: "t", priority: "high", title: "x", target: { componentId: "app", endpoint: "GET /api/admin/users" }, attacker: "user", resetStrategy: "none", steps: [{ operation: "send_request", asIdentity: "customer", target: "GET /api/admin/users", inputClass: "x" }], source: "catalogue", severity: "high", owasp: [], asset: "a", boundary: "b" } as unknown as CatalogCampaign;
  const withOracle = (oracle: CatalogCampaign["oracle"]): CatalogCampaign => ({ ...base, oracle });

  it("access_denied: requires a successful authorized control before a 403 holds or a 200 crosses", () => {
    expect(judgeCampaign(withOracle({ kind: "access_denied" }), obs({ turns: [turn(200), turn(403)] })).status).toBe("passed");
    expect(judgeCampaign(withOracle({ kind: "access_denied" }), obs({ turns: [turn(200), turn(200, { id: 1 })] })).status).toBe("failed");
    expect(judgeCampaign(withOracle({ kind: "access_denied" }), obs({ turns: [turn(404)] })).status).toBe("inconclusive");
  });
  it("rate_limited: a 429 among attempts holds, all-accepted crosses", () => {
    expect(judgeCampaign(withOracle({ kind: "rate_limited" }), obs({ turns: [turn(200), turn(200), turn(429)] })).status).toBe("passed");
    expect(judgeCampaign(withOracle({ kind: "rate_limited" }), obs({ turns: [turn(200), turn(200), turn(200)] })).status).toBe("failed");
  });
  it("logic_rejected: requires a valid control before a 4xx holds or a 2xx crosses", () => {
    expect(judgeCampaign(withOracle({ kind: "logic_rejected" }), obs({ turns: [turn(201), turn(400)] })).status).toBe("passed");
    expect(judgeCampaign(withOracle({ kind: "logic_rejected" }), obs({ turns: [turn(201), turn(201, { ok: true })] })).status).toBe("failed");
    expect(judgeCampaign(withOracle({ kind: "logic_rejected" }), obs({ turns: [turn(422)] })).status).toBe("inconclusive");
  });
  it("field_unchanged: reflecting the privileged value crosses", () => {
    expect(judgeCampaign(withOracle({ kind: "field_unchanged", field: "role", value: "admin" }), obs({ turns: [turn(200), turn(200), turn(200, { role: "admin" })] })).status).toBe("failed");
    expect(judgeCampaign(withOracle({ kind: "field_unchanged", field: "role", value: "admin" }), obs({ turns: [turn(200), turn(200), turn(200, { role: "user" })] })).status).toBe("passed");
    expect(judgeCampaign(withOracle({ kind: "field_unchanged", field: "role", value: "admin" }), obs({ turns: [turn(422), turn(404), turn(404)] })).status).toBe("inconclusive");
  });
  it("injection_inert: diverging true/false probes cross, matching probes hold", () => {
    expect(judgeCampaign(withOracle({ kind: "injection_inert" }), obs({ turns: [turn(200, { rows: [] }), turn(200, { rows: Array.from({ length: 40 }, (_, i) => i) }), turn(200, {})] })).status).toBe("failed");
    expect(judgeCampaign(withOracle({ kind: "injection_inert" }), obs({ turns: [turn(200, { rows: [] }), turn(200, { rows: [] }), turn(200, { rows: [] })] })).status).toBe("passed");
  });
  it("numeric_nonnegative: confirms a race only after a returned invariant becomes negative", () => {
    const oracle: CatalogCampaign["oracle"] = { kind: "numeric_nonnegative", fields: ["from", "balance"] };
    expect(judgeCampaign(withOracle(oracle), obs({ turns: [turn(200, { from: 40 }), turn(200, { from: -20 })] })).status).toBe("failed");
    expect(judgeCampaign(withOracle(oracle), obs({ turns: [turn(200, { from: 40 }), turn(409, { error: "insufficient" })] })).status).toBe("passed");
    expect(judgeCampaign(withOracle(oracle), obs({ turns: [turn(200, { ok: true })] })).status).toBe("inconclusive");
  });
  it("is inconclusive when the oracle preconditions are not established", () => {
    const o = obs({ turns: [turn(200)], preconditions: { appBooted: true, targetReached: true, fixtureReady: true, oracleReady: false } });
    expect(judgeCampaign(withOracle({ kind: "access_denied" }), o).status).toBe("inconclusive");
  });
  it("preserves the exact sanitized setup node reason when a campaign never ran", () => {
    const o = obs({ ran: false, turns: [], blockedReason: "customer sign-in: HTTP 401 invalid credentials" });
    const verdict = judgeCampaign(withOracle({ kind: "access_denied" }), o);
    expect(verdict.status).toBe("blocked");
    expect(verdict.detail).toContain("customer sign-in: HTTP 401");
  });
});

describe("general lane readiness", () => {
  const attackers = classifyAttackers(IDENTITIES);
  const endpoints = new Set(ROUTES.map((e) => `${e.method} ${e.path}`));
  const campaigns = buildGeneralCampaigns({ routes: ROUTES, attackers, identities: IDENTITIES, security: null, endpoints });
  it("marks a lane available exactly when a campaign targets it", () => {
    const lanes = generalLaneReadiness(campaigns, true, true);
    const ba = lanes.find((l) => l.lane === "broken_access")!;
    expect(ba.available).toBe(true);
    const de = lanes.find((l) => l.lane === "data_exposure")!;
    expect(de.available).toBe(false); // folded into broken access control
  });
  it("blocks every lane when no runtime is available", () => {
    const lanes = generalLaneReadiness(campaigns, false, true);
    expect(lanes.every((l) => !l.available)).toBe(true);
  });
});

describe("AI attacker hypotheses become gated campaigns", () => {
  const attackers = classifyAttackers(IDENTITIES);
  const endpoints = endpointKeys(dossier(ROUTES)); // normalized route keys, exactly as the orchestrator passes them
  const hyps: AttackHypothesis[] = [
    { technique: "function-authz", endpoint: "GET /api/admin/users", asIdentity: "customer" },
    { technique: "object-authz", endpoint: "GET /api/notes/:id", asIdentity: "customer", crossIdentity: "customer-2" },
    { technique: "injection-differential", endpoint: "GET /api/notes/search", asIdentity: "customer" },
    { technique: "function-authz", endpoint: "GET /not/a/route", asIdentity: "customer" }, // unknown endpoint: dropped
  ];
  const campaigns = campaignsFromHypotheses(hyps, { routes: ROUTES, attackers });

  it("builds a typed campaign per hypothesis that names a known route, tagged attacker_model", () => {
    expect(campaigns).toHaveLength(3);
    expect(campaigns.every((c) => c.source === "attacker_model")).toBe(true);
    expect(campaigns.every((c) => c.steps.every((s) => ["send_request", "repeat_bounded", "run_parallel_bounded"].includes(s.operation)))).toBe(true);
  });

  it("every AI-proposed campaign passes the same safety compiler the deterministic catalogue does", () => {
    const rules = clampRules(null, "standard", { allowedEndpoints: [...endpoints], allowedIdentities: ["anonymous", "customer", "customer-2", "admin"], allowedTools: [], allowedFiles: [], allowedDataClasses: [], allowedMutationTypes: [], canaries: [] });
    const compiled = compilePlan(campaigns, { roe: rules, endpoints, identities: new Set(["customer", "customer-2", "admin"]), tools: new Set(), files: new Set(), maxCampaigns: 24 });
    expect(compiled.rejected).toHaveLength(0);
    expect(compiled.campaigns).toHaveLength(campaigns.length);
  });
});

describe("general chain templates", () => {
  it("confirms an object-authz chain only when its link is confirmed by trusted evidence", () => {
    const c: CatalogCampaign = { id: "gen-object-authz-1", seq: 1, lane: "broken_access", techniqueId: "object-authz", priority: "critical", title: "IDOR", target: { componentId: "app", endpoint: "GET /api/notes/:id" }, attacker: "cross_user", resetStrategy: "db_reseed", steps: [], source: "catalogue", severity: "high", owasp: [], asset: "records", boundary: "object authorization" } as unknown as CatalogCampaign;
    const confirmed = new Map<string, CampaignVerdict>([["gen-object-authz-1", { status: "failed", confirmed: true, severity: "high", detail: "crossed", expected: "e", observed: "o", executionIds: ["x1"], evidence: [ev] }]]);
    const chainsConfirmed = correlateChains([c], confirmed);
    const idor = chainsConfirmed.find((x) => x.id === "chain-idor-data-exfil");
    expect(idor?.verdict).toBe("confirmed");

    const held = new Map<string, CampaignVerdict>([["gen-object-authz-1", { status: "passed", confirmed: false, severity: "high", detail: "held", expected: "e", observed: "o", executionIds: ["x1"], evidence: [ev] }]]);
    const chainsHeld = correlateChains([c], held);
    expect(chainsHeld.find((x) => x.id === "chain-idor-data-exfil")?.verdict).toBe("rejected");
  });
});
