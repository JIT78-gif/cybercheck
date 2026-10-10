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
  };
}
