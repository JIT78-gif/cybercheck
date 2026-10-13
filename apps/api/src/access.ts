import type { FastifyReply, FastifyRequest } from "fastify";
import { fromNodeHeaders } from "better-auth/node";
import { and, eq } from "drizzle-orm";
import type { ApiError, SnapshotSummary, ProjectSummary } from "@cybercheck/contracts";
import { auth } from "./auth/auth.ts";
import { db } from "./db/client.ts";
import { project, snapshot, workspaceMember } from "./db/schema.ts";

export function sendError(reply: FastifyReply, status: number, error: ApiError) {
  return reply.status(status).send(error);
}

export const notFound = (what: string): ApiError => ({
  code: "not_found",
  message: `That ${what} doesn't exist, or you don't have access to it.`,
  fix: "Check the link, or switch to the workspace that owns it.",
});

export async function requireSession(request: FastifyRequest, reply: FastifyReply) {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
  if (!session) {
    await sendError(reply, 401, {
      code: "unauthenticated",
      message: "You need to sign in to do that.",
      fix: "Sign in and try again.",
    });
    return null;
  }
  return session;
}

/** Tenant boundary: every lookup goes through workspace membership. Unknown and foreign IDs look the same (404). */
export async function isMember(userId: string, workspaceId: string) {
  const [row] = await db
    .select({ role: workspaceMember.role })
    .from(workspaceMember)
    .where(and(eq(workspaceMember.userId, userId), eq(workspaceMember.workspaceId, workspaceId)))
    .limit(1);
  return row ?? null;
}

export async function projectForUser(userId: string, projectId: string) {
  const [row] = await db
    .select({ project })
    .from(project)
    .innerJoin(workspaceMember, eq(workspaceMember.workspaceId, project.workspaceId))
    .where(and(eq(project.id, projectId), eq(workspaceMember.userId, userId)))
    .limit(1);
  return row?.project ?? null;
}

export async function snapshotForUser(userId: string, snapshotId: string) {
  const [row] = await db
    .select({ snapshot })
    .from(snapshot)
    .innerJoin(project, eq(project.id, snapshot.projectId))
    .innerJoin(workspaceMember, eq(workspaceMember.workspaceId, project.workspaceId))
    .where(and(eq(snapshot.id, snapshotId), eq(workspaceMember.userId, userId)))
    .limit(1);
  return row?.snapshot ?? null;
}

export function toSnapshotSummary(s: typeof snapshot.$inferSelect): SnapshotSummary {
  return {
    id: s.id,
    projectId: s.projectId,
    status: s.status,
    sourceType: s.sourceType,
    sourceRef: s.sourceRef,
    resolvedRevision: s.resolvedRevision,
    contentDigest: s.contentDigest,
    fileCount: s.fileCount,
    totalBytes: s.totalBytes,
    detection: (s.detection as SnapshotSummary["detection"]) ?? null,
    warnings: (s.warnings as SnapshotSummary["warnings"]) ?? [],
    rejectionReasons: (s.rejectionReasons as SnapshotSummary["rejectionReasons"]) ?? [],
    exclusions: (s.exclusions as string[]) ?? [],
    error: s.error,
    createdAt: s.createdAt.toISOString(),
    baselinedAt: s.baselinedAt?.toISOString() ?? null,
  };
}

export function toProjectSummary(
  p: typeof project.$inferSelect,
  latest: typeof snapshot.$inferSelect | null,
  analysis: ProjectSummary["analysis"] = { stage: "none", step: null, progress: null, error: null },
): ProjectSummary {
  return {
    id: p.id,
    workspaceId: p.workspaceId,
    name: p.name,
    description: p.description,
    sourceType: p.sourceType,
    githubRepo: p.githubRepo,
    createdAt: p.createdAt.toISOString(),
    latestSnapshot: latest ? toSnapshotSummary(latest) : null,
    analysis,
  };
}

/**
 * Workspace roles that may review findings, accept a risk and approve a sandbox repair. Every member during the
 * hackathon; narrow this list (for example to owner and admin) to make review an owner or admin decision again.
 */
export const REVIEW_ROLES: ReadonlyArray<"owner" | "admin" | "member"> = ["owner", "admin", "member"];

/** Project authority: the caller's role in the workspace that holds the project, when that role may decide. Null otherwise. */
export async function projectAuthority(userId: string, projectId: string): Promise<"owner" | "admin" | "member" | null> {
  const [row] = await db
    .select({ role: workspaceMember.role })
    .from(project)
    .innerJoin(workspaceMember, eq(workspaceMember.workspaceId, project.workspaceId))
    .where(and(eq(project.id, projectId), eq(workspaceMember.userId, userId)))
    .limit(1);
  const role = row?.role as "owner" | "admin" | "member" | undefined;
  return role && REVIEW_ROLES.includes(role) ? role : null;
}

export const notAuthorized = (what: string): ApiError => ({
  code: "forbidden",
  message: `Your role in this workspace cannot ${what}.`,
  fix: "Ask an owner of the workspace to do it, or to change your role.",
});
