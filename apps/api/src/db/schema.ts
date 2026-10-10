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
