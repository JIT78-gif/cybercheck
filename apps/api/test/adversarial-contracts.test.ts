import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AdversarialLane, AdversarialPolicyInput, AdversarialReport, AD_PROFILE_LIMITS, AttackOperation, ExecutionKind, RulesOfEngagement } from "@cybercheck/contracts";

// AI Adversarial Step 2: the contracts are the fixed shape the engine and the UI share. These lock the policy defaults,
// the rules-of-engagement envelope, the typed operation catalogue, the report schema and the execution kinds.

describe("AI Adversarial contracts", () => {
  it("policy input applies safe defaults", () => {
    const p = AdversarialPolicyInput.parse({});
    expect(p).toMatchObject({ profile: "standard", aiAttacker: "auto", aiCritic: "auto", runtime: "auto", targetComponentId: null, baselineRunId: null, attackPackIds: [] });
  });

  it("every profile keeps bounded, non-widening limits", () => {
    for (const prof of ["quick", "standard", "deep"] as const) {
      const l = AD_PROFILE_LIMITS[prof];
      expect(l.stepsPerChain).toBeGreaterThan(0);
      expect(l.requests).toBeGreaterThanOrEqual(l.requestsPerTarget);
      expect(l.costUsd).toBeGreaterThan(0);
    }
    // quick is the cheapest, deep the most expensive.
    expect(AD_PROFILE_LIMITS.quick.costUsd).toBeLessThan(AD_PROFILE_LIMITS.deep.costUsd);
  });

  it("the typed operation catalogue is the only executable surface and external network is off by default", () => {
    expect(AttackOperation.options).toContain("send_message");
    expect(AttackOperation.options).toContain("reset_state");
    // There is no raw-command or arbitrary-navigation operation.
    expect(AttackOperation.options.some((o) => /shell|exec|command|navigate_any/i.test(o))).toBe(false);
    const roe = RulesOfEngagement.parse({ allowedEndpoints: [], allowedIdentities: [], allowedTools: [], allowedFiles: [], allowedDataClasses: [], allowedMutationTypes: [], canaries: [], limits: { requests: 1, requestsPerTarget: 1, authAttempts: 1, stepsPerChain: 1, toolCalls: 1, tokens: 1, timeoutSec: 1, costUsd: 1, concurrency: 1 } });
    expect(roe.externalNetwork).toBe(false);
  });

  it("the execution ledger gained the six adversarial kinds", () => {
    for (const k of ["adversarial_app", "adversarial_fixture", "adversarial_campaign", "adversarial_browser", "adversarial_canary", "adversarial_model"]) {
      expect(ExecutionKind.options).toContain(k);
    }
  });

  it("the contract lanes are exactly the lanes the benchmark was frozen against", () => {
    const frozen = JSON.parse(readFileSync(join(import.meta.dirname, "adversarial-bench/gauntlet-adversarial-frozen.json"), "utf8")) as { aiAdversarialGauntlet: { chains: Array<{ lane: string }> } };
    const benchLanes = new Set(frozen.aiAdversarialGauntlet.chains.map((c) => c.lane));
    for (const lane of benchLanes) expect(AdversarialLane.options, lane).toContain(lane);
  });

  it("a minimal report validates against the schema", () => {
    const report = AdversarialReport.parse({
      schemaVersion: 1,
      engine: "2026-10-18.a1",
      catalogueVersion: "2026-10-18.ac1",
      compilerVersion: "2026-10-18.acc1",
      decision: "not_applicable",
      headline: "No AI component was found.",
      claims: [],
      applicability: { status: "not_applicable", reason: "no AI component", components: [], targets: [], unbound: [] },
      surface: { nodes: [], edges: [] },
      rulesOfEngagement: { allowedEndpoints: [], allowedIdentities: [], allowedTools: [], allowedFiles: [], allowedDataClasses: [], allowedMutationTypes: [], canaries: [], externalNetwork: false, limits: { requests: 0, requestsPerTarget: 0, authAttempts: 0, stepsPerChain: 0, toolCalls: 0, tokens: 0, timeoutSec: 0, costUsd: 0, concurrency: 0 } },
      environment: { requested: "auto", selected: "none", provider: null, fallbackReason: null, isolation: "Nothing was executed." },
      obligations: [],
      obligationCoverage: { decisive: 0, required: 0, criticalDecisive: 0, criticalRequired: 0 },
      coverage: { decisive: 0, applicable: 0 },
      chains: [],
      findings: { confirmed: 0, suspected: 0, rejected: 0, inconclusive: 0, blocked: 0, confirmedCriticalHigh: 0 },
      rejectedHypotheses: [],
      untested: [],
      attacker: { status: "off", provider: null, model: null, hypotheses: 0, uniqueFindings: 0, reason: "off" },
      critic: { status: "off", provider: null, model: null, lowered: 0, reason: "off" },
      usage: { modelRequests: 0, tokensIn: 0, tokensOut: 0, costUsd: null, durationMs: null },
      audit: [],
      versions: { engine: "2026-10-18.a1", catalogue: "2026-10-18.ac1", compiler: "2026-10-18.acc1", snapshotDigest: "d", attackPackDigests: [], runtimeImage: null, provider: null, model: null },
      limitations: [],
    });
    expect(report.decision).toBe("not_applicable");
    expect(AdversarialReport.parse({ ...report, schemaVersion: 2 }).schemaVersion).toBe(2);
  });
});
