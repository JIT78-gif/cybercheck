// End-to-end validation of the sandbox repair pipeline on a real runtime for AI Adversarial and AI Evaluator, with NO
// AI credits: the patch proposal is injected, so this measures the deterministic parts the release gates rely on
// (overlay in fresh sandboxes, focused rerun, before/after judgement, unsafe-patch refusal, snapshot immutability).
// Usage (from apps/api): npx tsx --env-file=../../.env scripts/eval-repair.ts <round> [adversarial|ai-evaluator ...] [--runtime=local] [--repeat=1]
// Output: ../../.data/eval/repair-round-<n>/scorecard.md
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buffer } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { AdversarialCampaign, AdversarialFinding, AiEvaluationCase, AiEvaluationFinding, TestingRepair } from "@cybercheck/contracts";
import { adversarialRepairScope } from "../src/adversarial/repair.ts";
import { AD_ENGINE_VERSION } from "../src/adversarial/version.ts";
import { aiRepairScope } from "../src/ai-evaluator/repair.ts";
import { AI_EVALUATOR_ENGINE } from "../src/ai-evaluator/version.ts";
import { db, pool } from "../src/db/client.ts";
import { adversarialCampaign, aiEvaluationCase, findingReview, snapshot, testFinding, testingRepair, testingRun } from "../src/db/schema.ts";
import { providers } from "../src/env.ts";
import { objectStore } from "../src/storage/object-store.ts";
import { processRepair, type Proposal } from "../src/testing/repair.ts";
import { processRun, sandboxProvider } from "../src/testing/worker.ts";
import { getSnapshotSource } from "../src/understanding/source.ts";
import { evalUser, readyUnderstanding, snapshotOf } from "./eval-common.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const args = process.argv.slice(2);
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const runtime = (flag("runtime") ?? "local") as "auto" | "nebius" | "local";
const repeat = Math.max(1, Number(flag("repeat") ?? 1) || 1);
const [round = "0", ...only] = args.filter((a) => !a.startsWith("--"));
const outDir = join(root, ".data/eval", `repair-round-${round}`);
mkdirSync(outDir, { recursive: true });
providers.ai = false;

type Scenario = { name: string; expect: TestingRepair["status"]; edit: () => Proposal };
type Suite = {
  dir: string;
  check: "adversarial" | "ai-evaluator";
  policy: Record<string, unknown>;
  /** The confirmed finding to repair, and its scope, from the finished parent run. */
  target: (runId: string) => Promise<{ findingId: string; title: string; scope: TestingRepair["scope"] }>;
  /** Must exist verbatim in the snapshot, so a "correct" scenario really edits the vulnerable code. */
  anchor: { path: string; text: string };
  scenarios: Scenario[];
};

const OVERVIEW = 'app.get("/api/admin/overview", requireUser, (_req, res) => res.json({';
const REPLY_SINK = "answer.innerHTML = x.reply;";

