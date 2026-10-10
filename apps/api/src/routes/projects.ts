import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { text } from "node:stream/consumers";
import type { FastifyInstance, FastifyReply } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  CreateProjectInput,
  INTAKE_LIMITS,
  type FileTreeEntry,
  type ProjectDetail,
} from "@cybercheck/contracts";
import {
  isMember,
  notFound,
  projectForUser,
  requireSession,
  sendError,
  snapshotForUser,
  toProjectSummary,
  toSnapshotSummary,
} from "../access.ts";
import { db } from "../db/client.ts";
import { idempotencyKey, project, snapshot } from "../db/schema.ts";
import { TERMINAL_EVENTS, emitIntakeEvent, listIntakeEvents, subscribeIntake } from "../intake/events.ts";
import { startIntake } from "../intake/pipeline.ts";
import { INTAKE_POLICY_VERSION } from "../intake/policy.ts";
import { objectStore } from "../storage/object-store.ts";

const UPLOAD_DIR = fileURLToPath(new URL("../../../../.data/uploads", import.meta.url));

function badRequest(reply: FastifyReply, message: string, fix: string, code = "invalid_request") {
  return sendError(reply, 400, { code, message, fix });
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export async function projectRoutes(app: FastifyInstance) {
  // ---------- Projects ----------

  app.get<{ Params: { wid: string } }>("/v1/workspaces/:wid/projects", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    if (!(await isMember(session.user.id, request.params.wid))) return sendError(reply, 404, notFound("workspace"));

    const projects = await db
      .select()
      .from(project)
      .where(eq(project.workspaceId, request.params.wid))
      .orderBy(desc(project.createdAt));
    const snaps = projects.length
      ? await db
          .select()
          .from(snapshot)
          .where(inArray(snapshot.projectId, projects.map((p) => p.id)))
          .orderBy(desc(snapshot.createdAt))
      : [];
    const latest = new Map<string, typeof snapshot.$inferSelect>();
    for (const s of snaps) if (!latest.has(s.projectId)) latest.set(s.projectId, s);
    return { projects: projects.map((p) => toProjectSummary(p, latest.get(p.id) ?? null)) };
  });

  app.post<{ Params: { wid: string } }>("/v1/workspaces/:wid/projects", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    if (!(await isMember(session.user.id, request.params.wid))) return sendError(reply, 404, notFound("workspace"));

    const parsed = CreateProjectInput.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      return badRequest(reply, issue.message, "Fix the highlighted field and try again.");
    }
    try {
      const [row] = await db
        .insert(project)
        .values({
          id: randomUUID(),
          workspaceId: request.params.wid,
          name: parsed.data.name,
          description: parsed.data.description || null,
          sourceType: parsed.data.sourceType,
          githubRepo: parsed.data.githubRepo ?? null,
          createdBy: session.user.id,
        })
        .returning();
      return reply.status(201).send({ project: toProjectSummary(row!, null) });
    } catch (err) {
      const pg = ((err as { cause?: { code?: string; constraint?: string } }).cause ?? err) as {
        code?: string;
        constraint?: string;
      };
      if (pg.code === "23505" && pg.constraint === "project_workspace_repo_idx") {
        const [existing] = await db
          .select({ id: project.id })
          .from(project)
          .where(and(eq(project.workspaceId, request.params.wid), eq(project.githubRepo, parsed.data.githubRepo!)))
          .limit(1);
        return sendError(reply, 409, {
          code: "project_repo_exists",
          message: `${parsed.data.githubRepo} is already a project in this workspace.`,
          fix: `Open it to import a newer commit as a new snapshot.${existing ? ` (project ${existing.id})` : ""}`,
        });
      }
      if (pg.code === "23505") {
        return sendError(reply, 409, {
          code: "project_name_taken",
          message: "A project with this name already exists in this workspace.",
          fix: "Choose a different name, or open the existing project and add a new snapshot to it.",
        });
      }
      throw err;
    }
  });

  app.get<{ Params: { id: string } }>("/v1/projects/:id", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const p = await projectForUser(session.user.id, request.params.id);
    if (!p) return sendError(reply, 404, notFound("project"));
    const snaps = await db
      .select()
      .from(snapshot)
      .where(eq(snapshot.projectId, p.id))
      .orderBy(desc(snapshot.createdAt));
    const detail: ProjectDetail = {
      ...toProjectSummary(p, snaps[0] ?? null),
      snapshots: snaps.map(toSnapshotSummary),
    };
    return { project: detail };
  });

  // ---------- Archive upload -> snapshot ----------

  app.post<{ Params: { id: string } }>("/v1/projects/:id/snapshots/archive", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const p = await projectForUser(session.user.id, request.params.id);
    if (!p) return sendError(reply, 404, notFound("project"));

    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8 || key.length > 200) {
      return badRequest(reply, "Missing Idempotency-Key header.", "Retry from the app; it sends one automatically.");
    }
    if (!request.isMultipart()) {
      return badRequest(reply, "Expected a file upload.", "Upload the archive as multipart form data.");
    }

    const part = await request.file({ limits: { fileSize: INTAKE_LIMITS.maxUploadBytes, files: 1, fields: 4 } });
    if (!part) return badRequest(reply, "No file was uploaded.", "Choose a .zip or .tar.gz file and try again.");
    const attest = (part.fields.attest as { value?: unknown } | undefined)?.value;
    if (attest !== "true") {
      part.file.resume();
      return badRequest(
        reply,
        "Ownership confirmation is required.",
        "Tick \"I own this code or am authorized to assess it\" and upload again.",
        "attestation_required",
      );
    }

    // Stream to a randomly named temp file (the client's file name is never used on disk).
    await mkdir(UPLOAD_DIR, { recursive: true });
    const tempPath = join(UPLOAD_DIR, randomUUID());
    const hash = createHash("sha256");
    let bytes = 0;
    try {
      await pipeline(
        part.file,
        new Transform({
          transform(chunk: Buffer, _e, cb) {
            hash.update(chunk);
            bytes += chunk.length;
            cb(null, chunk);
          },
        }),
        createWriteStream(tempPath),
      );
    } catch (err) {
      await rm(tempPath, { force: true });
      throw err;
    }
    if (part.file.truncated) {
      await rm(tempPath, { force: true });
      return sendError(reply, 413, {
        code: "upload_too_large",
        message: `The file is larger than ${INTAKE_LIMITS.maxUploadBytes / 1024 / 1024} MB.`,
        fix: "Delete node_modules, build output and large media before compressing, then upload again.",
      });
    }

    const route = "snapshots/archive";
    const requestHash = sha256(`${p.id}:${hash.digest("hex")}`);
    const displayName = (part.filename || "upload").replace(/[^\w .()-]/g, "_").slice(-120);

    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(idempotencyKey)
        .where(and(eq(idempotencyKey.userId, session.user.id), eq(idempotencyKey.route, route), eq(idempotencyKey.key, key)))
        .for("update");
      if (existing) {
        return existing.requestHash === requestHash
          ? ({ kind: "replay", response: existing.response } as const)
          : ({ kind: "conflict" } as const);
      }
      const [row] = await tx
        .insert(snapshot)
        .values({
          id: randomUUID(),
          projectId: p.id,
          status: "RECEIVED",
          sourceType: "archive",
          sourceRef: displayName,
          intakePolicyVersion: INTAKE_POLICY_VERSION,
          ownershipAttestedAt: new Date(),
          attestedBy: session.user.id,
        })
        .returning();
      const response = { snapshot: toSnapshotSummary(row!) };
      await tx.insert(idempotencyKey).values({ userId: session.user.id, route, key, requestHash, response });
      return { kind: "created", response, snapshotId: row!.id } as const;
    });

    if (result.kind !== "created") {
      await rm(tempPath, { force: true });
      if (result.kind === "conflict") {
        return sendError(reply, 422, {
          code: "idempotency_key_reused",
          message: "This upload ID was already used for a different file.",
          fix: "Start the upload again from the app.",
        });
      }
      return reply.status(202).send(result.response);
    }

    await emitIntakeEvent(result.snapshotId, "received", { file: displayName, bytes });
    startIntake(result.snapshotId, tempPath);
    return reply.status(202).send(result.response);
  });

  // ---------- Snapshot status, progress and tree ----------

  app.get<{ Params: { id: string } }>("/v1/snapshots/:id", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const s = await snapshotForUser(session.user.id, request.params.id);
    if (!s) return sendError(reply, 404, notFound("snapshot"));
    return { snapshot: toSnapshotSummary(s), events: await listIntakeEvents(s.id) };
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    "/v1/snapshots/:id/events",
    async (request, reply) => {
      const session = await requireSession(request, reply);
      if (!session) return;
      const s = await snapshotForUser(session.user.id, request.params.id);
      if (!s) return sendError(reply, 404, notFound("snapshot"));

      const after = Math.max(0, Number(request.query.after ?? request.headers["last-event-id"] ?? 0) || 0);
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      let closed = false;
      let last = after;
      const send = (e: { seq: number; type: string }) => {
        if (closed || e.seq <= last) return;
        last = e.seq;
        res.write(`id: ${e.seq}\nevent: intake\ndata: ${JSON.stringify(e)}\n\n`);
        if (TERMINAL_EVENTS.has(e.type)) close();
      };
      const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
      const unsubscribe = subscribeIntake(s.id, send);
      function close() {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        res.end();
      }
      request.raw.on("close", close);

      // Replay what happened before the client connected, then stream live events.
      for (const e of await listIntakeEvents(s.id, after)) send(e);
    },
  );

  app.get<{ Params: { id: string } }>("/v1/snapshots/:id/tree", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const s = await snapshotForUser(session.user.id, request.params.id);
    if (!s) return sendError(reply, 404, notFound("snapshot"));
    if (s.status !== "BASELINED" || !s.manifestObjectKey) {
      return sendError(reply, 409, {
        code: "snapshot_not_ready",
        message: "This snapshot has no file list because it isn't baselined.",
        fix: "Wait for processing to finish, or upload again if it was rejected.",
      });
    }
    const manifest = JSON.parse(await text(objectStore.get(s.manifestObjectKey))) as {
      files: Array<{ path: string; size: number }>;
    };
    const tree: FileTreeEntry[] = manifest.files.map((f) => ({ path: f.path, size: f.size }));
    return { tree };
  });
}

