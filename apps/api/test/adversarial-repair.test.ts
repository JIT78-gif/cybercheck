import { describe, expect, it } from "vitest";
import type { AdversarialCampaign, AdversarialFinding, Obligation } from "@cybercheck/contracts";
import { adversarialRepairScope } from "../src/adversarial/repair.ts";
import { judgeAttempt, repairAdapterFor, reviewEdits } from "../src/testing/repair.ts";

// AI Adversarial repairs on the shared repair engine: scope selection, the focused-rerun policy, the deterministic
// validation policy, and the verification rule (only a decisively held attack verifies a repair).

const ev = (path: string, line = 1) => ({ path, line });

function finding(over: Partial<AdversarialFinding> = {}): AdversarialFinding {
  return {
    id: "A1", status: "confirmed", severity: "high", lane: "broken_access", title: "A non-admin can call GET /api/admin/overview",
    componentId: "app", endpoint: "GET /api/admin/overview", rootCause: "function-authz", owasp: [], attacker: "user",
    boundaryCrossed: "function authorization", assetReached: "an administrator-only function",
    expected: "The route refuses non-admins.", observed: "A 200 response granted access.", impact: "x", remediation: "Enforce the role on the server.",
    campaignIds: ["gen-function-authz-1"], chainIds: [], executionIds: ["e1"],
    sourceEvidence: [ev("src/app.js", 34), ev("test/app.test.js", 3), ev("package.json", 1)],
    basis: "execution", confirmation: "Controlled runtime reproduction.", stateChange: null, resetResult: null, limitations: [], related: [],
    ...over,
  } as AdversarialFinding;
}

function campaign(id: string, status: AdversarialCampaign["status"], over: Partial<AdversarialCampaign> = {}): AdversarialCampaign {
  return {
    id, seq: 1, lane: "broken_access", techniqueId: "function-authz", priority: "critical", title: id,
    target: { componentId: "app", endpoint: "GET /api/admin/overview" }, attacker: "user", resetStrategy: "none",
    steps: [], status, reason: status, executionIds: ["e1"], findingIds: [], limitations: [], source: "catalogue", ...over,
  } as AdversarialCampaign;
}

describe("adversarial repair scope", () => {
  it("allows only editable application source, never tests or configuration", () => {
    const s = adversarialRepairScope(finding(), []);
    expect(s.files).toEqual(["src/app.js"]);
  });

  it("reproduces exactly the confirming campaigns", () => {
    expect(adversarialRepairScope(finding(), []).reproduction).toEqual(["gen-function-authz-1"]);
  });

  it("selects as regression only campaigns that already held on the same endpoint, lane or component", () => {
    const campaigns = [
      campaign("gen-function-authz-1", "failed"),                                                     // the target itself: never regression
      campaign("held-same-endpoint", "passed"),                                                       // held, same endpoint: included
      campaign("held-other", "passed", { lane: "injection_pivot", target: { componentId: "other", endpoint: "GET /x" } }), // unrelated: excluded
      campaign("blocked-same", "blocked"),                                                            // never held: excluded
      campaign("crossed-same", "failed"),                                                             // crossed, not a held baseline: excluded
    ];
    expect(adversarialRepairScope(finding(), campaigns).regression).toEqual(["held-same-endpoint"]);
  });

  it("defaults to two attempts and scales the estimate", () => {
    const s = adversarialRepairScope(finding(), [], 3);
    expect(s.maxAttempts).toBe(3);
    expect(s.estimate.minutes[1]).toBe(30);
    expect(adversarialRepairScope(finding(), []).maxAttempts).toBe(2);
  });
});

