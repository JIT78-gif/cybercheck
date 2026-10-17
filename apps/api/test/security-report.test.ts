import { describe, expect, it } from "vitest";
import type { AnalyzeReadiness, SecurityFinding, SecurityObligation, TestExecution } from "@cybercheck/contracts";
import { buildSecurityReport, securityAudit } from "../src/security/report.ts";
import { validateFindings } from "../src/security/validate.ts";
import type { ToolRun } from "../src/security/scan.ts";
import { sourceFromFiles } from "../src/understanding/source.ts";

// Validation, the release decision and the audit (Security Round 1, step 5).

const src = sourceFromFiles({ "src/app.js": "a\nb\nc\nd\n" });
const exec = { id: "exec-1" } as TestExecution;
const finding = (over: Partial<SecurityFinding>): SecurityFinding => ({
  id: "S1", status: "confirmed", severity: "medium", lane: "configuration", category: "cors", title: "t", cwe: [], owasp: [], expected: "", observed: "", impact: "", location: { path: "src/app.js", line: 2 }, evidence: [{ path: "src/app.js", line: 2 }], trust: "tool_observation",
  detector: { tool: "semgrep", version: "1.95.0", rule: "r" }, secret: null, confirmation: "c", obligationIds: [], executionIds: ["exec-1"], remediation: "", rootCause: "x", ...over,
});
const ob = (over: Partial<SecurityObligation>): SecurityObligation => ({ id: "o", lane: "secrets", category: "secrets", asset: { kind: "repository", ref: ".", label: "." }, requirement: "r", expectedControl: "c", applicabilityEvidence: [], standards: ["CWE-1"], priority: "high", proofStrategy: "secret_scan", dependencies: [], status: "passed", reason: "ok", executionIds: ["exec-1"], findingIds: [], ...over });
const ready: AnalyzeReadiness = { level: "READY", issues: [], runnableLanes: [] };
const okRuns: ToolRun[] = (["gitleaks", "semgrep", "osv", "trivy"] as const).map((name) => ({ name, ok: true, exitCode: 0, output: {}, problem: null }));
const versions = { semgrep: "1.95.0", gitleaks: "8.21.2", osvScanner: "1.9.1", trivy: "0.74.0", osvDatabaseAt: "2026-10-14T12:04:03Z", trivyChecksAt: "2026-10-14T12:04:04Z" };
const report = (obligations: SecurityObligation[], findings: SecurityFinding[], over: Partial<Parameters<typeof buildSecurityReport>[0]> = {}) =>
  buildSecurityReport({ engine: "test", readiness: ready, obligations, findings, executions: [exec], runs: okRuns, versions, toolImage: "img", rulePackHash: "hash", scanExecutionId: "exec-1", scanTruncated: false, unsupportedLanguages: [], skippedTestFileMatches: 0, validationNotes: 0, ...over });

describe("finding validation", () => {
  it("drops evidence that is not in this snapshot and lowers a confirmation it leaves unsupported", () => {
    const { findings, notes } = validateFindings([finding({ location: { path: "src/other.js", line: 1 }, evidence: [{ path: "src/other.js", line: 1 }, { path: "src/app.js", line: 99 }] })], src, [exec]);
    expect(findings[0]).toMatchObject({ status: "suspected", evidence: [], location: null, confirmation: expect.stringMatching(/Downgraded: none of its evidence could be verified/) });
    expect(notes.length).toBeGreaterThan(0);
  });

  it("never lets a scanner confirm injection or authorization, or cite a run that is not this one", () => {
    const { findings } = validateFindings([finding({ id: "S1", category: "sql-injection", lane: "injection" }), finding({ id: "S2", executionIds: ["exec-from-another-run"] })], src, [exec]);
    expect(findings[0]).toMatchObject({ status: "suspected", confirmation: expect.stringMatching(/confirmed only by a runtime proof/) });
    expect(findings[1]).toMatchObject({ status: "suspected", executionIds: [] });
  });

  it("keeps a secret file confirmed from the intake record, which has no readable evidence by design", () => {
    const { findings } = validateFindings([finding({ category: "secrets", lane: "secrets", trust: "source_evidence", rootCause: "secret-file:.env", location: null, evidence: [], executionIds: [] })], src, [exec]);
    expect(findings[0]!.status).toBe("confirmed");
  });
});

