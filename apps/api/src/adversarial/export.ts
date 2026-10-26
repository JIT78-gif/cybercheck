import type { AdversarialRunDetail } from "@cybercheck/contracts";

// Plain-language Markdown rendering. Structured JSON remains the machine-readable source of truth; this export makes
// the same evidence understandable without requiring the reader to know the internal lane or campaign vocabulary.

export function adversarialRunToMarkdown(run: AdversarialRunDetail, projectName: string): string {
  const r = run.report;
  const campaigns = run.campaigns ?? [];
  const out: string[] = [];
  out.push(`# AI Adversarial report: ${projectName}`, "");
  if (run.parentRunId) out.push(`> **Targeted rerun:** This report covers only selected attacks from parent run \`${run.parentRunId}\`. It is not a new full-project score.`, "");
  out.push(`- Decision: ${r?.decision ?? run.status}${r?.headline ? ` (${r.headline})` : run.error ? ` (${run.error})` : ""}`);
  out.push(`- Profile: ${run.profile}`);
  if (r) {
    const accounting = r.accounting ?? { selected: campaigns.length, compiled: campaigns.length, attempted: campaigns.filter((c) => c.status !== "blocked").length, decisive: r.coverage.decisive, blocked: campaigns.filter((c) => c.status === "blocked").length, compilerRejected: 0 };
    const setup = r.setup ?? [];
    out.push(`- Coverage: ${r.coverage.decisive} of ${r.coverage.applicable} campaign(s) decisive`);
    out.push(`- Campaign accounting: ${accounting.selected} selected, ${accounting.compiled} compiled, ${accounting.attempted} attempted, ${accounting.decisive} decisive, ${accounting.blocked} blocked, ${accounting.compilerRejected} compiler-rejected`);
    out.push(`- Findings: ${r.findings.confirmed} confirmed, ${r.findings.suspected} suspected, ${r.findings.inconclusive} inconclusive, ${r.findings.blocked} blocked`);
    out.push("", "## Decision summary", "", r.headline || "No decision explanation was recorded.", "");
    out.push("## Confirmed attack chains", "");
    const confirmedChains = r.chains.filter((x) => x.verdict === "confirmed");
    if (!confirmedChains.length) out.push("None.");
    else for (const c of confirmedChains) out.push(`- **${c.title}**: ${c.links.map((l) => l.label).join(" -> ")}. ${c.reproducedImpact ?? c.reason}`);
    out.push("");
    out.push("## Required lanes", "");
    for (const o of r.obligations) out.push(`- ${o.label}: ${o.status} (${o.reason})`);
    out.push("");
    out.push("## Test setup", "");
    if (!setup.length) out.push("No synthetic setup steps were recorded.");
    else for (const s of setup) out.push(`- ${s.ok ? "ok" : "FAILED"} ${s.name} (${s.kind}): ${s.detail}`);
    out.push("");
    out.push("## Audit", "");
    for (const a of r.audit) out.push(`- ${a.ok ? "ok" : "FAIL"} ${a.check}: ${a.detail}`);
    out.push("", "## Environment and limitations", "");
    out.push(`- Runtime: ${r.environment.selected}${r.environment.provider ? ` (${r.environment.provider})` : ""}`);
    out.push(`- Isolation: ${r.environment.isolation}`);
    out.push(`- Optional AI attacker: ${r.attacker.status}. ${r.attacker.reason}`);
    out.push(`- Optional AI critic: ${r.critic.status}. ${r.critic.reason}`);
    out.push(`- Model usage: ${r.usage.modelRequests} request(s), ${r.usage.tokensIn + r.usage.tokensOut} token(s), cost ${r.usage.costUsd == null ? "not available" : `$${r.usage.costUsd.toFixed(4)}`}`);
    if (r.limitations.length) for (const x of r.limitations) out.push(`- Limitation: ${x}`);
    else out.push("- Limitations: none recorded.");
    out.push("", "## Untested or unsupported checks", "");
    if (!r.untested.length) out.push("None.");
    else for (const x of r.untested) out.push(`- **${x.what}**: ${x.reason}`);
  }
  out.push("", "## Findings", "");
  if (!run.findings.length) out.push("None.");
  else {
    const order = ["confirmed", "suspected", "inconclusive", "blocked", "rejected"] as const;
    for (const status of order) {
      const findings = run.findings.filter((f) => f.status === status);
      out.push(``, `### ${status[0]!.toUpperCase()}${status.slice(1)}`, "");
      if (!findings.length) {
        out.push("None.");
        continue;
      }
      for (const f of findings) {
        out.push(`#### ${f.title}`, "");
        out.push(`- Severity: ${f.severity}`);
        out.push(`- Affected target: ${f.endpoint ?? f.componentId}`);
        out.push(`- What the attacker did: ${f.confirmation}`);
        out.push(`- What should have happened: ${f.expected}`);
        out.push(`- What actually happened: ${f.observed}`);
        out.push(`- Why it matters: ${f.impact}`);
        out.push(`- Recommended fix: ${f.remediation}`);
        out.push(`- Evidence: campaign ${f.campaignIds.join(", ") || "none"}; execution ${f.executionIds.join(", ") || "none"}; source ${f.sourceEvidence.map((e) => `${e.path}:${e.line}`).join(", ") || "not available"}.`);
        if (f.limitations.length) out.push(`- Limitations: ${f.limitations.join("; ")}`);
        out.push("");
      }
    }
  }
  out.push("", `Engine ${r?.engine ?? "n/a"}, catalogue ${r?.catalogueVersion ?? "n/a"}, compiler ${r?.compilerVersion ?? "n/a"}.`);
  return out.join("\n");
}
