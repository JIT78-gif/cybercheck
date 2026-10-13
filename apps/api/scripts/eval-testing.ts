// Runs the Testing check end to end on benchmark projects and scores it against answer keys.
// Usage (from apps/api): npm run eval:testing -- <round> [project ...]
//   projects: names under test/testing-bench (default: all), "lead" or "hotel" for the local real projects (kept in .data/eval, never committed).
// Answer keys (expected.json) are read only by the scorer, never by the engine or its agents.
// Output: ../../.data/eval/testing-round-<n>/{scorecard.md, <project>.run.json}
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import tar from "tar-stream";
import { eq } from "drizzle-orm";
import type { ProjectDossier, TestingRunDetail } from "@cybercheck/contracts";
import { db, pool } from "../src/db/client.ts";
import { project, snapshot, testExecution, testFinding, testingRun, testObligation, understandingRun, user, workspace, workspaceMember } from "../src/db/schema.ts";
import { env } from "../src/env.ts";
import { startIntake } from "../src/intake/pipeline.ts";
import { INTAKE_POLICY_VERSION } from "../src/intake/policy.ts";
import { ENGINE_VERSION, POLICY } from "../src/testing/orchestrator.ts";
import { processRun, sandboxProvider, sessionFor, TESTING_MODELS } from "../src/testing/worker.ts";
import { ensureUnderstanding } from "../src/understanding/run.ts";
import { scoreRun, type Expected } from "../test/testing-score.ts";
import { scoreStrict } from "../test/testing-score-strict.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const benchDir = join(here, "../test/testing-bench");
const holdoutDir = join(here, "../test/testing-holdout");
const round = process.argv[2] ?? "0";
const only = process.argv.slice(3);
const outDir = join(root, ".data/eval", `testing-round-${round}`);
mkdirSync(outDir, { recursive: true });
const SKIP = /(^|\/)(node_modules|\.git|dist|build|coverage|\.venv|venv|__pycache__|\.pytest_cache|\.next)(\/|$)/;

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const rel = relative(base, full).replace(/\\/g, "/");
    if (SKIP.test(rel)) return [];
    return statSync(full).isDirectory() ? walk(full, base) : [rel];
  });
}

async function packDir(dir: string) {
  const out = join(tmpdir(), `cc-eval-${randomUUID()}.tar.gz`);
  const pack = tar.pack();
  const files = walk(dir);
  const done = pipeline(pack, createGzip(), createWriteStream(out));
  for (const f of files) {
    const body = readFileSync(join(dir, f));
    await new Promise<void>((res, rej) => pack.entry({ name: f, size: body.length, mode: 0o644 }, body, (e) => (e ? rej(e) : res())));
  }
  pack.finalize();
  await done;
  return out;
}

