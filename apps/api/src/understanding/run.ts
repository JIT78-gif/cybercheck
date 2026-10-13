import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { ProjectAnalysis, ProjectDossier, UnderstandingRun } from "@cybercheck/contracts";
import { db } from "../db/client.ts";
import { withLock as withRunLock } from "../db/locks.ts";
import { snapshot, understandingRun } from "../db/schema.ts";
import { objectStore } from "../storage/object-store.ts";
import { ANALYZER_VERSION, analyzeSource } from "./analyze.ts";
import { getSnapshotSource } from "./source.ts";
import { env, providers } from "../env.ts";
import { buildAiDiagrams } from "./ai/diagrams.ts";
import { AiSession } from "./ai/gateway.ts";
import { emptyInsights, synthesize } from "./ai/synthesize.ts";

/** Live progress of runs being worked on right now (kept in memory; a restart re-runs them anyway). */
const live = new Map<string, { step: string; progress: number | null }>();

// One analysis at a time: parsing is CPU-bound and finishes in seconds.
let busy = false;
const waiting: string[] = [];

function enqueue(runId: string) {
  waiting.push(runId);
  void drain();
}

async function drain() {
  if (busy) return;
  const next = waiting.shift();
  if (!next) return;
  busy = true;
  try {
    await withRunLock(`understanding:${next}`, () => execute(next));
  } catch (err) {
    console.error("[understanding] run crashed:", err);
  } finally {
    busy = false;
    void drain();
  }
}

async function execute(runId: string) {
  const [run] = await db.select().from(understandingRun).where(eq(understandingRun.id, runId));
  if (!run || run.status !== "queued") return;
  await db.update(understandingRun).set({ status: "analyzing" }).where(eq(understandingRun.id, runId));
  live.set(runId, { step: "Reading the code: files, routes, data, configuration", progress: null });
  try {
    const [snap] = await db.select().from(snapshot).where(eq(snapshot.id, run.snapshotId));
    if (!snap?.archiveObjectKey || !snap.contentDigest) throw new Error("snapshot has no archive");
    const src = await getSnapshotSource(objectStore, snap.archiveObjectKey);
    // Secret files were left out at intake (never stored); coverage still reports them.
    // The cached source is shared between requests, so exclusions go on a copy.
    const excluded = new Map(src.excluded);
    for (const w of (snap.warnings as Array<{ code: string; path?: string }> | null) ?? []) {
      if (w.code === "secret_file_excluded" && w.path) excluded.set(w.path, "secret file (never stored)");
    }
    const dossier = await analyzeSource({ ...src, excluded }, { snapshotId: snap.id, contentDigest: snap.contentDigest });
    // Facts are ready now; the AI step adds meaning afterwards in its own queue.
    if (aiEnabled()) dossier.ai = runningInsights();
    await db.update(understandingRun).set({ status: "ready", dossier, finishedAt: new Date() }).where(eq(understandingRun.id, runId));
    if (dossier.ai) enqueueAi(runId);
  } catch (err) {
    console.error(`[understanding] run ${runId} failed:`, err);
    await db
      .update(understandingRun)
      .set({ status: "failed", error: "The analysis stopped because of an internal error. Try running it again.", finishedAt: new Date() })
      .where(eq(understandingRun.id, runId));
  } finally {
    live.delete(runId);
  }
}

// ---------------------------------------------------------------- AI step (separate queue)

const MODELS = () => ({ fast: env.NEBIUS_MODEL_FAST, strong: env.NEBIUS_MODEL_STRONG, critic: env.NEBIUS_MODEL_CRITIC });
const aiEnabled = () => providers.ai && env.NODE_ENV !== "test";
const runningInsights = () => ({ ...emptyInsights(MODELS()), status: "running" as const });

// The AI step is slow (minutes) and network-bound, so it never blocks the code analysis queue.
let aiBusy = false;
const aiWaiting: string[] = [];

function enqueueAi(runId: string) {
  if (!aiWaiting.includes(runId)) aiWaiting.push(runId);
  void drainAi();
}

async function drainAi() {
  if (aiBusy) return;
  const next = aiWaiting.shift();
  if (!next) return;
  aiBusy = true;
  try {
    await withRunLock(`understanding-ai:${next}`, () => executeAi(next));
  } catch (err) {
    console.error("[understanding] AI step crashed:", err);
  } finally {
    aiBusy = false;
    void drainAi();
  }
}

