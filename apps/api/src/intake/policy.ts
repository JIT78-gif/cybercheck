import { INTAKE_LIMITS, type IntakeIssue } from "@cybercheck/contracts";

/** Bump when validation rules change, so every snapshot records which rules it passed. */
export const INTAKE_POLICY_VERSION = "2026-10-10.2";

export const LIMITS = INTAKE_LIMITS;

/** Excluded entries never become part of a snapshot; caps keep their processing bounded. */
export const EXCLUDED_LIMITS = {
  maxEntries: 300_000,
  maxExpandedBytes: 3 * 1024 * 1024 * 1024,
} as const;

// Exclusion rules live in @cybercheck/contracts so the browser (folder upload) and server agree.
export { EXCLUDED_FILES, EXCLUDED_SEGMENTS, exclusionFor } from "@cybercheck/contracts";

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

/** Every rejection reason, with a fix written for the person uploading. */
export const issues = {
  unsupportedFormat: (): IntakeIssue => ({
    code: "unsupported_format",
    message: "This file isn't a .zip or .tar.gz archive.",
    fix: "Compress your project folder as .zip (or .tar.gz) and upload that file.",
  }),
  corruptArchive: (detail: string): IntakeIssue => ({
    code: "corrupt_archive",
    message: `The archive couldn't be read (${detail}).`,
    fix: "Create the archive again and re-upload it. If it was downloaded, download it again.",
  }),
  encrypted: (path: string): IntakeIssue => ({
    code: "encrypted_entry",
    message: "The archive contains password-protected files.",
    fix: "Create the archive without a password.",
    path,
  }),
  unsupportedCompression: (path: string): IntakeIssue => ({
    code: "unsupported_compression",
    message: "The archive uses a compression method we can't read.",
    fix: "Create a standard .zip (Deflate) or .tar.gz archive.",
    path,
  }),
  absolutePath: (path: string): IntakeIssue => ({
    code: "absolute_path",
    message: "A file uses an absolute path, which could write outside the project.",
    fix: "Zip the project folder itself so every path is relative to it.",
    path,
  }),
  traversal: (path: string): IntakeIssue => ({
    code: "path_traversal",
    message: "A file path contains \"..\", which could escape the project folder.",
    fix: "Remove that entry or re-create the archive from the project folder.",
    path,
  }),
  backslash: (path: string): IntakeIssue => ({
    code: "backslash_path",
    message: "A file path contains a backslash, which some systems treat as a folder separator.",
    fix: "Re-create the archive with a standard zip tool so paths use forward slashes.",
    path,
  }),
  nulByte: (path: string): IntakeIssue => ({
    code: "invalid_path_character",
    message: "A file path contains an invalid control character.",
    fix: "Rename that file and re-create the archive.",
    path,
  }),
  pathTooLong: (path: string): IntakeIssue => ({
    code: "path_too_long",
    message: `A file path is longer than ${LIMITS.maxPathLength} characters.`,
    fix: "Shorten deeply nested folder or file names.",
    path,
  }),
  tooDeep: (path: string): IntakeIssue => ({
    code: "path_too_deep",
    message: `A file is nested more than ${LIMITS.maxDepth} folders deep.`,
    fix: "Flatten the folder structure or exclude generated folders.",
    path,
  }),
  duplicatePath: (path: string): IntakeIssue => ({
    code: "duplicate_path",
    message: "Two files have the same path when letter case is ignored.",
    fix: "Rename one of them so the names differ by more than capitalisation.",
    path,
  }),
  tooManyFiles: (): IntakeIssue => ({
    code: "too_many_files",
    message: `The project has more than ${LIMITS.maxEntries.toLocaleString("en-US")} files (after exclusions).`,
    fix: "Remove generated files, build output and vendored dependencies, then upload again.",
  }),
  fileTooLarge: (path: string): IntakeIssue => ({
    code: "file_too_large",
    message: `A single file is larger than ${mb(LIMITS.maxFileBytes)}.`,
    fix: "Remove large binaries, datasets or media from the upload.",
    path,
  }),
  expandedTooLarge: (): IntakeIssue => ({
    code: "expanded_too_large",
    message: `The project is larger than ${mb(LIMITS.maxExpandedBytes)} once unpacked.`,
    fix: "Remove large binaries, datasets, media and build output, then upload again.",
  }),
  compressionBomb: (path: string): IntakeIssue => ({
    code: "suspicious_compression_ratio",
    message: `A file expands more than ${LIMITS.maxCompressionRatio}x its compressed size, which is how archive bombs work.`,
    fix: "If this file is genuine (for example a huge log), remove it from the upload.",
    path,
  }),
  sizeMismatch: (path: string): IntakeIssue => ({
    code: "size_mismatch",
    message: "A file's real size doesn't match the size recorded in the archive.",
    fix: "Re-create the archive with a standard tool.",
    path,
  }),
  excludedTooLarge: (): IntakeIssue => ({
    code: "archive_too_large",
    message: "The archive is too large to process, even after ignoring dependency and build folders.",
    fix: "Delete node_modules, build output and other generated folders before compressing.",
  }),
  empty: (): IntakeIssue => ({
    code: "empty_project",
    message: "No project files were found in the archive (after exclusions).",
    fix: "Make sure you compressed the project folder that contains your source code.",
  }),
} as const;

export const warnings = {
  secretFileExcluded: (path: string): IntakeIssue => ({
    code: "secret_file_excluded",
    message: "A file that usually holds credentials was left out and never stored.",
    fix: "Remove it from your repository and rotate any keys it contained if the repository was ever shared.",
    path,
  }),
  symlinkSkipped: (path: string): IntakeIssue => ({
    code: "symlink_skipped",
    message: "A symbolic link was skipped. Links are never followed.",
    fix: "If the target file matters, include the real file instead of a link.",
    path,
  }),
  specialSkipped: (path: string): IntakeIssue => ({
    code: "special_file_skipped",
    message: "A special file (device, pipe or hard link) was skipped.",
    fix: "No action needed unless that file is part of your source code.",
    path,
  }),
  notNode: (): IntakeIssue => ({
    code: "unsupported_stack",
    message: "No package.json found. This release runs checks on Node.js and TypeScript projects.",
    fix: "You can keep the snapshot. Checks for other stacks will be added later.",
  }),
  noLockfile: (): IntakeIssue => ({
    code: "no_lockfile",
    message: "No lockfile found, so dependency versions can't be pinned exactly.",
    fix: "Commit package-lock.json, pnpm-lock.yaml, yarn.lock or bun.lock for reproducible results.",
  }),
  noTestScript: (): IntakeIssue => ({
    code: "no_test_script",
    message: "package.json has no \"test\" script.",
    fix: "No problem: the Testing check will report which areas are untested.",
  }),
} as const;
