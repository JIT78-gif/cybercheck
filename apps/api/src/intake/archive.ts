import { createReadStream, createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import tar from "tar-stream";
import yauzl from "yauzl";

export type ArchiveFormat = "zip" | "tar.gz";

export type RawEntry = {
  /** Name exactly as stored in the archive (decoded, not validated). */
  name: string;
  kind: "file" | "dir" | "symlink" | "other";
  size: number;
  /** Zip only: compressed size, for the bomb ratio check. */
  compressedSize?: number;
  encrypted?: boolean;
  /** Zip only: compression method can't be decoded. */
  unsupportedCompression?: boolean;
};

export class ArchiveError extends Error {}

/** Identify the archive by its first bytes, never by file name. */
export async function sniffFormat(path: string): Promise<ArchiveFormat | null> {
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    if (bytesRead >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05)) return "zip";
    if (bytesRead >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return "tar.gz";
    return null;
  } finally {
    await fh.close();
  }
}

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

function zipKind(entry: yauzl.Entry, name: string): RawEntry["kind"] {
  if (name.endsWith("/")) return "dir";
  const madeBy = entry.versionMadeBy >> 8;
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
  // Only Unix-made entries (3) and macOS (19) carry meaningful mode bits.
  if ((madeBy === 3 || madeBy === 19) && unixMode !== 0) {
    const type = unixMode & S_IFMT;
    if (type === S_IFLNK) return "symlink";
    if (type === S_IFDIR) return "dir";
    if (type !== S_IFREG && type !== 0) return "other";
  }
  return "file";
}

function zipName(entry: yauzl.Entry): string {
  // decodeStrings is off so yauzl doesn't throw on unsafe names; decode ourselves and
  // let validation report them as rejection reasons.
  const raw = entry.fileName as unknown as Buffer;
  const name = yauzl.getFileNameLowLevel(entry.generalPurposeBitFlag, raw, entry.extraFields, false);
  return name;
}

async function openZip(path: string) {
  try {
    return await yauzl.openPromise(path, { decodeStrings: false, validateEntrySizes: true, autoClose: true });
  } catch (err) {
    throw new ArchiveError((err as Error).message);
  }
}

/** Pass 1: list entries without extracting. Zip reads only the central directory. */
export async function listEntries(
  path: string,
  format: ArchiveFormat,
  opts: { maxEntries: number; maxExpandedBytes: number },
): Promise<RawEntry[]> {
  const out: RawEntry[] = [];
  if (format === "zip") {
    const zip = await openZip(path);
    try {
      for await (const entry of zip.eachEntry()) {
        const name = zipName(entry);
        out.push({
          name,
          kind: zipKind(entry, name),
          size: entry.uncompressedSize,
          compressedSize: entry.compressedSize,
          encrypted: entry.isEncrypted(),
          unsupportedCompression: !entry.canDecodeFileData(),
        });
        if (out.length > opts.maxEntries) throw new ArchiveError("too many entries");
      }
    } catch (err) {
      if (err instanceof ArchiveError) throw err;
      throw new ArchiveError((err as Error).message);
    } finally {
      zip.close();
    }
    return out;
  }

  // tar.gz has no index: stream through it, discarding data, with a hard byte cap.
  let expanded = 0;
  const extract = tar.extract();
  const reading = pipeline(createReadStream(path), createGunzip(), extract).catch((err: Error) => {
    throw new ArchiveError(err.message);
  });
  try {
    for await (const entry of extract) {
      const h = entry.header;
      expanded += h.size ?? 0;
      if (expanded > opts.maxExpandedBytes) throw new ArchiveError("expanded size over limit");
      if (out.length > opts.maxEntries) throw new ArchiveError("too many entries");
      const kind: RawEntry["kind"] =
        h.type === "file" || h.type === "contiguous-file"
          ? "file"
          : h.type === "directory"
            ? "dir"
            : h.type === "symlink"
              ? "symlink"
              : "other";
      // GitHub tarballs start with a pax global header; it is metadata, not a file.
      if ((h.type as string) !== "pax-global-header") out.push({ name: h.name, kind, size: h.size ?? 0 });
      entry.resume();
    }
    await reading;
  } catch (err) {
    extract.destroy();
    await reading.catch(() => undefined);
    if (err instanceof ArchiveError) throw err;
    throw new ArchiveError((err as Error).message);
  }
  return out;
}

export type ExtractedFile = { blobPath: string; size: number; sha256: string };

/** Counts bytes and fails if a file grows past its declared size or the per-file cap. */
function limiter(limit: number, onExceed: () => Error) {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > limit) return cb(onExceed());
      cb(null, chunk);
    },
  });
}

async function writeBlob(src: Readable, blobPath: string, declaredSize: number, maxFile: number): Promise<ExtractedFile> {
  const hash = createHash("sha256");
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      size += chunk.length;
      cb(null, chunk);
    },
  });
  const cap = Math.min(declaredSize, maxFile);
  await pipeline(src, limiter(cap, () => new ArchiveError("size_mismatch")), tap, createWriteStream(blobPath));
  if (size !== declaredSize) throw new ArchiveError("size_mismatch");
  return { blobPath, size, sha256: hash.digest("hex") };
}

/**
 * Pass 2: stream only the wanted entries into numbered blob files (never using archive
 * names on disk, so no path can escape the temp folder or hit OS-reserved names).
 */
export async function extractEntries(
  path: string,
  format: ArchiveFormat,
  wanted: Map<string, string>, // raw archive name -> normalized project path
  blobDir: string,
  maxFileBytes: number,
): Promise<Map<string, ExtractedFile>> {
  const result = new Map<string, ExtractedFile>();
  let n = 0;

  if (format === "zip") {
    const zip = await openZip(path);
    try {
      for await (const entry of zip.eachEntry()) {
        const target = wanted.get(zipName(entry));
        if (!target || result.has(target)) continue;
        const stream = await zip.openReadStreamPromise(entry);
        result.set(target, await writeBlob(stream, join(blobDir, String(n++)), entry.uncompressedSize, maxFileBytes));
      }
    } finally {
      zip.close();
    }
    return result;
  }

  const extract = tar.extract();
  const reading = pipeline(createReadStream(path), createGunzip(), extract);
  try {
    for await (const entry of extract) {
      const target = wanted.get(entry.header.name);
      if (!target || result.has(target)) {
        entry.resume();
        continue;
      }
      result.set(target, await writeBlob(entry as unknown as Readable, join(blobDir, String(n++)), entry.header.size ?? 0, maxFileBytes));
    }
    await reading;
  } catch (err) {
    extract.destroy();
    await reading.catch(() => undefined);
    throw err;
  }
  return result;
}
