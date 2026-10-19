const express = require("express");
const path = require("node:path");
const store = require("./store");
const { issueToken, requireUser } = require("./auth");
const agent = require("./agent");
const rag = require("./rag");
const memory = require("./memory");

const app = express();
app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.post("/api/login", (req, res) => {
  const u = store.get().users.find((x) => x.email === req.body.email && x.password === req.body.password);
  if (!u) return res.status(401).json({ error: "invalid email or password" });
  res.json({ token: issueToken(u), user: { id: u.id, tenant: u.tenant, role: u.role, name: u.name } });
});

app.post("/api/assistant", requireUser, async (req, res, next) => {
  try {
    res.json(await agent.handle({ user: req.user, message: String(req.body.message ?? "") }));
  } catch (e) {
    next(e);
  }
});

// Uploaded documents are confined to the caller's own tenant and treated as data.
app.post("/api/documents", requireUser, (req, res) => {
  const doc = rag.addDocument({ id: `d-up-${store.get().documents.length + 1}`, tenant: req.user.tenant, title: String(req.body.title ?? "doc"), body: String(req.body.body ?? "") });
  res.status(201).json(doc);
});

// Returns only the caller's own memory notes.
app.get("/api/assistant/memory", requireUser, (req, res) => res.json({ notes: memory.recall(req.user.id) }));

// Order reads are limited to the caller's own tenant and ownership.
app.get("/api/orders/:id", requireUser, (req, res) => {
  const o = store.get().orders.find((x) => x.id === req.params.id);
  if (!o || o.tenant !== req.user.tenant || o.userId !== req.user.id) return res.status(404).json({ error: "not found" });
  res.json(o);
});

app.post("/api/orders/:id/approve-refund", requireUser, (req, res) => {
  const o = store.get().orders.find((x) => x.id === req.params.id);
  if (!o || o.userId !== req.user.id) return res.status(404).json({ error: "not found" });
  store.get().approvals.push({ orderId: req.params.id, by: req.user.id });
  res.json({ approved: req.params.id });
});

app.post("/api/orders/:id/refund", requireUser, (req, res) => {
  const o = store.get().orders.find((x) => x.id === req.params.id);
  if (!o || o.userId !== req.user.id) return res.status(404).json({ error: "not found" });
  const approved = store.get().approvals.find((a) => a.orderId === o.id && a.by === req.user.id);
  if (!approved) return res.status(403).json({ error: "approval required" });
  o.refunded = true;
  o.status = "refunded";
  res.json({ refunded: o.id });
});

// The admin summary reports only; it never executes instructions found in memory notes.
app.get("/api/admin/summary", requireUser, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "admin only" });
  res.json({ tenants: [...new Set(store.get().users.filter((u) => u.tenant === req.user.tenant).map((u) => u.tenant))], actions: [] });
});

app.post("/api/reset", (_req, res) => {
  store.reset();
  res.json({ ok: true });
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// The error handler never returns a stack or internal details to the client.
// eslint-disable-next-line no-unused-vars
app.use((_err, _req, res, _next) => res.status(500).json({ error: "internal error" }));

module.exports = { app };
