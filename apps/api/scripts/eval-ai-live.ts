// Credit-dependent live validation of the AI Evaluator. This command intentionally fails closed until a sandbox
// provider exposes a trusted gateway sidecar: the evaluated app must never share the provider key or outbound network.
// Once that transport exists, this runs a replay baseline followed by a live, judged comparison.
//
// Usage (from apps/api, Gemini must be the judge provider):
//   TESTING_AI_PROVIDER=gemini npx tsx --env-file=../../.env scripts/eval-ai-live.ts <round>
// Output: ../../.data/eval/ai-round-<n>/{live-scorecard.md, control.replay.run.json, control.live.run.json}
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db, pool } from "../src/db/client.ts";
import { testingRun } from "../src/db/schema.ts";
import { env, providers } from "../src/env.ts";
import { aiDetail } from "../src/routes/ai-evaluator.ts";
import { redactAiRun } from "../src/ai-evaluator/redact.ts";
import { AI_EVALUATOR_ENGINE } from "../src/ai-evaluator/version.ts";
import { liveGatewayStatus } from "../src/ai-evaluator/gateway.ts";
import { processRun, sandboxProvider, sessionFor } from "../src/testing/worker.ts";
import type { AiSession } from "../src/understanding/ai/gateway.ts";
import { evalUser, readyUnderstanding, snapshotOf } from "./eval-common.ts";

// Describe the upstream model. These values alone do not enable live mode; liveGatewayStatus also requires the trusted
// sidecar capability, so this script cannot accidentally fall back to the old in-workload gateway.
process.env.CC_LIVE_MODEL_BASE_URL = env.NEBIUS_BASE_URL;
process.env.CC_LIVE_MODEL = "deepseek-ai/DeepSeek-V4-Flash-0731";
process.env.CC_LIVE_MODEL_KEY = env.NEBIUS_API_KEY ?? "";
process.env.CC_LIVE_MODEL_IN_PRICE = "0.30";
process.env.CC_LIVE_MODEL_OUT_PRICE = "0.90";
// No analysis AI: the dossier stays code-derived (deterministic). Credit is spent only on the app's live model traffic
// and the judge.
providers.ai = false;

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const round = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "live";
const outDir = join(root, ".data/eval", `ai-round-${round}`);
mkdirSync(outDir, { recursive: true });
const CONTROL = join(here, "../test/ai-bench/clean-ai-control/project");

type Run = Awaited<ReturnType<typeof aiDetail>>;

async function runOnce(label: string, snapId: string, projectId: string, understandingId: string, who: { userId: string }, policy: Record<string, unknown>, session: AiSession | null): Promise<Run> {
  const t0 = Date.now();
  const log = (m: string) => console.log(`[${label}] ${m}`);
  const runId = randomUUID();
  await db.insert(testingRun).values({ id: runId, check: "ai-evaluator", snapshotId: snapId, projectId, understandingRunId: understandingId, requestedBy: who.userId, policy: { engine: AI_EVALUATOR_ENGINE, ...policy }, status: "running", generation: 1, startedAt: new Date(), heartbeatAt: new Date() });
  let last = "";
  await processRun({ id: runId, generation: 1 }, { provider: sandboxProvider(), session, onProgress: (s) => s !== last && log((last = s)) });
  const [row] = await db.select().from(testingRun).where(eq(testingRun.id, runId));
  const run = redactAiRun(await aiDetail(row!));
  log(`finished ${run.status} in ${((Date.now() - t0) / 60000).toFixed(1)} min: ${run.report?.decision ?? run.error}`);
  return run;
}

