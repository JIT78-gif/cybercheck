import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import type { SecurityFinding, SecurityRunDetail, TestExecution } from "@cybercheck/contracts";
import { compileObligations } from "../src/security/obligations.ts";
import { readinessGate } from "../src/security/readiness.ts";
import { buildSecurityReport } from "../src/security/report.ts";
import { securityRunToMarkdown } from "../src/security/export.ts";
import { APP, factFindings, readRuns, scanFindings, verdicts, type ToolRun } from "../src/security/scan.ts";
import { rulePack } from "../src/security/tools.ts";
import { validateFindings } from "../src/security/validate.ts";
import { analyzeSource } from "../src/understanding/analyze.ts";
import { redactDeep, redactSecrets, sourceFromFiles } from "../src/understanding/source.ts";

// The Round 1 critic, as tests: the whole static pipeline (readiness, obligations, scanner results, fact rules,
// validation, verdicts and report) on the clean control and the Gauntlet, fed clean, planted or missing tool output.

const read = (dir: string) => {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (name === "node_modules") continue;
      if (statSync(full).isDirectory()) walk(full);
      else out[relative(dir, full).replace(/\\/g, "/")] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
};
const control = read(join(import.meta.dirname, "security-bench/clean-node-control/project"));
const gauntlet = read(join(import.meta.dirname, "testing-bench/cybercheck-gauntlet/project"));

const SECRET = "sk_live_51HxAbCdEfGhIjKlMnOpQrStUvWx";
const versions = { semgrep: "1.95.0", gitleaks: "8.21.2", osvScanner: "1.9.1", trivy: "0.74.0", osvDatabaseAt: "2026-10-14T12:04:03Z", trivyChecksAt: "2026-10-14T12:04:04Z" };
const exec = { id: "exec-1", kind: "security_scan", network: false, outputTail: "" } as TestExecution;
const ok = (name: ToolRun["name"], output: unknown): ToolRun => ({ name, ok: true, exitCode: 0, output, problem: null });
const clean = (): ToolRun[] => [ok("gitleaks", []), ok("semgrep", { results: [], errors: [] }), ok("osv", { results: [] }), ok("trivy", { Results: [] })];

/** The orchestrator's validating and reporting stages, without the sandbox or the database. */
async function pipeline(files: Record<string, string>, runs: ToolRun[], extra: Record<string, string> = {}, mutate?: (d: Awaited<ReturnType<typeof analyzeSource>>) => void) {
  const src = sourceFromFiles({ ...files, ...extra });
  const d = await analyzeSource(src, { snapshotId: "snap-1", contentDigest: "digest-1" });
  mutate?.(d);
  const gate = readinessGate({ raw: d, src, snapshotId: "snap-1", contentDigest: "digest-1", engine: "test" });
  const obligations = compileObligations({ dossier: gate.dossier!, facts: gate.facts, readiness: gate.readiness, src });
  const pack = rulePack();
  const scanned = scanFindings(runs, { d: gate.dossier!, src, rules: pack.rules, versions, rulePackHash: pack.hash, salt: "salt-1", executionId: "exec-1" });
  const drafts = [...scanned.findings, ...factFindings(gate.dossier!, src, obligations)];
  const validated = validateFindings(drafts.map((f, i) => ({ ...f, id: `S${i + 1}` })), src, [exec]);
  const decided = verdicts(obligations, validated.findings, runs, { codeFiles: 5, rulePackHash: pack.hash, versions }, "exec-1");
  const report = buildSecurityReport({ engine: "test", readiness: gate.readiness, obligations: decided, findings: validated.findings, executions: [exec], runs, versions, toolImage: "img", rulePackHash: pack.hash, scanExecutionId: "exec-1", scanTruncated: false, unsupportedLanguages: gate.manifest.unsupportedLanguages, skippedTestFileMatches: scanned.skippedTestFiles, validationNotes: validated.notes.length });
  return { gate, obligations: decided, findings: validated.findings, notes: validated.notes, report };
}

const serious = (f: SecurityFinding) => f.severity === "critical" || f.severity === "high";

