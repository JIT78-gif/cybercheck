import type { Obligation, TestingRunDetail } from "@cybercheck/contracts";
import { breakpointText } from "./load.ts";

/**
 * A Testing run as a Markdown report someone can read without the app: the result first, then each
 * finding with its reproduction, the untested scope, the project's own suites, every planned check
 * and what ran in the sandbox. Secrets never appear: only setting names and synthetic placeholders.
 */

const cell = (s: unknown) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const table = (headers: string[], rows: unknown[][]) =>
  rows.length ? `| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |\n${rows.map((r) => `| ${r.map(cell).join(" | ")} |`).join("\n")}\n` : "_None._\n";
const fence = (s: string) => `\`\`\`\n${s.replace(/```/g, "'''")}\n\`\`\``;

const DECISION: Record<string, string> = {
  ready: "Ready to release",
  ready_with_accepted_risk: "Ready with accepted risk",
  not_ready_product_failures: "Not ready: confirmed product defects",
  not_ready_insufficient_evidence: "Not ready: insufficient evidence",
  not_ready_environment_blocked: "Not ready: the environment blocked testing",
};
const VERDICT: Record<string, string> = {
  defects_found: "Defects found",
  problems_found: "Build or test problems",
  no_defects_found: "No defects found",
  partial: "Partly tested",
  could_not_test: "Could not test",
};
const STATUS: Record<Obligation["status"], string> = {
  passed: "Passed",
  failed: "Failed",
  flaky: "Flaky",
  blocked: "Blocked",
  unsupported: "Not supported yet",
  skipped: "Skipped",
  not_applicable: "Not applicable",
  inconclusive: "Inconclusive",
  planned: "Planned",
  running: "Running",
};

