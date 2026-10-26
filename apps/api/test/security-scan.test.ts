import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { ProjectDossier, SecurityObligation } from "@cybercheck/contracts";
import { compileObligations } from "../src/security/obligations.ts";
import { readinessGate } from "../src/security/readiness.ts";
import { APP, committedTokens, factFindings, OUT, readRuns, scanFindings, scanScript, secretFingerprint, verdicts, type ToolRun } from "../src/security/scan.ts";
import { installScript, parseVersions, rulePack, SECURITY_TOOLS, weekOf } from "../src/security/tools.ts";
import { analyzeSource } from "../src/understanding/analyze.ts";
import { sourceFromFiles, type SnapshotSource } from "../src/understanding/source.ts";

// The scanners' meaning (Security Round 1, step 4): tool output becomes findings and verdicts by the plan's rules.

const dir = join(import.meta.dirname, "testing-bench/cybercheck-gauntlet/project");
const files: Record<string, string> = {};
const walk = (d: string) => {
  for (const n of readdirSync(d)) {
    const f = join(d, n);
    if (n === "node_modules") continue;
    if (statSync(f).isDirectory()) walk(f);
    else files[relative(dir, f).replace(/\\/g, "/")] = readFileSync(f, "utf8");
  }
};
walk(dir);

let src: SnapshotSource;
let d: ProjectDossier;
let obligations: SecurityObligation[];
const versions = { semgrep: "1.95.0", gitleaks: "8.21.2", osvScanner: "1.9.1", trivy: "0.74.0", osvDatabaseAt: "2026-10-14T12:04:03Z", trivyChecksAt: "2026-10-14T12:04:04Z" };
const SECRET = "sk_live_51HxAbCdEfGhIjKlMnOpQrStUvWx";
const lineOf = (path: string, needle: string) => files[path]!.split("\n").findIndex((l) => l.includes(needle)) + 1;
const ctx = () => ({ d, src, rules: rulePack().rules, versions, rulePackHash: "testhash", salt: "salt-1", executionId: "exec-1" });

beforeAll(async () => {
  src = sourceFromFiles({ ...files, "src/keys.js": `const a = "${SECRET}";\nconst b = "${SECRET}";\n` }, { ".env": "secret" });
  d = await analyzeSource(src, { snapshotId: "snap-1", contentDigest: "digest-1" });
  const g = readinessGate({ raw: d, src, snapshotId: "snap-1", contentDigest: "digest-1", engine: "test" });
  obligations = compileObligations({ dossier: g.dossier!, facts: g.facts, readiness: g.readiness, src });
}, 60_000);

const run = (name: ToolRun["name"], output: unknown): ToolRun => ({ name, ok: true, exitCode: 0, output, problem: null });
const semgrepHit = (id: string, path: string, line: number) => ({ check_id: `cc-rules.${id}`, path: `${APP}/${path}`, start: { line }, extra: { message: "m", metadata: {}, lines: "secret code text" } });

