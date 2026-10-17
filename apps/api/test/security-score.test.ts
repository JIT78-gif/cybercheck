import { describe, expect, it } from "vitest";
import type { SecurityFinding, SecurityRunDetail, TestExecution } from "@cybercheck/contracts";
import { scoreSecurity, securityMatch, type SecurityExpected } from "./security-score.ts";

const finding = (over: Partial<SecurityFinding>): SecurityFinding => ({
  id: "S1",
  status: "suspected",
  severity: "high",
  lane: "injection",
  category: "sql-injection",
  title: "A database query is built as text (src/database.js, reached from GET /api/data/customers)",
  cwe: ["CWE-89"],
  owasp: [],
  expected: "Queries use parameters.",
  observed: "A database query is built as text at src/database.js:20.",
  impact: "",
  location: { path: "src/database.js", line: 20 },
  evidence: [{ path: "src/database.js", line: 20 }],
  trust: "tool_observation",
  detector: { tool: "semgrep", version: "1.95.0", rule: "cc.js.sql-string-built" },
  secret: null,
  confirmation: "Suspected.",
  obligationIds: [],
  executionIds: ["E1"],
  remediation: "",
  rootCause: "sast:sql:GET /api/data/customers",
  ...over,
});

const key = (defects: NonNullable<SecurityExpected["defects"]>, extra: Partial<SecurityExpected> = {}): SecurityExpected => ({ project: "p", commands: {}, expectedOutcomes: {}, defects, ...extra });
const sql = { id: "sqli", track: "security", category: "OWASP-A03-injection", summary: "", path: "src/database.js", line: 19, detectableBy: "security_probe", endpoint: "GET /api/data/customers", title: "SQL injection|query", mustFind: true };
const idor = { id: "idor", track: "security", category: "OWASP-A01-access-control", summary: "", path: "src/app.js", line: 32, detectableBy: "", endpoint: "GET /api/users/:id", title: "IDOR|access|password", mustFind: true };
const logs = { id: "logs", track: "security", category: "OWASP-A09-logging", summary: "", path: "src/app.js", line: 26, detectableBy: "static", endpoint: "POST /api/login", title: "password|credential|log", mustFind: false };

const scanExec = (network: boolean) => ({ id: "E1", kind: "security_scan", network }) as TestExecution;
const run = (findings: SecurityFinding[], over: Partial<SecurityRunDetail> = {}): SecurityRunDetail =>
  ({
    findings,
    executions: [scanExec(false)],
    report: { decision: "not_ready_insufficient_evidence", coverage: { decisive: 30, applicable: 90, criticalDecisive: 1, criticalApplicable: 10 }, audit: [{ check: "a", ok: true, detail: "" }] },
    usage: { costUsd: 0 },
    ...over,
  }) as unknown as SecurityRunDetail;

describe("security scorer", () => {
  it("matches on the endpoint plus the defect's words", () => {
    expect(securityMatch(finding({}), sql)).toBeGreaterThan(0);
  });

  it("never credits a finding whose CWE belongs to another category, even close by and sharing a word", () => {
    const plain = finding({ id: "S2", lane: "crypto", category: "password storage", title: "Passwords are compared as plain text", cwe: ["CWE-256", "CWE-916"], location: { path: "src/app.js", line: 26 }, evidence: [{ path: "src/app.js", line: 26 }], observed: "The sign-in handler compares the password with ===." });
    expect(securityMatch(plain, idor)).toBe(0);
  });

  it("does not read 'log' out of 'login': the endpoint's own words are not behaviour", () => {
    const token = finding({ id: "S3", lane: "auth", category: "token-integrity", cwe: [], title: "A token has no signature (src/auth.js, reached from POST /api/login)", observed: "No signature.", location: { path: "src/auth.js", line: 5 }, evidence: [{ path: "src/app.js", line: 26 }] });
    expect(securityMatch(token, logs)).toBe(0);
  });

  it("gives half credit to a suspected match and full credit to a confirmed one", () => {
    expect(scoreSecurity(run([finding({})]), key([sql])).rows[0]!.credit).toBe(0.5);
    expect(scoreSecurity(run([finding({ status: "confirmed" })]), key([sql])).rows[0]!.credit).toBe(1);
  });

  it("lets one finding satisfy at most one defect", () => {
    const sql2 = { ...sql, id: "sqli-2" };
    const s = scoreSecurity(run([finding({})]), key([sql, sql2]));
    expect(s.counts.found).toBe(1);
  });

  it("counts duplicates of one root cause once", () => {
    const s = scoreSecurity(run([finding({}), finding({ id: "S9" })]), key([sql]));
    expect(s.counts.duplicates).toBe(1);
    expect(s.counts.reported).toBe(1);
  });

  it("holds a confirmed finding outside the key for review instead of passing the confirmed gate", () => {
    const cve = finding({ id: "S4", status: "confirmed", severity: "medium", lane: "dependencies", category: "dependencies", title: "qs 6.14.2 has a known vulnerability", cwe: ["CWE-1395"], location: { path: "package-lock.json", line: 50 }, evidence: [], rootCause: "dep:qs" });
    const s = scoreSecurity(run([finding({}), cve]), key([sql]));
    expect(s.counts.needsReview).toBe(1);
    expect(s.targets.find((t) => t.name.startsWith("Confirmed findings"))!.ok).toBeNull();
    expect(s.precision.low).toBe(0.5);
    expect(s.precision.high).toBe(1);
  });

  it("fails a control on any critical or high finding, suspected included", () => {
    const s = scoreSecurity(run([finding({})]), key([]));
    expect(s.control).toBe(true);
    expect(s.targets.find((t) => t.name.startsWith("Control"))!.ok).toBe(false);
    expect(scoreSecurity(run([finding({ severity: "low" })]), key([])).targets.find((t) => t.name.startsWith("Control"))!.ok).toBe(true);
  });

  it("counts a documented non-defect as a known false finding", () => {
    const s = scoreSecurity(run([finding({ title: "The health route is public by design", observed: "", expected: "", category: "auth", cwe: [], rootCause: "x" })]), key([], { mustNotReport: ["The health route being public by design"] }));
    expect(s.counts.knownFalse).toBe(1);
  });

  it("flags a scan that ran with the network on, and evidence outside the snapshot", () => {
    const s = scoreSecurity(run([finding({ evidence: [{ path: "src/other.js", line: 3 }] })], { executions: [scanExec(true)] }), key([sql]), new Map([["src/database.js", 40]]));
    expect(s.targets.find((t) => t.name.startsWith("Zero unsafe"))!.ok).toBe(false);
    expect(s.targets.find((t) => t.name.startsWith("Evidence ownership"))!.ok).toBe(false);
  });
});
