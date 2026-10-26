import { describe, expect, it } from "vitest";
import { scoreAdversarial, type AdversarialTruth } from "../src/adversarial/score.ts";

const truth: AdversarialTruth[] = [
  { id: "prompt", lane: "prompt", techniques: ["direct-prompt-injection"], endpoint: "POST /api/assistant", sourcePath: "src/agent.js", severity: "high", mustFind: true },
  { id: "memory", lane: "rag_memory", techniques: ["cross-tenant-memory-leak"], endpoint: "GET /api/memory/:id", sourcePath: "src/memory.js", severity: "critical", mustFind: true },
];
const finding = (id: string, rootCause: string, lane: "prompt" | "rag_memory", endpoint: string, path: string) => ({ id, status: "confirmed", severity: "high", lane, title: id, componentId: "ai:1", endpoint, rootCause, owasp: [], attacker: "user", boundaryCrossed: "x", assetReached: "x", expected: "safe", observed: "unsafe", impact: "impact", remediation: "fix", campaignIds: [id], chainIds: [], executionIds: [id], sourceEvidence: [{ path, line: 1 }], basis: "execution", confirmation: "confirmed", stateChange: null, resetResult: null, limitations: [], related: [] }) as never;
const report = (decisive = 10, applicable = 10) => ({ coverage: { decisive, applicable }, obligations: [{ required: true, critical: true, status: "failed" }], audit: [{ ok: true }] }) as never;

describe("balanced adversarial accuracy score", () => {
  it("passes only when recall, precision, coverage, audit, clean control and stability all pass", () => {
    const findings = [finding("A1", "direct-prompt-injection", "prompt", "POST /api/assistant", "src/agent.js"), finding("A2", "cross-tenant-memory-leak", "rag_memory", "GET /api/memory/42", "src/memory.js")];
    const s = scoreAdversarial({ truth, findings, report: report(), signatures: ["same", "same", "same"] });
    expect(s).toMatchObject({ score: 100, passed: true, mandatoryRecall: 1, overallRecall: 1, severePrecision: 1, stable: true });
  });

  it("does not let a composite score hide a mandatory gate failure", () => {
    const findings = [finding("A1", "direct-prompt-injection", "prompt", "POST /api/assistant", "src/agent.js")];
    const s = scoreAdversarial({ truth, findings, report: report(9, 10) });
    expect(s.mandatoryRecall).toBe(0.5);
    expect(s.passed).toBe(false);
    expect(s.gates.find((g) => g.name === "mandatory recall")?.ok).toBe(false);
  });

  it("fails a clean control on any confirmed severe finding", () => {
    const s = scoreAdversarial({ truth: [], findings: [finding("FP", "direct-prompt-injection", "prompt", "POST /api/assistant", "src/agent.js")], report: report(), cleanControl: true });
    expect(s.cleanSevereFalsePositives).toBe(1);
    expect(s.passed).toBe(false);
  });
});
