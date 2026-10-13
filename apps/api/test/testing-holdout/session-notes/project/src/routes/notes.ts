import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requireSession } from "../auth.js";
import type { NoteStore } from "../notes.js";

const CreateNoteBody = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(50_000).default(""),
  pinned: z.boolean().default(false),
});

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const NoteParams = z.object({ id: z.coerce.number().int().positive() });

interface NotePatch {
  title: string;
  body?: string;
  pinned?: boolean;
}

export const noteRoutes: FastifyPluginAsync<{ store: NoteStore }> = async (app, { store }) => {
  app.addHook("preHandler", requireSession);

  app.get("/api/notes", async (request) => {
    const { limit, offset } = ListQuery.parse(request.query);
    return store.list(limit, offset);
  });

  app.post("/api/notes", async (request, reply) => {
    const input = CreateNoteBody.parse(request.body);
    return reply.code(201).send(store.create(input));
  });

  app.get("/api/notes/:id", async (request, reply) => {
    const { id } = NoteParams.parse(request.params);
    const note = store.get(id);
    if (!note) return reply.code(404).send({ error: "not_found" });
    return note;
  });

  app.patch("/api/notes/:id", async (request, reply) => {
    const { id } = NoteParams.parse(request.params);
    const existing = store.get(id);
    if (!existing) return reply.code(404).send({ error: "not_found" });

    const patch = request.body as NotePatch;
    const updated = store.update(id, {
      title: patch.title.trim() || existing.title,
      body: patch.body ?? existing.body,
      pinned: patch.pinned ?? existing.pinned,
    });
    return updated;
  });

  app.delete("/api/notes/:id", async (request, reply) => {
    const { id } = NoteParams.parse(request.params);
    if (!store.delete(id)) return reply.code(404).send({ error: "not_found" });
    return reply.code(204).send();
  });
};