describe("tool runs", () => {
  it("reads exit codes as the tools mean them, and says why a tool did not finish", () => {
    const out = new Map<string, Buffer>([
      [`${OUT}/gitleaks.exit`, Buffer.from("0\n")], [`${OUT}/gitleaks.json`, Buffer.from("[]")],
      [`${OUT}/osv.exit`, Buffer.from("1\n")], [`${OUT}/osv.json`, Buffer.from('{"results":[]}')],
      [`${OUT}/semgrep.exit`, Buffer.from("1\n")], [`${OUT}/semgrep.json`, Buffer.from('{"results":[]}')],
      [`${OUT}/trivy.exit`, Buffer.from("124\n")], [`${OUT}/trivy.log`, Buffer.from("scanning...\n")],
    ]);
    const runs = readRuns(out);
    expect(runs.map((r) => [r.name, r.ok])).toEqual([["gitleaks", true], ["semgrep", true], ["osv", true], ["trivy", false]]);
    expect(runs.find((r) => r.name === "trivy")!.problem).toMatch(/ran out of time/);
    expect(readRuns(new Map()).every((r) => !r.ok && /did not run/.test(r.problem!))).toBe(true);
  });

  it("writes its outputs outside the project and starts from an empty output directory, so the project cannot plant results", () => {
    const s = scanScript();
    expect(OUT.startsWith(APP)).toBe(false);
    expect(s.indexOf(`rm -rf ${OUT} ${APP}`)).toBeLessThan(s.indexOf("tar xzf"));
    for (const tool of ["gitleaks", "semgrep", "osv-scanner", "trivy"]) expect(s).toMatch(new RegExp(`${tool}[^\\n]*${OUT}/`));
    expect(installScript()).toMatch(/verify gl\.sums .* gl\.tgz/);
    expect(installScript()).toContain(`semgrep==${SECURITY_TOOLS.semgrep}`);
  });
});

