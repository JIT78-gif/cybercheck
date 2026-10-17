import { describe, expect, it } from "vitest";
import type { Obligation } from "@cybercheck/contracts";
import { DECISION_LABEL, completeness, releaseDecision } from "../src/testing/assurance.ts";

const ob = (id: string, status: Obligation["status"], extra: Partial<Obligation> = {}): Obligation => ({ id, layer: "api", asset: { kind: "endpoint", ref: id, label: id }, objective: id, priority: "high", oracle: { source: "code_contract", expected: "x", evidence: [] }, status, reason: status === "passed" ? null : "why", origin: "dossier", executionIds: [], findingIds: [], proofClass: "business_behavior", oracleStrength: "strong", reachedTarget: true, ...extra });

const decide = (obs: Obligation[], target: number) => releaseDecision({ obs, findings: [], completeness: completeness(obs, target), auditOk: true, thresholdsSet: false });

describe("release decision", () => {
  const core = ["install", "build", "typecheck", "boot"].map((s) => ob(`env:${s}:.`, "passed", { layer: "environment", proofClass: "static" }));

  it("says the selected checks passed, not ready to release, when a run met its own target but not the release bar", () => {
    // 8 of 10 checks decisive and passed: 80% completeness, above a 70% target, below the 90% release bar.
    const obs = [...core, ...Array.from({ length: 4 }, (_, i) => ob(`api:${i}`, "passed")), ob("api:x", "inconclusive"), ob("api:y", "inconclusive")];
    const r = decide(obs, 70);
    expect(r.decision).toBe("selected_checks_passed");
    expect(r.gates.find((g) => g.id === "completeness")?.ok).toBe(true);
    expect(r.gates.find((g) => g.id === "release_evidence")).toMatchObject({ ok: false });
    expect(DECISION_LABEL[r.decision]).toBe("Selected checks passed (not enough evidence for a release decision)");
  });

  it("is ready only with every gate including the release bar, and otherwise says what is missing", () => {
    expect(decide([...core, ...Array.from({ length: 6 }, (_, i) => ob(`api:${i}`, "passed"))], 70).decision).toBe("ready");
    // Below the run's own target as well: cybercheck could not test enough.
    const thin = decide([...core, ob("api:a", "passed"), ...Array.from({ length: 6 }, (_, i) => ob(`api:${i}`, "inconclusive"))], 70);
    expect(thin.decision).toBe("not_ready_insufficient_evidence");
    expect(DECISION_LABEL[thin.decision]).toBe("Not ready: cybercheck could not test enough");
  });
});
