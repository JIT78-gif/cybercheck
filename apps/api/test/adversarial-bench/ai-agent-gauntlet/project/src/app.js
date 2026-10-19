const express = require("express");
const path = require("node:path");
const store = require("./store");
const { issueToken, requireUser } = require("./auth");
const agent = require("./agent");
const rag = require("./rag");
const memory = require("./memory");
const { TOOLS } = require("./tools");

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

// Upload a synthetic knowledge-base document. DELIBERATE: no sanitization and the caller may set any tenant, so an
// uploaded document becomes an indirect-injection payload and can be planted into another tenant's knowledge base.
app.post("/api/documents", requireUser, (req, res) => {
  const doc = rag.addDocument({ id: `d-up-${store.get().documents.length + 1}`, tenant: String(req.body.tenant ?? req.user.tenant), title: String(req.body.title ?? "doc"), body: String(req.body.body ?? "") });
  res.status(201).json(doc);
});

// DELIBERATE (cross-tenant-memory-leak surfaced over HTTP): returns every user's memory notes.
app.get("/api/assistant/memory", requireUser, (req, res) => res.json({ notes: memory.recall(req.user.id) }));

// DELIBERATE: no owner/tenant check, so any signed-in user reads any order (cross-tenant order read).
app.get("/api/orders/:id", requireUser, (req, res) => {
  const o = store.get().orders.find((x) => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: "not found" });
  res.json(o);
});

// The intended, safe refund gate: it requires a recorded approval by the caller. The assistant's tool path bypasses it.
app.post("/api/orders/:id/refund", requireUser, (req, res) => {
  const o = store.get().orders.find((x) => x.id === req.params.id);
  if (!o) return res.status(404).json({ error: "not found" });
  const approved = store.get().approvals.find((a) => a.orderId === o.id && a.by === req.user.id);
  if (!approved) return res.status(403).json({ error: "approval required" });
  o.refunded = true;
  o.status = "refunded";
  res.json({ refunded: o.id });
});

app.post("/api/orders/:id/approve-refund", requireUser, (req, res) => {
  store.get().approvals.push({ orderId: req.params.id, by: req.user.id });
  res.json({ approved: req.params.id });
});

// DELIBERATE (memory-poison-to-privileged-action): the admin summary reads every memory note (recall ignores the
// caller) and executes any "refund <ORDER>" instruction it finds, so a note planted by an ordinary user causes a
// privileged refund during a later admin session.
app.get("/api/admin/summary", requireUser, (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "admin only" });
  const actions = [];
  for (const note of memory.recall(req.user.id)) {
    const m = String(note).match(/refund\s+([A-Z0-9-]+)/i);
    if (m) actions.push(TOOLS.issue_refund.run({ orderId: m[1] }));
  }
  res.json({ tenants: [...new Set(store.get().users.map((u) => u.tenant))], actions });
});

// State reset for the harness between mutating campaigns.
app.post("/api/reset", (_req, res) => {
  store.reset();
  res.json({ ok: true });
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// DELIBERATE (internal error and configuration disclosure): the error handler returns the stack to the client.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => res.status(500).json({ error: String(err && err.message), stack: err && err.stack }));

module.exports = { app };
