import { z } from "zod";

// Shared API contracts between apps/api and apps/web.

export const ApiError = z.object({
  code: z.string(),
  message: z.string(),
  fix: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiError>;

// ---------- Checks (the four product tabs) ----------

export const CHECKS = ["testing", "security", "ai-evaluator", "adversarial"] as const;
export const CheckId = z.enum(CHECKS);
export type CheckId = z.infer<typeof CheckId>;

// ---------- Snapshots ----------

export const SNAPSHOT_STATUSES = ["RECEIVED", "VALIDATING", "REJECTED", "BASELINED", "FAILED"] as const;
export const SnapshotStatus = z.enum(SNAPSHOT_STATUSES);
export type SnapshotStatus = z.infer<typeof SnapshotStatus>;

export const SourceType = z.enum(["archive", "github"]);
export type SourceType = z.infer<typeof SourceType>;

/** A problem that blocks the snapshot, with a fix the user can act on. */
export const IntakeIssue = z.object({
  code: z.string(),
  message: z.string(),
  fix: z.string(),
  path: z.string().optional(),
});
export type IntakeIssue = z.infer<typeof IntakeIssue>;

export const Detection = z.object({
  languages: z.array(z.string()),
  packageManager: z.enum(["npm", "pnpm", "yarn", "bun", "pip", "poetry", "uv", "pipenv"]).nullable(),
  lockfile: z.string().nullable(),
  typescript: z.boolean(),
  frameworks: z.array(z.string()),
  aiSdks: z.array(z.string()),
  scripts: z.record(z.string(), z.string()),
  nodeEngine: z.string().nullable(),
  packageName: z.string().nullable(),
});
export type Detection = z.infer<typeof Detection>;

export const SnapshotSummary = z.object({
  id: z.string(),
  projectId: z.string(),
  status: SnapshotStatus,
  sourceType: SourceType,
  sourceRef: z.string().nullable(),
  resolvedRevision: z.string().nullable(),
  contentDigest: z.string().nullable(),
  fileCount: z.number().nullable(),
  totalBytes: z.number().nullable(),
  detection: Detection.nullable(),
  warnings: z.array(IntakeIssue),
  rejectionReasons: z.array(IntakeIssue),
  exclusions: z.array(z.string()),
  error: z.string().nullable(),
  createdAt: z.string(),
  baselinedAt: z.string().nullable(),
});
export type SnapshotSummary = z.infer<typeof SnapshotSummary>;

export const IntakeEvent = z.object({
  seq: z.number(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export type IntakeEvent = z.infer<typeof IntakeEvent>;

// ---------- Projects ----------

/**
 * How far the project is from being usable by the checks. Only "ready" may be checked:
 * processing (upload being validated) → reading_code (static analysis) → explaining (AI step) → ready.
 */
export const AnalysisStage = z.enum(["processing", "reading_code", "explaining", "ready", "failed", "rejected", "none"]);
export type AnalysisStage = z.infer<typeof AnalysisStage>;
export const ProjectAnalysis = z.object({
  stage: AnalysisStage,
  /** What is happening right now, e.g. "Reading module 3 of 9: src/services". */
  step: z.string().nullable(),
  /** 0 to 1 when the step count is known. */
  progress: z.number().min(0).max(1).nullable(),
  /** Why it failed or was rejected, in plain words. */
  error: z.string().nullable(),
});
export type ProjectAnalysis = z.infer<typeof ProjectAnalysis>;

export const ProjectSummary = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sourceType: SourceType,
  githubRepo: z.string().nullable(),
  createdAt: z.string(),
  latestSnapshot: SnapshotSummary.nullable(),
  /** Readiness of the latest snapshot, including the full understanding (code facts and AI step). */
  analysis: ProjectAnalysis,
});
export type ProjectSummary = z.infer<typeof ProjectSummary>;

export const ProjectDetail = ProjectSummary.extend({
  snapshots: z.array(SnapshotSummary),
});
export type ProjectDetail = z.infer<typeof ProjectDetail>;

/** owner/name, as GitHub allows them (no path tricks). */
export const GithubRepoName = z
  .string()
  .regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/, "Use the owner/name form, like octocat/hello-world.")
  .refine((s) => !s.split("/")[1]!.startsWith(".") && !s.includes(".."), "That isn't a valid repository name.");

export const CreateProjectInput = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Give your project a name.")
      .max(80, "Use at most 80 characters.")
      .regex(/^[\w .()-]+$/, "Use letters, numbers, spaces, dots, dashes, underscores or brackets."),
    description: z.string().trim().max(500).optional(),
    sourceType: SourceType,
    githubRepo: GithubRepoName.optional(),
  })
  .refine((v) => (v.sourceType === "github") === Boolean(v.githubRepo), {
    message: "GitHub projects need a repository; uploaded projects must not have one.",
    path: ["githubRepo"],
  });
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

