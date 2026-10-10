import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, FastifyReply } from "fastify";
import { and, eq, inArray } from "drizzle-orm";
import { GithubRepoName, GithubSnapshotInput, INTAKE_LIMITS, type GithubRepo, type GithubStatus } from "@cybercheck/contracts";
import { isMember, notFound, projectForUser, requireSession, sendError, toSnapshotSummary } from "../access.ts";
import { db } from "../db/client.ts";
import { idempotencyKey, project, snapshot } from "../db/schema.ts";
import { env, providers } from "../env.ts";
import {
  GithubError,
  downloadTarball,
  gh,
  githubAccountFor,
  githubTokenFor,
  listBranches,
  listInstallationRepos,
  listInstallations,
  resolveCommit,
} from "../github/client.ts";
import { emitIntakeEvent } from "../intake/events.ts";
import { startIntake } from "../intake/pipeline.ts";
import { INTAKE_POLICY_VERSION } from "../intake/policy.ts";

const UPLOAD_DIR = fileURLToPath(new URL("../../../../.data/uploads", import.meta.url));
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function sendGithubError(reply: FastifyReply, err: unknown) {
  if (err instanceof GithubError) return sendError(reply, err.status, err.body);
  throw err;
}

const notConfigured = {
  code: "github_not_configured",
  message: "GitHub import isn't set up on this server yet.",
  fix: "Add the GitHub App's GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and GITHUB_APP_SLUG to .env.",
};

