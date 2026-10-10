import { rm } from "node:fs/promises";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/client.ts";
import { snapshot } from "../db/schema.ts";
import { GithubError } from "../github/client.ts";
import { objectStore } from "../storage/object-store.ts";
import { emitIntakeEvent } from "./events.ts";
import { processArchive } from "./process.ts";
import { ensureUnderstanding } from "../understanding/run.ts";

/** Small in-process queue. A durable workflow engine replaces this with the orchestrator. */
const MAX_CONCURRENT = 2;
let running = 0;
const waiting: Array<() => Promise<void>> = [];

function enqueue(job: () => Promise<void>) {
  waiting.push(job);
  drain();
}

function drain() {
  while (running < MAX_CONCURRENT && waiting.length > 0) {
    const job = waiting.shift()!;
    running += 1;
    job()
      .catch((err) => console.error("[intake] job crashed:", err))
      .finally(() => {
        running -= 1;
        drain();
      });
  }
}

/**
 * A snapshot's source: an archive already on disk (upload), or a step that fetches one
 * (GitHub) and returns its path. Fetch steps may throw GithubError with a user-facing fix.
 */
export type IntakeSource = string | (() => Promise<string>);

export function startIntake(snapshotId: string, source: IntakeSource, opts: { stripTopLevel?: boolean } = {}) {
  enqueue(() => runIntake(snapshotId, source, opts));
}

async function runIntake(snapshotId: string, source: IntakeSource, opts: { stripTopLevel?: boolean }) {
  let archivePath = typeof source === "string" ? source : null;
  try {
    await db.update(snapshot).set({ status: "VALIDATING" }).where(eq(snapshot.id, snapshotId));
    if (typeof source !== "string") {
      try {
        archivePath = await source();
      } catch (err) {
        if (!(err instanceof GithubError)) throw err;
        if (err.transient) {
          await db
            .update(snapshot)
            .set({ status: "FAILED", error: `${err.body.message} ${err.body.fix ?? ""}`.trim() })
            .where(eq(snapshot.id, snapshotId));
          await emitIntakeEvent(snapshotId, "failed", { code: err.body.code });
        } else {
          await db
            .update(snapshot)
            .set({
              status: "REJECTED",
              rejectionReasons: [{ code: err.body.code, message: err.body.message, fix: err.body.fix ?? "Try again." }],
            })
            .where(eq(snapshot.id, snapshotId));
          await emitIntakeEvent(snapshotId, "rejected", { reasons: 1 });
        }
        return;
      }
    }
    const outcome = await processArchive(archivePath!, objectStore, {
      stripTopLevel: opts.stripTopLevel,
      onStage: async (stage, detail) => {
        await emitIntakeEvent(snapshotId, stage, detail ?? {});
      },
    });

    if (outcome.status === "REJECTED") {
      await db
        .update(snapshot)
        .set({
          status: "REJECTED",
          rejectionReasons: outcome.rejections,
          warnings: outcome.warnings,
          exclusions: outcome.exclusions,
        })
        .where(eq(snapshot.id, snapshotId));
      await emitIntakeEvent(snapshotId, "rejected", { reasons: outcome.rejections.length });
      return;
    }

    await db
      .update(snapshot)
      .set({
        status: "BASELINED",
        contentDigest: outcome.contentDigest,
        archiveObjectKey: outcome.archiveObjectKey,
        manifestObjectKey: outcome.manifestObjectKey,
        fileCount: outcome.fileCount,
        totalBytes: outcome.totalBytes,
        detection: outcome.detection,
        warnings: outcome.warnings,
        exclusions: outcome.exclusions,
        baselinedAt: new Date(),
      })
      .where(eq(snapshot.id, snapshotId));
    // Start understanding the project right away; the dossier is ready by the time it's opened.
    void ensureUnderstanding(snapshotId).catch((err) => console.error("[understanding] could not start:", err));
    await emitIntakeEvent(snapshotId, "baselined", {
      digest: outcome.contentDigest,
      files: outcome.fileCount,
      bytes: outcome.totalBytes,
    });
  } catch (err) {
    console.error(`[intake] snapshot ${snapshotId} failed:`, err);
    await db
      .update(snapshot)
      .set({ status: "FAILED", error: "Processing stopped because of an internal error. Please try again." })
      .where(eq(snapshot.id, snapshotId))
      .catch(() => undefined);
    await emitIntakeEvent(snapshotId, "failed", {}).catch(() => undefined);
  } finally {
    if (archivePath) await rm(archivePath, { force: true });
  }
}

/** On startup, snapshots that were mid-processing when the API stopped can't resume: mark them. */
export async function recoverInterruptedSnapshots() {
  const stuck = await db
    .update(snapshot)
    .set({ status: "FAILED", error: "Processing was interrupted by a server restart. Please upload again." })
    .where(inArray(snapshot.status, ["RECEIVED", "VALIDATING"]))
    .returning({ id: snapshot.id });
  for (const s of stuck) await emitIntakeEvent(s.id, "failed", { reason: "interrupted" });
  return stuck.length;
}
