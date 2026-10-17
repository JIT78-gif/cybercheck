import { describe, expect, it } from "vitest";
import type { Evidence, SecurityFinding, SecurityObligation, SecurityProof } from "@cybercheck/contracts";
import { correlate } from "../src/security/correlate.ts";

const finding = (over: Partial<SecurityFinding>): SecurityFinding => ({
  id: "S1", status: "suspected", severity: "high", lane: "injection", category: "sql-injection",
  title: "A database query is built as text (src/database.js, reached from GET /api/data/customers)",
  cwe: ["CWE-89"], owasp: [], expected: "parameters", observed: "text query at src/database.js:20, reached from GET /api/data/customers", impact: "",
  location: { path: "src/database.js", line: 20 }, evidence: [{ path: "src/database.js", line: 20 }], trust: "tool_observation",
  detector: { tool: "semgrep", version: "1", rule: "cc.js.sql-string-built" }, secret: null, confirmation: "Suspected.",
  obligationIds: ["sec:endpoint:GET /api/data/customers:input-handling"], executionIds: [], remediation: "", rootCause: "sast:sql:GET /api/data/customers",
  ...over,
});
const proof = (over: Partial<SecurityProof>): SecurityProof => ({
  id: "P1", type: "input_differential", target: { kind: "endpoint", ref: "GET /api/data/customers" },
  obligationIds: ["sec:endpoint:GET /api/data/customers:input-handling"], identities: ["customer"],
  preconditions: [{ what: "signed in", met: true }, { what: "oracle", met: true }], reset: "none_needed", payloadClass: "boolean clause",
  expected: "A boolean clause does not change the result", observed: "a boolean payload changed the result deterministically",
  evidence: [], source: [], executionIds: ["e1"], artifacts: [], verdict: "failed", reason: "The input is interpreted as query logic.", limitations: [], redacted: true, requests: 3,
  ...over,
});
const ob = (over: Partial<SecurityObligation> = {}): SecurityObligation => ({ id: "sec:endpoint:GET /api/data/customers:input-handling", lane: "injection", category: "injection", asset: { kind: "endpoint", ref: "x", label: "x" }, requirement: "r", expectedControl: "c", applicabilityEvidence: [], standards: ["CWE-89"], priority: "critical", proofStrategy: "runtime_proof", dependencies: [], status: "unsupported", reason: "Round 2", executionIds: [], findingIds: [], ...over });

describe("proof correlation", () => {
  it("upgrades a suspected injection finding to confirmed on a reproduced proof, and fails its obligation", () => {
    const r = correlate([finding({})], [proof({})], [ob()]);
    const s1 = r.findings.find((f) => f.id === "S1")!;
    expect(s1).toMatchObject({ status: "confirmed", basis: "runtime_confirmed", trust: "controlled_reproduction", proofIds: ["P1"] });
    expect(r.obligations[0]).toMatchObject({ status: "failed" });
    expect(r.obligations[0]!.findingIds).toContain("S1");
  });

  it("never hides a static finding a passing proof could not reproduce; it stays suspected with a note", () => {
    const r = correlate([finding({})], [proof({ verdict: "passed", reason: "held", observed: "no change" })], [ob()]);
    const s1 = r.findings.find((f) => f.id === "S1")!;
    expect(s1.status).toBe("suspected");
    expect(s1.confirmation).toMatch(/did not reproduce it|stays suspected/);
    expect(r.obligations[0]).toMatchObject({ status: "passed" });
  });

  it("synthesizes a confirmed finding for a reproduced vulnerability no static rule could see (IDOR)", () => {
    const idor = proof({ id: "P9", type: "authz_object", target: { kind: "endpoint", ref: "GET /api/users/:id" }, obligationIds: ["sec:endpoint:GET /api/users/:id:object-authorization"], verdict: "failed", observed: "returned another identity's record" });
    const evidence = new Map<string, Evidence>([["GET /api/users/:id", { path: "src/app.js", line: 32 }]]);
    const r = correlate([], [idor], [ob({ id: "sec:endpoint:GET /api/users/:id:object-authorization" })], evidence);
    const synth = r.findings.find((f) => f.category === "idor")!;
    expect(synth).toMatchObject({ status: "confirmed", basis: "runtime_confirmed", location: { path: "src/app.js", line: 32 }, proofIds: ["P9"] });
    expect(synth.evidence).toEqual([{ path: "src/app.js", line: 32 }]);
    expect(r.obligations[0]).toMatchObject({ status: "failed" });
  });

  it("marks a blocked proof's obligation inconclusive and leaves the finding suspected", () => {
    const r = correlate([finding({})], [proof({ verdict: "blocked", reason: "the app did not boot" })], [ob()]);
    expect(r.findings.find((f) => f.id === "S1")!.status).toBe("suspected");
    expect(r.obligations[0]).toMatchObject({ status: "inconclusive", reason: "the app did not boot" });
  });

  it("never lets a proof settle an obligation it does not name", () => {
    const other = ob({ id: "sec:endpoint:GET /api/other:input-handling" });
    const r = correlate([finding({})], [proof({})], [ob(), other]);
    expect(r.obligations.find((o) => o.id === other.id)!.status).toBe("unsupported");
  });

  it("attaches a reproducing proof to an already-confirmed static finding (CORS) without changing its status", () => {
    const cors = finding({ id: "S2", status: "confirmed", lane: "configuration", category: "cors", title: "CORS allows every origin", obligationIds: ["sec:config:cors"], basis: "component_present" });
    const corsProof = proof({ id: "P31", type: "cors_response", target: { kind: "endpoint", ref: "GET /x" }, obligationIds: ["sec:config:cors"], verdict: "failed" });
    const r = correlate([cors], [corsProof], [ob({ id: "sec:config:cors" })]);
    const s2 = r.findings.find((f) => f.id === "S2")!;
    expect(s2.status).toBe("confirmed");
    expect(s2.basis).toBe("runtime_confirmed");
    expect(s2.proofIds).toContain("P31");
  });

  it("does not let a proof confirm a finding of a category it is not an oracle for (throttling never confirms token forgery)", () => {
    const token = finding({ id: "S2", lane: "auth", category: "token-integrity", title: "unsigned token (reached from POST /api/login)", observed: "at src/auth.js:5, reached from POST /api/login", obligationIds: ["sec:sast:token-integrity"] });
    const throttle = proof({ id: "P31", type: "login_throttling", target: { kind: "endpoint", ref: "POST /api/login" }, obligationIds: ["sec:endpoint:POST /api/login:login-throttling"], verdict: "failed" });
    const r = correlate([token], [throttle], [ob()]);
    expect(r.findings.find((f) => f.id === "S2")!.status).toBe("suspected");
  });
});
