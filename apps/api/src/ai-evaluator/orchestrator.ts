import { and, eq, inArray } from "drizzle-orm";
import { buffer } from "node:stream/consumers";
import { AI_DEFAULT_THRESHOLDS, AiEvaluationPolicyInput, type AiApplicability, type AiEvaluationReport, type ProjectDossier, type TestExecution, type TestingUsage } from "@cybercheck/contracts";
import { db } from "../db/client.ts";
import { aiEvaluationDataset, snapshot, testingRun, understandingRun } from "../db/schema.ts";
import type { AiSession } from "../understanding/ai/gateway.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { selectSecurityRuntime } from "../security/runtime.ts";
import { SandboxUnavailableError, type SandboxProvider } from "../testing/sandbox/provider.ts";
import { POLICY, type Ctx } from "../testing/runtime.ts";
import type { RunStore } from "../testing/store.ts";
import { getSnapshotSource } from "../understanding/source.ts";
import { assessApplicability } from "./applicability.ts";
import { readFrozenDataset } from "./datasets.ts";
import { buildAiReport } from "./report.ts";
import { runAiCases, type AiRunResult } from "./run.ts";
import { AI_EVALUATOR_ENGINE, AI_GRADER_VERSION } from "./version.ts";

// The AI Evaluator engine: admission, applicability, frozen datasets, then the defensive cases compiled, run against
// the project's own app (replay model or direct, network off), graded deterministically, aggregated and decided. A
// project with no AI component finishes as not_applicable without any sandbox or judge.

export type AiDeps = { provider: SandboxProvider | null; session: AiSession | null; objects: ObjectStore; signal: AbortSignal };

const noUsage = (): TestingUsage => ({ aiCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, sandboxOperations: 0, sandboxCpuSeconds: 0, models: {} });

function notApplicableReport(applicability: AiApplicability, contentDigest: string): AiEvaluationReport {
  return {
    schemaVersion: 1,
    engine: AI_EVALUATOR_ENGINE,
    graderVersion: AI_GRADER_VERSION,
    decision: "not_applicable",
    headline: "No AI component was found, so the AI Evaluator does not apply. Nothing was executed.",
    claims: ["The decision rests on the project analysis only; no sandbox, model or judge was used."],
    applicability,
    mode: { requested: "auto", used: "none", reason: "Nothing to evaluate." },
    environment: { requested: "auto", selected: "none", provider: null, fallbackReason: null, isolation: "Nothing was executed." },
    datasets: [],
    coverage: { decisive: 0, applicable: 0, criticalDecisive: 0, criticalApplicable: 0 },
    categories: [],
    metrics: [],
    performance: { turns: 0, p50Ms: null, p95Ms: null, maxMs: null, modelRequests: 0, tokensIn: 0, tokensOut: 0, costUsd: null, costBasis: "not_measured" },
    findings: { confirmed: 0, suspected: 0, rejected: 0, inconclusive: 0, confirmedCriticalHigh: 0 },
    untested: [],
    judge: { status: "not_needed", provider: null, model: null, rubricVersions: [], calibration: null, calls: 0, costUsd: 0, reason: "No AI component." },
    thresholds: AI_DEFAULT_THRESHOLDS,
    audit: [{ check: "evidence ownership", ok: applicability.ownership.ok, detail: `${applicability.ownership.checked} item(s) checked against this snapshot.` }],
    versions: { engine: AI_EVALUATOR_ENGINE, grader: AI_GRADER_VERSION, rubric: null, snapshotDigest: contentDigest, datasetDigests: [], runtimeImage: null, provider: null, model: null },
    limitations: [],
  };
}

const ISOLATION = {
  nebius: "An ephemeral Nebius sandbox; the network was off while the app ran and model traffic went only to the loopback replay model.",
  local: "A disposable local container with no host project mount; the network was off while the app ran, capabilities were dropped and no-new-privileges was set. Model traffic went only to the loopback replay model.",
  static: "Nothing was executed.",
} as const;