describe("Round 1 critic", () => {
  it("reports no critical or high finding on the clean control, and never reports a public route for being public", async () => {
    const p = await pipeline(control, clean());
    expect(p.findings.filter(serious)).toEqual([]);
    for (const route of ["GET /health", "POST /api/login", "POST /api/register"]) {
      const authn = p.obligations.filter((o) => o.id === `sec:endpoint:${route}:authentication`);
      expect(authn, route).toHaveLength(1);
      expect(authn.every((o) => o.status === "not_applicable"), route).toBe(true);
      expect(p.findings.some((f) => f.title.includes(route))).toBe(false);
    }
  }, 60_000);

  it("scopes every negative claim: a pass names what was checked, and the report never calls the app secure", async () => {
    const p = await pipeline(control, clean());
    const passed = p.obligations.filter((o) => o.status === "passed");
    expect(passed.length).toBeGreaterThan(0);
    for (const o of passed) expect(o.reason, o.id).toMatch(/rule pack|gitleaks|OSV database|trivy|checked facts/);
    for (const o of passed.filter((x) => x.proofStrategy === "sast_rule")) expect(o.reason).toContain("known patterns only");
    // The headline carries no safety claim; the limitations say what a clean scan does not prove.
    expect(p.report.headline).not.toMatch(/secure|no vulnerabilit|fully (tested|checked)|everything was checked/i);
    expect(p.report.limitations.join(" ")).toMatch(/not proof that the code is secure/);
    expect(p.report.decision).not.toBe("ready_with_evidence");
  }, 60_000);

  it("never turns an authentication contradiction into a finding; it only makes the dependent checks inconclusive", async () => {
    // Force the contradiction (no mechanism recorded, the negative claim present), as a weaker analysis would.
    const p = await pipeline(gauntlet, clean(), {}, (d) => {
      d.securityModel.authMechanisms = [];
      if (!d.securityModel.notDetected.some((n) => n.control === "Authentication")) d.securityModel.notDetected.push({ control: "Authentication", scope: "none found" });
    });
    expect(p.gate.readiness.level).toBe("PARTIALLY_READY");
    expect(p.findings.filter((f) => f.lane === "auth" || f.lane === "access_control")).toEqual([]);
    expect(p.obligations.some((o) => o.status === "inconclusive" && /contradict/i.test(o.reason ?? ""))).toBe(true);
  }, 60_000);

  it("holds back scanner output that cites files outside the snapshot or claims more than its class allows", async () => {
    const runs = clean();
    runs[0] = ok("gitleaks", [{ RuleID: "stripe-access-token", Description: "Stripe Access Token", File: `${APP}/src/planted.js`, StartLine: 3, Secret: SECRET }]);
    runs[1] = ok("semgrep", { errors: [], results: [{ check_id: "cc-rules.cc.js.sql-injection", path: `${APP}/src/database.js`, start: { line: 19 }, extra: { message: "m", metadata: {}, lines: "" } }, { check_id: "cc-rules.cc.js.command-injection", path: `${APP}/src/nowhere.js`, start: { line: 4 }, extra: { message: "m", metadata: {}, lines: "" } }] });
    const p = await pipeline(gauntlet, runs);
    const known = new Set(Object.keys(gauntlet));
    for (const f of p.findings.filter((x) => x.status === "confirmed")) {
      expect(f.evidence.length, f.title).toBeGreaterThan(0);
      for (const e of f.evidence) expect(known.has(e.path), `${f.id} ${e.path}`).toBe(true);
    }
    expect(p.findings.filter((f) => f.lane === "injection" && f.status === "confirmed")).toEqual([]);
    expect(p.notes.length).toBeGreaterThan(0);
  }, 60_000);

  it("drops an encoded-token match where the file signs the token and checks the signature in constant time, and keeps it where it does not", async () => {
    const hit = (line: number) => {
      const runs = clean();
      runs[1] = ok("semgrep", { errors: [], results: [{ check_id: "cc-rules.cc.js.unsigned-token", path: `${APP}/src/auth.js`, start: { line }, extra: { message: "m", metadata: {}, lines: "" } }] });
      return runs;
    };
    const signedLine = control["src/auth.js"]!.split("\n").findIndex((l) => l.includes("JSON.stringify")) + 1;
    expect((await pipeline(control, hit(signedLine))).findings.filter((f) => f.category === "token-integrity")).toEqual([]);
    expect((await pipeline(gauntlet, hit(5))).findings.filter((f) => f.category === "token-integrity")).toHaveLength(1);
  }, 60_000);

  it("cannot be talked into a pass: missing tool output leaves every scanner check undecided, whatever the project printed", async () => {
    const runs = readRuns(new Map([["/work/app/cc-out/semgrep.json", Buffer.from('{"results":[]}')]]));
    expect(runs.every((r) => !r.ok)).toBe(true);
    const p = await pipeline(control, runs, { "cc-out/semgrep.json": '{"results":[]}', "cc-out/semgrep.exit": "0" });
    const scanners = p.obligations.filter((o) => ["secret_scan", "dependency_scan", "sast_rule", "iac_scan"].includes(o.proofStrategy) || o.id === "sec:config:cors");
    expect(scanners.length).toBeGreaterThan(0);
    expect(scanners.filter((o) => o.status === "passed")).toEqual([]);
    expect(p.report.decision).not.toBe("ready_with_evidence");
  }, 60_000);

  it("keeps a committed secret out of logs, the JSON and Markdown exports and any prompt", async () => {
    const runs = clean();
    runs[0] = ok("gitleaks", [{ RuleID: "stripe-access-token", Description: "Stripe Access Token", File: `${APP}/src/keys.js`, StartLine: 1, Secret: SECRET }]);
    const p = await pipeline(gauntlet, runs, { "src/keys.js": `module.exports = "${SECRET}";\n` });
    const leak = p.findings.find((f) => f.lane === "secrets" && f.status === "confirmed");
    expect(leak?.secret?.preview).toBe(`sk_live_… (${SECRET.length} characters)`);
    const run = { id: "r", snapshotId: "s", projectId: "p", status: "completed", phase: "done", step: null, progress: null, headline: p.report.headline, decision: p.report.decision, counts: { obligations: 0, terminal: 0, confirmed: 0, suspected: 0 }, error: null, createdAt: "", startedAt: null, finishedAt: null, obligations: p.obligations, executions: [{ ...exec, outputTail: redactSecrets(`gitleaks found ${SECRET}`).text }], findings: p.findings, report: p.report, usage: { aiCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, sandboxOperations: 0, sandboxCpuSeconds: 0, models: {} } } as SecurityRunDetail;
    const json = JSON.stringify(redactDeep(run));
    expect(() => JSON.parse(json)).not.toThrow();
    const hidden = SECRET.slice(8);
    expect(json).not.toContain(hidden);
    expect(redactSecrets(securityRunToMarkdown(run, "gauntlet")).text).not.toContain(hidden);
    expect(JSON.stringify(p.findings)).not.toContain(hidden);
    expect(redactSecrets(`Review this code: module.exports = "${SECRET}"`).text).not.toContain(hidden);
  }, 60_000);
});