/** Live-focused metrics: real model cost/tokens/latency, judge activity, pairwise, gateway health, audit, network. */
function liveLines(replay: Run, live: Run): string[] {
  const rep = live.report;
  const totCost = live.cases.reduce((n, c) => n + (c.measurements.costUsd ?? 0), 0);
  const totIn = live.cases.reduce((n, c) => n + c.measurements.tokensIn, 0);
  const totOut = live.cases.reduce((n, c) => n + c.measurements.tokensOut, 0);
  const totReq = live.cases.reduce((n, c) => n + c.measurements.modelRequests, 0);
  const lat = live.cases.map((c) => c.measurements.medianMs).filter((x): x is number => x != null).sort((a, b) => a - b);
  const liveCases = live.cases.filter((c) => c.mode === "live");
  const j = rep?.judge;
  const pw = rep?.pairwise;
  const g = rep?.gateway ?? liveGatewayStatus();
  const netOn = live.executions.filter((e) => e.kind === "probe" && e.network).length;
  return [
    `replay baseline decision: ${replay.report?.decision ?? replay.status}; live decision: ${rep?.decision ?? live.status}`,
    `live mode cases: ${liveCases.length} of ${live.cases.length} ran through the gateway; modes present: ${[...new Set(live.cases.map((c) => c.mode))].join(", ")}`,
    `real model spend: $${totCost.toFixed(4)} of the $0.50 cap; ${totReq} model request(s); tokens ${totIn} in / ${totOut} out`,
    `latency (median per case, ms): min ${lat[0] ?? "n/a"}, median ${lat[Math.floor((lat.length - 1) / 2)] ?? "n/a"}, max ${lat.at(-1) ?? "n/a"}`,
    `gateway health: ${g.available ? `available, routing to ${g.model}` : `unavailable: ${g.reason}`}`,
    `Gemini judge: status ${j?.status ?? "n/a"}, provider ${j?.provider ?? "n/a"}/${j?.model ?? "n/a"}, calibration ${j?.calibration ? `balAcc ${j.calibration.balancedAccuracy.toFixed(2)} (${j.calibration.passed ? "passed" : "below gate"})` : "none"}, settled ${j?.calls ?? 0} call(s) over ${rep?.coverage.applicable ?? 0} case(s), judge cost $${(j?.costUsd ?? 0).toFixed(4)}`,
    `pairwise vs replay baseline: ${pw ? `${pw.compared} compared, ${pw.better} better, ${pw.worse} worse, ${pw.tie} tied (${pw.note})` : "none"}`,
    `audit: ${(rep?.audit ?? []).filter((a) => !a.ok).map((a) => a.check).join(", ") || "all checks passed"}; executions ${live.executions.length}, network on while app ran: ${netOn} (must be 0; only the trusted gateway sidecar may have egress)`,
  ];
}

async function main() {
  if (env.TESTING_AI_PROVIDER !== "gemini") throw new Error("Run with TESTING_AI_PROVIDER=gemini so the judge session is Gemini. Current: " + env.TESTING_AI_PROVIDER);
  if (!providers.testingAi) throw new Error("No judge model configured (GEMINI_API_KEY).");
  const gw = liveGatewayStatus();
  if (!gw.available) throw new Error(`Live gateway is not available: ${gw.reason}`);
  console.log(`Live gateway ready -> ${gw.model}; judge provider Gemini (${env.GEMINI_MODEL_CRITIC}).`);

  const who = await evalUser();
  const snap = await snapshotOf(CONTROL, "ai-control-live", who, round);
  const ur = await readyUnderstanding(snap.id, "control");
  console.log("analysis ready (code-derived); starting replay baseline, then live");

  // Replay baseline on this snapshot (deterministic), then the live run comparing against it.
  const replay = await runOnce("control replay", snap.id, snap.projectId, ur.id, who, { profile: "quick", judge: "auto", modelMode: "replay", runtime: "local", datasetIds: [] }, sessionFor());
  writeFileSync(join(outDir, "control.replay.run.json"), JSON.stringify(replay, null, 2));

  const live = await runOnce("control live", snap.id, snap.projectId, ur.id, who, { profile: "quick", judge: "auto", modelMode: "live", runtime: "local", datasetIds: [], baselineRunId: replay.id }, sessionFor());
  writeFileSync(join(outDir, "control.live.run.json"), JSON.stringify(live, null, 2));

  const lines = [`# AI Evaluator round ${round} (step 10 live validation)`, "", `Engine ${AI_EVALUATOR_ENGINE}, profile quick, runtime local, live model ${gw.model}.`, "", "## control (replay baseline then live)", "", ...liveLines(replay, live).map((l) => `- ${l}`), ""];
  writeFileSync(join(outDir, "live-scorecard.md"), lines.join("\n"));
  console.log(`\n${lines.join("\n")}\nWritten to ${outDir}`);
  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
