import type { AnalyzeReadiness, SecurityFinding, SecurityObligation, SecurityProof, SecurityProofVerdict, SecurityReleaseDecision, SecurityReport, TestExecution } from "@cybercheck/contracts";
import { SecurityObligationStatus } from "@cybercheck/contracts";
import type { ToolRun } from "./scan.ts";
import type { ToolVersions } from "./tools.ts";

// The Security report (Round 1, step 5): the release decision, coverage with both numbers, what was found and what was
// not tested, the exact tools and data, the capabilities that did not run, and a mechanical audit of the ledger.

/** The share of applicable obligations that must have decisive evidence before "ready". */
export const SECURITY_COVERAGE_BAR = 90;

export const DECISION_TEXT: Record<SecurityReleaseDecision, string> = {
  ready_with_evidence: "Ready, with evidence",
  ready_with_accepted_risk: "Ready only with accepted risk",
  not_ready_security_findings: "Not ready: confirmed security findings",
  not_ready_insufficient_evidence: "Not ready: not enough evidence",
  not_ready_environment_blocked: "Not ready: the environment blocked the check",
};

/** Capabilities of the full Security plan that Round 1 does not run, said in every report. */
const NOT_IN_ROUND_1 = [
  { capability: "Runtime proofs (authorization matrix, injection, CSRF, upload, webhook)", reason: "Built in Round 2; their obligations are counted as not yet tested." },
  { capability: "AI threat modelling, planning, triage and independent critic", reason: "Round 1 runs without an AI provider; added in Round 2 and never needed to confirm a finding." },
  { capability: "Human review, repair and exploit replay", reason: "Built in Round 3." },
];

/** Capabilities the full plan still does not run after Round 2. */
const NOT_IN_ROUND_2 = (critic: SecurityReport["critic"]): SecurityReport["skipped"] => [
  ...(critic?.ran ? [] : [{ capability: "AI threat modelling, extra hypotheses and an independent critic", reason: critic?.reason ?? "Not requested or no AI provider; deterministic proofs do not need it and it can never confirm a finding." }]),
  { capability: "Human review, repair and exploit replay after a fix", reason: "Built in Round 3." },
];

const DECISIVE = new Set(["passed", "failed"]);

/** One row per endpoint, one column per identity, from the authentication and authorization proofs. */
function authorizationMatrix(proofs: SecurityProof[]): NonNullable<SecurityReport["authorizationMatrix"]> {
  const authz = proofs.filter((p) => ["authn_required", "authz_object", "authz_function", "authz_property"].includes(p.type));
  const identities = [...new Set(["anonymous", ...authz.flatMap((p) => p.identities)])];
  const rows = new Map<string, NonNullable<SecurityReport["authorizationMatrix"]>["rows"][number]>();
  for (const p of authz) {
    const endpoint = p.target.ref;
    const row = rows.get(endpoint) ?? { endpoint, cells: {} };
    // The identity the proof exercised against its control, and whether it should have been allowed.
    const actor = p.type === "authn_required" ? "anonymous" : p.type === "authz_object" ? p.identities.at(-1)! : p.identities[0]!;
    const outcome = p.verdict === "failed" ? "allowed" : p.verdict === "passed" ? "denied" : p.verdict === "blocked" ? "not_tested" : "inconclusive";
    row.cells[actor] = { outcome, expected: "denied", proofId: p.id };
    rows.set(endpoint, row);
  }
  return { identities, rows: [...rows.values()] };
}

