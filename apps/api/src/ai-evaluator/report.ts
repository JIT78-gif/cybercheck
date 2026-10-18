import type { AiApplicability, AiEvaluationCase, AiEvaluationFinding, AiEvaluationReport, AiEvaluationThresholds, AiExecutionMode, AiModelMode, Evidence, TestExecution } from "@cybercheck/contracts";
import { redactSecrets } from "../understanding/source.ts";
import { BUILTIN_DIGEST } from "./catalog.ts";
import { categoryResults, coverageOf, decide, findingsOf, laneObligations, metricsOf, obligationCoverageOf, performanceOf, type LaneContext } from "./decide.ts";
import { AI_CATALOG_VERSION, AI_EVALUATOR_ENGINE, AI_GRADER_VERSION } from "./version.ts";

// The AI Evaluator report (schema v1): the decision and what it rests on, per-category results with their
// denominators, findings, what was not tested and why, and a mechanical audit of the run's own evidence.

export type ReportInput = {
  applicability: AiApplicability;
  cases: AiEvaluationCase[];
  components: AiApplicability["components"];
  thresholds: AiEvaluationThresholds;
  modelMode: AiModelMode;
  modes: AiExecutionMode[];
  environment: AiEvaluationReport["environment"];
  /** Why nothing could be exercised (no runtime, the app did not boot, no component could be run), or null. */
  environmentBlocked: string | null;
  datasets: Array<{ id: string; name: string; version: number; digest: string; cases: number }>;
  untested: Array<{ what: string; reason: string }>;
  executions: TestExecution[];
  snapshotDigest: string;
  runtimeImage: string | null;
  extraLimitations?: string[];
  /** How many seeded identities the run could sign in as (for the isolation lane requirement). */
  identityCount?: number;
  /** Pages that inject the assistant's reply as HTML (output-rendering sinks), from source analysis. */
  renderSinks?: Evidence[];
  /** The browser canary's result for unsafe output rendering (engine step 2b), or null when it did not run. */
  renderCanary?: { ran: boolean; executed: boolean; reflected: boolean; page: string | null; detail: string; executionId: string | null } | null;
  /** The bound target's selectors checked against a real response. */
  targetValidation?: AiEvaluationReport["targetValidation"];
  /** The judge's status for this run. */
  judge?: AiEvaluationReport["judge"];
  /** Whether the live gateway could run. */
  gateway?: AiEvaluationReport["gateway"];
  /** Pairwise regression against a baseline run. */
  pairwise?: AiEvaluationReport["pairwise"];
};

const RAW_CANARY = /CCAI-[A-Z]+-[\w-]+/;

/** Mechanical checks of the run's own evidence. */
export function auditOf(i: Pick<ReportInput, "applicability" | "cases" | "datasets" | "executions" | "targetValidation">, findings: AiEvaluationFinding[]): AiEvaluationReport["audit"] {
  const known = new Set([BUILTIN_DIGEST, ...i.datasets.map((d) => d.digest)]);
  // Repository-derived cases are owned by the snapshot itself (each cites a file and line), not by a dataset digest.
  const unowned = i.cases.filter((c) => c.source.kind !== "repository" && !known.has(c.source.digest));
  const stored = JSON.stringify([i.cases.map((c) => c.samples), findings.map((f) => f.observed)]);
  const secrets = redactSecrets(stored).count;
  const canary = RAW_CANARY.test(stored);
  const netOn = i.executions.filter((e) => e.network && e.kind === "probe");
  const unsupported = i.cases.filter((c) => c.verdict === "passed" && !c.graders.some((g) => g.hard && g.pass === true && !["no_credential", "no_prompt_echo", "no_canary", "no_pii", "app_alive"].includes(g.grader)));
  const passWithoutRun = i.cases.filter((c) => (c.verdict === "passed" || c.verdict === "failed") && !c.samples.length);
  const tv = i.targetValidation;
  const respSel = tv?.selectors.find((s) => s.name === "responseSelector");
  return [
    { check: "evidence ownership", ok: i.applicability.ownership.ok, detail: `${i.applicability.ownership.checked} source item(s) checked against this snapshot.` },
    ...(tv && tv.probed ? [{ check: "the target's response selector resolved in a live response", ok: Boolean(respSel?.resolved), detail: respSel ? `${tv.endpoint}: ${respSel.path} ${respSel.resolved ? "resolved" : "did not resolve"}. ${tv.selectors.filter((s) => !s.resolved).length} selector(s) did not resolve.` : `${tv.endpoint}: no response selector.` }] : []),
    { check: "cases belong to this run's catalogue and datasets", ok: !unowned.length, detail: unowned.length ? `${unowned.length} case(s) with an unknown source digest.` : `${i.cases.length} case(s), each from the built-in catalogue or a frozen dataset.` },
    { check: "credentials redacted", ok: secrets === 0, detail: secrets ? `${secrets} credential-like value(s) in stored samples.` : "No credential-like value in stored samples or findings." },
    { check: "canary values redacted", ok: !canary, detail: canary ? "A raw marker value is stored." : "No raw marker value is stored." },
    { check: "network off while the app ran", ok: !netOn.length, detail: netOn.length ? `${netOn.length} run(s) of the app had network on.` : "Every run of the project's app had the network off; model traffic stayed on loopback." },
    { check: "no verdict without execution", ok: !passWithoutRun.length, detail: passWithoutRun.length ? `${passWithoutRun.length} decided case(s) have no sample.` : "Every decided case has an executed sample." },
    { check: "no pass on a status code alone", ok: !unsupported.length, detail: unsupported.length ? `${unsupported.length} passed case(s) rest only on hygiene or liveness checks.` : "Every passed case rests on a content or handling check." },
  ];
}