async function executeAi(runId: string) {
  const [run] = await db.select().from(understandingRun).where(eq(understandingRun.id, runId));
  const dossier = run?.dossier as ProjectDossier | null;
  if (!run || run.status !== "ready" || !dossier || dossier.ai?.status !== "running") return;
  const [snap] = await db.select().from(snapshot).where(eq(snapshot.id, run.snapshotId));
  if (!snap?.archiveObjectKey) return;

  // Identical content already explained: reuse it instead of paying again.
  const [twin] = await db
    .select({ dossier: understandingRun.dossier })
    .from(understandingRun)
    .innerJoin(snapshot, eq(snapshot.id, understandingRun.snapshotId))
    .where(and(eq(snapshot.contentDigest, snap.contentDigest!), ne(understandingRun.id, runId), eq(understandingRun.analyzerVersion, ANALYZER_VERSION), sql`${understandingRun.dossier}->'ai'->>'status' in ('ready', 'partial')`))
    .orderBy(desc(understandingRun.createdAt))
    .limit(1);
  if (twin?.dossier) {
    const done = twin.dossier as ProjectDossier;
    await db.update(understandingRun).set({ dossier: { ...dossier, ai: done.ai, diagrams: { ...dossier.diagrams, ...buildAiDiagrams(done.ai!, dossier) } } }).where(eq(understandingRun.id, runId));
    return;
  }

  const src = await getSnapshotSource(objectStore, snap.archiveObjectKey);
  const session = new AiSession({ apiKey: env.NEBIUS_API_KEY!, baseUrl: env.NEBIUS_BASE_URL, models: MODELS(), budgetUsd: env.AI_RUN_BUDGET_USD });
  live.set(runId, { step: "Starting the AI explanation", progress: 0 });
  try {
    const ai = await synthesize(dossier, src, { session, models: MODELS(), onProgress: (step, progress) => live.set(runId, { step, progress }) });
    const next: ProjectDossier = { ...dossier, ai, diagrams: { ...dossier.diagrams, ...buildAiDiagrams(ai, dossier) } };
    await db.update(understandingRun).set({ dossier: next }).where(eq(understandingRun.id, runId));
    console.log(`[understanding] AI step for run ${runId}: ${ai.status}, $${ai.usage.costUsd.toFixed(4)}, ${ai.verification.verified}/${ai.verification.claims} claims verified`);
  } finally {
    live.delete(runId);
  }
}

/** Progress to show for a run: live progress if it is being worked on, else its place in the queue. */
function progressOf(r: typeof understandingRun.$inferSelect): UnderstandingRun["progress"] {
  const now = live.get(r.id);
  if (now) return now;
  if (r.status === "queued") {
    const ahead = waiting.indexOf(r.id);
    return { step: ahead > 0 ? `Waiting to start (${ahead} ahead)` : "Waiting to start", progress: 0 };
  }
  if (r.status === "ready" && (r.dossier as ProjectDossier | null)?.ai?.status === "running") {
    const ahead = aiWaiting.indexOf(r.id) + (aiBusy ? 1 : 0);
    return { step: ahead > 0 ? `Code read. Waiting for the AI explanation (${ahead} ahead)` : "Code read. Starting the AI explanation", progress: 0 };
  }
  return null;
}

/**
 * Readiness of a project's latest snapshot for the checks. Only "ready" may be checked: the code
 * has been read and, when the AI step is enabled, explained. Starts the analysis if it is missing
 * (for example after an analyzer upgrade).
 */