describe("findings", () => {
  it("confirms a committed secret once per value, and never keeps the value", () => {
    const leaks = [1, 2].map((line) => ({ RuleID: "stripe-access-token", Description: "Stripe Access Token", File: `${APP}/src/keys.js`, StartLine: line, Secret: SECRET }));
    const { findings } = scanFindings([run("gitleaks", leaks)], ctx());
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ status: "confirmed", severity: "critical", obligationIds: ["sec:secrets:repository"], secret: { type: "stripe-access-token", fingerprint: secretFingerprint(SECRET, "salt-1"), preview: `sk_live_… (${SECRET.length} characters)` }, evidence: [{ path: "src/keys.js", line: 1 }, { path: "src/keys.js", line: 2 }] });
    expect(JSON.stringify(findings)).not.toContain(SECRET.slice(8));
  });

  it("confirms a vulnerable dependency only at a locked version", () => {
    const osv = { results: [
      { source: { path: `${APP}/package-lock.json`, type: "lockfile" }, packages: [{ package: { name: "express", version: "4.17.1", ecosystem: "npm" }, vulnerabilities: [{ id: "GHSA-x", aliases: ["CVE-2024-1"], summary: "open redirect" }], groups: [{ ids: ["GHSA-x"], max_severity: "7.5" }] }] },
      { source: { path: `${APP}/web/package.json`, type: "manifest" }, packages: [{ package: { name: "react", version: "18.0.0", ecosystem: "npm" }, vulnerabilities: [{ id: "GHSA-y" }], groups: [] }] },
    ] };
    const { findings } = scanFindings([run("osv", osv)], ctx());
    expect(findings[0]).toMatchObject({ status: "confirmed", severity: "high", title: expect.stringMatching(/^express 4\.17\.1 has 1 known vulnerability \(CVE-2024-1\)/), obligationIds: ["sec:deps:package.json"] });
    expect(findings[1]).toMatchObject({ status: "inconclusive", confirmation: expect.stringMatching(/Only a version range/) });
  });

  it("does not trust OSV's lockfile label for an unpinned requirements.txt", () => {
    const pySrc = sourceFromFiles({ "requirements.txt": "fastapi>=0.115,<1\npyjwt==2.10.0\n" });
    const osv = { results: [{ source: { path: `${APP}/requirements.txt`, type: "lockfile" }, packages: [
      { package: { name: "fastapi", version: "0.115.9", ecosystem: "PyPI" }, vulnerabilities: [{ id: "PYSEC-fastapi" }], groups: [] },
      { package: { name: "pyjwt", version: "2.10.0", ecosystem: "PyPI" }, vulnerabilities: [{ id: "PYSEC-pyjwt" }], groups: [] },
    ] }] };
    const findings = scanFindings([run("osv", osv)], { ...ctx(), src: pySrc }).findings;
    expect(findings[0]).toMatchObject({ status: "inconclusive", dependency: { limitations: [expect.stringMatching(/declared version range/)] } });
    expect(findings[1]).toMatchObject({ status: "confirmed", dependency: { version: "2.10.0" } });
  });

  it("keeps a generic key in an example environment file suspected until a person confirms it is real", () => {
    const secret = "example-api-key-1234567890";
    const leaks = [{ RuleID: "generic-api-key", Description: "Generic API Key", File: `${APP}/.env.example`, StartLine: 1, Secret: secret }];
    const f = scanFindings([run("gitleaks", leaks)], ctx()).findings[0]!;
    expect(f).toMatchObject({ status: "suspected", severity: "medium", confirmation: expect.stringMatching(/example\/template context/) });
  });

  it("enriches an advisory: aliases deduplicated, fixed version recommended, freshness disclosed, scope and directness", () => {
    const osv = { results: [{ source: { path: `${APP}/package-lock.json`, type: "lockfile" }, packages: [{ package: { name: "qs", version: "6.5.1", ecosystem: "npm" }, vulnerabilities: [{ id: "GHSA-qs", aliases: ["CVE-2022-24999", "GHSA-qs"], affected: [{ ranges: [{ events: [{ introduced: "0" }, { fixed: "6.5.3" }] }] }] }], groups: [{ ids: ["GHSA-qs"], max_severity: "7.5" }] }] }] };
    const f = scanFindings([run("osv", osv)], ctx()).findings[0]!;
    expect(f.dependency).toMatchObject({ ecosystem: "npm", package: "qs", version: "6.5.1", lockfile: "package-lock.json", fixedVersions: ["6.5.3"], nearestFix: "6.5.3", reachability: "unknown", databaseAt: versions.osvDatabaseAt });
    expect(f.dependency!.advisories).toEqual([{ id: "GHSA-qs", aliases: ["CVE-2022-24999", "GHSA-qs"], withdrawn: false, severitySource: "OSV" }]);
    expect(f.remediation).toMatch(/Upgrade qs to 6\.5\.3 or later/);
  });

  it("does not confirm when every matching advisory is withdrawn", () => {
    const osv = { results: [{ source: { path: `${APP}/package-lock.json`, type: "lockfile" }, packages: [{ package: { name: "left-pad", version: "1.0.0", ecosystem: "npm" }, vulnerabilities: [{ id: "GHSA-old", withdrawn: "2023-01-01T00:00:00Z" }], groups: [{ ids: ["GHSA-old"], max_severity: "5" }] }] }] };
    const f = scanFindings([run("osv", osv)], ctx()).findings[0]!;
    expect(f.status).toBe("inconclusive");
    expect(f.confirmation).toMatch(/withdrawn/);
    expect(f.dependency!.advisories[0]!.withdrawn).toBe(true);
  });

  it("keeps code matches suspected (injection needs a runtime proof), notes a strong trace, and confirms configuration", () => {
    const sg = { results: [
      semgrepHit("cc.js.xss", "src/app.js", lineOf("src/app.js", "res.type(\"html\").send")),
      semgrepHit("cc.js.sql-string-built", "src/database.js", lineOf("src/database.js", "unsafeCustomerSearch(query) {") + 1),
      semgrepHit("cc.js.cors-any-origin", "src/app.js", lineOf("src/app.js", "access-control-allow-origin")),
      semgrepHit("cc.js.ssrf", "test/app.test.js", 3),
    ] };
    const { findings, skippedTestFiles } = scanFindings([run("semgrep", sg)], ctx());
    expect(skippedTestFiles).toBe(1);
    const [xss, sql, cors] = findings;
    expect(xss).toMatchObject({ status: "suspected", title: expect.stringMatching(/\(GET \/api\/search\)$/), confirmation: expect.stringMatching(/^Strong trace: request input reaches the sink inside the handler of GET \/api\/search\. Injection is confirmed only by a runtime proof/) });
    // A helper outside any route, reached from the handler that calls it.
    expect(sql).toMatchObject({ status: "suspected", title: expect.stringMatching(/\(src\/database\.js, reached from GET \/api\/data\/customers\)$/), evidence: expect.arrayContaining([expect.objectContaining({ path: "src/app.js" })]) });
    expect(cors).toMatchObject({ status: "confirmed", lane: "configuration", obligationIds: ["sec:config:cors"] });
    expect(JSON.stringify(findings)).not.toContain("secret code text");
  });

  it("groups repeats of one root cause, and never blames a route for the error handler after it", () => {
    const issue = lineOf("src/auth.js", "Buffer.from(JSON.stringify");
    const parse = lineOf("src/auth.js", "JSON.parse(Buffer.from");
    const errorHandler = lineOf("src/app.js", "stack: error.stack");
    const sg = { results: [semgrepHit("cc.js.unsigned-token", "src/auth.js", issue), semgrepHit("cc.js.unsigned-token", "src/auth.js", parse), semgrepHit("cc.js.error-disclosure", "src/app.js", errorHandler)] };
    const { findings } = scanFindings([run("semgrep", sg)], ctx());
    const token = findings.filter((f) => f.category === "token-integrity");
    expect(token).toHaveLength(1);
    expect(token[0]!.evidence.filter((e) => e.path === "src/auth.js").map((e) => e.line)).toEqual([issue, parse]);
    expect(token[0]!.observed).toContain(`Also at src/auth.js:${parse}`);
    // The global error handler follows the last route; it belongs to no route.
    expect(findings.find((f) => f.category === "error-disclosure")!.title).toMatch(new RegExp(`\\(src/app\\.js:${errorHandler}\\)$`));
  });

  it("always plans the CORS check for an app with HTTP routes, so a CORS finding has a check to fail", () => {
    expect(obligations.find((o) => o.id === "sec:config:cors")).toMatchObject({ status: "planned" });
  });

  it("confirms failing configuration checks and files them under the right obligation", () => {
    const tv = { Results: [{ Target: `${APP}/Dockerfile`, Type: "dockerfile", Misconfigurations: [{ ID: "DS-0002", Title: "Image user should not be 'root'", Message: "Specify at least 1 USER command", Resolution: "Add USER", Severity: "HIGH", Status: "FAIL", CauseMetadata: { StartLine: 1 } }, { ID: "DS-0001", Title: "ok", Message: "", Resolution: "", Severity: "LOW", Status: "PASS" }] }] };
    const { findings } = scanFindings([run("trivy", tv)], ctx());
    expect(findings).toEqual([expect.objectContaining({ status: "confirmed", severity: "high", obligationIds: ["sec:iac:dockerfile:Dockerfile"], detector: expect.objectContaining({ rule: "DS-0002" }) })]);
  });

  it("applies the fact rules: a secret file kept out at intake, and a plain-text password comparison", () => {
    const drafts = factFindings(d, src, obligations);
    expect(drafts.find((f) => f.rootCause === "secret-file:.env")).toMatchObject({ status: "confirmed", obligationIds: ["sec:secrets:file:.env"] });
    // The gauntlet seeds plain-text password literals and compares with ===, so storage is plain text, not inferred.
    expect(drafts.find((f) => f.rootCause === "password-storage")).toMatchObject({ status: "confirmed", title: "Passwords are stored and compared as plain text" });
  });

  it("weak crypto: confirmed when a broken hash is applied to a credential, suspected when it is not", () => {
    const mk = (code: string) => ({ ...ctx(), src: sourceFromFiles({ "src/hash.js": code }, {}) });
    const hit = { results: [semgrepHit("cc.js.weak-crypto", "src/hash.js", 2)] };
    const cred = scanFindings([run("semgrep", hit)], mk('const crypto = require("crypto");\nmodule.exports = (req) => crypto.createHash("md5").update(req.body.password).digest("hex");\n')).findings.find((f) => f.category === "weak-crypto");
    const cache = scanFindings([run("semgrep", hit)], mk('const crypto = require("crypto");\nmodule.exports = (url) => crypto.createHash("md5").update(url).digest("hex");\n')).findings.find((f) => f.category === "weak-crypto");
    expect(cred?.status).toBe("confirmed");
    expect(cache?.status).toBe("suspected");
  });
});

