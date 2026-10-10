import type { IntakeIssue } from "@cybercheck/contracts";
import type { RawEntry } from "./archive.ts";
import { isSecretFile } from "../understanding/source.ts";
import { EXCLUDED_LIMITS, LIMITS, exclusionFor, issues, warnings } from "./policy.ts";

export type ValidationResult = {
  /** raw archive name -> normalized project path, for files that become the snapshot */
  wanted: Map<string, string>;
  rejections: IntakeIssue[];
  warnings: IntakeIssue[];
  /** e.g. "node_modules/ (1,204 files)" */
  exclusions: string[];
  fileCount: number;
  totalBytes: number;
};

/** Small archives that compress extremely well (a file of spaces) are harmless. */
const BOMB_MIN_BYTES = 1024 * 1024;
const MAX_ISSUES_PER_CODE = 3;

type Normalized = { ok: true; path: string } | { ok: false; issue: IntakeIssue };

export function normalizePath(raw: string): Normalized {
  if (raw.includes("\0") || /[\u0001-\u001f]/.test(raw)) return { ok: false, issue: issues.nulByte(printable(raw)) };
  if (raw.includes("\\")) return { ok: false, issue: issues.backslash(raw) };
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) return { ok: false, issue: issues.absolutePath(raw) };
  const segments = raw.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.includes("..")) return { ok: false, issue: issues.traversal(raw) };
  return { ok: true, path: segments.join("/") };
}

function printable(s: string) {
  return s.replace(/[\u0000-\u001f]/g, "?");
}

export function validateEntries(entries: RawEntry[], opts: { stripTopLevel?: boolean } = {}): ValidationResult {
  const rejections: IntakeIssue[] = [];
  const warns: IntakeIssue[] = [];
  const perCode = new Map<string, number>();
  const reject = (issue: IntakeIssue) => {
    const n = perCode.get(issue.code) ?? 0;
    perCode.set(issue.code, n + 1);
    if (n < MAX_ISSUES_PER_CODE) rejections.push(issue);
  };
  const warn = (issue: IntakeIssue) => {
    const n = perCode.get(`w:${issue.code}`) ?? 0;
    perCode.set(`w:${issue.code}`, n + 1);
    if (n < MAX_ISSUES_PER_CODE) warns.push(issue);
  };

  // 1. Normalize every name; unsafe names reject the whole archive.
  const files: Array<{ raw: string; path: string; entry: RawEntry }> = [];
  for (const entry of entries) {
    if (entry.kind === "dir") {
      const n = normalizePath(entry.name);
      if (!n.ok) reject(n.issue);
      continue;
    }
    const n = normalizePath(entry.name);
    if (!n.ok) {
      reject(n.issue);
      continue;
    }
    if (n.path === "") continue;
    files.push({ raw: entry.name, path: n.path, entry });
  }

  // 2. GitHub tarballs (and most zipped folders) wrap everything in one top folder: drop it.
  const candidates = files.filter((f) => !exclusionFor(f.path));
  const firstSegments = new Set(candidates.map((f) => f.path.split("/")[0]));
  const allNested = candidates.length > 0 && candidates.every((f) => f.path.includes("/"));
  if (opts.stripTopLevel || (allNested && firstSegments.size === 1)) {
    for (const f of files) {
      const i = f.path.indexOf("/");
      f.path = i === -1 ? "" : f.path.slice(i + 1);
    }
  }

  // 3. Exclusions, special files, per-file limits.
  const excluded = new Map<string, { files: number; bytes: number }>();
  const wanted = new Map<string, string>();
  const seenLower = new Map<string, string>();
  let totalBytes = 0;
  let excludedFiles = 0;
  let excludedBytes = 0;

  for (const f of files) {
    if (f.path === "") continue;
    // Credentials and keys are never stored in a snapshot; the user is told which file.
    if (isSecretFile(f.path)) {
      const label = "secret files (never stored)";
      const agg = excluded.get(label) ?? { files: 0, bytes: 0 };
      agg.files += 1;
      excluded.set(label, agg);
      warn(warnings.secretFileExcluded(f.path));
      continue;
    }
    const ex = exclusionFor(f.path);
    if (ex) {
      const agg = excluded.get(ex) ?? { files: 0, bytes: 0 };
      agg.files += 1;
      agg.bytes += f.entry.size;
      excluded.set(ex, agg);
      excludedFiles += 1;
      excludedBytes += f.entry.size;
      continue;
    }
    if (f.entry.kind === "symlink") {
      warn(warnings.symlinkSkipped(f.path));
      continue;
    }
    if (f.entry.kind === "other") {
      warn(warnings.specialSkipped(f.path));
      continue;
    }
    if (f.entry.encrypted) reject(issues.encrypted(f.path));
    if (f.entry.unsupportedCompression) reject(issues.unsupportedCompression(f.path));
    if (f.path.length > LIMITS.maxPathLength) reject(issues.pathTooLong(f.path.slice(0, 120) + "..."));
    if (f.path.split("/").length > LIMITS.maxDepth) reject(issues.tooDeep(f.path));
    if (f.entry.size > LIMITS.maxFileBytes) reject(issues.fileTooLarge(f.path));
    const c = f.entry.compressedSize;
    if (c !== undefined && f.entry.size >= BOMB_MIN_BYTES && f.entry.size > (c || 1) * LIMITS.maxCompressionRatio) {
      reject(issues.compressionBomb(f.path));
    }

    const lower = f.path.toLowerCase();
    // Any repeat is rejected: archives with duplicate names can hide different content
    // behind the same path, and case-only differences collide on many file systems.
    if (seenLower.has(lower)) {
      reject(issues.duplicatePath(f.path));
      continue;
    }
    seenLower.set(lower, f.path);
    wanted.set(f.raw, f.path);
    totalBytes += f.entry.size;
  }

  // 4. Whole-archive limits.
  if (wanted.size > LIMITS.maxEntries) reject(issues.tooManyFiles());
  if (totalBytes > LIMITS.maxExpandedBytes) reject(issues.expandedTooLarge());
  if (excludedFiles > EXCLUDED_LIMITS.maxEntries || excludedBytes > EXCLUDED_LIMITS.maxExpandedBytes) {
    reject(issues.excludedTooLarge());
  }
  if (wanted.size === 0 && rejections.length === 0) reject(issues.empty());

  const exclusions = [...excluded.entries()]
    .sort((a, b) => b[1].files - a[1].files)
    .map(([pattern, agg]) => `${pattern} (${agg.files.toLocaleString("en-US")} ${agg.files === 1 ? "file" : "files"})`);

  return { wanted, rejections, warnings: warns, exclusions, fileCount: wanted.size, totalBytes };
}