export function buildSecurityReport(input: {
  engine: string;
  readiness: AnalyzeReadiness;
  obligations: SecurityObligation[];
  findings: SecurityFinding[];
  executions: TestExecution[];
  runs: ToolRun[];
  versions: ToolVersions | null;
  toolImage: string | null;
  rulePackHash: string;
  scanExecutionId: string | null;
  scanTruncated: boolean;
  unsupportedLanguages: Array<{ name: string; files: number }>;
  skippedTestFileMatches: number;
  validationNotes: number;
  /** Round 2 runtime proofs; absent on a Round 1 run. */
  proofs?: SecurityProof[];
  critic?: SecurityReport["critic"];
  /** Where the check executed and how the runtime was chosen; present makes the report schema version 3. */
  environment?: SecurityReport["environment"];
}): SecurityReport {
  const { obligations: obs, findings } = input;
  const applicable = obs.filter((o) => o.status !== "not_applicable");
  const decisive = applicable.filter((o) => DECISIVE.has(o.status));
  const critical = applicable.filter((o) => o.priority === "critical");
  const coverage = { decisive: decisive.length, applicable: applicable.length, criticalDecisive: critical.filter((o) => DECISIVE.has(o.status)).length, criticalApplicable: critical.length };
  const totals = Object.fromEntries(SecurityObligationStatus.options.map((s) => [s, obs.filter((o) => o.status === s).length])) as SecurityReport["totals"];
  const confirmed = findings.filter((f) => f.status === "confirmed");
  const suspected = findings.filter((f) => f.status === "suspected");
  const confirmedCriticalHigh = confirmed.filter((f) => f.severity === "critical" || f.severity === "high");
  const toolsBroken = input.toolImage === null || input.runs.every((r) => !r.ok);
  const percent = coverage.applicable ? Math.round((coverage.decisive / coverage.applicable) * 100) : 0;

  const decision: SecurityReleaseDecision =
    input.readiness.level === "BLOCKED" || toolsBroken ? "not_ready_environment_blocked"
    : confirmedCriticalHigh.length ? "not_ready_security_findings"
    : coverage.criticalDecisive < coverage.criticalApplicable || percent < SECURITY_COVERAGE_BAR ? "not_ready_insufficient_evidence"
    : "ready_with_evidence";

  const parts = [
    `${coverage.decisive} of ${coverage.applicable} applicable obligations produced decisive evidence (${coverage.criticalDecisive} of ${coverage.criticalApplicable} critical)`,
    `${confirmed.length} confirmed finding(s)${confirmedCriticalHigh.length ? ` (${confirmedCriticalHigh.length} critical or high)` : ""}`,
    `${suspected.length} suspected risk(s) to review`,
  ];
  const headline = `${DECISION_TEXT[decision]}. ${parts.join("; ")}.`;

  const names: Record<string, string> = { gitleaks: "Gitleaks", semgrep: "Semgrep", osv: "OSV-Scanner", trivy: "Trivy" };
  const v = input.versions;
  const tools: SecurityReport["tools"] = input.runs.map((r) => ({
    name: names[r.name] ?? r.name,
    version: !v ? "not installed" : r.name === "gitleaks" ? v.gitleaks : r.name === "semgrep" ? v.semgrep : r.name === "osv" ? v.osvScanner : v.trivy,
    rulePack: r.name === "semgrep" ? input.rulePackHash : null,
    databaseAt: !v ? null : r.name === "osv" ? v.osvDatabaseAt : r.name === "trivy" ? v.trivyChecksAt : null,
    image: input.toolImage,
    command: r.name === "gitleaks" ? "gitleaks detect --no-git" : r.name === "semgrep" ? "semgrep scan (Cybercheck rule pack)" : r.name === "osv" ? "osv-scanner scan --experimental-offline -r" : "trivy config --skip-check-update",
    exitCode: r.exitCode,
    truncated: input.scanTruncated,
    executionId: input.scanExecutionId,
  }));

  const limitations = [
    "Static rules find known patterns only; a clean scan is not proof that the code is secure.",
    input.proofs
      ? "A code pattern is confirmed only when a runtime proof reproduced it this run; one left suspected could not be reproduced or could not be reached."
      : "Code patterns, including traced injection paths, stay suspected until a runtime proof (Round 2) or a review confirms them.",
    ...(input.readiness.level === "PARTIALLY_READY" ? [`The project analysis contradicts itself; checks that rely on it are inconclusive (lanes: ${[...new Set(input.readiness.issues.flatMap((i) => i.blocks))].join(", ")}).`] : []),
    ...(input.unsupportedLanguages.length ? [`Not analysed in depth: ${input.unsupportedLanguages.map((l) => `${l.name} (${l.files} file${l.files === 1 ? "" : "s"})`).join(", ")}.`] : []),
    ...(input.skippedTestFileMatches ? [`${input.skippedTestFileMatches} code-rule match(es) in test files were left out: tests are not shipped.`] : []),
    ...input.runs.filter((r) => !r.ok).map((r) => r.problem ?? `${r.name} did not finish.`),
    ...(v?.osvDatabaseAt ? [`Vulnerability data from the OSV database downloaded ${v.osvDatabaseAt}; advisories published later are not included.`] : []),
    "Configuration that depends on where the app is deployed (headers added by a proxy, cookie defaults) is reported as suspected.",
  ];

  const proofs = input.proofs ?? [];
  const report: SecurityReport = {
    schemaVersion: input.environment ? 3 : proofs.length || input.proofs ? 2 : 1,
    engine: input.engine,
    decision,
    headline,
    readiness: input.readiness,
    coverage,
    totals,
    findings: { confirmed: confirmed.length, suspected: suspected.length, confirmedCriticalHigh: confirmedCriticalHigh.length },
    tools,
    skipped: input.proofs ? NOT_IN_ROUND_2(input.critic) : NOT_IN_ROUND_1,
    limitations,
    audit: [],
    ...(input.proofs ? { proofs: { total: proofs.length, byVerdict: Object.fromEntries((["passed", "failed", "blocked", "inconclusive"] as SecurityProofVerdict[]).map((v) => [v, proofs.filter((p) => p.verdict === v).length])) as Record<SecurityProofVerdict, number>, requests: proofs.reduce((n, p) => n + p.requests, 0) }, authorizationMatrix: authorizationMatrix(proofs), critic: input.critic ?? { ran: false, reason: "No AI critic was requested or available.", proposals: 0, accepted: 0 } } : {}),
    ...(input.environment ? { environment: input.environment } : {}),
  };
  report.audit = securityAudit(report, obs, findings, input.executions, input.validationNotes);
  return report;
}