describe("verdicts", () => {
  it("fails on a confirmed finding, stays inconclusive on suspected ones or a tool that did not finish, and passes with its scope stated", () => {
    const sg = { results: [semgrepHit("cc.js.xss", "src/app.js", lineOf("src/app.js", "res.type(\"html\").send"))] };
    const runs = [run("gitleaks", []), run("semgrep", sg), run("osv", { results: [] }), { name: "trivy" as const, ok: false, exitCode: 124, output: null, problem: "trivy could not finish: it ran out of time." }];
    const found = scanFindings(runs, ctx()).findings.map((f, i) => ({ ...f, id: `S${i + 1}` }));
    const facts = factFindings(d, src, obligations).map((f, i) => ({ ...f, id: `F${i + 1}` }));
    const all = [...found, ...facts];
    const out = verdicts(obligations, all, runs, { codeFiles: 7, rulePackHash: "testhash", versions }, "exec-1");
    const ob = (id: string) => out.find((o) => o.id === id)!;
    expect(ob("sec:sast:xss")).toMatchObject({ status: "inconclusive", reason: expect.stringMatching(/1 suspected match/), findingIds: ["S1"] });
    expect(ob("sec:sast:sql-injection")).toMatchObject({ status: "passed", reason: expect.stringMatching(/No match in 7 .* rule pack testhash; static rules cover known patterns only/), executionIds: ["exec-1"] });
    expect(ob("sec:secrets:repository")).toMatchObject({ status: "passed" });
    expect(ob("sec:secrets:file:.env")).toMatchObject({ status: "failed" });
    // Runtime proofs keep their status: a scan never decides them.
    expect(ob("sec:endpoint:GET /api/search:input-handling").status).toBe("unsupported");
    expect(ob("sec:endpoint:GET /api/users/:id:object-authorization").status).toBe("unsupported");
  });
});

