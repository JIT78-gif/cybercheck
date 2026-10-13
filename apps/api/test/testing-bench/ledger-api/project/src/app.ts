import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { bearerAuth } from "./auth.js";
import { openDb } from "./db.js";
import { DomainError } from "./errors.js";
import { accountRoutes } from "./routes/accounts.js";
import { healthRoutes } from "./routes/health.js";
import { invoiceRoutes } from "./routes/invoices.js";
import { transferRoutes } from "./routes/transfers.js";

export interface BuildAppOptions {
  adminToken: string;
  dbPath?: string;
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 64 * 1024 });
  const db = openDb(options.dbPath ?? ":memory:");

  app.addHook("onClose", async () => {
    db.close();
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "validation_failed", issues: error.issues });
    }
    if (error instanceof DomainError) {
      return reply.code(error.statusCode).send({ error: error.code, message: error.message });
    }
    if (typeof error.statusCode === "number" && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: "bad_request", message: error.message });
    }
    request.log.error({ err: error }, "unhandled error");
    return reply.code(500).send({ error: "internal_error" });
  });

  app.register(healthRoutes);
  app.register(async (secured) => {
    secured.addHook("onRequest", bearerAuth(options.adminToken));
    await secured.register(accountRoutes, { db });
    await secured.register(transferRoutes, { db });
    await secured.register(invoiceRoutes, { db });
  });

  return app;
}
