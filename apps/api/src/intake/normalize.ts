import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import tar from "tar-stream";
import type { ExtractedFile } from "./archive.ts";

export type ManifestEntry = { path: string; size: number; sha256: string };

/** Byte-order sort, independent of locale, so the digest is the same on every machine. */
const byPath = (a: ManifestEntry, b: ManifestEntry) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export function buildManifest(files: Map<string, ExtractedFile>): ManifestEntry[] {
  return [...files.entries()].map(([path, f]) => ({ path, size: f.size, sha256: f.sha256 })).sort(byPath);
}

/**
 * Content digest of a snapshot: sha256 over "<sha256>  <size>  <path>\n" lines in path order.
 * Archive order, timestamps, permissions and compression never change it.
 */
export function contentDigest(manifest: ManifestEntry[]): string {
  const h = createHash("sha256");
  for (const e of manifest) h.update(`${e.sha256}  ${e.size}  ${e.path}\n`);
  return h.digest("hex");
}

/** Repack as a normalized tar.gz: sorted entries, fixed mtime/mode/owner. */
export function packNormalized(manifest: ManifestEntry[], files: Map<string, ExtractedFile>): Readable {
  const pack = tar.pack();
  const epoch = new Date(0);
  (async () => {
    for (const e of manifest) {
      const f = files.get(e.path)!;
      const entry = pack.entry({ name: e.path, size: e.size, mode: 0o644, mtime: epoch, uid: 0, gid: 0, type: "file" });
      await pipeline(createReadStream(f.blobPath), entry);
    }
    pack.finalize();
  })().catch((err: Error) => pack.destroy(err));
  return pack.pipe(createGzip({ level: 9 }));
}
