import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import type { SourceExcerpt } from "@cybercheck/contracts";
import { notFound, requireSession, sendError, snapshotForUser } from "../access.ts";
import { db } from "../db/client.ts";
import { project } from "../db/schema.ts";
import { objectStore } from "../storage/object-store.ts";
import { dossierToMarkdown } from "../understanding/export.ts";
import { ensureUnderstanding, toUnderstandingRun } from "../understanding/run.ts";
import { getSnapshotSource, isSecretFile, redactSecrets } from "../understanding/source.ts";

const notReady = {
  code: "snapshot_not_ready",
  message: "This snapshot isn't baselined, so it can't be analysed.",
  fix: "Wait for processing to finish, or upload again if it was rejected.",
};

const MAX_EXCERPT_LINES = 400;

export async function understandingRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/v1/snapshots/:id/understanding", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const s = await snapshotForUser(session.user.id, request.params.id);
    if (!s) return sendError(reply, 404, notFound("snapshot"));
    if (s.status !== "BASELINED") return sendError(reply, 409, notReady);
    return { run: toUnderstandingRun(await ensureUnderstanding(s.id)) };
  });

  app.post<{ Params: { id: string } }>("/v1/snapshots/:id/understanding/rerun", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const s = await snapshotForUser(session.user.id, request.params.id);
    if (!s) return sendError(reply, 404, notFound("snapshot"));
    if (s.status !== "BASELINED") return sendError(reply, 409, notReady);
    return reply.status(202).send({ run: toUnderstandingRun(await ensureUnderstanding(s.id, true)) });
  });

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>("/v1/snapshots/:id/understanding/export", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const s = await snapshotForUser(session.user.id, request.params.id);
    if (!s) return sendError(reply, 404, notFound("snapshot"));
    const run = toUnderstandingRun(await ensureUnderstanding(s.id));
    if (!run.dossier) {
      return sendError(reply, 409, { code: "understanding_not_ready", message: "The analysis hasn't finished yet.", fix: "Try the export again in a few seconds." });
    }
    const [p] = await db.select({ name: project.name }).from(project).where(eq(project.id, s.projectId));
    const base = (p?.name ?? "project").replace(/[^\w.-]+/g, "-").slice(0, 60);
    if (request.query.format === "json") {
      reply.header("content-disposition", `attachment; filename="${base}-architecture.json"`);
      return run.dossier;
    }
    reply.header("content-type", "text/markdown; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="${base}-architecture.md"`);
    return dossierToMarkdown(run.dossier, p?.name ?? "Project");
  });

  /** Source lines for evidence links. Owner-only, never secret files, secrets redacted. */
  app.get<{ Params: { id: string }; Querystring: { path?: string; start?: string; end?: string } }>("/v1/snapshots/:id/file", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const s = await snapshotForUser(session.user.id, request.params.id);
    if (!s) return sendError(reply, 404, notFound("snapshot"));
    if (s.status !== "BASELINED" || !s.archiveObjectKey) return sendError(reply, 409, notReady);
    const path = request.query.path ?? "";
    if (!path || path.length > 400 || isSecretFile(path)) {
      return sendError(reply, 404, { code: "file_not_available", message: "That file can't be shown.", fix: "Secret files (like .env or keys) are never displayed." });
    }
    const src = await getSnapshotSource(objectStore, s.archiveObjectKey);
    const file = src.files.get(path);
    if (!file) {
      return sendError(reply, 404, { code: "file_not_available", message: "That file isn't part of the analysed snapshot.", fix: src.skipped.get(path) ? `It was skipped: ${src.skipped.get(path)}.` : "Check the path." });
    }
    const all = file.text.split("\n");
    const start = Math.max(1, Number(request.query.start) || 1);
    const end = Math.min(all.length, Math.max(start, Number(request.query.end) || start + 80), start + MAX_EXCERPT_LINES - 1);
    const { text, count } = redactSecrets(all.slice(start - 1, end).join("\n"));
    const excerpt: SourceExcerpt = { path, start, end, totalLines: all.length, lines: text.split("\n"), redactions: count };
    return excerpt;
  });
}
