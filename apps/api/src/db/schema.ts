import { sql } from "drizzle-orm";
import {
  bigint,
  integer,
  jsonb,
  boolean,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ---------- Better Auth core tables (fields match better-auth 1.7 getAuthTables) ----------

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// ---------- Workspaces (tenant boundary; every user gets a "Personal" one) ----------

export const workspaceRole = pgEnum("workspace_role", ["owner", "admin", "member"]);

export const workspace = pgTable(
  "workspace",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    personal: boolean("personal").notNull().default(false),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // At most one personal workspace per user (makes the sign-up hook idempotent).
  (t) => [uniqueIndex("workspace_one_personal_per_user").on(t.createdBy).where(sql`${t.personal}`)],
);

export const workspaceMember = pgTable(
  "workspace_member",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: workspaceRole("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index("workspace_member_user_idx").on(t.userId),
  ],
);

// ---------- Projects and immutable baseline snapshots ----------

export const sourceType = pgEnum("source_type", ["archive", "github"]);
export const snapshotStatus = pgEnum("snapshot_status", [
  "RECEIVED",
  "VALIDATING",
  "REJECTED",
  "BASELINED",
  "FAILED",
]);

export const project = pgTable(
  "project",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    sourceType: sourceType("source_type").notNull(),
    githubRepo: text("github_repo"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("project_workspace_name_idx").on(t.workspaceId, t.name),
    // One project per GitHub repository per workspace; re-imports become new snapshots.
    uniqueIndex("project_workspace_repo_idx").on(t.workspaceId, t.githubRepo).where(sql`${t.githubRepo} is not null`),
  ],
);

export const snapshot = pgTable(
  "snapshot",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    status: snapshotStatus("status").notNull().default("RECEIVED"),
    sourceType: sourceType("source_type").notNull(),
    sourceRef: text("source_ref"),
    resolvedRevision: text("resolved_revision"),
    contentDigest: text("content_digest"),
    archiveObjectKey: text("archive_object_key"),
    manifestObjectKey: text("manifest_object_key"),
    fileCount: integer("file_count"),
    totalBytes: bigint("total_bytes", { mode: "number" }),
    detection: jsonb("detection"),
    warnings: jsonb("warnings").notNull().default([]),
    rejectionReasons: jsonb("rejection_reasons").notNull().default([]),
    exclusions: jsonb("exclusions").notNull().default([]),
    error: text("error"),
    intakePolicyVersion: text("intake_policy_version").notNull(),
    ownershipAttestedAt: timestamp("ownership_attested_at", { withTimezone: true }).notNull(),
    attestedBy: text("attested_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    baselinedAt: timestamp("baselined_at", { withTimezone: true }),
  },
  (t) => [index("snapshot_project_idx").on(t.projectId, t.createdAt)],
);

export const intakeEvent = pgTable(
  "intake_event",
  {
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => snapshot.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.snapshotId, t.seq] })],
);

export const idempotencyKey = pgTable(
  "idempotency_key",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    route: text("route").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    response: jsonb("response").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.route, t.key] })],
);

// ---------- Project understanding (dossier per snapshot) ----------

export const understandingStatus = pgEnum("understanding_status", ["queued", "analyzing", "ready", "failed"]);

export const understandingRun = pgTable(
  "understanding_run",
  {
    id: text("id").primaryKey(),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => snapshot.id, { onDelete: "cascade" }),
    status: understandingStatus("status").notNull().default("queued"),
    analyzerVersion: text("analyzer_version").notNull(),
    dossier: jsonb("dossier"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("understanding_run_snapshot_idx").on(t.snapshotId, t.createdAt)],
);

// ---------- Check runs (one run per request, bound to a snapshot and its dossier) ----------
// The testing_run table holds the runs of every check engine (Testing, Security); "check" says which engine owns it.
// Obligations, executions, findings, events, reviews and repairs reference the run, so they serve every check.

export const testingRunStatus = pgEnum("testing_run_status", ["queued", "running", "completed", "partial", "blocked", "failed", "cancelled"]);

export const testingRun = pgTable(
  "testing_run",
  {
    id: text("id").primaryKey(),
    /** The engine that owns the run: "testing" or "security" (CheckId). */
    check: text("check").notNull().default("testing"),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => snapshot.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    understandingRunId: text("understanding_run_id").references(() => understandingRun.id, { onDelete: "set null" }),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => user.id),
    status: testingRunStatus("status").notNull().default("queued"),
    phase: text("phase").notNull().default("admission"),
    /** Engine version, models, budgets and limits that applied to this run. */
    policy: jsonb("policy").notNull(),
    /** Boot plan, identities and other planning decisions (no secret values). */
    plan: jsonb("plan"),
    report: jsonb("report"),
    usage: jsonb("usage"),
    error: text("error"),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    /** Incremented on every claim; writes from an older claim are ignored (fencing). */
    generation: integer("generation").notNull().default(0),
    workerId: text("worker_id"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("testing_run_snapshot_idx").on(t.snapshotId, t.createdAt), index("testing_run_status_idx").on(t.status, t.createdAt), index("testing_run_check_idx").on(t.check, t.status, t.createdAt)],
);

