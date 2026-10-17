import type { AiEvaluationCase, AiEvaluationRunDetail } from "@cybercheck/contracts";

// The Markdown export of an AI Evaluator run. It receives an already redacted run and keeps every number with its
// denominator, every verdict with how it was reached, and every limit of the evidence.

const DECISION: Record<string, string> = {
  not_applicable: "Not applicable: the project has no AI component",
  ready_with_evidence: "Ready, with evidence",
  not_ready_ai_findings: "Not ready: AI findings",
  not_ready_insufficient_evidence: "Not ready: not enough evidence",
  not_ready_environment_blocked: "Not ready: the environment could not run the evaluation",
};
const pct = (n: number | null) => (n == null ? "n/a" : `${Math.round(n * 100)}%`);
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

function caseLine(c: AiEvaluationCase) {
  const g = c.graders.filter((x) => x.hard).map((x) => `${x.grader}: ${x.pass === null ? "undecided" : x.pass ? "pass" : "fail"}`).join("; ");
  return `| ${c.id} | ${c.category} | ${c.priority} | ${cell(c.title)} | ${c.mode} | ${c.verdict} (${c.evaluator}) | ${cell(g || c.reason)} |`;
}

export function aiRunToMarkdown(run: AiEvaluationRunDetail, projectName: string): string {
  const r = run.report;
  const lines: string[] = [`# AI Evaluator report: ${projectName}`, "", `Run ${run.id}, started ${run.createdAt}${run.parentRunId ? `, rerun of ${run.parentRunId}` : ""}. Status: ${run.status}.`, ""];
  if (!r) {
    lines.push(`No report was produced. ${run.error ?? ""}`.trim());
    return `${lines.join("\n")}\n`;
  }
  lines.push(`## Decision`, "", `**${DECISION[r.decision] ?? r.decision}.** ${r.headline}`, "");
  if (r.claims.length) lines.push("What this decision covers:", "", ...r.claims.map((c) => `- ${c}`), "");
  lines.push(`Mode: ${r.mode.used} (requested ${r.mode.requested}). ${r.mode.reason}`, `Runtime: ${r.environment.selected}${r.environment.fallbackReason ? ` (${r.environment.fallbackReason})` : ""}. ${r.environment.isolation}`, "");

  lines.push("## AI components and targets", "");
  for (const c of r.applicability.components) lines.push(`- **${c.name}** (${c.kind}${c.provider.name ? `, ${c.provider.name}` : ""}): ${c.endpoints.join(", ") || "no route found"}. ${c.provider.reason ?? ""}`.trim());
  for (const t of r.applicability.targets) lines.push(`- Target: ${t.target.method ?? "POST"} ${t.target.path}, reply at \`${t.target.responseSelector}\` (bound by ${t.boundBy === "user" ? "the user" : "the only matching route"}).`);
  for (const u of r.applicability.unbound) lines.push(`- Not bound: ${u.componentId}: ${u.reason}`);
  lines.push("");

  lines.push("## Coverage", "", `${r.coverage.decisive} of ${r.coverage.applicable} applicable cases are decisive; critical: ${r.coverage.criticalDecisive} of ${r.coverage.criticalApplicable}.`, "");
  lines.push("| Category | Result | Passed | Failed | Undecided | Score | Threshold | Evaluated by |", "| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const c of r.categories) lines.push(`| ${c.category} | ${c.status} | ${c.passed} | ${c.failed} | ${c.undecided} | ${pct(c.score)} | ${pct(c.threshold)} | ${c.evaluators.join(", ") || "n/a"} |`);
  lines.push("");
  if (r.metrics.length) lines.push("Metrics:", "", ...r.metrics.map((m) => `- ${m.name}: ${m.score == null ? "n/a" : m.score <= 1 ? pct(m.score) : m.score} (${m.numerator} of ${m.denominator}${m.threshold == null ? "" : `, threshold ${m.threshold <= 1 ? pct(m.threshold) : m.threshold}`}, ${m.evaluator}). ${m.rationale}`), "");

  lines.push("## Findings", "");
  if (!run.findings.length) lines.push("No AI findings.", "");
  for (const f of run.findings) {
    lines.push(`### ${f.id}: ${f.title}`, "", `- Status: ${f.status} (${f.basis}, ${f.mode} mode). Severity: ${f.severity}. Category: ${f.category}. ${f.owasp.join(", ")}`, `- Where: ${f.endpoint ?? "no endpoint"}${f.sourceEvidence.length ? `; ${f.sourceEvidence.map((e) => `${e.path}:${e.line}`).join(", ")}` : ""}`, `- Expected: ${f.expected}`, `- Observed: ${f.observed}`, `- Impact: ${f.impact}`, `- Fix: ${f.remediation}`, `- Cases: ${f.caseIds.join(", ")}`, `- ${f.confirmation}`);
    if (f.limitations.length) lines.push(`- Limits: ${f.limitations.join(" ")}`);
    lines.push("");
  }

  lines.push("## Performance and cost", "", `${r.performance.turns} assistant turn(s); median ${r.performance.p50Ms ?? "n/a"} ms, p95 ${r.performance.p95Ms ?? "n/a"} ms, max ${r.performance.maxMs ?? "n/a"} ms; ${r.performance.modelRequests} model request(s), ${r.performance.tokensIn} input and ${r.performance.tokensOut} output tokens; cost ${r.performance.costUsd == null ? "not measured" : `$${r.performance.costUsd.toFixed(4)} (${r.performance.costBasis})`}.`, "");

  lines.push("## Cases", "", "| Case | Category | Priority | What | Mode | Verdict | Graders |", "| --- | --- | --- | --- | --- | --- | --- |", ...run.cases.map(caseLine), "");

  lines.push("## Judge", "", `${r.judge.status}: ${r.judge.reason}${r.judge.calibration ? ` Calibration ${r.judge.calibration.datasetVersion}: balanced accuracy ${r.judge.calibration.balancedAccuracy.toFixed(2)} (${r.judge.calibration.passed ? "passed" : "below the gate; judge results are informational"}).` : ""}`, "");
  if (r.untested.length) lines.push("## Untested and blocked", "", ...r.untested.map((u) => `- ${u.what}: ${u.reason}`), "");
  lines.push("## Datasets", "", ...r.datasets.map((d) => `- ${d.name} (${d.source}, version ${d.version}, ${d.cases} case(s), digest ${d.digest.slice(0, 16)})`), "");
  lines.push("## Audit", "", ...r.audit.map((a) => `- ${a.ok ? "OK" : "FAILED"}: ${a.check}. ${a.detail}`), "", `Engine ${r.versions.engine}, graders ${r.versions.grader}${r.versions.rubric ? `, rubric ${r.versions.rubric}` : ""}, snapshot ${r.versions.snapshotDigest.slice(0, 16)}${r.versions.model ? `, model ${r.versions.model}` : ""}.`, "");
  if (r.limitations.length) lines.push("## Limitations", "", ...r.limitations.map((l) => `- ${l}`), "");
  return `${lines.join("\n")}\n`;
}
