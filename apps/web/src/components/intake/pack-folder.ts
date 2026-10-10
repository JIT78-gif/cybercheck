import { Zip, ZipDeflate } from "fflate";
import { EXCLUDED_SEGMENTS, INTAKE_LIMITS, exclusionFor } from "@cybercheck/contracts";
import { formatBytes } from "@/lib/format";

export type FolderFile = { path: string; file: File };

export type FolderScan = {
  rootName: string;
  files: FolderFile[];
  totalBytes: number;
  skipped: number;
  problems: string[];
};

/** Read a dropped folder without descending into excluded folders (node_modules can be huge). */
export async function readDroppedEntries(items: DataTransferItemList): Promise<{ rootName: string; files: FolderFile[]; skipped: number } | null> {
  const entries = [...items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => Boolean(e));
  const dirs = entries.filter((e) => e.isDirectory);
  if (dirs.length !== 1 || entries.length !== 1) return null; // not a single folder
  const root = dirs[0] as FileSystemDirectoryEntry;
  const files: FolderFile[] = [];
  let skipped = 0;

  const readAll = (dir: FileSystemDirectoryEntry) =>
    new Promise<FileSystemEntry[]>((resolve, reject) => {
      const reader = dir.createReader();
      const out: FileSystemEntry[] = [];
      const next = () =>
        reader.readEntries((batch) => {
          if (batch.length === 0) resolve(out);
          else {
            out.push(...batch);
            next();
          }
        }, reject);
      next();
    });

  async function walk(dir: FileSystemDirectoryEntry, prefix: string) {
    for (const entry of await readAll(dir)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if ((EXCLUDED_SEGMENTS as readonly string[]).includes(entry.name)) {
          skipped += 1;
          continue;
        }
        await walk(entry as FileSystemDirectoryEntry, path);
      } else if (exclusionFor(path)) {
        skipped += 1;
      } else {
        const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
        files.push({ path, file });
      }
      if (files.length > INTAKE_LIMITS.maxEntries) return;
    }
  }
  await walk(root, "");
  return { rootName: root.name, files, skipped };
}

/** Files from <input webkitdirectory>: paths start with the chosen folder's name. */
export function fromDirectoryInput(list: FileList): { rootName: string; files: FolderFile[]; skipped: number } {
  const files: FolderFile[] = [];
  let skipped = 0;
  let rootName = "project";
  for (const file of [...list]) {
    const rel = file.webkitRelativePath || file.name;
    const slash = rel.indexOf("/");
    if (slash > 0) rootName = rel.slice(0, slash);
    const path = slash > 0 ? rel.slice(slash + 1) : rel;
    if (exclusionFor(path)) skipped += 1;
    else files.push({ path, file });
  }
  return { rootName, files, skipped };
}

/** Check the same limits the server enforces, so problems show before uploading. */
export function checkFolder(scan: { rootName: string; files: FolderFile[]; skipped: number }): FolderScan {
  const problems: string[] = [];
  const totalBytes = scan.files.reduce((s, f) => s + f.file.size, 0);
  if (scan.files.length === 0) problems.push("No project files found in this folder (after leaving out dependency and build folders).");
  if (scan.files.length > INTAKE_LIMITS.maxEntries) {
    problems.push(`More than ${INTAKE_LIMITS.maxEntries.toLocaleString("en-US")} files. Remove generated files or vendored dependencies.`);
  }
  if (totalBytes > INTAKE_LIMITS.maxExpandedBytes) {
    problems.push(`The folder is ${formatBytes(totalBytes)}; the limit is ${formatBytes(INTAKE_LIMITS.maxExpandedBytes)}. Remove large media, datasets or build output.`);
  }
  const big = scan.files.filter((f) => f.file.size > INTAKE_LIMITS.maxFileBytes).slice(0, 3);
  for (const f of big) problems.push(`${f.path} is ${formatBytes(f.file.size)} (limit ${formatBytes(INTAKE_LIMITS.maxFileBytes)} per file).`);
  return { ...scan, totalBytes, problems };
}

/** Zip the folder in the browser (streaming, file by file) so it uses the normal upload path. */
export async function zipFolder(scan: FolderScan, onProgress: (fraction: number) => void): Promise<File> {
  const chunks: Uint8Array[] = [];
  let failure: Error | null = null;
  const zip = new Zip((err, data) => {
    if (err) failure = err;
    else chunks.push(data);
  });

  let done = 0;
  const sorted = [...scan.files].sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const { path, file } of sorted) {
    const entry = new ZipDeflate(path, { level: 6 });
    zip.add(entry);
    const data = new Uint8Array(await file.arrayBuffer());
    entry.push(data, true);
    done += file.size;
    onProgress(scan.totalBytes ? done / scan.totalBytes : 1);
    if (failure) throw failure;
  }
  zip.end();
  if (failure) throw failure;

  const blob = new Blob(chunks as BlobPart[], { type: "application/zip" });
  const safeName = scan.rootName.replace(/[^\w .()-]/g, "-").slice(0, 80) || "project";
  return new File([blob], `${safeName}.zip`, { type: "application/zip" });
}
