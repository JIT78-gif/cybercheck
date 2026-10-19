import type { AdversarialRunDetail } from "@cybercheck/contracts";

// A plain-text Markdown rendering of an AI Adversarial run, for download. The full report layout is plan step 13; this
// keeps to the decision, coverage, confirmed chains, findings and audit so an export works from the first lifecycle.

export function adversarialRunToMarkdown(run: AdversarialRunDetail, projectName: string): string {
  const r = run.report;
  const out: string[] = [];
  out.push(`# AI Adversarial report: ${projectName}`, "");
  out.push(`- Decision: ${r?.decision ?? run.status}${r?.headline ? ` (${r.headline})` : run.error ? ` (${run.error})` : ""}`);
  out.push(`- Profile: ${run.profile}`);
  if (r) {
    out.push(`- Coverage: ${r.coverage.decisive} of ${r.coverage.applicable} campaign(s) decisive`);
    out.push(`- Findings: ${r.findings.confirmed} confirmed, ${r.findings.suspected} suspected, ${r.findings.inconclusive} inconclusive, ${r.findings.blocked} blocked`);
    out.push("");
    if (r.chains.length) {
      out.push("## Confirmed attack chains", "");
      for (const c of r.chains.filter((x) => x.verdict === "confirmed")) out.push(`- ${c.title}: ${c.links.map((l) => l.label).join(" -> ")}`);
      out.push("");
    }
    out.push("## Required lanes", "");
    for (const o of r.obligations) out.push(`- ${o.label}: ${o.status} (${o.reason})`);
    out.push("");
    out.push("## Audit", "");
    for (const a of r.audit) out.push(`- ${a.ok ? "ok" : "FAIL"} ${a.check}: ${a.detail}`);
  }
  if (run.findings.length) {
    out.push("", "## Findings", "");
    for (const f of run.findings) out.push(`- [${f.status}] ${f.severity} ${f.lane}: ${f.title}`);
  }
  out.push("", `Engine ${r?.engine ?? "n/a"}, catalogue ${r?.catalogueVersion ?? "n/a"}, compiler ${r?.compilerVersion ?? "n/a"}.`);
  return out.join("\n");
}
