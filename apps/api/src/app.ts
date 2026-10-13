import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { fromNodeHeaders } from "better-auth/node";
import { eq } from "drizzle-orm";
import { requireSession } from "./access.ts";
import { auth } from "./auth/auth.ts";
import { db, pool } from "./db/client.ts";
import { workspace, workspaceMember } from "./db/schema.ts";
import { env, providers } from "./env.ts";
import { githubRoutes } from "./routes/github.ts";
import { projectRoutes } from "./routes/projects.ts";
import { testingRoutes } from "./routes/testing.ts";
import { testingReviewRoutes } from "./routes/testing-review.ts";
import { understandingRoutes } from "./routes/understanding.ts";

export async function buildApp() {
  const app = Fastify({
    logger: { level: env.NODE_ENV === "production" ? "info" : "warn" },
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });
  await app.register(multipart);

  // ---------- Better Auth: forward /api/auth/* as a Fetch Request ----------
  async function authHandler(request: FastifyRequest, reply: FastifyReply) {
    const url = new URL(request.url, env.BETTER_AUTH_URL);
    const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.body != null;
    const response = await auth.handler(
      new Request(url, {
        method: request.method,
        headers: fromNodeHeaders(request.headers),
        body: hasBody ? JSON.stringify(request.body) : undefined,
      }),
    );
    reply.status(response.status);
    response.headers.forEach((value, key) => {
      if (key.toLowerCase() !== "set-cookie") reply.header(key, value);
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) reply.header("set-cookie", cookies);
    return reply.send(response.body ? await response.text() : null);
  }
  app.route({ method: ["GET", "POST"], url: "/api/auth/*", handler: authHandler });

  // ---------- Basics ----------
  app.get("/v1/health", async () => {
    await pool.query("select 1");
    return { ok: true };
  });

  app.get("/v1/auth/providers", async () => ({
    google: providers.google,
    github: providers.github,
    githubApp: providers.githubApp,
    emailDelivery: providers.smtp ? "smtp" : "console",
  }));

  app.get("/v1/me", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const workspaces = await db
      .select({ id: workspace.id, name: workspace.name, personal: workspace.personal, role: workspaceMember.role })
      .from(workspaceMember)
      .innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
      .where(eq(workspaceMember.userId, session.user.id));
    return {
      user: {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        image: session.user.image ?? null,
        emailVerified: session.user.emailVerified,
      },
      workspaces,
    };
  });

  await app.register(projectRoutes);
  await app.register(githubRoutes);
  await app.register(understandingRoutes);
  await app.register(testingRoutes);
  await app.register(testingReviewRoutes);
  return app;
}