export const testObligation = pgTable(
  "test_obligation",
  {
    runId: text("run_id")
      .notNull()
      .references(() => testingRun.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    seq: integer("seq").notNull(),
    status: text("status").notNull(),
    data: jsonb("data").notNull(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.id] })],
);

export const testExecution = pgTable(
  "test_execution",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => testingRun.id, { onDelete: "cascade" }),
    data: jsonb("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("test_execution_run_idx").on(t.runId, t.createdAt)],
);

export const testFinding = pgTable(
  "test_finding",
  {
    /** Short per-run id shown to users (F1, F2 ...). */
    id: text("id").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => testingRun.id, { onDelete: "cascade" }),
    data: jsonb("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.id] })],
);

/** Security runtime proofs (Round 2): one row per proof, in the order they were run. */
export const securityProof = pgTable(
  "security_proof",
  {
    id: text("id").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => testingRun.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    data: jsonb("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.id] }), uniqueIndex("security_proof_run_seq_idx").on(t.runId, t.seq)],
);

/** One AI Evaluator case of a run (inputs as classes, redacted samples, grader and judge results, verdict). */
export const aiEvaluationCase = pgTable(
  "ai_evaluation_case",
  {
    runId: text("run_id")
      .notNull()
      .references(() => testingRun.id, { onDelete: "cascade" }),
    id: text("id").notNull(),
    seq: integer("seq").notNull(),
    category: text("category").notNull(),
    verdict: text("verdict").notNull(),
    data: jsonb("data").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.id] }), uniqueIndex("ai_evaluation_case_run_seq_idx").on(t.runId, t.seq)],
);

/** An uploaded AI evaluation dataset version: immutable once stored (the normalized JSONL is an object-store artifact). */
export const aiEvaluationDataset = pgTable(
  "ai_evaluation_dataset",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    version: integer("version").notNull(),
    /** sha256 of the normalized JSONL. */
    digest: text("digest").notNull(),
    artifactKey: text("artifact_key").notNull(),
    schemaVersion: integer("schema_version").notNull(),
    caseCount: integer("case_count").notNull(),
    byCategory: jsonb("by_category").notNull(),
    validation: jsonb("validation").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ai_evaluation_dataset_version_idx").on(t.projectId, t.name, t.version), index("ai_evaluation_dataset_project_idx").on(t.projectId, t.createdAt)],
);

export const testRunEvent = pgTable(
  "test_run_event",
  {
    runId: text("run_id")
      .notNull()
      .references(() => testingRun.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    message: text("message").notNull(),
    /** Structured detail of a live action (a request sent, a screen opened, a journey step), for the live view. */
    data: jsonb("data"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

/** Sandbox images with a snapshot's dependencies installed, reused across runs (keyed by content). */
export const sandboxImageCache = pgTable("sandbox_image_cache", {
  key: text("key").primaryKey(),
  provider: text("provider").notNull(),
  imageId: text("image_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Human reviews of Testing findings. Append-only: a later review links the one it supersedes, and the latest one
 * is the effective decision. The machine finding itself is never changed by a review.
 */
export const findingReview = pgTable(
  "finding_review",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => testingRun.id, { onDelete: "cascade" }),
    findingId: text("finding_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => snapshot.id, { onDelete: "cascade" }),
    reviewerUserId: text("reviewer_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    reviewerRole: text("reviewer_role").notNull(),
    decision: text("decision").notNull(),
    reason: text("reason"),
    supersedesReviewId: text("supersedes_review_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("finding_review_run_idx").on(t.runId, t.findingId, t.createdAt), index("finding_review_project_idx").on(t.projectId)],
);

/** Who did what to which object (reviews, approvals): an append-only record of user decisions. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    workspaceId: text("workspace_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    data: jsonb("data"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_target_idx").on(t.targetType, t.targetId)],
);

/**
 * A repair of one human-confirmed finding, tried only inside fresh sandboxes after explicit approval. The project
 * snapshot is never changed: a patch exists only as an overlay on the validation runs' sandboxes.
 */
export const testingRepair = pgTable(
  "testing_repair",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => testingRun.id, { onDelete: "cascade" }),
    findingId: text("finding_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    snapshotId: text("snapshot_id")
      .notNull()
      .references(() => snapshot.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    approvedBy: text("approved_by").references(() => user.id, { onDelete: "set null" }),
    scope: jsonb("scope").notNull(),
    attempts: jsonb("attempts").notNull().default(sql`'[]'::jsonb`),
    error: text("error"),
    /** Worker claim: who is running it and when it last reported (a stale one is picked up again). */
    workerId: text("worker_id"),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
    cancelRequested: boolean("cancel_requested").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("testing_repair_run_idx").on(t.runId, t.findingId)],
);
