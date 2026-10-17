import { createHmac } from "node:crypto";
import type { Evidence, ProjectDossier, SecurityFinding, SecurityObligation } from "@cybercheck/contracts";
import type { SnapshotSource } from "../understanding/source.ts";
import { seededAccounts } from "../testing/fixtures.ts";
import { OSV_DB, TOOL_ROOT, TRIVY_CACHE, type ToolVersions } from "./tools.ts";

// The Round 1 scanners and what their output means. The scan runs from the tool image with the network off; the
// project's code is only read, never run. Outputs are written to a directory the supervisor's own command creates, and
// only those files are parsed: anything the project prints is ignored. Confirmation follows the plan's class rules:
// secrets on detection, dependencies on an exact resolved version, repository configuration statically; code patterns
// (including injection traces) stay suspected until a runtime proof in Round 2.

export const APP = "/work/app";
export const OUT = "/cc-out";
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|fixtures?|e2e)\/|(\.|_)(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_\w+\.py$/;

/** The scan command: unpack the snapshot, run each tool with its own time limit, record each exit code. */
export function scanScript() {
  return `bash <<'CC_SCAN'
set -uo pipefail
export PATH=${TOOL_ROOT}/venv/bin:${TOOL_ROOT}/bin:$PATH SEMGREP_ENABLE_VERSION_CHECK=0 SEMGREP_SEND_METRICS=off OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY=${OSV_DB}
rm -rf ${OUT} ${APP} && mkdir -p ${OUT} ${APP}
tar xzf /in/snapshot.tgz -C ${APP} --no-same-owner
cd ${APP}
timeout 300 gitleaks detect --no-git --source ${APP} --report-format json --report-path ${OUT}/gitleaks.json --exit-code 0 > ${OUT}/gitleaks.log 2>&1; echo $? > ${OUT}/gitleaks.exit
timeout 600 semgrep scan --metrics=off --disable-version-check --config /cc-rules/javascript.yml --config /cc-rules/python.yml --json --output ${OUT}/semgrep.json --timeout 30 --max-target-bytes 1000000 ${APP} > ${OUT}/semgrep.log 2>&1; echo $? > ${OUT}/semgrep.exit
timeout 300 osv-scanner scan --experimental-offline --format json --output ${OUT}/osv.json -r ${APP} > ${OUT}/osv.log 2>&1; echo $? > ${OUT}/osv.exit
timeout 300 trivy config --quiet --skip-version-check --skip-check-update --cache-dir ${TRIVY_CACHE} -f json -o ${OUT}/trivy.json ${APP} > ${OUT}/trivy.log 2>&1; echo $? > ${OUT}/trivy.exit
for t in gitleaks semgrep osv trivy; do printf '%s=%s ' "$t" "$(cat ${OUT}/$t.exit)"; done; echo
CC_SCAN`;
}

export const SCAN_FILES = ["gitleaks.json", "semgrep.json", "osv.json", "trivy.json", "gitleaks.exit", "semgrep.exit", "osv.exit", "trivy.exit", "semgrep.log", "osv.log", "trivy.log", "gitleaks.log"].map((f) => `${OUT}/${f}`);

const rel = (p: string) => p.replace(/^\/work\/app\//, "").replace(/^\.\//, "");

// ---------------------------------------------------------------- tool runs

export type ToolName = "gitleaks" | "semgrep" | "osv" | "trivy";
export type ToolRun = { name: ToolName; ok: boolean; exitCode: number | null; output: unknown; problem: string | null };

/**
 * What each tool reported, and whether it ran. Exit codes that mean "found something" are not failures: gitleaks runs
 * with --exit-code 0, osv-scanner exits 1 when it finds vulnerabilities, semgrep exits 1 on findings with --error off.
 */
export function readRuns(files: Map<string, Buffer>): ToolRun[] {
  const text = (name: string) => files.get(`${OUT}/${name}`)?.toString("utf8") ?? null;
  return (["gitleaks", "semgrep", "osv", "trivy"] as const).map((name) => {
    const code = Number((text(`${name}.exit`) ?? "").trim());
    const exitCode = Number.isFinite(code) && (text(`${name}.exit`) ?? "").trim() !== "" ? code : null;
    const raw = text(`${name}.json`);
    let output: unknown = null;
    try {
      output = raw ? JSON.parse(raw) : null;
    } catch {
      output = null;
    }
    const okCodes = name === "osv" || name === "semgrep" ? [0, 1] : [0];
    const ok = exitCode !== null && okCodes.includes(exitCode) && output !== null;
    const why = exitCode === 124 ? "it ran out of time" : exitCode === null ? "it did not run" : output === null ? `it exited with ${exitCode} without a readable report` : `it exited with ${exitCode}`;
    // osv-scanner exits 128 when it finds no package source at all: nothing to scan, not a failure.
    if (name === "osv" && exitCode === 128 && /No package sources found/i.test(text("osv.log") ?? "")) return { name, ok: true, exitCode, output: { results: [] }, problem: null };
    return { name, ok, exitCode, output, problem: ok ? null : `${name} could not finish: ${why}. ${(text(`${name}.log`) ?? "").trim().split("\n").slice(-2).join(" ").slice(0, 200)}`.trim() };
  });
}

// ---------------------------------------------------------------- findings

type Draft = Omit<SecurityFinding, "id">;
type Rule = { id: string; obligation: string; category: string; cwe: string[]; mode: "taint" | "search"; message: string; severity: string };

/** Rules whose match is the effective repository configuration itself: confirmable statically, as the plan allows. */
const CONFIG_RULES = new Set(["cc.js.cors-any-origin", "cc.py.cors-any-origin", "cc.py.debug-mode"]);
const INJECTION = new Set(["sql-injection", "command-injection", "code-injection", "xss", "path-traversal", "ssrf", "open-redirect", "unsafe-deserialization"]);
const OWASP: Record<string, string[]> = {
  "sql-injection": ["A03:2021"], "command-injection": ["A03:2021"], "code-injection": ["A03:2021"], xss: ["A03:2021"], "path-traversal": ["A01:2021"], ssrf: ["A10:2021", "API7:2023"], "open-redirect": ["A01:2021"], "unsafe-deserialization": ["A08:2021"],
  "token-integrity": ["A07:2021", "API2:2023"], "mass-assignment": ["A01:2021", "API3:2023"], "credentials-in-logs": ["A09:2021"], "error-disclosure": ["A05:2021"], "debug-mode": ["A05:2021"], cors: ["A05:2021", "API8:2023"], "weak-crypto": ["A02:2021"],
};
const REMEDY: Record<string, string> = {
  "sql-injection": "Pass values as query parameters (placeholders), never inside the SQL text.",
  "command-injection": "Avoid the shell: pass arguments as a list (execFile, subprocess without shell=True).",
  "code-injection": "Never evaluate input as code or templates; parse it as data.",
  xss: "Escape output for HTML (or render with a template engine that escapes) before sending it.",
  "path-traversal": "Resolve the path and check it stays inside the allowed directory, or allow only known file names.",
  ssrf: "Only fetch allow-listed hosts and refuse internal or link-local addresses.",
  "open-redirect": "Redirect only to relative paths or an allow-list of destinations.",
  "unsafe-deserialization": "Use a safe parser (JSON, yaml.safe_load) for untrusted data.",
  "token-integrity": "Issue and verify tokens with a maintained library that signs them and checks the signature and expiry.",
  "mass-assignment": "Copy only an allow-list of fields from the request body.",
  "credentials-in-logs": "Log only the fields you need, never request bodies or passwords.",
  "error-disclosure": "Return a generic error; keep stack traces in the server logs.",
  "debug-mode": "Turn debug mode off in the shipped configuration.",
  cors: "Allow only the origins that need access.",
  "weak-crypto": "Use SHA-256 or better, and crypto.randomBytes / secrets for anything security-relevant.",
};

/**
 * Each handler's lines: from its route up to the next top-level statement (another route, middleware, an export: a
 * line at column 0 that does not close a block), at most 80 lines. A global error handler after the last route is not
 * part of that route.
 */
export function handlerRanges(d: ProjectDossier, src: SnapshotSource) {
  const byFile = new Map<string, Array<{ line: number; end: number; label: string; id: string; handler: Evidence }>>();
  const routes = d.entryPoints.filter((x) => x.kind !== "page");
  for (const e of routes) {
    const lines = src.files.get(e.handler.path)?.text.split("\n") ?? [];
    let end = Math.min(lines.length + 1, e.handler.line + 80);
    for (let i = e.handler.line; i < end - 1; i++) {
      const l = lines[i]!;
      if (/^\S/.test(l) && !/^[})\]]/.test(l)) {
        end = i + 1;
        break;
      }
    }
    const next = Math.min(...routes.filter((x) => x.handler.path === e.handler.path && x.handler.line > e.handler.line).map((x) => x.handler.line), Infinity);
    byFile.set(e.handler.path, [...(byFile.get(e.handler.path) ?? []), { line: e.handler.line, end: Math.min(end, next), label: `${e.method} ${e.path}`, id: e.id, handler: e.handler }]);
  }
  return {
    at: (path: string, line: number) => (byFile.get(path) ?? []).find((h) => line >= h.line && line < h.end) ?? null,
    all: () => [...byFile.values()].flat(),
    body: (h: { handler: Evidence; end: number; line: number }) => src.files.get(h.handler.path)?.text.split("\n").slice(h.line - 1, h.end - 1).join("\n") ?? "",
  };
}

