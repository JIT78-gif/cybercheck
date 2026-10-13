import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { NoteStore } from "./notes.js";

const NoteBody = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(20_000).default(""),
  tags: z.array(z.string().trim().toLowerCase().min(1).max(32)).max(10).default([]),
});

const IdParams = z.object({ id: z.string().uuid() });
const ListQuery = z.object({ tag: z.string().trim().toLowerCase().min(1).max(32).optional() });

export function buildApp(store = new NoteStore()): FastifyInstance {
  const app = Fastify({ logger: false });

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

  app.get("/notes", async (request) => {
    const { tag } = ListQuery.parse(request.query);
    return { notes: store.list(tag) };
  });

  app.post("/notes", async (request, reply) => {
    const input = NoteBody.parse(request.body);
    return reply.code(201).send(store.create(input));
  });

  app.get("/notes/:id", async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const note = store.get(id);
    if (!note) return reply.code(404).send({ error: "not_found" });
    return note;
  });

  app.put("/notes/:id", async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const input = NoteBody.parse(request.body);
    const note = store.replace(id, input);
    if (!note) return reply.code(404).send({ error: "not_found" });
    return note;
  });

  app.delete("/notes/:id", async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    if (!store.delete(id)) return reply.code(404).send({ error: "not_found" });
    return reply.code(204).send();
  });

  return app;
}