const SUITES: Record<string, Suite> = {
  adversarial: {
    dir: "../test/adversarial-bench/hotel-management-gauntlet/project",
    check: "adversarial",
    policy: { engine: AD_ENGINE_VERSION, profile: "standard", aiAttacker: "off", aiCritic: "off", runtime, attackPackIds: [] },
    target: async (runId) => {
      const findings = (await db.select().from(testFinding).where(eq(testFinding.runId, runId))).map((r) => r.data as AdversarialFinding);
      const f = findings.find((x) => x.status === "confirmed" && x.rootCause === "function-authz" && x.endpoint === "GET /api/admin/overview");
      if (!f) throw new Error(`no confirmed overview function-authz finding: ${findings.map((x) => `${x.id}:${x.rootCause}:${x.status}`).join(", ")}`);
      const campaigns = (await db.select().from(adversarialCampaign).where(eq(adversarialCampaign.runId, runId))).map((c) => c.data as AdversarialCampaign);
      return { findingId: f.id, title: f.title, scope: adversarialRepairScope(f, campaigns, 1) };
    },
    anchor: { path: "src/app.js", text: OVERVIEW },
    scenarios: [
      { name: "correct fix (adds the administrator check)", expect: "verified", edit: () => ({ summary: "Refuse non-admins on the overview route.", edits: [{ path: "src/app.js", find: OVERVIEW, replace: 'app.get("/api/admin/overview", requireUser, (req, res) => req.user.role !== "admin" ? res.status(403).json({ error: "administrators only" }) : res.json({' }] }) },
      { name: "unsafe patch (drops the sign-in guard)", expect: "failed_validation", edit: () => ({ summary: "Remove the guard.", edits: [{ path: "src/app.js", find: 'app.get("/api/admin/overview", requireUser, ', replace: 'app.get("/api/admin/overview", ' }] }) },
      { name: "ineffective patch (renames a field only)", expect: "failed_validation", edit: () => ({ summary: "Rename a field.", edits: [{ path: "src/app.js", find: "(_req, res) => res.json({ bookings: store.get().bookings.length", replace: "(_req, res) => res.json({ bookingCount: store.get().bookings.length" }] }) },
    ],
  },
  "ai-evaluator": {
    dir: "../test/testing-bench/cybercheck-gauntlet/project",
    check: "ai-evaluator",
    policy: { engine: AI_EVALUATOR_ENGINE, profile: "standard", judge: "auto", modelMode: "auto", runtime, datasetIds: [] },
    target: async (runId) => {
      const findings = (await db.select().from(testFinding).where(eq(testFinding.runId, runId))).map((r) => r.data as AiEvaluationFinding);
      const f = findings.find((x) => x.status === "confirmed" && x.category === "output_rendering");
      if (!f) throw new Error(`no confirmed output-rendering finding: ${findings.map((x) => `${x.id}:${x.category}:${x.status}`).join(", ")}`);
      const cases = (await db.select().from(aiEvaluationCase).where(eq(aiEvaluationCase.runId, runId))).map((c) => c.data as AiEvaluationCase);
      return { findingId: f.id, title: f.title, scope: aiRepairScope(f, cases, 1) };
    },
    anchor: { path: "public/assistant.html", text: REPLY_SINK },
    scenarios: [
      { name: "correct fix (render the reply as text)", expect: "verified", edit: () => ({ summary: "Render the assistant reply as text, not HTML.", edits: [{ path: "public/assistant.html", find: REPLY_SINK, replace: "answer.textContent = x.reply;" }] }) },
      { name: "unsafe patch (edits package.json)", expect: "failed_validation", edit: () => ({ summary: "Change a dependency.", edits: [{ path: "package.json", find: '"name"', replace: '"name"' }] }) },
      { name: "ineffective patch (fixes the search page, not the reply)", expect: "failed_validation", edit: () => ({ summary: "Escape search results.", edits: [{ path: "public/index.html", find: "results.innerHTML = ", replace: "results.textContent = " }] }) },
    ],
  },
};

const digestOf = async (key: string) => createHash("sha256").update(await buffer(await objectStore.get(key))).digest("hex");

