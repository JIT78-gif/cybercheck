import fastifyCookie from "@fastify/cookie";
import fastifySession from "@fastify/session";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { passwordMatches } from "./auth.js";
import type { Config } from "./config.js";
import { NoteStore } from "./notes.js";
import { noteRoutes } from "./routes/notes.js";

export function buildApp(config: Config, store = new NoteStore()): FastifyInstance {
  const app = Fastify({ logger: true, bodyLimit: 128 * 1024 });

  app.register(fastifyCookie);
  app.register(fastifySession, {
    secret: config.sessionSecret,
    cookieName: "sid",
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: config.secureCookies,
      maxAge: 8 * 60 * 60 * 1000,
      path: "/",
    },
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "validation_failed", issues: error.issues });
    }
    if (typeof error.statusCode === "number" && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: "bad_request", message: error.message });
    }
    request.log.error(error);
    return reply.code(500).send({ error: "internal_error" });
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.post("/login", async (request, reply) => {
    const password = (request.body as { password?: unknown } | undefined)?.password;
    if (!passwordMatches(password, config.dashboardPassword)) {
      return reply.code(401).send({ error: "invalid_password" });
    }
    await request.session.regenerate();
    request.session.set("authenticated", true);
    return { status: "signed_in" };
  });

  app.post("/logout", async (request) => {
    await request.session.destroy();
    return { status: "signed_out" };
  });

  app.register(noteRoutes, { store });

  return app;
}
