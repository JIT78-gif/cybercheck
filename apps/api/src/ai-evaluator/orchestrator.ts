import { and, eq, inArray } from "drizzle-orm";
import { buffer } from "node:stream/consumers";
import { AI_DEFAULT_THRESHOLDS, AiEvaluationPolicyInput, type AiApplicability, type AiEvaluationReport, type ProjectDossier, type TestExecution, type TestingUsage } from "@cybercheck/contracts";
import { db } from "../db/client.ts";
import { aiEvaluationCase, aiEvaluationDataset, snapshot, testingRun, understandingRun } from "../db/schema.ts";
import type { AiSession } from "../understanding/ai/gateway.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { selectSecurityRuntime } from "../security/runtime.ts";
import { overlayArchive, overlaySource, type RepairOverlay } from "../security/repair-overlay.ts";
import { SandboxUnavailableError, type SandboxProvider } from "../testing/sandbox/provider.ts";
import { POLICY, type Ctx } from "../testing/runtime.ts";
import type { RunStore } from "../testing/store.ts";
import { getSnapshotSource } from "../understanding/source.ts";
import { assessApplicability } from "./applicability.ts";
import { readFrozenDataset } from "./datasets.ts";
import { detectRenderSinks } from "./rendering.ts";
import { runRenderCanary, type CanaryResult } from "./canary.ts";
import { calibrate, sessionJudge, JUDGE_RUBRIC_VERSION, type Calibration, type JudgeProvider } from "./judge.ts";
import { JUDGE_CALIBRATION } from "./judge-calibration.ts";
import { liveGatewayStatus } from "./gateway.ts";
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
    obligations: [],
    obligationCoverage: null,
    gateway: null,
    pairwise: null,
    targetValidation: null,
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
  const { rerun, repair, ...rawPolicy } = (run.policy ?? {}) as Record<string, unknown> & { rerun?: { parentRunId: string; caseIds: string[] }; repair?: { repairId: string; attempt: number; files: Array<{ path: string; key: string }> } };
  const policy = AiEvaluationPolicyInput.parse(rawPolicy);
  const thresholds = { ...AI_DEFAULT_THRESHOLDS, ...(policy.thresholds ?? {}) };

  await step("applicability", "Looking for AI components and the routes that call them");
  let src = await getSnapshotSource(deps.objects, snap.archiveObjectKey);
  const originalSrc = src;
  // Repair validation: the approved patch is overlaid on this disposable run only; the uploaded snapshot never changes.
  let repairOverlay: RepairOverlay | null = null;
  if (repair?.files?.length) {
    repairOverlay = new Map();
    for (const f of repair.files) repairOverlay.set(f.path, (await buffer(deps.objects.get(f.key))).toString("utf8"));
    src = overlaySource(src, repairOverlay);
    await store.event("applicability", `Validating a repair: ${repairOverlay.size} patched file(s) are overlaid in this isolated run only; the snapshot is unchanged.`);
  }
  const archiveForRun = async () => {
    const original = await buffer(deps.objects.get(snap.archiveObjectKey!));
    return repairOverlay ? Buffer.from(await overlayArchive(original, repairOverlay)) : original;
  };
  const applicability = assessApplicability({ dossier: d, src, contentDigest: snap.contentDigest, target: policy.target });
  await store.setPlan({ engine: AI_EVALUATOR_ENGINE, applicability });
  // Pages that inject the reply as HTML. A repair rerun keeps proving the pages the original snapshot had: a patch that
  // removes the sink must show in a real browser that the payload now stays inert, not merely that a scan stops seeing it.
  const sinksIn = (source: typeof src) => {
    const bt = applicability.targets[0];
    return bt ? detectRenderSinks(source, { routePaths: [bt.target.path, ...(applicability.components.find((c) => c.id === bt.target.componentId)?.endpoints.map((e) => e.split(" ").pop() ?? "") ?? [])], replySelector: bt.target.responseSelector }) : [];
  };
  const renderSinksOf = () => {
    const now = sinksIn(src);
    if (!repairOverlay) return now;
    const seen = new Set(now.map((e) => `${e.path}:${e.line}`));
    return [...now, ...sinksIn(originalSrc).filter((e) => !seen.has(`${e.path}:${e.line}`))];
  };
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

  // The judge is optional and never blocks deterministic work. It is built only when the user asked for it and a
  // model session exists, and it must calibrate against the frozen human-labelled set before it may gate anything.
  let judgeProvider: JudgeProvider | null = null;
  let calibration: Calibration | null = null;
  const judgeCost = () => (deps.session?.usage.filter((u) => u.purpose === "ai-judge").reduce((s, u) => s + u.costUsd, 0) ?? 0);
  const judgeStatusOf = (result: AiRunResult | null): AiEvaluationReport["judge"] => {
    const base = { provider: judgeProvider?.name ?? null, model: judgeProvider?.model ?? null, rubricVersions: judgeProvider ? [JUDGE_RUBRIC_VERSION] : [], calibration, calls: result?.judge?.calls ?? 0, costUsd: judgeCost() };
    if (policy.judge === "off") return { ...base, status: "off", reason: "The judge was turned off for this run; only deterministic checks decided." };
    if (!judgeProvider) return { ...base, status: "unavailable", reason: "No judge model or credit is available, so cases that need a judgement of meaning stay inconclusive." };
    if (!result?.judge?.scored) return { ...base, status: "not_needed", reason: "No case needed a judgement of meaning; deterministic checks settled every case." };
    return { ...base, status: "ran", reason: calibration?.passed ? `The judge was calibrated (balanced accuracy ${calibration.balancedAccuracy.toFixed(2)}) and settled ${result.judge.scored} case(s).` : "The judge is not calibrated for this version, so its scores are informational and dependent cases stay inconclusive." };
  };

  const finish = async (o: { result: AiRunResult | null; environmentBlocked: string | null; environment: AiEvaluationReport["environment"]; executions: TestExecution[]; usage: TestingUsage; headline?: string; renderCanary?: CanaryResult | null }) => {
    await step("aggregating", "Grading cases and building findings");
    const cases = o.result?.cases ?? [];
    const renderSinks = renderSinksOf();
    const untested = [...(o.result?.untested ?? []), ...applicability.unbound.map((u) => ({ what: `Component ${u.componentId}`, reason: u.reason })), ...applicability.unsupported];
    if (renderSinks.length && !(o.renderCanary?.executed || (o.renderCanary?.ran && o.renderCanary.reflected))) {
      untested.push({ what: "Unsafe output rendering (browser canary)", reason: o.renderCanary?.detail ?? (o.environmentBlocked ? `The browser proof could not run because ${o.environmentBlocked}` : "The application did not produce a runnable response before the browser proof step.") });
    }
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
      untested,
      executions: o.executions,
      snapshotDigest: snap.contentDigest!,
      identityCount: o.result?.identities ?? 0,
      targetValidation: o.result?.targetValidation ?? null,
      gateway: o.result?.gateway ?? liveGatewayStatus(),
      pairwise: o.result?.pairwise ?? null,
      renderSinks,
      renderCanary: o.renderCanary ?? null,
      runtimeImage: o.environment.selected === "none" || o.environment.selected === "static" ? null : POLICY.image,
      judge: judgeStatusOf(o.result),
      extraLimitations: [...(o.result?.limitations ?? []), ...(rerun ? [`A rerun of ${rerun.parentRunId}: only ${rerun.caseIds.length} chosen case(s) ran, and no verdict was copied from that run.`] : []), ...(o.result?.bootNote && !o.result.appBooted ? [o.result.bootNote] : [])],
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

  if (policy.judge === "auto" && deps.session) {
    judgeProvider = sessionJudge(deps.session, deps.session.opts.models.critic);
    await step("judging", "Calibrating the judge against the human-labelled set");
    try {
      calibration = await calibrate(judgeProvider, JUDGE_CALIBRATION);
      await store.event("judging", `Judge calibration: balanced accuracy ${calibration.balancedAccuracy.toFixed(2)}, ${calibration.passed ? "passed the gate" : "below the gate (its scores will be informational only)"}.`);
    } catch (err) {
      judgeProvider = null;
      await store.event("judging", `The judge could not be calibrated (${(err as Error).message}); its scores will not be used.`);
    }
  }

  // A baseline run to compare against (pairwise regression): its cases' replies, keyed by case id.
  let baseline: { runId: string; byId: Map<string, { reply: string | null }> } | null = null;
  if (policy.baselineRunId) {
    const [br] = await db.select().from(testingRun).where(and(eq(testingRun.id, policy.baselineRunId), eq(testingRun.projectId, run.projectId)));
    if (br) {
      const rows = await db.select().from(aiEvaluationCase).where(eq(aiEvaluationCase.runId, policy.baselineRunId));
      baseline = { runId: policy.baselineRunId, byId: new Map(rows.map((row) => { const c = row.data as import("@cybercheck/contracts").AiEvaluationCase; return [c.id, { reply: c.samples[0]?.turns.at(-1)?.reply ?? null }]; })) };
    }
  }

  await step("compiling", "Compiling the cases and checking them against the safety rules");
  let result: AiRunResult;
  try {
    await step("executing", "Preparing the app and running the cases");
    result = await runAiCases(ctx, { d, src, archive: await archiveForRun(), applicability, policy, datasets, onlyCaseIds: rerun?.caseIds, judge: judgeProvider && calibration ? { provider: judgeProvider, calibration } : null, baseline, onEvent: (m) => store.event("executing", m) });
  } catch (err) {
    if (!(err instanceof SandboxUnavailableError)) throw err;
    return finish({ result: null, environmentBlocked: `the ${selection.selected} runtime became unavailable: ${err.message}`, environment, executions: executions(), usage: usage() });
  }
  await store.event("executing", result.bootNote);
  const runnable = result.plans.some((p) => p.mode);
  const ran = result.cases.some((c) => c.samples.length);
  const environmentBlocked = !runnable ? `no component can be exercised in this engine version (${result.plans.map((p) => p.reason).join(" ")})` : result.liveProviderError ? result.liveProviderError : !ran && result.cases.length ? result.bootNote || "no case could be executed" : null;
  // Output-rendering canary (engine step 2b): only when a page injects the reply as HTML. It opens that page in a real
  // browser and tries to make the reply's markup execute; a real execution upgrades the finding to confirmed.
  let renderCanary: CanaryResult | null = null;
  const sinks = renderSinksOf();
  if (sinks.length && !environmentBlocked && ran) {
    await store.event("executing", "A page injects the reply as HTML; opening it in a browser to test whether model output executes (unsafe rendering)");
    try {
      renderCanary = await runRenderCanary(ctx, { d, src, archive: await archiveForRun(), applicability, sinks, nonce: `CCXSS${run.id.replace(/\D/g, "").slice(0, 8)}${Date.now().toString(36)}` });
      await store.event("executing", `Rendering canary: ${renderCanary.executed ? "model output executed in the browser (confirmed)" : renderCanary.ran ? "sent a payload; it did not execute" : "could not drive the page"}`);
    } catch (err) {
      renderCanary = { ran: false, executed: false, reflected: false, page: null, detail: `The rendering canary could not run: ${(err as Error).message}`, executionId: null };
    }
  }
  return finish({ result, environmentBlocked, environment, executions: executions(), usage: usage(), renderCanary });
}
