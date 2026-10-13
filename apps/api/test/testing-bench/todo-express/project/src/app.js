"use strict";

const express = require("express");
const { TodoStore } = require("./store");
const { validateCreate, validatePatch, parseId, parseListQuery } = require("./validation");

function createApp({ store = new TodoStore() } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "16kb" }));

  app.get("/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/todos", (req, res) => {
    const query = parseListQuery(req.query);
    if (!query.ok) return res.status(400).json({ error: "validation_failed", details: query.errors });
    res.json(store.list(query.value));
  });

  app.post("/todos", (req, res) => {
    const result = validateCreate(req.body);
    if (!result.ok) return res.status(400).json({ error: "validation_failed", details: result.errors });
    const todo = store.create(result.value);
    res.status(201).location(`/todos/${todo.id}`).json(todo);
  });

  app.get("/todos/:id", (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: "invalid_id" });
    const todo = store.get(id);
    if (!todo) return res.status(404).json({ error: "not_found" });
    res.json(todo);
  });

  app.patch("/todos/:id", (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: "invalid_id" });
    const result = validatePatch(req.body);
    if (!result.ok) return res.status(400).json({ error: "validation_failed", details: result.errors });
    const todo = store.update(id, result.value);
    if (!todo) return res.status(404).json({ error: "not_found" });
    res.json(todo);
  });

  app.delete("/todos/:id", (req, res) => {
    const id = parseId(req.params.id);
    if (id === null) return res.status(400).json({ error: "invalid_id" });
    if (!store.remove(id)) return res.status(404).json({ error: "not_found" });
    res.status(204).end();
  });

  app.use((req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 400 && status < 500) {
      const error = err.type === "entity.parse.failed" ? "invalid_json" : err.type === "entity.too.large" ? "payload_too_large" : "bad_request";
      return res.status(status).json({ error });
    }
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}

module.exports = { createApp };
