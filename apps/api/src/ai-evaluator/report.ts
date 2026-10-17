import type { AiApplicability, AiEvaluationCase, AiEvaluationFinding, AiEvaluationReport, AiEvaluationThresholds, AiExecutionMode, AiModelMode, TestExecution } from "@cybercheck/contracts";
import { redactSecrets } from "../understanding/source.ts";
import { BUILTIN_DIGEST } from "./catalog.ts";
import { categoryResults, coverageOf, decide, findingsOf, metricsOf, performanceOf } from "./decide.ts";
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
};

const RAW_CANARY = /CCAI-[A-Z]+-[\w-]+/;

/** Mechanical checks of the run's own evidence. */
export function auditOf(i: Pick<ReportInput, "applicability" | "cases" | "datasets" | "executions">, findings: AiEvaluationFinding[]): AiEvaluationReport["audit"] {
  const known = new Set([BUILTIN_DIGEST, ...i.datasets.map((d) => d.digest)]);
  const unowned = i.cases.filter((c) => !known.has(c.source.digest));
  const stored = JSON.stringify([i.cases.map((c) => c.samples), findings.map((f) => f.observed)]);
  const secrets = redactSecrets(stored).count;
  const canary = RAW_CANARY.test(stored);
  const netOn = i.executions.filter((e) => e.network && e.kind === "probe");
  const unsupported = i.cases.filter((c) => c.verdict === "passed" && !c.graders.some((g) => g.hard && g.pass === true && !["no_credential", "no_prompt_echo", "no_canary", "no_pii", "app_alive"].includes(g.grader)));
  const passWithoutRun = i.cases.filter((c) => (c.verdict === "passed" || c.verdict === "failed") && !c.samples.length);
  return [
    { check: "evidence ownership", ok: i.applicability.ownership.ok, detail: `${i.applicability.ownership.checked} source item(s) checked against this snapshot.` },
    { check: "cases belong to this run's catalogue and datasets", ok: !unowned.length, detail: unowned.length ? `${unowned.length} case(s) with an unknown source digest.` : `${i.cases.length} case(s), each from the built-in catalogue or a frozen dataset.` },
    { check: "credentials redacted", ok: secrets === 0, detail: secrets ? `${secrets} credential-like value(s) in stored samples.` : "No credential-like value in stored samples or findings." },
    { check: "canary values redacted", ok: !canary, detail: canary ? "A raw marker value is stored." : "No raw marker value is stored." },
    { check: "network off while the app ran", ok: !netOn.length, detail: netOn.length ? `${netOn.length} run(s) of the app had network on.` : "Every run of the project's app had the network off; model traffic stayed on loopback." },
    { check: "no verdict without execution", ok: !passWithoutRun.length, detail: passWithoutRun.length ? `${passWithoutRun.length} decided case(s) have no sample.` : "Every decided case has an executed sample." },
    { check: "no pass on a status code alone", ok: !unsupported.length, detail: unsupported.length ? `${unsupported.length} passed case(s) rest only on hygiene or liveness checks.` : "Every passed case rests on a content or handling check." },
  ];
}

export function buildAiReport(i: ReportInput): { report: AiEvaluationReport; findings: AiEvaluationFinding[] } {
  const mode: AiEvaluationReport["mode"]["used"] = i.modes.includes("replay") ? "replay" : i.modes.includes("direct") ? "direct" : i.modes.includes("live") ? "live" : "none";
  const ran = i.cases.some((c) => c.samples.length);
  const findings = findingsOf(i.cases, i.components);
  const categories = categoryResults(i.cases, i.thresholds);
  const perf = performanceOf(i.cases, mode);
  const metrics = metricsOf(i.cases, categories, perf, i.thresholds);
  const environmentBlocked = i.environmentBlocked ?? (!ran && i.cases.length ? i.cases[0]!.reason || "no case could be executed" : null);
  const { decision, headline } = decide({ cases: i.cases, categories, findings, thresholds: i.thresholds, environmentBlocked, perf, perfMeasured: mode === "direct" || mode === "live" });
  const claims: string[] = [];
  if (i.modes.includes("replay")) claims.push("Replay mode: the model's answers were scripted by cybercheck, so the results show how the application handles model output, errors and citations. They do not establish the real model's answer quality, latency or cost.");
  if (i.modes.includes("direct")) claims.push("Direct mode: the component calls no model, so its own replies were evaluated as they are.");
  claims.push("Every verdict comes from deterministic checks; no AI judge was used, so cases that need a judgement of meaning are left undecided.");
  claims.push("Only defensive cases ran: ordinary questions, provider failures and unusual input. Prompt injection, extraction and cross-tenant cases are not part of this engine version.");
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
    mode: { requested: i.modelMode, used: mode, reason: mode === "replay" ? "The component's provider base URL can be pointed at cybercheck's replay model; live mode needs the model gateway, which this engine version does not have." : mode === "direct" ? "The component calls no model provider." : "Nothing was executed." },
    environment: i.environment,
    datasets: [{ id: "builtin", source: "builtin", name: "cybercheck defensive catalogue", version: AI_CATALOG_VERSION, digest: BUILTIN_DIGEST, cases: i.cases.filter((c) => c.source.kind === "builtin").length }, ...i.datasets.map((d) => ({ id: d.id, source: "uploaded" as const, name: d.name, version: String(d.version), digest: d.digest, cases: d.cases }))],
    coverage: coverageOf(i.cases),
    categories,
    metrics,
    performance: perf,
    findings: { ...counts, confirmedCriticalHigh: findings.filter((f) => f.status === "confirmed" && (f.severity === "critical" || f.severity === "high")).length },
    untested: i.untested,
    judge: { status: "off", provider: null, model: null, rubricVersions: [], calibration: null, calls: 0, costUsd: 0, reason: "The AI judge is not part of this engine version; only deterministic checks decide." },
    thresholds: i.thresholds,
    audit: auditOf(i, findings),
    versions: { engine: AI_EVALUATOR_ENGINE, grader: AI_GRADER_VERSION, rubric: null, snapshotDigest: i.snapshotDigest, datasetDigests: [BUILTIN_DIGEST, ...i.datasets.map((d) => d.digest)], runtimeImage: i.runtimeImage, provider: mode === "replay" ? "cybercheck replay model" : null, model: null },
    limitations: [...new Set([...(i.extraLimitations ?? []), ...(mode === "replay" ? ["Latency and cost were not measured against a real model."] : [])])],
  };
  return { report, findings };
}