describe("adversarial repair adapter", () => {
  const adapter = repairAdapterFor("adversarial");

  it("is registered for the adversarial check (not the Testing fallback)", () => {
    expect(adapter).not.toBe(repairAdapterFor("testing"));
  });

  it("focuses the validation run on campaign ids, reproduction first", () => {
    const scope = adversarialRepairScope(finding(), [campaign("held-same-endpoint", "passed")]);
    expect(adapter.rerun(scope, "parent-1")).toEqual({ parentRunId: "parent-1", campaignIds: ["gen-function-authz-1", "held-same-endpoint"] });
  });

  it("validates deterministically: no attacker or critic model in the validation run", () => {
    expect(adapter.extraPolicy()).toEqual({ aiAttacker: "off", aiCritic: "off" });
  });

  it("maps the finding into the shared prompt input with its campaigns as reproduction targets", () => {
    const f = adapter.finding(finding());
    expect(f.obligationIds).toEqual(["gen-function-authz-1"]);
    expect(f.actual).toBe("A 200 response granted access.");
    expect(f.location).toEqual({ path: "src/app.js", line: 34 });
  });
});

describe("verification rule on campaign results", () => {
  const scope = adversarialRepairScope(finding(), [campaign("held-same-endpoint", "passed")]);
  const ob = (id: string, status: string) => ({ id, status, objective: id, reason: status, reachedTarget: status === "passed" || status === "failed" }) as unknown as Obligation;
  const before = new Map([["gen-function-authz-1", ob("gen-function-authz-1", "failed")], ["held-same-endpoint", ob("held-same-endpoint", "passed")]]);

  it("verifies only when the attack now holds and nothing regresses", () => {
    const after = new Map([["gen-function-authz-1", ob("gen-function-authz-1", "passed")], ["held-same-endpoint", ob("held-same-endpoint", "passed")]]);
    expect(judgeAttempt(scope, before, after).status).toBe("verified");
  });

  it("never verifies a blocked or inconclusive rerun of the attack", () => {
    for (const s of ["blocked", "inconclusive"]) {
      const after = new Map([["gen-function-authz-1", ob("gen-function-authz-1", s)], ["held-same-endpoint", ob("held-same-endpoint", "passed")]]);
      expect(judgeAttempt(scope, before, after).status).toBe("failed_validation");
    }
  });

  it("reports a regression when a previously held attack now crosses", () => {
    const after = new Map([["gen-function-authz-1", ob("gen-function-authz-1", "passed")], ["held-same-endpoint", ob("held-same-endpoint", "failed")]]);
    expect(judgeAttempt(scope, before, after).status).toBe("regression_introduced");
  });

  it("does not verify when the attack still crosses", () => {
    const after = new Map([["gen-function-authz-1", ob("gen-function-authz-1", "failed")], ["held-same-endpoint", ob("held-same-endpoint", "passed")]]);
    expect(judgeAttempt(scope, before, after).status).toBe("failed_validation");
  });
});

describe("unsafe patches are refused before running", () => {
  const files = new Map([["src/app.js", "app.get('/api/admin/overview', requireAdmin, handler);\n"]]);
  it("refuses removing an authorization guard", () => {
    const problems = reviewEdits([{ path: "src/app.js", find: "app.get('/api/admin/overview', requireAdmin, handler);", replace: "app.get('/api/admin/overview', handler);" }], ["src/app.js"], files);
    expect(problems.join(" ")).toMatch(/weaken authorization/);
  });
  it("allows a fix that keeps the guard while changing the same line", () => {
    const problems = reviewEdits([{ path: "src/app.js", find: "app.get('/api/admin/overview', requireAdmin, handler);", replace: "app.get('/api/admin/overview', requireAdmin, safeHandler);" }], ["src/app.js"], files);
    expect(problems.join(" ")).not.toMatch(/weaken authorization/);
  });
  it("catches common middleware names (requireUser, isAuthenticated, adminOnly)", () => {
    for (const guard of ["requireUser", "isAuthenticated", "adminOnly"]) {
      const text = `app.get('/x', ${guard}, h);\n`;
      const p = reviewEdits([{ path: "src/app.js", find: `app.get('/x', ${guard}, h);`, replace: "app.get('/x', h);" }], ["src/app.js"], new Map([["src/app.js", text]]));
      expect(p.join(" ")).toMatch(/weaken authorization/);
    }
  });
  it("refuses editing a test or a file outside the repair scope", () => {
    expect(reviewEdits([{ path: "test/app.test.js", find: "x", replace: "y" }], ["src/app.js"], files).join(" ")).toMatch(/tests may not be edited/);
  });
});