export async function githubRoutes(app: FastifyInstance) {
  app.get("/v1/github/status", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const status: GithubStatus = {
      configured: providers.githubApp,
      installUrl: env.GITHUB_APP_SLUG ? `https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new` : null,
      connected: false,
      authorized: false,
      login: null,
      avatarUrl: null,
      installations: [],
    };
    if (!(await githubAccountFor(session.user.id))) return status;
    status.connected = true;
    if (!providers.githubApp) return status;

    try {
      const token = await githubTokenFor(session.user.id);
      const me = await gh<{ login: string; avatar_url: string }>(token, "/user").catch(() => null);
      status.login = me?.login ?? null;
      status.avatarUrl = me?.avatar_url ?? null;
      status.installations = await listInstallations(token);
      status.authorized = true;
    } catch (err) {
      if (!(err instanceof GithubError)) throw err;
      if (err.transient) return sendGithubError(reply, err);
      // reconnect needed: report connected-but-not-authorized so the UI offers "Reconnect"
    }
    return status;
  });

  app.get<{ Params: { iid: string }; Querystring: { workspace?: string; q?: string; refresh?: string } }>(
    "/v1/github/installations/:iid/repos",
    async (request, reply) => {
      const session = await requireSession(request, reply);
      if (!session) return;
      if (!providers.githubApp) return sendError(reply, 409, notConfigured);
      const iid = Number(request.params.iid);
      const wid = request.query.workspace ?? "";
      if (!Number.isInteger(iid) || iid <= 0) return sendError(reply, 404, notFound("installation"));
      if (!(await isMember(session.user.id, wid))) return sendError(reply, 404, notFound("workspace"));

      try {
        const token = await githubTokenFor(session.user.id);
        // Never trust an installation ID from the client: it must be one GitHub says this user can access.
        const mine = await listInstallations(token);
        if (!mine.some((i) => i.id === iid)) return sendError(reply, 404, notFound("installation"));

        const all = await listInstallationRepos(token, session.user.id, iid, request.query.refresh === "1");
        const q = (request.query.q ?? "").trim().toLowerCase().slice(0, 100);
        const filtered = q ? all.filter((r) => r.fullName.toLowerCase().includes(q)) : all;
        const shown = filtered.slice(0, 100);

        const imported = shown.length
          ? await db
              .select({ id: project.id, repo: project.githubRepo })
              .from(project)
              .where(and(eq(project.workspaceId, wid), inArray(project.githubRepo, shown.map((r) => r.fullName))))
          : [];
        const byRepo = new Map(imported.map((p) => [p.repo, p.id]));
        const repos: GithubRepo[] = shown.map((r) => ({ ...r, importedProjectId: byRepo.get(r.fullName) ?? null }));
        return { repos, total: filtered.length };
      } catch (err) {
        return sendGithubError(reply, err);
      }
    },
  );

  app.get<{ Params: { owner: string; repo: string } }>("/v1/github/repos/:owner/:repo/branches", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    if (!providers.githubApp) return sendError(reply, 409, notConfigured);
    const parsed = GithubRepoName.safeParse(`${request.params.owner}/${request.params.repo}`);
    if (!parsed.success) return sendError(reply, 400, { code: "invalid_request", message: "Invalid repository name.", fix: "Pick the repository from the list." });
    try {
      const token = await githubTokenFor(session.user.id);
      return { branches: await listBranches(token, parsed.data) };
    } catch (err) {
      return sendGithubError(reply, err);
    }
  });

  // ---------- Import: GitHub repository at an exact commit -> snapshot ----------

  app.post<{ Params: { id: string } }>("/v1/projects/:id/snapshots/github", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    if (!providers.githubApp) return sendError(reply, 409, notConfigured);
    const p = await projectForUser(session.user.id, request.params.id);
    if (!p) return sendError(reply, 404, notFound("project"));

    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8 || key.length > 200) {
      return sendError(reply, 400, { code: "invalid_request", message: "Missing Idempotency-Key header.", fix: "Retry from the app; it sends one automatically." });
    }
    const parsed = GithubSnapshotInput.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!;
      const code = issue.path[0] === "attest" ? "attestation_required" : "invalid_request";
      return sendError(reply, 400, { code, message: issue.message, fix: "Fix the highlighted field and try again." });
    }
    const { repo, ref } = parsed.data;
    if (p.sourceType !== "github" || p.githubRepo?.toLowerCase() !== repo.toLowerCase()) {
      return sendError(reply, 400, {
        code: "repo_mismatch",
        message: "This project is linked to a different source.",
        fix: "Import this repository as its own project.",
      });
    }

    let token: string;
    try {
      token = await githubTokenFor(session.user.id);
    } catch (err) {
      return sendGithubError(reply, err);
    }

    const route = "snapshots/github";
    const requestHash = sha256(`${p.id}:${repo}:${ref}`);
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
          sourceType: "github",
          sourceRef: ref,
          intakePolicyVersion: INTAKE_POLICY_VERSION,
          ownershipAttestedAt: new Date(),
          attestedBy: session.user.id,
        })
        .returning();
      const response = { snapshot: toSnapshotSummary(row!) };
      await tx.insert(idempotencyKey).values({ userId: session.user.id, route, key, requestHash, response });
      return { kind: "created", response, snapshotId: row!.id } as const;
    });

    if (result.kind === "conflict") {
      return sendError(reply, 422, {
        code: "idempotency_key_reused",
        message: "This import ID was already used for a different repository or branch.",
        fix: "Start the import again from the app.",
      });
    }
    if (result.kind === "replay") return reply.status(202).send(result.response);

    const snapshotId = result.snapshotId;
    await emitIntakeEvent(snapshotId, "received", { repo, ref });
    // The token lives only in this closure for the duration of the job.
    startIntake(
      snapshotId,
      async () => {
        await emitIntakeEvent(snapshotId, "resolving", { ref });
        const sha = await resolveCommit(token, repo, ref);
        await db.update(snapshot).set({ resolvedRevision: sha }).where(eq(snapshot.id, snapshotId));
        await emitIntakeEvent(snapshotId, "downloading", { sha });
        await mkdir(UPLOAD_DIR, { recursive: true });
        const dest = join(UPLOAD_DIR, randomUUID());
        await downloadTarball(token, repo, sha, dest, INTAKE_LIMITS.maxUploadBytes);
        return dest;
      },
      { stripTopLevel: true },
    );
    return reply.status(202).send(result.response);
  });
}