/** Mechanical checks of the ledger and the report: they never change a result, they say whether it can be trusted. */
export function securityAudit(report: SecurityReport, obs: SecurityObligation[], findings: SecurityFinding[], executions: TestExecution[], validationNotes = 0): SecurityReport["audit"] {
  const execIds = new Set(executions.map((e) => e.id));
  const checks: SecurityReport["audit"] = [];
  const add = (check: string, ok: boolean, detail: string) => checks.push({ check, ok, detail });
  const open = obs.filter((o) => o.status === "planned" || o.status === "running");
  add("Every obligation has a final status", !open.length, open.length ? `${open.length} still open: ${open.slice(0, 3).map((o) => o.id).join(", ")}` : `${obs.length} of ${obs.length}`);
  const noReason = obs.filter((o) => o.status !== "passed" && !o.reason);
  add("Every non-passing status has a reason", !noReason.length, noReason.length ? noReason.slice(0, 5).map((o) => o.id).join(", ") : "all have reasons");
  const scannerVerdicts = obs.filter((o) => DECISIVE.has(o.status) && ["secret_scan", "dependency_scan", "sast_rule", "iac_scan"].includes(o.proofStrategy) && !o.executionIds.some((id) => execIds.has(id)));
  add("Every scanner verdict is backed by a sandbox execution of this run", !scannerVerdicts.length, scannerVerdicts.length ? scannerVerdicts.slice(0, 5).map((o) => o.id).join(", ") : "all cite an execution");
  // A confirmed finding must cite snapshot evidence, a runtime proof (a reproduced weakness, e.g. missing headers,
  // has no single source line), or be an intake-excluded secret file.
  const unproven = findings.filter((f) => f.status === "confirmed" && !f.evidence.length && !(f.proofIds ?? []).length && !f.rootCause.startsWith("secret-file:"));
  add("Every confirmed finding cites evidence, a runtime proof, or an intake record", !unproven.length, unproven.length ? unproven.map((f) => f.id).join(", ") : "all do");
  const classBreach = findings.filter((f) => f.status === "confirmed" && f.trust !== "controlled_reproduction" && ["injection", "access_control"].includes(f.lane));
  add("No injection or authorization finding is confirmed without a runtime proof", !classBreach.length, classBreach.length ? classBreach.map((f) => f.id).join(", ") : "none");
  const leaky = findings.filter((f) => f.secret && !/… \(\d+ characters\)$/.test(f.secret.preview));
  add("No secret value appears in a finding", !leaky.length, leaky.length ? leaky.map((f) => f.id).join(", ") : "previews show only a known prefix and the length");
  // Every execution that runs or probes the project's code ran with the network off; only trusted preparation may use it.
  const unsafeExec = executions.filter((e) => ["probe", "security_scan", "security_api_proof", "security_browser_proof", "security_canary"].includes(e.kind) && e.network);
  add("No execution ran the project's code with the network on", !unsafeExec.length, unsafeExec.length ? unsafeExec.map((e) => `${e.kind} ${e.id}`).join(", ") : "scans and proofs ran with the network off");
  const c = report.coverage;
  add("Coverage states both numbers", c.decisive <= c.applicable && c.criticalDecisive <= c.criticalApplicable && report.headline.includes(`${c.decisive} of ${c.applicable}`), `${c.decisive} of ${c.applicable}`);
  add("The headline states the decision and does not overstate", report.headline.startsWith(DECISION_TEXT[report.decision]) && !/\b(is secure|everything (was )?checked|cannot be hacked|\d+% secure)\b/i.test(report.headline), report.decision);
  const depsChecked = obs.some((o) => o.proofStrategy === "dependency_scan" && DECISIVE.has(o.status));
  add("Vulnerability database freshness is disclosed", !depsChecked || report.tools.some((t) => t.databaseAt), depsChecked ? (report.tools.find((t) => t.name === "OSV-Scanner")?.databaseAt ?? "missing") : "no dependency verdict");
  add("Findings passed validation", true, validationNotes ? `${validationNotes} correction(s) made before storing (evidence dropped or status lowered)` : "no correction needed");
  return checks;
}