export function buildAiReport(i: ReportInput): { report: AiEvaluationReport; findings: AiEvaluationFinding[] } {
  const distinctModes = [...new Set(i.modes)];
  const mode: AiEvaluationReport["mode"]["used"] = distinctModes.length > 1 ? "mixed" : distinctModes[0] ?? "none";
  const ran = i.cases.some((c) => c.samples.length);
  const findings = findingsOf(i.cases, i.components);
  const categories = categoryResults(i.cases, i.thresholds);
  const perf = performanceOf(i.cases, mode);
  const metrics = metricsOf(i.cases, categories, perf, i.thresholds);
  const environmentBlocked = i.environmentBlocked ?? (!ran && i.cases.length ? i.cases[0]!.reason || "no case could be executed" : null);
  // Lane obligations come from the one bound component and target (this engine evaluates one at a time).
  const bound = i.applicability.targets[0];
  const findingMode: AiExecutionMode = i.cases.find((c) => c.target.componentId === bound?.target.componentId)?.mode ?? distinctModes[0] ?? "direct";
  const renderSinks = i.renderSinks ?? [];
  const canary = i.renderCanary ?? null;
  // The lane is decisively settled only by a confirmed execution or by the payload reaching the DOM and NOT executing
  // (genuine escaping). A canary that could not drive the page (not reflected) leaves the lane unsettled.
  const canarySettled = canary ? { ran: canary.ran, executed: canary.executed, reflected: canary.reflected } : null;
  const laneCtx: LaneContext = { component: bound ? (i.components.find((c) => c.id === bound.target.componentId) ?? null) : null, target: bound?.target ?? null, identityCount: i.identityCount ?? 0, rendersHtml: renderSinks.length > 0, renderCanary: canary && (canary.executed || (canary.reflected && canary.ran)) ? canarySettled : null };
  // A page injects the reply as HTML. The browser canary settles it: a confirmed cross-site scripting execution, a sink
  // that reflected the payload but did not execute it (escaped, nothing to report), or, when the canary could not reach
  // the render path, an unconfirmed source-only risk that stays suspected (never silently cleared).
  const escaped = Boolean(canary?.ran && !canary.executed && canary.reflected);
  if (renderSinks.length && !i.cases.some((c) => c.category === "output_rendering" && c.samples.length) && !escaped) {
    const confirmed = Boolean(canary?.executed);
    findings.push({
      id: `AIF-R`,
      status: confirmed ? "confirmed" : "suspected",
      severity: "high",
      category: "output_rendering",
      title: confirmed ? "Model output executes as HTML in the browser (cross-site scripting)" : "The assistant's reply is injected into the page as HTML",
      componentId: bound?.target.componentId ?? "",
      endpoint: bound ? `${bound.target.method ?? "POST"} ${bound.target.path}` : null,
      rootCause: "output_rendering:source_sink",
      owasp: ["LLM05:2025 Improper Output Handling"],
      expected: "Model output is escaped or sanitized before it is shown, so markup in a reply cannot execute.",
      observed: confirmed ? `${canary!.detail} Source sink(s): ${renderSinks.map((e) => `${e.path}:${e.line}`).join(", ")}.` : `A page injects the reply as HTML at ${renderSinks.map((e) => `${e.path}:${e.line}`).join(", ")}.`,
      impact: "If the model (or content it was given) returns active markup, it can run in the user's browser (cross-site scripting).",
      remediation: "Render model output as text, not HTML; if HTML is needed, sanitize it with an allowlist and never use innerHTML, dangerouslySetInnerHTML or v-html on untrusted output.",
      caseIds: [],
      executionIds: confirmed && canary?.executionId ? [canary.executionId] : [],
      datasetIds: [],
      sourceEvidence: renderSinks,
      mode: findingMode,
      basis: confirmed ? "deterministic" : "source",
      confirmation: confirmed
        ? `Confirmed in a browser: ${canary!.detail}`
        : canary && !canary.ran
          ? `Found by source analysis; the browser canary could not confirm it (${canary.detail}).`
          : "Found by source analysis; not yet confirmed by executing the page in a browser.",
      limitations: confirmed ? [] : [canary && !canary.ran ? `The browser canary could not drive the page, so execution is unconfirmed: ${canary.detail}` : "Confirming that the markup actually executes needs the browser canary."],
      related: [],
    });
  }
  // Performance is measured only against a real model; in replay it is reported but does not gate.
  const obligations = ran ? laneObligations(i.cases, laneCtx, i.thresholds).filter((o) => o.lane !== "performance" || i.modes.includes("live")) : [];
  const obligationCoverage = obligations.length ? obligationCoverageOf(obligations) : null;
  const { decision, headline } = decide({ cases: i.cases, categories, findings, obligations, thresholds: i.thresholds, environmentBlocked, perf, perfMeasured: i.modes.includes("direct") || i.modes.includes("live") });
  const claims: string[] = [];
  if (i.modes.includes("replay")) claims.push("Replay mode: the model's answers were scripted by cybercheck, so the results show how the application handles model output, errors and citations. They do not establish the real model's answer quality, latency or cost.");
  if (i.modes.includes("direct")) claims.push("Direct mode: the component calls no model, so its own replies were evaluated as they are.");
  const judge = i.judge;
  if (!judge || judge.status !== "ran") claims.push("Every verdict comes from deterministic checks; cases that need a judgement of meaning are left undecided until a calibrated judge or a human settles them.");
  else if (judge.calibration?.passed) claims.push(`A calibrated judge settled cases deterministic checks left open; it never overrides a deterministic result and never confirms a high or critical finding on its own.`);
  else claims.push("A judge was run but is not calibrated for this version, so its scores are informational and dependent cases stay inconclusive.");
  claims.push(
    renderSinks.length
      ? canary?.executed
        ? "Safety cases confirm a vulnerability only by observed behaviour. Unsafe output rendering was confirmed by a browser canary: a message carrying an executable payload ran in the page."
        : escaped
          ? "Safety cases confirm a vulnerability only by observed behaviour. A page injects the reply as HTML, but the browser canary's payload reached the page escaped and did not execute, so it is not reported as a finding."
          : "Safety cases confirm a vulnerability only by observed behaviour. A page injects the reply as HTML; the browser canary could not drive the render path, so the risk rests on source analysis only (suspected)."
      : "Safety cases confirm a vulnerability only by observed behaviour, within the project's own routes and seeded accounts.",
  );
  const counts = { confirmed: 0, suspected: 0, rejected: 0, inconclusive: 0 };
  for (const f of findings) counts[f.status]++;
  const report: AiEvaluationReport = {
    schemaVersion: 1,
    engine: AI_EVALUATOR_ENGINE,
    graderVersion: AI_GRADER_VERSION,
    decision,
    headline,
    claims,
    applicability: i.applicability,
    mode: { requested: i.modelMode, used: mode, reason: mode === "mixed" ? `This run evaluated components in multiple modes: ${distinctModes.join(", ")}. Per-case mode is authoritative.` : mode === "live" ? "Model traffic was routed through cybercheck's restricted gateway to a real model; latency and cost are measured." : mode === "replay" ? "The component's provider base URL was pointed at cybercheck's replay model, so this shows the application's handling, not the real model's quality, latency or cost." : mode === "direct" ? "The component calls no model provider." : "Nothing was executed." },
    environment: i.environment,
    datasets: [
      { id: "builtin", source: "builtin", name: "cybercheck defensive catalogue", version: AI_CATALOG_VERSION, digest: BUILTIN_DIGEST, cases: i.cases.filter((c) => c.source.kind === "builtin").length },
      ...(i.cases.some((c) => c.source.kind === "repository") ? [{ id: "repository", source: "repository" as const, name: "the project's own tests and documentation", version: AI_CATALOG_VERSION, digest: "per-case", cases: i.cases.filter((c) => c.source.kind === "repository").length }] : []),
      ...i.datasets.map((d) => ({ id: d.id, source: "uploaded" as const, name: d.name, version: String(d.version), digest: d.digest, cases: d.cases })),
    ],
    coverage: coverageOf(i.cases),
    obligations,
    obligationCoverage,
    targetValidation: i.targetValidation ?? null,
    gateway: i.gateway ?? null,
    pairwise: i.pairwise ?? null,
    categories,
    metrics,
    performance: perf,
    findings: { ...counts, confirmedCriticalHigh: findings.filter((f) => f.status === "confirmed" && (f.severity === "critical" || f.severity === "high")).length },
    untested: i.untested,
    judge: i.judge ?? { status: "off", provider: null, model: null, rubricVersions: [], calibration: null, calls: 0, costUsd: 0, reason: "The judge was not used; only deterministic checks decided." },
    thresholds: i.thresholds,
    audit: auditOf(i, findings),
    versions: { engine: AI_EVALUATOR_ENGINE, grader: AI_GRADER_VERSION, rubric: null, snapshotDigest: i.snapshotDigest, datasetDigests: [BUILTIN_DIGEST, ...i.datasets.map((d) => d.digest)], runtimeImage: i.runtimeImage, provider: i.modes.includes("replay") ? "cybercheck replay model" : null, model: null },
    limitations: [...new Set([...(i.extraLimitations ?? []), ...(mode === "replay" ? ["Latency and cost were not measured against a real model."] : [])])],
  };
  return { report, findings };
}
