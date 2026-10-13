"use strict";

const express = require("express");
const { createTaskRepository } = require("./tasks");
const { validateCreate, validatePatch, parseId, parseListQuery } = require("./validation");

function createApp(pool) {
  const tasks = createTaskRepository(pool);
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));

  // Express 4 does not forward rejected promises to the error handler.
  const route = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

  app.get(
    "/health",
    route(async (req, res) => {
      await pool.query("SELECT 1");
      res.json({ status: "ok" });
    }),
  );

  app.get(
    "/tasks",
    route(async (req, res) => {
      const query = parseListQuery(req.query);
      if (query.errors) return res.status(400).json({ error: "validation_failed", details: query.errors });
      res.json(await tasks.list(query.value));
    }),
  );

  app.post(
    "/tasks",
    route(async (req, res) => {
      const result = validateCreate(req.body);
      if (result.errors) return res.status(400).json({ error: "validation_failed", details: result.errors });
      const task = await tasks.create(result.value);
      res.status(201).location(`/tasks/${task.id}`).json(task);
    }),
  );

  app.get(
    "/tasks/:id",
    route(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ error: "invalid_id" });
      const task = await tasks.get(id);
      if (!task) return res.status(404).json({ error: "not_found" });
      res.json(task);
    }),
  );

  app.patch(
    "/tasks/:id",
    route(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ error: "invalid_id" });
      const result = validatePatch(req.body);
      if (result.errors) return res.status(400).json({ error: "validation_failed", details: result.errors });
      const task = await tasks.update(id, result.value);
      if (!task) return res.status(404).json({ error: "not_found" });
      res.json(task);
    }),
  );

  app.delete(
    "/tasks/:id",
    route(async (req, res) => {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ error: "invalid_id" });
      if (!(await tasks.remove(id))) return res.status(404).json({ error: "not_found" });
      res.status(204).end();
    }),
  );

  app.use((req, res) => res.status(404).json({ error: "not_found" }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode;
    if (status >= 400 && status < 500) {
      return res.status(status).json({ error: err.type === "entity.parse.failed" ? "invalid_json" : "bad_request" });
    }
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}

module.exports = { createApp };