async function runSuite(name: string, suite: Suite, rep: number) {
  const who = await evalUser();
  const snap = await snapshotOf(join(here, suite.dir), `repair-${name}`, who, `${round}-${rep}`);
  const ur = await readyUnderstanding(snap.id, `repair-${name}`);
  const archiveBefore = await digestOf(snap.archiveObjectKey!);
  const provider = sandboxProvider();
  const runValidation = (id: string) => processRun({ id, generation: 1 }, { provider, session: null });
  console.log(`[${name}] running the parent ${suite.check} check`);
  const parentId = randomUUID();
  await db.insert(testingRun).values({ id: parentId, check: suite.check, snapshotId: snap.id, projectId: snap.projectId, understandingRunId: ur.id, requestedBy: who.userId, policy: suite.policy, status: "running", generation: 1, startedAt: new Date(), heartbeatAt: new Date() });
  await runValidation(parentId);
  const t = await suite.target(parentId);
  const src = await getSnapshotSource(objectStore, snap.archiveObjectKey!);
  if (!src.files.get(suite.anchor.path)?.text.includes(suite.anchor.text)) throw new Error(`${suite.anchor.path} does not contain the vulnerable code.`);
  if (!t.scope.files.includes(suite.anchor.path)) throw new Error(`repair scope ${t.scope.files.join(", ")} does not include ${suite.anchor.path}.`);
  await db.insert(findingReview).values({ id: randomUUID(), runId: parentId, findingId: t.findingId, projectId: snap.projectId, snapshotId: snap.id, reviewerUserId: who.userId, reviewerRole: "owner", decision: "confirmed", reason: "eval", supersedesReviewId: null });

  const results: Array<{ scenario: string; status: string; ok: boolean; line: string[] }> = [];
  for (const s of suite.scenarios) {
    const id = randomUUID();
    await db.insert(testingRepair).values({ id, runId: parentId, findingId: t.findingId, projectId: snap.projectId, snapshotId: snap.id, status: "running", requestedBy: who.userId, approvedBy: who.userId, scope: t.scope });
    console.log(`[${name}] ${s.name}`);
    const t0 = Date.now();
    const r = await processRepair(id, { provider, session: null, objects: objectStore, runValidation, propose: async () => s.edit() });
    const a = r.attempts[0];
    const ok = r.status === s.expect;
    results.push({
      scenario: s.name, status: r.status, ok,
      line: [`### ${s.name}`, "", `- expected ${s.expect}, got **${r.status}** ${ok ? "(PASS)" : "(FAIL)"} in ${((Date.now() - t0) / 1000).toFixed(0)}s`, `- attempt: ${a?.status ?? "none"}${a?.rejectedBecause.length ? `; refused because: ${a.rejectedBecause.join(" ")}` : ""}`, `- validation run: ${a?.validationRunId ?? "none (refused before running)"}`, ...(a?.checks.length ? [`- checks: ${a.checks.map((c) => `${c.obligationId} ${c.role} ${c.before}->${c.after}`).join("; ")}`] : []), ""],
    });
  }
  const [snapNow] = await db.select().from(snapshot).where(eq(snapshot.id, snap.id));
  const immutable = archiveBefore === (await digestOf(snap.archiveObjectKey!)) && snapNow?.contentDigest === snap.contentDigest;
  return { finding: `${t.findingId} (${t.title})`, scope: t.scope, results, immutable };
}

async function main() {
  const names = only.length ? only : Object.keys(SUITES);
  const lines = [`# Repair pipeline round ${round}`, "", `Runtime ${runtime}; ${repeat} repetition(s); proposals injected (no AI credits).`, ""];
  let allOk = true;
  for (const name of names) {
    const suite = SUITES[name];
    if (!suite) throw new Error(`Unknown suite ${name}. Known: ${Object.keys(SUITES).join(", ")}`);
    const reps: Awaited<ReturnType<typeof runSuite>>[] = [];
    for (let i = 0; i < repeat; i++) reps.push(await runSuite(name, suite, i));
    const first = reps[0]!;
    const sig = (r: (typeof reps)[number]) => r.results.map((x) => `${x.scenario}:${x.status}`).join("|");
    const stable = new Set(reps.map(sig)).size === 1;
    const passed = first.results.filter((r) => r.ok).length;
    const immutable = reps.every((r) => r.immutable);
    allOk &&= reps.every((r) => r.results.every((x) => x.ok)) && immutable && stable;
    lines.push(`## ${name}`, "", `Finding ${first.finding}; scope files ${first.scope.files.join(", ")}; reproduction ${first.scope.reproduction.join(", ")}; regression ${first.scope.regression.length}.`, "", ...first.results.flatMap((r) => r.line), `- scenarios as expected: ${passed}/${first.results.length}`, `- snapshot immutable in every repetition: ${immutable ? "yes" : "NO"}`, ...(repeat > 1 ? [`- identical outcomes across ${repeat} repetitions: ${stable ? "yes" : "NO"}`] : []), "");
  }
  lines.push(`**Overall: ${allOk ? "PASS" : "FAIL"}.**`);
  writeFileSync(join(outDir, "scorecard.md"), lines.join("\n"));
  console.log(`\n${lines.join("\n")}\nWritten to ${outDir}`);
  await pool.end();
  process.exit(allOk ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