function duration(a: string | null, b: string | null) {
  if (!a || !b) return "n/a";
  const s = Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function testingRunToMarkdown(run: TestingRunDetail, projectName: string) {
  const r = run.report;
  const out: string[] = [];
  out.push(`# Testing report: ${projectName}`, "");
  out.push(
    `Run \`${run.id}\` · snapshot \`${run.snapshotId}\` · started ${run.startedAt ?? run.createdAt} · took ${duration(run.startedAt, run.finishedAt)} · status ${run.status}`,
    "",
  );
  if (!r) {
    out.push(`**${run.error ?? "This run has no report."}**`, "");
    return out.join("\n");
  }

  if (r.release && r.completeness && r.productHealth) {
    // Level 1 and 2: the answer, then what is proven and what is not.
    const c = r.completeness;
    const h = r.productHealth;
    out.push(`## Release decision: ${DECISION[r.release.decision]}`, "", r.headline, "");
    out.push(
      `- **Workflow:** ${run.status} (a finished run is not the same as a passing product)`,
      `- **Testing completeness:** ${c.percent}% of risk-weighted applicable checks have decisive, strong evidence (release bar ${c.threshold}%); ${c.criticalDecisive} of ${c.criticalTotal} critical checks decisive`,
      `- **Product health:** ${h.percent == null ? "unknown (nothing decisive)" : `${h.percent}% of the decisive scope passed`}`,
      `- **Profile:** ${r.profile ?? "standard"}${run.parentRunId ? ` (targeted rerun of run \`${run.parentRunId}\`)` : ""}`,
      "",
    );
    const failed = r.release.gates.filter((g) => g.ok === false);
    if (failed.length) out.push("Why:", "", ...failed.map((g) => `- ${g.label}: ${g.detail}`), "");
    const claims = r.claims ?? [];
    const proved = claims.filter((x) => x.kind === "proved").map((x) => `- ${x.text}`);
    out.push("### Proven", "", ...(proved.length ? proved : ["- Nothing was proven by a decisive check."]), "");
    out.push("### Not proven, or a problem", "", ...claims.filter((x) => x.kind !== "proved").map((x) => `- ${x.text}`), "");
    if (r.nextActions?.length) out.push("### Next actions", "", ...r.nextActions.map((n) => `- ${n.label}`), "");
    if (r.layers?.length) out.push("### Coverage by layer", "", table(["Layer", "Decisive", "Passed", "Failed", "Completeness", "Confidence", "Gap"], r.layers.map((l) => [l.layer.replace("_", " "), `${l.decisive} of ${l.planned}`, l.passed, l.failed, l.completeness == null ? "n/a" : `${l.completeness}%`, l.confidence, l.gap ?? ""])));
    if (r.capabilities?.length) out.push("### Coverage by capability", "", table(["Capability", "Decisive", "Failed", "Proven by", "Your tests", "Missing"], r.capabilities.map((x) => [x.name, `${x.decisive} of ${x.obligations}`, x.failed, x.proofClasses.join(", ") || "nothing yet", x.existingTests, x.missing ?? ""])));
  } else out.push(`## Result: ${VERDICT[r.verdict] ?? r.verdict}`, "", r.headline, "");
  const totals = (Object.entries(r.totals) as Array<[Obligation["status"], number]>).filter(([, n]) => n > 0);
  out.push(table(["Status", "Checks"], totals.map(([s, n]) => [STATUS[s], n])));
  out.push(table(["Measure", "Result", "Note"], r.measures.map((m) => [m.label, `${m.numerator} of ${m.denominator}`, m.note ?? ""])));

  const groups: Array<[string, string, (f: TestingRunDetail["findings"][number]) => boolean]> = [
    ["Confirmed product defects", "Reproduced in clean sandboxes and confirmed by an independent reviewer model, or reported by a deterministic tool (compiler, database, accessibility rules).", (f) => f.kind === "product_defect" && f.status === "confirmed"],
    ["Needs your review", "Looks like a defect but was not independently confirmed.", (f) => f.kind === "product_defect" && f.status === "suspected"],
    ["Testing-system problems", "Checks cybercheck wrote or ran that did not work. They say nothing about your code.", (f) => (f.kind === "tool_failure" || (f.kind === "test_defect" && f.status === "confirmed")) && f.status !== "rejected"],
    ["Environment and configuration blockers", "A missing CI configuration, a build that needs internet access, or a service the sandbox does not provide.", (f) => (f.kind === "environment_failure" || f.kind === "configuration_gap") && f.status !== "rejected"],
    ["Problems in your own tests", "Your test suites hang, run nothing, or disagree between identical runs.", (f) => ["suite_integrity", "flaky"].includes(f.kind) && f.status !== "rejected"],
    ["Dismissed", "Checks whose own expectation was wrong, or failures a reviewer rejected.", (f) => f.status === "rejected"],
  ];
  out.push("## Findings", "");
  if (!run.findings.length) out.push("_No findings._", "");
  for (const [title, intro, test] of groups) {
    const items = run.findings.filter(test);
    if (!items.length) continue;
    out.push(`### ${title} (${items.length})`, "", intro, "");
    for (const f of items) {
      out.push(`#### ${f.id}. ${f.title}`, "");
      out.push(`- **Severity:** ${f.severity} · **Evidence:** ${f.confidence} confidence · **Status:** ${f.status}`);
      if (f.location) out.push(`- **Where:** \`${f.location.path}:${f.location.line}\``);
      out.push(`- **Expected:** ${f.expected}`, `- **Actual:** ${f.actual.replace(/\n/g, " ")}`);
      if (f.rootCause) out.push(`- **Likely cause:** ${f.rootCause}`);
      out.push(`- **How it was verified:** ${f.validation}`);
      if (f.limitation) out.push(`- **Limitation:** ${f.limitation}`);
      if (f.nextAction) out.push(`- **Next action:** ${f.nextAction}`);
      out.push("", "Reproduce:", "", fence(f.reproduction), "");
    }
  }

  out.push("## Missing evidence", "", "These checks were planned but gave no verdict. They are never counted as passed.", "");
  out.push(table(["Reason", "Who can fix it", "Checks"], r.untested.map((u) => [u.reason, u.owner === "you" ? "you" : u.owner === "cybercheck" ? "cybercheck" : u.owner === "not_supported" ? "not supported yet" : "", u.count])));

  if (r.suites.length) {
    out.push("## The project's own test suites", "");
    out.push(table(["Workspace", "Framework", "Verdict", "Tests", "Passed", "Failed", "Skipped", "Command"], r.suites.map((s) => [s.workspace, s.framework, s.verdict.replace("_", " "), s.tests.total, s.tests.passed, s.tests.failed, s.tests.skipped, s.command])));
    const failing = r.suites.flatMap((s) => s.cases.filter((c) => c.status !== "passed" && c.status !== "skipped").map((c) => [s.workspace, c.name, c.message ?? ""]));
    if (failing.length) out.push("Failing tests:", "", table(["Workspace", "Test", "Message"], failing));
  }

  if (r.load?.stages.length) {
    out.push("## Load and capacity", "", r.load.note, "");
    out.push(table(["Stage", "Users", "Requests", "Per second", "p50 ms", "p95 ms", "Errors %", "Result"], r.load.stages.map((st) => [st.name, st.vus, st.requests, st.verdict === "invalid" ? "" : st.rps, st.p50Ms ?? "", st.p95Ms ?? "", st.errorRatePct, st.name === "breakpoint" ? "measurement" : st.verdict === "measured" ? "measured, no threshold" : st.verdict === "invalid" ? "not valid: the app stopped" : st.verdict])));
    const bp = r.load.stages.find((st) => st.name === "breakpoint");
    if (bp) out.push(`**Breakpoint:** ${breakpointText(bp)}`, "");
  }
  if (r.fixtures?.nodes.length) out.push("## Test data and sign-in setup", "", table(["Step", "Result", "Detail"], r.fixtures.nodes.map((n) => [n.label, n.ok === true ? "worked" : n.ok === false ? "failed" : "not run", n.detail])));
  out.push("## Expert evidence", "", "### Every planned check", "");
  out.push(table(["Check", "Asset", "Layer", "Expected", "Result", "Reason"], run.obligations.map((o) => [`${o.objective}${o.origin === "authored" ? " (AI-written)" : ""}`, o.asset.label, o.layer.replace("_", " "), o.oracle.expected, STATUS[o.status], o.reason ?? ""])));

  out.push("## What ran in the sandbox", "", "Each command ran in a fresh isolated sandbox. Exit codes and timeouts come from the sandbox platform.", "");
  out.push(table(["Step", "Outcome", "Exit code", "Seconds", "Network", "Command"], run.executions.map((e) => [e.label, e.outcome, e.exitCode ?? "", e.durationMs != null ? (e.durationMs / 1000).toFixed(1) : "", e.network ? "on" : "off", e.command.slice(0, 200)])));

  out.push("## Environment and cost", "");
  out.push(
    `- **Sandbox:** ${r.environment.provider}, image \`${r.environment.image}\`, runtime ${r.environment.runtime ?? "unknown"}`,
    `- **Network:** ${r.environment.network}`,
    `- **Synthetic settings (names only):** ${r.environment.syntheticEnv.join(", ") || "none"}`,
    `- **AI:** ${run.usage.aiCalls} calls, ${(run.usage.inputTokens + run.usage.outputTokens).toLocaleString("en-US")} tokens, $${run.usage.costUsd.toFixed(3)}`,
    `- **Sandbox work:** ${run.usage.sandboxOperations} operations, ${run.usage.sandboxCpuSeconds} CPU seconds`,
  );
  if (run.projectSpendUsd != null) out.push(`- **All Testing AI for this project:** $${run.projectSpendUsd.toFixed(3)}`);
  if (run.usage.planSource === "cache") out.push(`- **Plan:** reused from an earlier run of this code (saved about $${(run.usage.savedByCacheUsd ?? 0).toFixed(3)})`);
  for (const [name, st] of Object.entries(run.usage.byStage ?? {})) out.push(`- **AI, ${name}:** ${st.calls} call(s), $${st.costUsd.toFixed(3)}`);
  if (r.performance) out.push(`- **Single-user probe latency (diagnostic only):** p50 ${r.performance.p50Ms} ms, p95 ${r.performance.p95Ms} ms over ${r.performance.requests} requests (${r.performance.note})`);
  out.push("");

  if (r.release) out.push("## Release gates", "", table(["Gate", "Result", "Detail"], r.release.gates.map((g) => [g.label, g.ok === true ? "met" : g.ok === false ? "NOT MET" : "does not apply", g.detail])));
  out.push("## Report checks", "", table(["Check", "Result", "Detail"], r.audit.map((a) => [a.check, a.ok ? "OK" : "FAILED", a.detail])));
  out.push("## Limitations", "", ...r.limitations.map((l) => `- ${l}`), "");
  return out.join("\n");
}