export async function runAiEvaluation(store: RunStore, deps: AiDeps, onProgress: (step: string) => void) {
  const [run] = await db.select().from(testingRun).where(eq(testingRun.id, store.runId));
  if (!run) throw new Error("run not found");
  const blocked = async (reason: string) => {
    await store.event("admission", reason);
    await store.finish("blocked", { error: reason, usage: noUsage() });
  };
  const step = async (phase: Parameters<RunStore["phase"]>[0], text: string) => {
    onProgress(text);
    await store.phase(phase, text);
  };

  await step("admission", "Checking the snapshot and its analysis");
  const [snap] = await db.select().from(snapshot).where(eq(snapshot.id, run.snapshotId));
  const [ur] = run.understandingRunId ? await db.select().from(understandingRun).where(eq(understandingRun.id, run.understandingRunId)) : [];
  const d = ur?.dossier as ProjectDossier | null;
  if (!snap?.archiveObjectKey || !snap.contentDigest || snap.status !== "BASELINED") return blocked("The snapshot is not baselined.");
  if (!d || ur?.status !== "ready") return blocked("The project analysis is not ready. Wait until the project shows Ready.");
  if (snap.projectId !== run.projectId) return blocked("The snapshot does not belong to this run's project.");
  const { rerun, ...rawPolicy } = (run.policy ?? {}) as Record<string, unknown> & { rerun?: { parentRunId: string; caseIds: string[] } };
  const policy = AiEvaluationPolicyInput.parse(rawPolicy);
  const thresholds = { ...AI_DEFAULT_THRESHOLDS, ...(policy.thresholds ?? {}) };

  await step("applicability", "Looking for AI components and the routes that call them");
  const src = await getSnapshotSource(deps.objects, snap.archiveObjectKey);
  const applicability = assessApplicability({ dossier: d, src, contentDigest: snap.contentDigest, target: policy.target });
  await store.setPlan({ engine: AI_EVALUATOR_ENGINE, applicability });
  await store.event("applicability", applicability.reason);
  if (applicability.status === "not_applicable") {
    await store.finish("completed", { report: notApplicableReport(applicability, snap.contentDigest), usage: noUsage() });
    return;
  }
  if (applicability.status === "ownership_failed") return blocked(applicability.reason);

  // ---- frozen datasets: read back from their artifacts; the digest must still match
  await step("datasets", policy.datasetIds.length ? `Loading ${policy.datasetIds.length} frozen dataset(s)` : "Using the built-in defensive catalogue");
  const rows = policy.datasetIds.length ? await db.select().from(aiEvaluationDataset).where(and(eq(aiEvaluationDataset.projectId, run.projectId), inArray(aiEvaluationDataset.id, policy.datasetIds))) : [];
  if (rows.length !== policy.datasetIds.length) return blocked("A chosen dataset does not belong to this project.");
  const datasets: Array<{ id: string; name: string; version: number; digest: string; cases: ReturnType<typeof readFrozenDataset> }> = [];
  for (const r of rows) {
    try {
      const text = (await buffer(deps.objects.get(r.artifactKey))).toString("utf8");
      datasets.push({ id: r.id, name: r.name, version: r.version, digest: r.digest, cases: readFrozenDataset(text, r.digest) });
    } catch (err) {
      return blocked(`The dataset ${r.name} v${r.version} could not be read back intact: ${(err as Error).message}`);
    }
  }
  const datasetInfo = datasets.map((x) => ({ id: x.id, name: x.name, version: x.version, digest: x.digest, cases: x.cases.length }));

  const finish = async (o: { result: AiRunResult | null; environmentBlocked: string | null; environment: AiEvaluationReport["environment"]; executions: TestExecution[]; usage: TestingUsage; headline?: string }) => {
    await step("aggregating", "Grading cases and building findings");
    const cases = o.result?.cases ?? [];
    const { report, findings } = buildAiReport({
      applicability,
      cases,
      components: applicability.components,
      thresholds,
      modelMode: policy.modelMode,
      modes: o.result?.modes ?? [],
      environment: o.environment,
      environmentBlocked: o.environmentBlocked,
      datasets: datasetInfo,
      untested: [...(o.result?.untested ?? []), ...applicability.unbound.map((u) => ({ what: `Component ${u.componentId}`, reason: u.reason })), ...applicability.unsupported],
      executions: o.executions,
      snapshotDigest: snap.contentDigest!,
      runtimeImage: o.environment.selected === "none" || o.environment.selected === "static" ? null : POLICY.image,
      extraLimitations: [...(rerun ? [`A rerun of ${rerun.parentRunId}: only ${rerun.caseIds.length} chosen case(s) ran, and no verdict was copied from that run.`] : []), ...(o.result?.bootNote && !o.result.appBooted ? [o.result.bootNote] : [])],
    });
    if (o.headline) report.headline = o.headline;
    await step("reporting", "Writing the report");
    for (const c of cases) await store.putAiCase(c);
    for (const f of findings) await store.putFinding(f);
    await store.finish("completed", { report, usage: o.usage });
  };
  const none: AiEvaluationReport["environment"] = { requested: policy.runtime, selected: "none", provider: null, fallbackReason: null, isolation: "Nothing was executed." };

  if (applicability.status === "no_target") return finish({ result: null, environmentBlocked: null, environment: none, executions: [], usage: noUsage(), headline: `AI was found, but no route to evaluate it could be established: ${applicability.reason} Choose the endpoint to evaluate and run again.` });

  // ---- runtime: Nebius, else local Docker, else nothing (the project's code never runs on the host)
  await step("preparing", "Choosing where to run the app");
  const selection = await selectSecurityRuntime(policy.runtime, deps.provider);
  const environment: AiEvaluationReport["environment"] = { requested: policy.runtime, selected: selection.selected, provider: selection.provider?.name ?? null, fallbackReason: selection.fallbackReason, isolation: ISOLATION[selection.selected] };
  await store.setPlan({ engine: AI_EVALUATOR_ENGINE, applicability, runtime: { selected: selection.selected, fallbackReason: selection.fallbackReason, health: selection.health }, datasets: datasetInfo, rerun: rerun ?? null });
  if (!selection.provider) return finish({ result: null, environmentBlocked: `no sandbox runtime is available (${selection.fallbackReason ?? "none configured"}).`, environment, executions: [], usage: noUsage() });
  await store.event("preparing", `Runtime: ${selection.selected}${selection.fallbackReason ? ` (${selection.fallbackReason})` : ""}; network off while the app runs`);

  const ctx = { ...deps, provider: selection.provider, store, runId: run.id, services: [], d, executions: [], sandboxOps: 0, sandboxCpu: 0 } as unknown as Ctx;
  const usage = (): TestingUsage => ({ ...noUsage(), sandboxOperations: ctx.sandboxOps, sandboxCpuSeconds: Math.round(ctx.sandboxCpu) });
  const executions = () => (ctx as unknown as { executions: TestExecution[] }).executions;

  await step("compiling", "Compiling the cases and checking them against the safety rules");
  let result: AiRunResult;
  try {
    await step("executing", "Preparing the app and running the cases");
    result = await runAiCases(ctx, { d, src, archive: await buffer(deps.objects.get(snap.archiveObjectKey)), applicability, policy, datasets, onlyCaseIds: rerun?.caseIds, onEvent: (m) => store.event("executing", m) });
  } catch (err) {
    if (!(err instanceof SandboxUnavailableError)) throw err;
    return finish({ result: null, environmentBlocked: `the ${selection.selected} runtime became unavailable: ${err.message}`, environment, executions: executions(), usage: usage() });
  }
  await store.event("executing", result.bootNote);
  const runnable = result.plans.some((p) => p.mode);
  const ran = result.cases.some((c) => c.samples.length);
  const environmentBlocked = !runnable ? `no component can be exercised in this engine version (${result.plans.map((p) => p.reason).join(" ")})` : !ran && result.cases.length ? result.bootNote || "no case could be executed" : null;
  return finish({ result, environmentBlocked, environment, executions: executions(), usage: usage() });
}