/** The function a line sits in, and the endpoints whose handlers call it (one hop: a helper called by a route). */
function callers(src: SnapshotSource, ranges: ReturnType<typeof handlerRanges>, path: string, line: number): Array<{ label: string; at: Evidence }> {
  const lines = src.files.get(path)?.text.split("\n") ?? [];
  let name: string | null = null;
  // A tool may cite a file or line the snapshot does not have (validation drops that evidence later): never crash on it.
  for (let i = Math.min(line, lines.length) - 1; i >= 0 && !name; i--) name = lines[i]!.match(/function\s+(\w+)\s*\(|(\w+)\s*[:=]\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)|def\s+(\w+)\s*\(/)?.slice(1).find(Boolean) ?? null;
  if (!name) return [];
  const out: Array<{ label: string; at: Evidence }> = [];
  for (const h of ranges.all()) {
    if (new RegExp(`\\b${name}\\s*\\(`).test(ranges.body(h)) && !(h.handler.path === path && line >= h.line && line < h.end)) out.push({ label: h.label, at: h.handler });
  }
  return out;
}

function signsAndVerifies(src: SnapshotSource, path: string) {
  const code = (src.files.get(path)?.text ?? "")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|#|\*|\/\*)/.test(l))
    .join("\n");
  return /\bcreateHmac\(|\bcreateSign\(|\bhmac\.new\(/.test(code) && /\btimingSafeEqual\(|\bcompare_digest\(|\.verify\(/.test(code);
}

/** The structured dependency context of an OSV match: scope, direct/transitive, aliases, fixed versions, freshness. */
export function dependencyContext(
  d: ProjectDossier,
  pkg: { name: string; version: string; ecosystem: string },
  lockfile: string,
  exact: boolean,
  vulns: Array<{ id: string; aliases?: string[]; withdrawn?: string; affected?: Array<{ ranges?: Array<{ events?: Array<{ fixed?: string }> }> }> }>,
  databaseAt: string,
): NonNullable<SecurityFinding["dependency"]> {
  const dep = d.dependencies.find((x) => x.name === pkg.name && (x.resolved === pkg.version || x.resolved === null));
  const fixedVersions = [...new Set(vulns.flatMap((v) => (v.affected ?? []).flatMap((a) => (a.ranges ?? []).flatMap((r) => (r.events ?? []).map((e) => e.fixed).filter((f): f is string => Boolean(f))))))];
  // Recommend the highest fixed version among the matched advisories, so upgrading to it clears all of them (not just
  // the nearest single fix, which could still leave another advisory unpatched).
  const sorted = [...fixedVersions].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const nearestFix = sorted.at(-1) ?? null;
  return {
    ecosystem: pkg.ecosystem.toLowerCase().includes("pypi") ? "pypi" : "npm",
    package: pkg.name,
    version: pkg.version,
    lockfile,
    direct: dep ? d.dependencies.some((x) => x.name === pkg.name && x.manifest === lockfile.replace(/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/, "$1package.json").replace(/(^|\/)poetry\.lock$/, "$1pyproject.toml")) : null,
    scope: dep ? (dep.dev ? "development" : "production") : "unknown",
    advisories: vulns.map((v) => ({ id: v.id, aliases: v.aliases ?? [], withdrawn: Boolean(v.withdrawn), severitySource: "OSV" })),
    affected: null,
    fixedVersions,
    nearestFix,
    reachability: "unknown",
    usage: [],
    limitations: exact ? [] : ["Only a declared version range was available; the installed version could not be confirmed."],
    databaseAt: databaseAt || null,
  };
}

const severityOfCvss =(score: number | null): SecurityFinding["severity"] => (score == null ? "medium" : score >= 9 ? "critical" : score >= 7 ? "high" : score >= 4 ? "medium" : "low");

/** A credential assigned to a secret-named identifier as a string literal in source code (not .env, tests or docs). */
const TOKEN_NAME = /\b([A-Za-z_]*(?:token|secret|api[_-]?key|apikey|credential|passwd|password|private[_-]?key)[A-Za-z_]*)\b/i;
const TOKEN_VALUE = /^(ghp_|gho_|ghu_|ghs_|github_pat_|sk_[a-z]+_|sk-|pk_[a-z]+_|xox[baprs]-|AKIA[0-9A-Z]{8,}|AIza[\w-]{10,}|glpat-|eyJ[\w-]{10,})/;
/** Values that announce themselves as non-secrets: a fixture marker, not a real credential to report. */
const PLACEHOLDER = /do.?not.?use|fixture|example|sample|dummy|placeholder|change.?me|redacted|your[_-]|\bxxx+\b/i;
export function committedTokens(src: SnapshotSource, salt: string): Draft[] {
  const out: Draft[] = [];
  const seen = new Set<string>();
  for (const [path, f] of src.files) {
    if (TEST_PATH.test(path) || /\.(md|txt|example|sample)$|(^|\/)\.env/.test(path) || !/\.(c|m)?[jt]sx?$|\.py$|\.go$|\.rb$/.test(path) || path.includes("node_modules/")) continue;
    f.text.split("\n").forEach((line, i) => {
      // NAME = "value" or "name": "value" where the name looks like a credential and the value looks like a token.
      const m = line.match(/["']?([A-Za-z_][\w]*)["']?\s*[:=]\s*["'`]([^"'`\s]{10,200})["'`]/);
      if (!m || !TOKEN_NAME.test(m[1]!) || !TOKEN_VALUE.test(m[2]!) || PLACEHOLDER.test(m[2]!)) return;
      if (/process\.env|import\.meta\.env|os\.environ|getenv|\$\{/.test(line)) return; // reading a setting, not a literal
      const value = m[2]!;
      const fp = secretFingerprint(value, salt);
      if (seen.has(fp)) return;
      seen.add(fp);
      const loc = { path, line: i + 1 };
      out.push({
        status: "confirmed",
        severity: "high",
        lane: "secrets",
        category: "committed-token",
        title: `A credential is hard-coded in the source (${m[1]}, ${path}:${i + 1})`,
        cwe: ["CWE-798"],
        owasp: ["A07:2021"],
        expected: "Tokens and credentials come from the environment, never written into the code",
        observed: `${m[1]} is assigned a token-shaped literal in ${path} (shown only as a fingerprint); it ships with the code.`,
        impact: "Anyone with read access to the code has this credential until it is rotated.",
        location: loc,
        evidence: [loc],
        trust: "source_evidence",
        detector: { tool: "cybercheck", version: "committed-token", rule: null },
        secret: { type: "committed-token", preview: secretPreview(value), fingerprint: fp },
        confirmation: "The literal is in the committed source; whether it is a live external credential was not checked.",
        obligationIds: ["sec:secrets:repository"],
        executionIds: [],
        remediation: "Move the value to an environment variable or secret manager, rotate it, and remove it from the code and its history.",
        rootCause: `committed-token:${fp}`,
      });
    });
    if (out.length >= 25) break;
  }
  return out;
}

export function secretFingerprint(value: string, salt: string) {
  return createHmac("sha256", salt).update(value).digest("hex").slice(0, 16);
}
/** A preview that names the kind of secret without revealing it: a short known prefix, then the length. */
export function secretPreview(value: string) {
  const prefix = value.match(/^(sk_live_|sk_test_|pk_live_|rk_live_|sk-|ghp_|gho_|github_pat_|xox[abpr]-|AKIA|AIza|eyJ|-----BEGIN)/)?.[0] ?? "";
  return `${prefix}… (${value.length} characters)`;
}

export type ScanContext = { d: ProjectDossier; src: SnapshotSource; rules: Rule[]; versions: ToolVersions; rulePackHash: string; salt: string; executionId: string };

/** Findings from the four tools. Secret values are read only to fingerprint them; they are never returned. */
export function scanFindings(runs: ToolRun[], c: ScanContext): { findings: Draft[]; skippedTestFiles: number; semgrepErrors: number } {
  const findings: Draft[] = [];
  const ranges = handlerRanges(c.d, c.src);
  const at = ranges.at;
  let skippedTestFiles = 0;
  const run = (n: ToolName) => runs.find((r) => r.name === n && r.ok);

  // ---------------- secrets
  const leaks = (run("gitleaks")?.output as Array<{ RuleID: string; Description: string; File: string; StartLine: number; Secret: string }> | null) ?? [];
  const bySecret = new Map<string, { draft: Draft; files: Evidence[] }>();
  for (const l of leaks) {
    const path = rel(l.File);
    const fp = secretFingerprint(l.Secret ?? "", c.salt);
    const loc = { path, line: Math.max(1, l.StartLine) };
    const known = bySecret.get(fp);
    if (known) {
      known.files.push(loc);
      continue;
    }
    const critical = /private-key|aws|gcp|azure|stripe|github|slack|live/i.test(l.RuleID);
    bySecret.set(fp, {
      files: [loc],
      draft: {
        status: "confirmed", severity: critical ? "critical" : "high", lane: "secrets", category: "secrets", title: `${l.Description} committed in ${path}`, cwe: ["CWE-798"], owasp: ["A07:2021"],
        expected: "Credentials and keys are not committed with the code", observed: `A value matching the ${l.RuleID} pattern is in the code (shown only as a fingerprint).`, impact: "Anyone with read access to the code can use the credential until it is rotated.",
        location: loc, evidence: [loc], trust: "tool_observation", detector: { tool: "gitleaks", version: c.versions.gitleaks, rule: l.RuleID }, secret: { type: l.RuleID, preview: secretPreview(l.Secret ?? ""), fingerprint: fp },
        confirmation: "A secret is confirmed when it is found in the code; whether it is still active was not checked.", obligationIds: ["sec:secrets:repository"], executionIds: [c.executionId], remediation: "Rotate the credential, remove it from the code (and its history), and load it from the environment.", rootCause: `secret:${fp}`,
      },
    });
  }
  for (const { draft, files } of bySecret.values()) findings.push({ ...draft, evidence: files.slice(0, 10), observed: files.length > 1 ? `${draft.observed} It appears in ${files.length} places.` : draft.observed });

  // ---------------- dependencies (exact resolved versions only confirm)
  type OsvVuln = { id: string; summary?: string; aliases?: string[]; withdrawn?: string; database_specific?: { severity?: string }; affected?: Array<{ package?: { name: string }; ranges?: Array<{ events?: Array<{ fixed?: string; introduced?: string }> }> }> };
  type Osv = { results?: Array<{ source: { path: string; type: string }; packages: Array<{ package: { name: string; version: string; ecosystem: string }; vulnerabilities?: OsvVuln[]; groups?: Array<{ ids: string[]; max_severity?: string }> }> }> };
  for (const r of ((run("osv")?.output as Osv | null)?.results ?? [])) {
    const lockfile = rel(r.source.path);
    const manifest = lockfile.replace(/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml)$/, "$1package.json").replace(/(^|\/)(poetry\.lock)$/, "$1pyproject.toml");
    const exact = r.source.type === "lockfile";
    const lines = c.src.files.get(lockfile)?.text.split("\n") ?? [];
    for (const p of r.packages) {
      const vulns = p.vulnerabilities ?? [];
      if (!vulns.length) continue;
      const max = Math.max(...(p.groups ?? []).map((g) => Number(g.max_severity)).filter((n) => Number.isFinite(n)), -1);
      const line = Math.max(1, lines.findIndex((l) => l.includes(`"${p.package.name}"`) || l.includes(`node_modules/${p.package.name}"`) || l.toLowerCase().startsWith(`${p.package.name.toLowerCase()}==`)) + 1);
      const loc = { path: lockfile, line };
      const ids = vulns.map((v) => v.aliases?.find((a) => a.startsWith("CVE-")) ?? v.id);
      const live = vulns.filter((v) => !v.withdrawn);
      const dependency = dependencyContext(c.d, p.package, lockfile, exact, vulns, c.versions.osvDatabaseAt);
      // An exact lockfile match confirms the vulnerable component is present. It does not claim the app is exploitable
      // (reachability is "unknown" until a runtime proof touches it); a withdrawn-only advisory is not confirmed.
      findings.push({
        status: exact && live.length ? "confirmed" : "inconclusive", severity: severityOfCvss(max >= 0 ? max : null), lane: "dependencies", category: "dependencies", title: `${p.package.name} ${p.package.version} has ${live.length || vulns.length} known vulnerabilit${(live.length || vulns.length) === 1 ? "y" : "ies"} (${ids.slice(0, 3).join(", ")}${ids.length > 3 ? ", ..." : ""})`, cwe: ["CWE-1395"], owasp: ["A06:2021"],
        expected: "No dependency has a known vulnerability at its installed version", observed: `${p.package.ecosystem} ${p.package.name}@${p.package.version} (from ${lockfile}) matches ${ids.join(", ")}. ${vulns[0]?.summary ?? ""}`.trim(), impact: `A published weakness in a ${dependency.direct ? "direct" : dependency.direct === false ? "transitive" : ""} ${dependency.scope} dependency the app ships; whether it is exploitable depends on how the app uses it (reachability: ${dependency.reachability}).`,
        location: loc, evidence: [loc], trust: "tool_observation", detector: { tool: "osv-scanner", version: c.versions.osvScanner, rule: `OSV database ${c.versions.osvDatabaseAt}` }, secret: null,
        confirmation: exact && live.length ? "The installed version is pinned by a lockfile and matches a current advisory exactly; the component is present." : live.length ? "Only a version range is declared, so the installed version is not known; not confirmed." : "Every matching advisory is withdrawn; not confirmed.", obligationIds: [`sec:deps:${manifest}`], executionIds: [c.executionId], remediation: dependency.nearestFix ? `Upgrade ${p.package.name} to ${dependency.nearestFix} or later and refresh the lockfile.` : "Upgrade to a fixed version and refresh the lockfile.", rootCause: `dep:${p.package.ecosystem}:${p.package.name}@${p.package.version}`, dependency,
      });
    }
  }

  // ---------------- code patterns (Cybercheck's rule pack)
  type Sg = { results?: Array<{ check_id: string; path: string; start: { line: number }; extra: { message: string; metadata?: { obligation?: string; category?: string; cwe?: string[]; mode?: string } } }>; errors?: unknown[] };
  const sg = run("semgrep")?.output as Sg | null;
  const seen = new Set<string>();
  for (const m of sg?.results ?? []) {
    const path = rel(m.path);
    if (TEST_PATH.test(path)) {
      skippedTestFiles++;
      continue;
    }
    const rule = c.rules.find((r) => m.check_id === r.id || m.check_id.endsWith(`.${r.id}`));
    if (!rule) continue;
    // Encoded JSON is a signed token when its file computes a signature and checks it in constant time: the signing
    // and the checking often sit in helpers the pattern cannot see. Comments do not count.
    if (rule.category === "token-integrity" && signsAndVerifies(c.src, path)) continue;
    const key = `${rule.category}:${path}:${m.start.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const loc = { path, line: m.start.line };
    const handler = at(path, m.start.line);
    const via = handler ? [] : callers(c.src, ranges, path, m.start.line);
    const where = handler ? handler.label : via.length ? `${path}, reached from ${via.map((v) => v.label).join(", ")}` : `${path}:${m.start.line}`;
    const config = CONFIG_RULES.has(rule.id);
    const traced = rule.mode === "taint" && Boolean(handler);
    // A broken hash (MD5/SHA-1) applied to a credential is a decisive crypto defect, not a maybe: the weakness is the
    // primitive itself, so no runtime proof is possible or needed. A broken hash over a non-credential (a cache key)
    // stays suspected, since that use is not always a vulnerability.
    const credHash = rule.category === "weak-crypto" && hashesCredential(c.src, path, m.start.line);
    findings.push({
      status: config || credHash ? "confirmed" : "suspected",
      severity: rule.severity === "ERROR" ? "high" : rule.severity === "WARNING" ? "medium" : "low",
      lane: rule.category === "cors" || rule.category === "debug-mode" ? "configuration" : rule.category === "token-integrity" ? "auth" : rule.category === "mass-assignment" ? "access_control" : rule.category === "credentials-in-logs" || rule.category === "error-disclosure" ? "logging" : rule.category === "weak-crypto" ? "crypto" : "injection",
      category: rule.category,
      title: `${rule.message} (${where})`,
      cwe: rule.cwe,
      owasp: OWASP[rule.category] ?? [],
      expected: `Code does not match ${rule.id}`,
      observed: `${rule.message} at ${path}:${m.start.line}${handler ? `, inside the handler of ${handler.label}` : via.length ? `, in a function called by ${via.map((v) => v.label).join(", ")}` : ""}.`,
      impact: INJECTION.has(rule.category) ? "If the input reaches it as the trace suggests, an attacker controls part of the query, command, page, path or URL." : "A weakness in code that handles security-relevant data.",
      location: loc,
      evidence: [loc, ...(handler ? [] : via.map((v) => v.at))].slice(0, 6),
      trust: "tool_observation",
      detector: { tool: "semgrep", version: c.versions.semgrep, rule: `${rule.id} (pack ${c.rulePackHash})` },
      secret: null,
      confirmation: config
        ? "Effective repository configuration: confirmed statically."
        : credHash
          ? "A broken hash (MD5 or SHA-1) is applied to a credential here; the primitive itself is the defect, confirmed from the code."
          : INJECTION.has(rule.category)
            ? `${traced ? `Strong trace: request input reaches the sink inside the handler of ${handler!.label}. ` : ""}Injection is confirmed only by a runtime proof, which arrives in Round 2.`
            : "A code pattern match: suspected until a runtime proof or a review confirms it.",
      obligationIds: [rule.obligation],
      executionIds: [c.executionId],
      remediation: REMEDY[rule.category] ?? "Fix the pattern at this location.",
      rootCause: `sast:${rule.category}:${handler ? handler.id : path}`,
    });
  }

  // ---------------- infrastructure configuration (Trivy)
  type Tv = { Results?: Array<{ Target: string; Type: string; Misconfigurations?: Array<{ ID: string; Title: string; Message: string; Resolution: string; Severity: string; Status: string; CauseMetadata?: { StartLine?: number } }> }> };
  for (const r of ((run("trivy")?.output as Tv | null)?.Results ?? [])) {
    const path = rel(r.Target);
    if (TEST_PATH.test(path)) continue;
    for (const m of (r.Misconfigurations ?? []).filter((x) => x.Status === "FAIL")) {
      const loc = { path, line: Math.max(1, m.CauseMetadata?.StartLine ?? 1) };
      const sev = m.Severity.toLowerCase();
      findings.push({
        status: "confirmed", severity: (["critical", "high", "medium", "low"].includes(sev) ? sev : "low") as SecurityFinding["severity"], lane: "infrastructure", category: r.Type, title: `${m.Title} (${path})`, cwe: [], owasp: ["A05:2021"],
        expected: m.Resolution, observed: m.Message, impact: "Weaker isolation or exposure where this configuration is deployed.", location: loc, evidence: [loc], trust: "tool_observation", detector: { tool: "trivy", version: c.versions.trivy, rule: m.ID }, secret: null,
        confirmation: "Effective repository configuration: confirmed statically.", obligationIds: [iacObligation(path, r.Type)], executionIds: [c.executionId], remediation: m.Resolution, rootCause: `iac:${m.ID}:${path}`,
      });
    }
  }
  return { findings: mergeRootCauses(findings), skippedTestFiles, semgrepErrors: sg?.errors?.length ?? 0 };
}

/** Findings with the same root cause are one problem: the first keeps its title, the others add their locations. */
export function mergeRootCauses(list: Draft[]): Draft[] {
  const byCause = new Map<string, Draft>();
  for (const f of list) {
    const first = byCause.get(f.rootCause);
    if (!first) {
      byCause.set(f.rootCause, { ...f, evidence: [...f.evidence] });
      continue;
    }
    for (const e of f.evidence) if (!first.evidence.some((x) => x.path === e.path && x.line === e.line)) first.evidence.push(e);
    if (f.location && !first.observed.includes(`${f.location.path}:${f.location.line}`)) first.observed = `${first.observed} Also at ${f.location.path}:${f.location.line}.`;
    if (f.status === "confirmed") first.status = "confirmed";
  }
  return [...byCause.values()];
}

/** The obligation a configuration file's problems belong to. */
export function iacObligation(path: string, type: string) {
  if (/dockerfile/i.test(type) || /(^|\/)Dockerfile/.test(path)) return `sec:iac:dockerfile:${path}`;
  if (/(^|\/)\.github\/workflows\//.test(path)) return `sec:ci:${path}`;
  if (/compose/i.test(path)) return `sec:iac:compose:${path}`;
  return `sec:iac:resources:${path}`;
}

/** A stored password value that is already hashed (so plain-text storage cannot be claimed from it). */
const HASHED_PASSWORD = /^(\$2[aby]\$|\$argon2|\$scrypt|\$pbkdf2|\{(?:sha|bcrypt|argon))/i;

/** Seeded accounts whose password is stored as a plain-text literal (not a hash): decisive evidence of plain-text
 * storage when the sign-in also compares the password directly. */
function plaintextSeededPasswords(src: SnapshotSource): Array<{ account: string; at: Evidence }> {
  return seededAccounts(src)
    .filter((a) => a.password.length >= 4 && !HASHED_PASSWORD.test(a.password) && !/^[a-f0-9]{32,}$/i.test(a.password))
    .map((a) => ({ account: a.account, at: { path: a.at.path, line: a.at.line } }));
}

/** True when the broken-hash call on this line hashes a credential (password, secret, token), not a cache key or ETag. */
function hashesCredential(src: SnapshotSource, path: string, line: number): boolean {
  const text = src.files.get(path)?.text;
  if (!text) return false;
  const near = text.split("\n").slice(Math.max(0, line - 1), line + 2).join(" ");
  return /\.update\([^)]*\b(pass(word)?|pwd|secret|credential|token|api_?key)\b/i.test(near);
}

// ---------------------------------------------------------------- rules on the checked facts (no tool needed)

export function factFindings(d: ProjectDossier, src: SnapshotSource, obligations: SecurityObligation[], salt = ""): Draft[] {
  const out: Draft[] = [];
  const has = (id: string) => obligations.some((o) => o.id === id && o.status === "planned");
  const fact = (o: Omit<Draft, "trust" | "detector" | "secret" | "executionIds" | "owasp"> & { owasp?: string[] }): Draft => ({ owasp: [], ...o, trust: "source_evidence", detector: { tool: "cybercheck", version: "facts", rule: o.obligationIds[0] ?? null }, secret: null, executionIds: [] });
  // A credential hard-coded in the source as a string literal (what an entropy-based secret scanner misses when the
  // value is low-entropy, e.g. a synthetic all-zero token). This is the component-present fact, never a claim of a
  // real external incident.
  for (const t of committedTokens(src, salt)) out.push(t);

  for (const [path, reason] of src.excluded) {
    if (reason !== "secret" || !has(`sec:secrets:file:${path}`)) continue;
    out.push(fact({ status: "confirmed", severity: "high", lane: "secrets", category: "secrets", title: `${path} was uploaded with the code`, cwe: ["CWE-540"], owasp: ["A05:2021"], expected: "Secret files stay out of the repository", observed: `${path} was in the uploaded project; cybercheck kept it out of the snapshot and never read it.`, impact: "Anyone with the code has the settings in this file.", location: null, evidence: [], confirmation: "Recorded by intake when the file was excluded.", obligationIds: [`sec:secrets:file:${path}`], remediation: "Remove the file from the repository and its history, rotate what it held, and add it to .gitignore.", rootCause: `secret-file:${path}` }));
  }
  for (const v of d.config.envVars.filter((x) => x.sensitivity === "secret" && x.side === "browser")) {
    if (!has(`sec:secrets:browser:${v.name}`)) continue;
    out.push(fact({ status: "suspected", severity: "high", lane: "secrets", category: "secrets", title: `${v.name} is read in browser code`, cwe: ["CWE-200"], owasp: ["A01:2021"], expected: "Secrets stay on the server", observed: `${v.name} looks like a secret and is read by frontend code, so its value is bundled for every visitor.`, impact: "Anyone who loads the page can read the value.", location: v.usedIn[0] ?? null, evidence: v.usedIn.slice(0, 5), confirmation: "Suspected from the setting's name; confirm it is really a secret.", obligationIds: [`sec:secrets:browser:${v.name}`], remediation: "Move the call that needs it to the server.", rootCause: `browser-secret:${v.name}` }));
  }
  for (const o of obligations.filter((x) => x.id.endsWith(":lockfile") && x.status === "planned")) {
    out.push(fact({ status: "confirmed", severity: "low", lane: "dependencies", category: "supply chain", title: `${o.asset.label} has no lockfile`, cwe: ["CWE-1357"], owasp: ["A06:2021"], expected: "Installs use a committed lockfile", observed: "Dependencies are declared as ranges with no lockfile, so the versions installed can differ from the ones reviewed.", impact: "A vulnerable or compromised version can be installed without any change to the code.", location: null, evidence: o.applicabilityEvidence, confirmation: "No resolved versions were found for this manifest.", obligationIds: [o.id], remediation: "Commit the lockfile your package manager writes and install with it (npm ci, poetry install).", rootCause: `lockfile:${o.asset.ref}` }));
  }
  const plainCompare = d.securityModel.credentialChecks.find((c) => c.kind === "plain_compare");
  if (plainCompare && has("sec:crypto:password-storage") && !d.securityModel.passwordHashing.length) {
    // Decisive when the seed itself stores plain-text passwords: the comparison is direct and the stored value is a
    // plain-text literal, so there is nothing left to infer. Otherwise the comparison is seen but storage is inferred.
    const plaintext = plaintextSeededPasswords(src);
    const decisive = plaintext.length > 0;
    out.push(fact({ status: decisive ? "confirmed" : "suspected", severity: "high", lane: "crypto", category: "password storage", title: "Passwords are stored and compared as plain text", cwe: ["CWE-256", "CWE-916"], owasp: ["A02:2021", "A07:2021"], expected: "Passwords are stored hashed (bcrypt, scrypt, Argon2) and compared in constant time", observed: decisive ? `${plainCompare.detail}, and the seeded account${plaintext.length > 1 ? "s store their passwords" : ` ${plaintext[0]!.account} stores its password`} as a plain-text literal, with no password hashing library in use.` : `${plainCompare.detail}, and no password hashing library is used.`, impact: "A database or log leak exposes every password directly.", location: plainCompare.evidence[0] ?? null, evidence: [...plainCompare.evidence, ...plaintext.map((p) => p.at)].slice(0, 6), confirmation: decisive ? "From the code: the password is compared with === and the stored value is a plain-text literal, so storage is plain text." : "From the code: the comparison is visible; how passwords are stored is inferred.", obligationIds: ["sec:crypto:password-storage"], remediation: "Hash passwords with bcrypt, scrypt or Argon2 and compare with the library's verify function.", rootCause: "password-storage" }));
  }
  if (has("sec:config:security-headers") && !d.securityModel.securityHeaders.length && !(d.runtime.reverseProxy?.directives ?? []).some((x) => /header/i.test(x))) {
    out.push(fact({ status: "suspected", severity: "low", lane: "configuration", category: "configuration", title: "No security headers are set by the app or its proxy configuration", cwe: ["CWE-693"], owasp: ["A05:2021"], expected: "Responses carry X-Content-Type-Options, frame protection and a content security policy for pages", observed: "No header middleware (helmet or similar) and no header directives in a reverse proxy configuration were found.", impact: "Pages are easier to frame or to exploit with injected content.", location: null, evidence: [], confirmation: "Suspected: headers may be added where the app is deployed.", obligationIds: ["sec:config:security-headers"], remediation: "Add helmet (or the framework's equivalent), or set the headers in the reverse proxy.", rootCause: "security-headers" }));
  }
  const s = d.runtime.session;
  if (s && has("sec:config:session-cookie")) {
    const flags = Object.fromEntries(Object.entries(s.cookie).map(([k, v]) => [k.toLowerCase(), String(v).toLowerCase()]));
    const off = ["httponly", "secure"].filter((k) => flags[k] === "false");
    const missing = ["httponly", "secure", "samesite"].filter((k) => !(k in flags));
    if (off.length || missing.length) out.push(fact({ status: off.length ? "confirmed" : "suspected", severity: "medium", lane: "configuration", category: "session", title: `The session cookie ${off.length ? `turns off ${off.join(" and ")}` : `does not set ${missing.join(", ")}`}`, cwe: ["CWE-1004", "CWE-614"], owasp: ["A05:2021"], expected: "HttpOnly, Secure and SameSite on the session cookie", observed: `Cookie options in code: ${JSON.stringify(s.cookie)}.`, impact: "Scripts or plain-HTTP requests can expose the session.", location: s.evidence[0] ?? null, evidence: s.evidence, confirmation: off.length ? "Turned off explicitly in the code." : "Not set in the code; the library's defaults may still apply.", obligationIds: ["sec:config:session-cookie"], remediation: "Set httpOnly, secure and sameSite on the session cookie.", rootCause: "session-cookie" }));
  }
  if (has("sec:config:csrf") && !d.securityModel.csrf.length) {
    out.push(fact({ status: "suspected", severity: "medium", lane: "configuration", category: "session", title: "State-changing requests rely on a cookie with no CSRF protection found", cwe: ["CWE-352"], owasp: ["A01:2021"], expected: "SameSite cookies, a CSRF token or an origin check", observed: "Sign-in uses a cookie and no CSRF library or token check was found.", impact: "Another site could make a signed-in user's browser change data.", location: s?.evidence[0] ?? null, evidence: s?.evidence ?? [], confirmation: "Suspected: SameSite defaults or custom checks may protect it; a runtime proof arrives in Round 2.", obligationIds: ["sec:config:csrf"], remediation: "Add CSRF tokens or check the Origin header on state-changing requests.", rootCause: "csrf" }));
  }
  d.runtime.uploads.forEach((u, i) => {
    if (!has(`sec:config:upload:${i + 1}`) || u.contentTypeFromClient !== true) return;
    out.push(fact({ status: "suspected", severity: "medium", lane: "configuration", category: "file upload", title: `${u.endpoint ?? u.library} keeps the content type the client sent`, cwe: ["CWE-434"], owasp: ["A04:2021"], expected: "The server decides the stored and served content type", observed: "The uploaded file's Content-Type comes from the client.", impact: "An uploaded HTML or SVG file can be served as a page and run script.", location: u.evidence[0] ?? null, evidence: u.evidence, confirmation: "From the code; a runtime proof arrives in Round 2.", obligationIds: [`sec:config:upload:${i + 1}`], remediation: "Detect the type on the server, allow-list it, and serve uploads as attachments.", rootCause: `upload:${i + 1}` }));
  });
  return out;
}

// ---------------------------------------------------------------- obligation verdicts

/**
 * Each planned static obligation gets its verdict: failed with a confirmed finding, inconclusive with only suspected ones
 * (or when its tool did not finish), passed when its tool ran and nothing matched. Scope is always stated.
 */
export function verdicts(obligations: SecurityObligation[], findings: Array<Draft & { id: string }>, runs: ToolRun[], scope: { codeFiles: number; rulePackHash: string; versions: ToolVersions }, executionId: string | null): SecurityObligation[] {
  // The CORS check is answered by a Semgrep rule: if Semgrep did not finish, it must not pass by default.
  const toolFor = (o: SecurityObligation): ToolName | null => (o.id === "sec:config:cors" || o.proofStrategy === "sast_rule" ? "semgrep" : o.proofStrategy === "secret_scan" ? "gitleaks" : o.proofStrategy === "dependency_scan" ? "osv" : o.proofStrategy === "iac_scan" ? "trivy" : null);
  return obligations.map((o) => {
    if (o.status !== "planned") return o;
    const mine = findings.filter((f) => f.obligationIds.includes(o.id));
    const ids = mine.map((f) => f.id);
    const tool = toolFor(o);
    const run = tool ? runs.find((r) => r.name === tool) : null;
    const execs = executionId && tool ? [executionId] : [];
    if (mine.some((f) => f.status === "confirmed")) return { ...o, status: "failed", reason: `${mine.filter((f) => f.status === "confirmed").length} confirmed finding(s).`, findingIds: ids, executionIds: execs };
    if (tool && run && !run.ok) return { ...o, status: "inconclusive", reason: run.problem ?? `${tool} did not finish.`, findingIds: ids, executionIds: execs };
    if (mine.length) return { ...o, status: "inconclusive", reason: `${mine.length} suspected match(es): they need a runtime proof (Round 2) or a review.`, findingIds: ids, executionIds: execs };
    if (!tool) return { ...o, status: "passed", reason: "The checked facts show no problem for this rule.", findingIds: [], executionIds: [] };
    const what =
      tool === "semgrep" ? `No match in ${scope.codeFiles} JavaScript, TypeScript and Python file(s) for Cybercheck's rule pack ${scope.rulePackHash}; static rules cover known patterns only.`
      : tool === "gitleaks" ? `No secret found by gitleaks ${scope.versions.gitleaks} across the snapshot.`
      : tool === "osv" ? `No known vulnerability at the resolved versions (OSV database downloaded ${scope.versions.osvDatabaseAt}).`
      : `No failing check from trivy ${scope.versions.trivy} for this file.`;
    return { ...o, status: "passed", reason: what, findingIds: [], executionIds: execs };
  });
}
