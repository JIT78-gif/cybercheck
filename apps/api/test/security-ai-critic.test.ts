import { describe, expect, it } from "vitest";
import type { SecurityFinding } from "@cybercheck/contracts";
import type { AiSession } from "../src/understanding/ai/gateway.ts";
import { reviewSecurityEvidence } from "../src/security/critic.ts";

const finding = { id: "S1", status: "confirmed", severity: "high", lane: "injection", category: "sql-injection", title: "SQL input", cwe: ["CWE-89"], owasp: [], expected: "input is data", observed: "differential", impact: "query changed", location: null, evidence: [], trust: "controlled_reproduction", detector: { tool: "runtime", version: "1", rule: null }, secret: null, confirmation: "proof P1", obligationIds: ["o1"], executionIds: ["e1"], remediation: "parameters", rootCause: "sql:1", proofIds: ["P1"], basis: "runtime_confirmed" } as SecurityFinding;

describe("optional Security AI critic", () => {
  it("never blocks deterministic results when disabled or unavailable", async () => {
    await expect(reviewSecurityEvidence(null, "off", [finding])).resolves.toMatchObject({ ran: false, reason: expect.stringMatching(/disabled/) });
    await expect(reviewSecurityEvidence(null, "auto", [finding])).resolves.toMatchObject({ ran: false, reason: expect.stringMatching(/No AI provider/) });
  });

  it("keeps reviews only for existing finding ids and cannot change their verdict", async () => {
    const session = {
      opts: { models: { critic: "critic-model" } },
      json: async () => ({ reviews: [{ findingId: "S1", verdict: "challenge", reason: "The impact needs a state oracle." }, { findingId: "invented", verdict: "supported", reason: "made up" }], summary: "One challenge." }),
    } as unknown as AiSession;
    const before = structuredClone(finding);
    const result = await reviewSecurityEvidence(session, "auto", [finding]);
    expect(result).toMatchObject({ ran: true, proposals: 2, accepted: 1, model: "critic-model", reviews: [{ findingId: "S1", verdict: "challenge" }] });
    expect(finding).toEqual(before);
  });
});