async function evalUser() {
  const email = "eval-testing@cybercheck.local";
  let [u] = await db.select().from(user).where(eq(user.email, email));
  if (!u) [u] = await db.insert(user).values({ id: randomUUID(), name: "Testing evaluation", email, emailVerified: true }).returning();
  let [ws] = await db.select().from(workspace).where(eq(workspace.createdBy, u!.id));
  if (!ws) {
    [ws] = await db.insert(workspace).values({ id: randomUUID(), name: "Evaluation", personal: true, createdBy: u!.id }).returning();
    await db.insert(workspaceMember).values({ workspaceId: ws!.id, userId: u!.id, role: "owner" });
  }
  return { userId: u!.id, workspaceId: ws!.id };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function snapshotOf(dir: string, name: string, who: { userId: string; workspaceId: string }) {
  const [p] = await db.insert(project).values({ id: randomUUID(), workspaceId: who.workspaceId, name: `${name}-r${round}-${Date.now().toString(36)}`, sourceType: "archive", createdBy: who.userId }).returning();
  const [s] = await db.insert(snapshot).values({ id: randomUUID(), projectId: p!.id, status: "RECEIVED", sourceType: "archive", sourceRef: `${name}.tar.gz`, intakePolicyVersion: INTAKE_POLICY_VERSION, ownershipAttestedAt: new Date(), attestedBy: who.userId }).returning();
  startIntake(s!.id, await packDir(dir));
  for (let i = 0; i < 120; i++) {
    const [now] = await db.select().from(snapshot).where(eq(snapshot.id, s!.id));
    if (now!.status === "BASELINED") return now!;
    if (now!.status === "REJECTED" || now!.status === "FAILED") throw new Error(`${name}: snapshot ${now!.status}: ${JSON.stringify(now!.rejectionReasons ?? now!.error)}`);
    await sleep(500);
  }
  throw new Error(`${name}: intake timed out`);
}

async function readyUnderstanding(snapId: string, name: string) {
  for (let i = 0; i < 400; i++) {
    const run = await ensureUnderstanding(snapId);
    const d = run.dossier as ProjectDossier | null;
    if (run.status === "failed") throw new Error(`${name}: analysis failed`);
    if (run.status === "ready" && d && d.ai?.status !== "running") return run;
    await sleep(3000);
  }
  throw new Error(`${name}: analysis timed out`);
}

async function detail(runId: string): Promise<TestingRunDetail> {
  const [r] = await db.select().from(testingRun).where(eq(testingRun.id, runId));
  const obs = await db.select().from(testObligation).where(eq(testObligation.runId, runId));
  const ex = await db.select().from(testExecution).where(eq(testExecution.runId, runId));
  const fi = await db.select().from(testFinding).where(eq(testFinding.runId, runId));
  return {
    id: r!.id, snapshotId: r!.snapshotId, projectId: r!.projectId, status: r!.status, phase: r!.phase as TestingRunDetail["phase"], step: null, progress: null,
    headline: (r!.report as { headline?: string } | null)?.headline ?? r!.error, counts: { obligations: obs.length, terminal: obs.filter((o) => !["planned", "running"].includes(o.status)).length, failed: obs.filter((o) => o.status === "failed").length, confirmedDefects: fi.filter((f) => (f.data as { kind: string; status: string }).kind === "product_defect" && (f.data as { status: string }).status === "confirmed").length }, error: r!.error,
    createdAt: r!.createdAt.toISOString(), startedAt: r!.startedAt?.toISOString() ?? null, finishedAt: r!.finishedAt?.toISOString() ?? null,
    obligations: obs.sort((a, b) => a.seq - b.seq).map((o) => o.data as TestingRunDetail["obligations"][number]),
    executions: ex.map((e) => e.data as TestingRunDetail["executions"][number]),
    findings: fi.map((f) => f.data as TestingRunDetail["findings"][number]),
    report: r!.report as TestingRunDetail["report"], usage: r!.usage as TestingRunDetail["usage"],
  };
}

async function evalProject(name: string, dir: string, expected: Expected | null, who: { userId: string; workspaceId: string }) {
  const t0 = Date.now();
  const log = (m: string) => console.log(`[${name}] ${m}`);
  const snap = await snapshotOf(dir, name, who);
  log(`snapshot ${snap.id.slice(0, 8)} baselined; waiting for the analysis`);
  const ur = await readyUnderstanding(snap.id, name);
  log(`analysis ready (AI ${(ur.dossier as ProjectDossier).ai?.status ?? "off"}); starting Testing`);
  const runId = randomUUID();
  await db.insert(testingRun).values({ id: runId, snapshotId: snap.id, projectId: snap.projectId, understandingRunId: ur.id, requestedBy: who.userId, policy: { engine: ENGINE_VERSION, ...POLICY, profile: process.env.TESTING_PROFILE ?? "standard", ...(process.env.TESTING_P95_MS ? { thresholds: { p95Ms: Number(process.env.TESTING_P95_MS), errorRatePct: 1 } } : {}), models: TESTING_MODELS(), budgetUsd: env.TESTING_RUN_BUDGET_USD }, status: "running", generation: 1, startedAt: new Date(), heartbeatAt: new Date() });
  let last = "";
  await processRun({ id: runId, generation: 1 }, { provider: sandboxProvider(), session: sessionFor(), onProgress: (s) => s !== last && log((last = s)) });
  const run = await detail(runId);
  writeFileSync(join(outDir, `${name}.run.json`), JSON.stringify(run, null, 2));
  const minutes = (Date.now() - t0) / 60000;
  log(`finished ${run.status} in ${minutes.toFixed(1)} min: ${run.headline}`);
  return { name, run, score: expected ? scoreRun(run, expected) : null, strict: expected ? scoreStrict(run, expected) : null, minutes };
}

/** The strict scorecard: one row per project with the plan's parts and gates, then the pooled precision. */
function strictTable(results: Array<{ name: string; strict: ReturnType<typeof scoreStrict> | null }>) {
  const pct = (n: number | null | undefined) => (n == null ? "n/a" : `${Math.round(n * 100)}%`);
  const rows = ["| Project | Strict score | Gates failed | Mandatory | Testing defects | Conf. precision | Oracle | Discovery | Reliability | Integrity | Unadjudicated | Duplicates | Abstention | AI $ |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const r of results.filter((x) => x.strict).sort((a, b) => a.name.localeCompare(b.name))) {
    const s = r.strict!;
    const prec = s.counts.confirmedTrue + s.counts.confirmedFalse ? s.counts.confirmedTrue / (s.counts.confirmedTrue + s.counts.confirmedFalse) : null;
    rows.push(`| ${r.name} | ${s.score.toFixed(1)}${s.failedGates ? ` (composite ${s.composite.toFixed(1)})` : ""} | ${s.failedGates} | ${s.counts.mandatoryFound}/${s.counts.mandatory} | ${s.counts.found}/${s.counts.testingDefects} | ${pct(prec)} | ${pct(s.parts.oracle)} | ${pct(s.parts.discovery)} | ${pct(s.parts.reliability)} | ${pct(s.parts.integrity)} | ${s.counts.unadjudicated} | ${s.counts.duplicates} | ${pct(s.abstention)} | ${s.costUsd.toFixed(3)} |`);
  }
  const all = results.filter((x) => x.strict).map((x) => x.strict!.counts);
  const tp = all.reduce((n, c) => n + c.confirmedTrue, 0);
  const fp = all.reduce((n, c) => n + c.confirmedFalse, 0);
  rows.push("", `Pooled confirmed-finding precision: ${tp + fp ? `${tp} of ${tp + fp} (${Math.round((tp / (tp + fp)) * 100)}%)` : "no adjudicated confirmed finding"}.`);
  return rows;
}

async function main() {
  const who = await evalUser();
  const names = existsSync(benchDir) ? readdirSync(benchDir).filter((n) => existsSync(join(benchDir, n, "expected.json"))) : [];
  const targets = (only.length ? only : names).map((n) =>
    n === "lead" || n === "hotel"
      ? { name: n, dir: join(root, `.data/eval/${n}-src`), expected: existsSync(join(root, `.data/eval/${n}.expected.json`)) ? (JSON.parse(readFileSync(join(root, `.data/eval/${n}.expected.json`), "utf8")) as Expected) : null }
      : n.startsWith("holdout:")
        ? { name: n.replace(":", "-"), dir: join(holdoutDir, n.slice(8), "project"), expected: JSON.parse(readFileSync(join(holdoutDir, n.slice(8), "expected.json"), "utf8")) as Expected }
        : { name: n, dir: join(benchDir, n, "project"), expected: JSON.parse(readFileSync(join(benchDir, n, "expected.json"), "utf8")) as Expected },
  );
  const results: Awaited<ReturnType<typeof evalProject>>[] = [];
  // A few projects at a time: sandboxes run in the cloud, the AI calls are the slow part.
  const queue = [...targets];
  await Promise.all(
    Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        try {
          results.push(await evalProject(t.name, t.dir, t.expected, who));
        } catch (err) {
          console.error(`[${t.name}] crashed:`, err);
        }
      }
    }),
  );

  const rows = [`# Testing evaluation, round ${round}`, "", `Engine ${ENGINE_VERSION}. Generated ${new Date().toISOString()}.`, "", ...strictTable(results)];
  rows.push("", "Legacy scorer (permissive matching, kept for comparison):", "", "| Project | Legacy score | Outcomes | Recall | Precision | Completeness | Minutes | AI $ | Headline |", "|---|---|---|---|---|---|---|---|---|");
  for (const r of results.sort((a, b) => a.name.localeCompare(b.name))) {
    const s = r.score;
    const pct = (n: number | undefined) => (s && n != null ? `${(n * 100).toFixed(0)}%` : "");
    rows.push(`| ${r.name} | ${s ? s.score.toFixed(1) : "n/a"} | ${pct(s?.outcomes)} | ${pct(s?.recall)} | ${pct(s?.precision)} | ${r.run.report?.completeness?.percent ?? "?"}% | ${r.minutes.toFixed(1)} | ${(r.run.usage?.costUsd ?? 0).toFixed(3)} | ${(r.run.headline ?? "").replace(/\|/g, "/").slice(0, 160)} |`);
  }
  for (const r of results.filter((x) => x.strict)) rows.push("", `## ${r.name}`, "", ...r.strict!.notes.map((n) => `- ${n}`));
  writeFileSync(join(outDir, "scorecard.md"), rows.join("\n"));
  console.log(rows.join("\n"));
  await pool.end();
  process.exit(0);
}

void main();