export async function analysisOf(snap: typeof snapshot.$inferSelect | null): Promise<ProjectAnalysis> {
  const none = (stage: ProjectAnalysis["stage"], error: string | null = null, step: string | null = null): ProjectAnalysis => ({ stage, step, progress: null, error });
  if (!snap) return none("none");
  if (snap.status === "RECEIVED" || snap.status === "VALIDATING") return none("processing", null, "Checking the upload");
  if (snap.status === "REJECTED") return none("rejected", (snap.rejectionReasons as Array<{ message?: string }> | null)?.[0]?.message ?? "The upload was rejected.");
  if (snap.status === "FAILED") return none("failed", snap.error ?? "Processing the upload failed.");
  const run = await ensureUnderstanding(snap.id);
  const p = progressOf(run);
  if (run.status === "queued" || run.status === "analyzing") return { stage: "reading_code", step: p?.step ?? "Reading the code", progress: p?.progress ?? null, error: null };
  if (run.status === "failed") return none("failed", run.error ?? "The analysis did not finish.");
  const ai = (run.dossier as ProjectDossier | null)?.ai;
  if (ai?.status === "running") return { stage: "explaining", step: p?.step ?? "Explaining the architecture with AI", progress: p?.progress ?? null, error: null };
  if (ai?.status === "failed") return none("failed", ai.error ?? "The AI explanation did not finish. Run the analysis again.");
  return none("ready");
}

export function toUnderstandingRun(r: typeof understandingRun.$inferSelect): UnderstandingRun {
  return {
    id: r.id,
    snapshotId: r.snapshotId,
    status: r.status,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    dossier: (r.dossier as ProjectDossier | null) ?? null,
    progress: progressOf(r),
  };
}

/**
 * The current understanding for a baselined snapshot, starting one if needed.
 * Identical content (same digest) reuses an existing dossier instantly.
 */
export async function ensureUnderstanding(snapshotId: string, force = false) {
  if (!force) {
    const [latest] = await db
      .select()
      .from(understandingRun)
      .where(and(eq(understandingRun.snapshotId, snapshotId), eq(understandingRun.analyzerVersion, ANALYZER_VERSION)))
      .orderBy(desc(understandingRun.createdAt))
      .limit(1);
    if (latest && latest.status !== "failed") return latest;
  }

  const [snap] = await db.select().from(snapshot).where(eq(snapshot.id, snapshotId));
  if (snap?.contentDigest && !force) {
    const [twin] = await db
      .select({ run: understandingRun })
      .from(understandingRun)
      .innerJoin(snapshot, eq(snapshot.id, understandingRun.snapshotId))
      .where(
        and(
          eq(snapshot.contentDigest, snap.contentDigest),
          ne(snapshot.id, snapshotId),
          eq(understandingRun.status, "ready"),
          eq(understandingRun.analyzerVersion, ANALYZER_VERSION),
        ),
      )
      .orderBy(desc(understandingRun.createdAt))
      .limit(1);
    // A twin whose AI step is still running would copy an unfinished state; analyse afresh instead.
    if (twin?.run.dossier && (twin.run.dossier as ProjectDossier).ai?.status !== "running") {
      const dossier = { ...(twin.run.dossier as ProjectDossier) };
      dossier.meta = { ...dossier.meta, snapshotId };
      // A twin analysed without the AI step (AI off at the time, or a failed step) still gets one now.
      const needsAi = aiEnabled() && (!dossier.ai || dossier.ai.status === "failed");
      if (needsAi) dossier.ai = runningInsights();
      const [copy] = await db
        .insert(understandingRun)
        .values({ id: randomUUID(), snapshotId, status: "ready", analyzerVersion: ANALYZER_VERSION, dossier, finishedAt: new Date() })
        .returning();
      if (needsAi) enqueueAi(copy!.id);
      return copy!;
    }
  }

  const [created] = await db
    .insert(understandingRun)
    .values({ id: randomUUID(), snapshotId, status: "queued", analyzerVersion: ANALYZER_VERSION })
    .returning();
  enqueue(created!.id);
  return created!;
}

/** Runs that were in progress when the server stopped are re-queued (analysis is deterministic). */
export async function recoverUnderstanding() {
  const stuck = await db
    .update(understandingRun)
    .set({ status: "queued" })
    .where(inArray(understandingRun.status, ["queued", "analyzing"]))
    .returning({ id: understandingRun.id });
  for (const r of stuck) enqueue(r.id);
  // AI steps that were running when the server stopped start again (facts are already saved).
  const aiStuck = await db
    .select({ id: understandingRun.id })
    .from(understandingRun)
    .where(and(eq(understandingRun.status, "ready"), sql`${understandingRun.dossier}->'ai'->>'status' = 'running'`));
  if (aiEnabled()) for (const r of aiStuck) enqueueAi(r.id);
  return stuck.length + aiStuck.length;
}