/** A branch name, tag or commit SHA; refuses characters git does not allow in refs. */
export const GitRef = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((r) => !/[\s~^:?*[\\\u0000-\u001f]|\.\.|@\{|^\/|\/$|\.lock$/.test(r), "That isn't a valid branch name.");

export const GithubSnapshotInput = z.object({
  repo: GithubRepoName,
  ref: GitRef,
  attest: z.literal(true, { message: "Confirm you own this code or are authorized to assess it." }),
});
export type GithubSnapshotInput = z.infer<typeof GithubSnapshotInput>;

export const FileTreeEntry = z.object({ path: z.string(), size: z.number() });
export type FileTreeEntry = z.infer<typeof FileTreeEntry>;

// ---------- Me / workspaces ----------

export const Workspace = z.object({
  id: z.string(),
  name: z.string(),
  personal: z.boolean(),
  role: z.string(),
});
export type Workspace = z.infer<typeof Workspace>;

export const Me = z.object({
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    image: z.string().nullable(),
    emailVerified: z.boolean(),
  }),
  workspaces: z.array(Workspace),
});
export type Me = z.infer<typeof Me>;

// ---------- GitHub ----------

export const GithubInstallation = z.object({
  id: z.number(),
  account: z.object({ login: z.string(), type: z.string(), avatarUrl: z.string() }),
  /** "all" or "selected" repositories */
  selection: z.string(),
  /** Where the user changes which repositories cybercheck can read. */
  settingsUrl: z.string(),
});
export type GithubInstallation = z.infer<typeof GithubInstallation>;

export const GithubStatus = z.object({
  /** The server has a GitHub App configured. */
  configured: z.boolean(),
  installUrl: z.string().nullable(),
  /** The user has a GitHub account connected. */
  connected: z.boolean(),
  /** The connection was made through the GitHub App and is still valid. */
  authorized: z.boolean(),
  login: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  installations: z.array(GithubInstallation),
});
export type GithubStatus = z.infer<typeof GithubStatus>;

export const GithubRepo = z.object({
  fullName: z.string(),
  name: z.string(),
  owner: z.string(),
  private: z.boolean(),
  defaultBranch: z.string(),
  pushedAt: z.string().nullable(),
  language: z.string().nullable(),
  description: z.string().nullable(),
  /** Already a project in this workspace. */
  importedProjectId: z.string().nullable(),
});
export type GithubRepo = z.infer<typeof GithubRepo>;

export const GithubBranch = z.object({ name: z.string(), sha: z.string(), isDefault: z.boolean() });
export type GithubBranch = z.infer<typeof GithubBranch>;

// ---------- Limits (shown in the UI, enforced by the API) ----------

export const INTAKE_LIMITS = {
  maxUploadBytes: 100 * 1024 * 1024,
  maxExpandedBytes: 500 * 1024 * 1024,
  maxFileBytes: 50 * 1024 * 1024,
  maxEntries: 20_000,
  maxCompressionRatio: 100,
  maxPathLength: 400,
  maxDepth: 32,
} as const;

/** Folders dropped wherever they appear (re-installable or generated). Shared by browser and server. */
export const EXCLUDED_SEGMENTS = ["node_modules", ".git", ".next", "dist", "build", "coverage", "__MACOSX"] as const;
/** File names dropped wherever they appear (OS clutter). */
export const EXCLUDED_FILES = [".DS_Store", "Thumbs.db"] as const;
export const DEFAULT_EXCLUSIONS = ["node_modules/", ".git/", ".next/", "dist/", "build/", "coverage/"] as const;

/** The exclusion that matches a project-relative path, or null. */
export function exclusionFor(path: string): string | null {
  const segments = path.split("/");
  for (const seg of segments.slice(0, -1)) {
    if ((EXCLUDED_SEGMENTS as readonly string[]).includes(seg)) return `${seg}/`;
  }
  const last = segments.at(-1) ?? "";
  if ((EXCLUDED_FILES as readonly string[]).includes(last)) return last;
  if ((EXCLUDED_SEGMENTS as readonly string[]).includes(last)) return `${last}/`;
  return null;
}
export * from "./dossier.ts";
export * from "./testing.ts";
export * from "./testing-scenarios.ts";
export * from "./security.ts";
export * from "./ai-evaluator.ts";
export * from "./adversarial.ts";
