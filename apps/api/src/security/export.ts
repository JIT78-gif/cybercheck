import type { SecurityRunDetail } from "@cybercheck/contracts";

const DECISION: Record<string, string> = {
  ready_with_evidence: "Ready, with evidence",
  ready_with_accepted_risk: "Ready only with accepted risk",
  not_ready_security_findings: "Not ready: confirmed security findings",
  not_ready_insufficient_evidence: "Not ready: not enough evidence",
  not_ready_environment_blocked: "Not ready: the environment blocked the check",
};

const cell = (v: unknown) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ");

/** The run as Markdown: the decision, coverage with both numbers, findings by status, and what was not tested. */
export function securityRunToMarkdown(run: SecurityRunDetail, projectName: string) {
  const r = run.report;
  const out = [`# Security report: ${projectName}`, "", `Run \`${run.id}\` · snapshot \`${run.snapshotId}\` · status ${run.status}`, ""];
  if (!r) return [...out, `**${run.error ?? "This run has no report."}**`, ""].join("\n");
  out.push(`## Decision: ${DECISION[r.decision] ?? r.decision}`, "", r.headline, "");
  out.push(`- **Coverage:** ${r.coverage.decisive} of ${r.coverage.applicable} applicable obligations produced decisive evidence; ${r.coverage.criticalDecisive} of ${r.coverage.criticalApplicable} critical ones.`);
  out.push(`- **Analyze readiness:** ${r.readiness.level}${r.readiness.issues.length ? ` (${r.readiness.issues.length} issue(s))` : ""}`);
  if (r.environment) {
    const e = r.environment;
    out.push(`- **Ran on:** ${e.selected}${e.provider ? ` (${e.provider})` : ""}, requested ${e.requested}${e.fallbackReason ? `; fell back because ${e.fallbackReason}` : ""}.`);
    out.push(`- **Isolation:** ${e.isolation}`);
  }
  if (r.critic) out.push(`- **AI critic:** ${r.critic.ran ? `reviewed ${r.critic.accepted} of ${r.critic.proposals} submitted claim(s); ${r.critic.reviews?.filter((x) => x.verdict === "challenge").length ?? 0} challenged` : r.critic.reason}`);
  if (r.proofRuntime) out.push(`- **Runtime proving:** ${r.proofRuntime.stage}; ${r.proofRuntime.executed} of ${r.proofRuntime.compiled} compiled proof(s) produced a record; ${r.proofRuntime.reason}`);
  out.push("");
  for (const [title, status] of [["Confirmed findings", "confirmed"], ["Suspected risks", "suspected"]] as const) {
    const list = run.findings.filter((f) => f.status === status);
    out.push(`## ${title} (${list.length})`, "");
    if (!list.length) out.push("None.", "");
    else out.push("| Severity | Finding | Location | Detector |", "|---|---|---|---|", ...list.map((f) => `| ${f.severity} | ${cell(f.title)} | ${f.location ? `${f.location.path}:${f.location.line}` : ""} | ${cell(`${f.detector.tool} ${f.detector.rule ?? ""}`)} |`), "");
  }
  const open = run.obligations.filter((o) => !["passed", "failed", "not_applicable"].includes(o.status));
  out.push(`## Not tested or not decided (${open.length})`, "");
  if (open.length) out.push("| Obligation | Status | Reason |", "|---|---|---|", ...open.map((o) => `| ${cell(o.requirement)} | ${o.status} | ${cell(o.reason)} |`), "");
  const proofs = run.proofs ?? [];
  if (proofs.length) {
    out.push(`## Runtime proofs (${proofs.length})`, "", "| Proof | Target | As | Verdict | Expected | Observed |", "|---|---|---|---|---|---|");
    out.push(...proofs.map((p) => `| ${p.id} ${cell(p.type)} | ${cell(p.target.ref)} | ${cell(p.identities.join(", "))} | ${p.verdict} | ${cell(p.expected)} | ${cell(p.observed)} |`), "");
  }
  if (r.authorizationMatrix?.rows.length) {
    const ids = r.authorizationMatrix.identities;
    out.push("## Authorization matrix", "", `| Endpoint | ${ids.join(" | ")} |`, `|---|${ids.map(() => "---|").join("")}`);
    out.push(...r.authorizationMatrix.rows.map((row) => `| ${cell(row.endpoint)} | ${ids.map((i) => { const c = row.cells[i]; return c ? `${c.outcome}${c.expected !== "unknown" && c.outcome !== "not_tested" && (c.outcome === "allowed") !== (c.expected === "allowed") ? " (unexpected)" : ""}` : ""; }).join(" | ")} |`), "");
  }
  if (r.skipped.length) out.push("## Skipped capabilities", "", ...r.skipped.map((s) => `- ${s.capability}: ${s.reason}`), "");
  if (r.tools.length) out.push("## Tools", "", "| Tool | Version | Rules | Database | Exit |", "|---|---|---|---|---|", ...r.tools.map((t) => `| ${t.name} | ${t.version} | ${t.rulePack ?? ""} | ${t.databaseAt ?? ""} | ${t.exitCode ?? ""}${t.truncated ? " (output truncated)" : ""} |`), "");
  if (r.limitations.length) out.push("## Limitations", "", ...r.limitations.map((l) => `- ${l}`), "");
  return out.join("\n");
}
