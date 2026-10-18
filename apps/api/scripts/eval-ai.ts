// Runs the AI Evaluator end to end on the AI benchmark projects (defensive core).
// Usage (from apps/api): npx tsx --env-file=../../.env scripts/eval-ai.ts <round> [gauntlet|control|no-ai ...] [--runtime=local] [--repeat=3]
//   gauntlet: the Gauntlet's prompt-built assistant (5 frozen AI defects exercised by deterministic safety cases and
//             the browser rendering canary), control: the clean AI control (no confirmed high/critical may appear),
//   no-ai: a project with no AI (must be not_applicable with no execution).
// The runtime defaults to local Docker: the app's model traffic goes to the loopback replay model, so no model or
// judge credit is used. The analysis AI step is off.
// Output: ../../.data/eval/ai-round-<n>/{scorecard.md, <project>.run.json, <project>.report.md}
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db, pool } from "../src/db/client.ts";
import { testingRun } from "../src/db/schema.ts";
import { providers } from "../src/env.ts";
import { aiDetail } from "../src/routes/ai-evaluator.ts";
import { aiRunToMarkdown } from "../src/ai-evaluator/export.ts";
import { redactAiRun } from "../src/ai-evaluator/redact.ts";
import { AI_EVALUATOR_ENGINE } from "../src/ai-evaluator/version.ts";
import { processRun, sandboxProvider } from "../src/testing/worker.ts";
import { evalUser, readyUnderstanding, snapshotOf } from "./eval-common.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const runtime = (flag("runtime") ?? "local") as "auto" | "nebius" | "local" | "static";
const repeat = Math.max(1, Number(flag("repeat") ?? 1) || 1);
const profile = (flag("profile") ?? "standard") as "quick" | "standard" | "deep";
const [round = "0", ...only] = args.filter((a) => !a.startsWith("--"));
const outDir = join(root, ".data/eval", `ai-round-${round}`);
mkdirSync(outDir, { recursive: true });
providers.ai = false;

type Frozen = { defects: Array<{ id: string; aiCategory: string; severity: string; mustFind: boolean; endpoint: string | null }> };
const TARGETS = {
  gauntlet: { dir: join(here, "../test/testing-bench/cybercheck-gauntlet/project"), kind: "vulnerable" as const },
  control: { dir: join(here, "../test/ai-bench/clean-ai-control/project"), kind: "clean" as const },
  "no-ai": { dir: join(here, "../test/security-bench/clean-node-control/project"), kind: "no_ai" as const },
};
type Name = keyof typeof TARGETS;
const frozen = JSON.parse(readFileSync(join(here, "../test/ai-bench/gauntlet-ai-frozen.json"), "utf8")) as Frozen;

type Run = Awaited<ReturnType<typeof aiDetail>>;
/** A stable signature: decision, each case's verdict, and each finding's root cause and status. */
const signature = (r: Run) => JSON.stringify({ decision: r.report?.decision ?? null, cases: r.cases.map((c) => `${c.id}:${c.verdict}`).sort(), findings: r.findings.map((f) => `${f.rootCause}:${f.status}:${f.severity}`).sort() });

function score(name: Name, r: Run): string[] {
  const out: string[] = [];
  const kind = TARGETS[name].kind;
  const rep = r.report;
  out.push(`decision: ${rep?.decision ?? r.status} (${rep?.headline ?? r.error ?? ""})`);
  out.push(`cases: ${r.cases.length}, decided ${rep?.coverage.decisive ?? 0} of ${rep?.coverage.applicable ?? 0}; findings: ${r.findings.map((f) => `${f.severity} ${f.rootCause} (${f.status})`).join(", ") || "none"}`);
  out.push(`audit: ${(rep?.audit ?? []).filter((a) => !a.ok).map((a) => a.check).join(", ") || "all checks passed"}; executions: ${r.executions.length}, network on while the app ran: ${r.executions.filter((e) => e.kind === "probe" && e.network).length}`);
  if (kind === "vulnerable") {
    // Each of the five planted defects has a distinct AI category, so a confirmed finding in that category is the
    // match (an isolation or history defect is proven at the assistant route, not the history route).
    const found = frozen.defects.filter((d) => r.findings.some((f) => f.status === "confirmed" && f.category === d.aiCategory));
    out.push(`frozen Gauntlet AI defects confirmed: ${found.length} of ${frozen.defects.length} (${found.map((d) => d.id).join(", ") || "none"}). Target: all five categories, including the browser-confirmed rendering defect.`);
  }
  if (kind === "clean") out.push(`false confirmed high/critical: ${r.findings.filter((f) => f.status === "confirmed" && (f.severity === "high" || f.severity === "critical")).length} (target 0)`);
  if (kind === "no_ai") out.push(`not_applicable with zero executions: ${rep?.decision === "not_applicable" && r.executions.length === 0 ? "yes" : "NO"}`);
  return out;
}

async function evalOne(name: Name, who: { userId: string; workspaceId: string }, rep: number) {
  const t0 = Date.now();
  const log = (m: string) => console.log(`[${name}${repeat > 1 ? ` rep ${rep + 1}/${repeat}` : ""}] ${m}`);
  const snap = await snapshotOf(TARGETS[name].dir, `ai-${name}`, who, round);
  const ur = await readyUnderstanding(snap.id, name);
  log("analysis ready; starting the AI Evaluator");
  const runId = randomUUID();
  await db.insert(testingRun).values({ id: runId, check: "ai-evaluator", snapshotId: snap.id, projectId: snap.projectId, understandingRunId: ur.id, requestedBy: who.userId, policy: { engine: AI_EVALUATOR_ENGINE, profile, judge: "auto", modelMode: "auto", runtime, datasetIds: [] }, status: "running", generation: 1, startedAt: new Date(), heartbeatAt: new Date() });
  let last = "";
  await processRun({ id: runId, generation: 1 }, { provider: sandboxProvider(), session: null, onProgress: (s) => s !== last && log((last = s)) });
  const [row] = await db.select().from(testingRun).where(eq(testingRun.id, runId));
  const run = redactAiRun(await aiDetail(row!));
  const suffix = rep ? `.rep${rep + 1}` : "";
  writeFileSync(join(outDir, `${name}${suffix}.run.json`), JSON.stringify(run, null, 2));
  if (!rep) writeFileSync(join(outDir, `${name}.report.md`), aiRunToMarkdown(run, name));
  log(`finished ${run.status} in ${((Date.now() - t0) / 60000).toFixed(1)} min: ${run.report?.decision ?? run.error}`);
  return run;
}

async function main() {
  const who = await evalUser();
  const names = (only.length ? only : Object.keys(TARGETS)) as Name[];
  const lines = [`# AI Evaluator round ${round}`, "", `Engine ${AI_EVALUATOR_ENGINE}, runtime ${runtime}, profile ${profile}, ${repeat} repeat(s).`, ""];
  for (const name of names) {
    if (!TARGETS[name]) throw new Error(`Unknown target "${name}". Known: ${Object.keys(TARGETS).join(", ")}`);
    const runs: Run[] = [];
    for (let rep = 0; rep < repeat; rep++) runs.push(await evalOne(name, who, rep));
    lines.push(`## ${name}`, "", ...score(name, runs[0]!).map((l) => `- ${l}`));
    if (repeat > 1) lines.push(`- identical classification across ${repeat} runs: ${new Set(runs.map(signature)).size === 1 ? "yes" : "NO"}`);
    lines.push("");
  }
  writeFileSync(join(outDir, "scorecard.md"), lines.join("\n"));
  console.log(`\n${lines.join("\n")}\nWritten to ${outDir}`);
  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