describe("release decision and report", () => {
  it("is ready only with every critical obligation decided, the coverage bar met and no confirmed high finding", () => {
    const all = [ob({ id: "a", priority: "critical" }), ob({ id: "b" }), ob({ id: "c", status: "not_applicable", reason: "n/a" })];
    expect(report(all, []).decision).toBe("ready_with_evidence");
    expect(report(all, [finding({ severity: "medium" })]).decision).toBe("ready_with_evidence");
    expect(report(all, [finding({ severity: "high" })]).decision).toBe("not_ready_security_findings");
    // Suspected findings never block on their own, but runtime proofs left to Round 2 do keep coverage below the bar.
    expect(report([...all, ob({ id: "d", priority: "critical", status: "unsupported", reason: "Round 2", proofStrategy: "runtime_proof" })], [finding({ status: "suspected", severity: "critical" })]).decision).toBe("not_ready_insufficient_evidence");
    expect(report(all, [], { toolImage: null, versions: null, runs: okRuns.map((r) => ({ ...r, ok: false, problem: "no tools" })) }).decision).toBe("not_ready_environment_blocked");
    expect(report(all, [], { readiness: { level: "BLOCKED", issues: [], runnableLanes: [] } }).decision).toBe("not_ready_environment_blocked");
  });

  it("states coverage with both numbers, says what did not run, and never claims the app is secure", () => {
    const r = report([ob({ id: "a", priority: "critical" }), ob({ id: "b", status: "unsupported", reason: "Round 2", proofStrategy: "runtime_proof" }), ob({ id: "c", status: "not_applicable", reason: "n/a" })], [finding({ status: "suspected" })]);
    expect(r.headline).toBe("Not ready: not enough evidence. 1 of 2 applicable obligations produced decisive evidence (1 of 1 critical); 0 confirmed finding(s); 1 suspected risk(s) to review.");
    expect(r.coverage).toEqual({ decisive: 1, applicable: 2, criticalDecisive: 1, criticalApplicable: 1 });
    expect(r.skipped.map((s) => s.capability)).toEqual(expect.arrayContaining([expect.stringMatching(/^Runtime proofs/), expect.stringMatching(/^AI threat modelling/)]));
    expect(r.limitations[0]).toMatch(/a clean scan is not proof that the code is secure/);
    expect(r.tools.find((t) => t.name === "OSV-Scanner")).toMatchObject({ version: "1.9.1", databaseAt: "2026-10-14T12:04:03Z" });
    expect(r.audit.filter((a) => !a.ok)).toEqual([]);
  });

  it("records the execution environment and becomes schema version 3 when it is present", () => {
    const env = { requested: "auto" as const, selected: "local" as const, provider: "local-docker", fallbackReason: "Nebius is unavailable for billing (HTTP 402).", health: { ok: false, status: "billing_unavailable", detail: "402" }, isolation: "A disposable local container." };
    const r = report([ob({ id: "a", priority: "critical" })], [], { environment: env });
    expect(r.schemaVersion).toBe(3);
    expect(r.environment).toEqual(env);
    // Without an environment a Round 1 report stays version 1.
    expect(report([ob({ id: "a" })], []).schemaVersion).toBe(1);
  });
});

describe("audit", () => {
  it("catches an open obligation, a scanner verdict without an execution, a confirmed injection and a leaking preview", () => {
    const base = report([ob({ id: "a" })], []);
    const obs = [ob({ id: "open", status: "planned", reason: null }), ob({ id: "noexec", executionIds: [] })];
    const findings = [finding({ id: "S1", lane: "injection", category: "sql-injection" }), finding({ id: "S2", lane: "secrets", category: "secrets", secret: { type: "aws", preview: "AKIAIOSFODNN7EXAMPLE", fingerprint: "f" } })];
    const failed = securityAudit({ ...base, headline: "This app is secure." }, obs, findings, [exec]).filter((a) => !a.ok).map((a) => a.check);
    expect(failed).toEqual([
      "Every obligation has a final status",
      "Every non-passing status has a reason",
      "Every scanner verdict is backed by a sandbox execution of this run",
      "No injection or authorization finding is confirmed without a runtime proof",
      "No secret value appears in a finding",
      "Coverage states both numbers",
      "The headline states the decision and does not overstate",
    ]);
  });
});
