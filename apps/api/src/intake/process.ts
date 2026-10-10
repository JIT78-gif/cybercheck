import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Detection, IntakeIssue } from "@cybercheck/contracts";
import type { ObjectStore } from "../storage/object-store.ts";
import { ArchiveError, extractEntries, listEntries, sniffFormat } from "./archive.ts";
import { detectProject } from "./detect.ts";
import { buildManifest, contentDigest, packNormalized } from "./normalize.ts";
import { EXCLUDED_LIMITS, LIMITS, issues } from "./policy.ts";
import { validateEntries } from "./validate.ts";

export type IntakeStage = "validating" | "extracting" | "normalizing" | "detecting";

export type IntakeOutcome =
  | {
      status: "REJECTED";
      rejections: IntakeIssue[];
      warnings: IntakeIssue[];
      exclusions: string[];
    }
  | {
      status: "BASELINED";
      warnings: IntakeIssue[];
      exclusions: string[];
      contentDigest: string;
      archiveObjectKey: string;
      manifestObjectKey: string;
      fileCount: number;
      totalBytes: number;
      detection: Detection;
      tree: Array<{ path: string; size: number }>;
    };

/**
 * Turns an untrusted archive into an immutable, content-addressed snapshot.
 * Only reads bytes: nothing from the archive is executed, interpreted as instructions,
 * or written to disk under its own name.
 */
export async function processArchive(
  archivePath: string,
  store: ObjectStore,
  opts: { stripTopLevel?: boolean; onStage?: (stage: IntakeStage, detail?: Record<string, unknown>) => Promise<void> } = {},
): Promise<IntakeOutcome> {
  const stage = opts.onStage ?? (async () => {});
  const rejected = (r: IntakeIssue[], w: IntakeIssue[] = [], e: string[] = []): IntakeOutcome => ({
    status: "REJECTED",
    rejections: r,
    warnings: w,
    exclusions: e,
  });

  const format = await sniffFormat(archivePath);
  if (!format) return rejected([issues.unsupportedFormat()]);

  await stage("validating", { format });
  let entries;
  try {
    entries = await listEntries(archivePath, format, {
      maxEntries: LIMITS.maxEntries + EXCLUDED_LIMITS.maxEntries,
      maxExpandedBytes: LIMITS.maxExpandedBytes + EXCLUDED_LIMITS.maxExpandedBytes,
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === "too many entries") return rejected([issues.tooManyFiles()]);
    if (msg === "expanded size over limit") return rejected([issues.expandedTooLarge()]);
    return rejected([issues.corruptArchive(msg.slice(0, 120))]);
  }

  const v = validateEntries(entries, { stripTopLevel: opts.stripTopLevel });
  if (v.rejections.length > 0) return rejected(v.rejections, v.warnings, v.exclusions);

  const work = await mkdtemp(join(tmpdir(), "cc-intake-"));
  try {
    await stage("extracting", { files: v.fileCount, bytes: v.totalBytes });
    let files;
    try {
      files = await extractEntries(archivePath, format, v.wanted, work, LIMITS.maxFileBytes);
    } catch (err) {
      if (err instanceof ArchiveError && err.message === "size_mismatch") {
        return rejected([issues.sizeMismatch("(an entry)")], v.warnings, v.exclusions);
      }
      return rejected([issues.corruptArchive((err as Error).message.slice(0, 120))], v.warnings, v.exclusions);
    }

    await stage("normalizing");
    const manifest = buildManifest(files);
    const digest = contentDigest(manifest);
    const archiveObjectKey = `snapshots/${digest}.tar.gz`;
    const manifestObjectKey = `manifests/${digest}.json`;
    // Content-addressed: identical content is stored once.
    if (!(await store.exists(archiveObjectKey))) await store.put(archiveObjectKey, packNormalized(manifest, files));
    if (!(await store.exists(manifestObjectKey))) {
      await store.put(manifestObjectKey, Readable.from([JSON.stringify({ digest, files: manifest })]));
    }

    await stage("detecting");
    const detected = await detectProject(files);

    return {
      status: "BASELINED",
      warnings: [...v.warnings, ...detected.warnings],
      exclusions: v.exclusions,
      contentDigest: digest,
      archiveObjectKey,
      manifestObjectKey,
      fileCount: manifest.length,
      totalBytes: manifest.reduce((s, e) => s + e.size, 0),
      detection: detected.detection,
      tree: manifest.map((e) => ({ path: e.path, size: e.size })),
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