describe("tool image", () => {
  it("reads the versions line, and rebuilds weekly", () => {
    expect(parseVersions(`noise\n${JSON.stringify(versions)}\n`)).toEqual(versions);
    expect(parseVersions("no json here")).toBeNull();
    expect(weekOf(new Date("2026-10-14T00:00:00Z"))).toBe("2026-W42");
    expect(weekOf(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
  });

  it("ships rules whose obligations exist in the compiler", () => {
    const ids = new Set(obligations.map((o) => o.id));
    for (const r of rulePack().rules) expect(ids.has(r.obligation) || r.obligation === "sec:config:cors", r.id).toBe(true);
  });
});

describe("committed tokens", () => {
  it("flags a hard-coded token-shaped literal, redacts it, and skips settings and fixtures", () => {
    const s = sourceFromFiles({
      "src/config.js": 'const SERVICE_TOKEN = "ghp_000000000000000000000000000000000000";\nconst API_URL = "https://api.example.test";\nconst key = process.env.API_KEY;\nconst fixtureSecret = "sk-fixture-DO-NOT-USE-1";',
      "test/seed.js": 'const TEST_TOKEN = "ghp_111111111111111111111111111111111111";',
    });
    const found = committedTokens(s, "salt");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ category: "committed-token", status: "confirmed", location: { path: "src/config.js", line: 1 }, cwe: ["CWE-798"] });
    expect(found[0]!.secret!.preview).toMatch(/^ghp_… \(40 characters\)$/);
    expect(JSON.stringify(found)).not.toContain("ghp_00000000"); // the value is never stored
  });
});
