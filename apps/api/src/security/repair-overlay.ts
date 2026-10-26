import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { buffer } from "node:stream/consumers";
import { createGunzip, createGzip } from "node:zlib";
import tar from "tar-stream";
import type { SnapshotSource } from "../understanding/source.ts";

/** A repair validation uses patched copies of source files, never a changed snapshot. */
export type RepairOverlay = Map<string, string>;

const normalized = (path: string) => path.replace(/^\.\//, "").replaceAll("\\", "/");

export function overlaySource(source: SnapshotSource, overlay: RepairOverlay): SnapshotSource {
  const files = new Map(source.files);
  for (const [path, text] of overlay) {
    const prior = files.get(path);
    if (!prior) throw new Error(`Repair overlay references a file outside the snapshot: ${path}`);
    files.set(path, { ...prior, text, lines: text.split("\n").length });
  }
  return { ...source, files };
}

/** Repack the normalized snapshot with the approved repair overlay for one validation run. */
export async function overlayArchive(archive: Buffer, overlay: RepairOverlay): Promise<Buffer> {
  if (!overlay.size) return archive;
  const extract = tar.extract();
  const pack = tar.pack();
  const output = buffer(pack.pipe(createGzip({ level: 9 })));
  const reading = pipeline(Readable.from([archive]), createGunzip(), extract);
  const seen = new Set<string>();

  for await (const entry of extract) {
    const path = normalized(entry.header.name);
    const original = await buffer(entry);
    const replacement = overlay.get(path);
    const body = replacement == null ? original : Buffer.from(replacement);
    if (replacement != null) seen.add(path);
    await new Promise<void>((resolve, reject) => {
      pack.entry({ ...entry.header, name: path, size: body.length, mtime: new Date(0), uid: 0, gid: 0 }, body, (error) => (error ? reject(error) : resolve()));
    });
  }
  await reading;
  const missing = [...overlay.keys()].filter((path) => !seen.has(path));
  pack.finalize();
  const result = await output;
  if (missing.length) throw new Error(`Repair overlay file was not present in the snapshot: ${missing.join(", ")}`);
  return result;
}
