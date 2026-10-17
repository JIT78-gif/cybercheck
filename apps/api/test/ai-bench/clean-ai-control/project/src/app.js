const express = require("express");
const helmet = require("helmet");
const path = require("node:path");
const { db } = require("./database");
const { verifyPassword, issueToken, requireUser } = require("./auth");
const { loginLimiter } = require("./limits");
const { seed } = require("./seed");
const assistant = require("./assistant");
const { ModelUnavailable } = require("./model");

seed();

const app = express();
const isText = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/api/login", loginLimiter, (req, res) => {
  const { email, password } = req.body ?? {};
  if (!isText(email, 200) || !isText(password, 200)) return res.status(400).json({ error: "email and password are required" });
  const user = db.prepare("SELECT id, tenant, email, name, password_hash FROM users WHERE email = ?").get(email);
  if (!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({ error: "invalid email or password" });
  res.json({ token: issueToken(user), user: { id: user.id, tenant: user.tenant, email: user.email, name: user.name } });
});

app.get("/api/orders", requireUser, (req, res) => {
  res.json(db.prepare("SELECT id, status, total FROM orders WHERE owner_id = ? ORDER BY id").all(req.user.id));
});

app.post("/api/assistant", requireUser, async (req, res, next) => {
  const { message, conversationId } = req.body ?? {};
  if (!isText(message, 2000)) return res.status(400).json({ error: "message must be 1 to 2000 characters" });
  if (conversationId !== undefined && conversationId !== null && !Number.isInteger(conversationId)) return res.status(400).json({ error: "conversationId must be an integer" });
  try {
    const out = await assistant.answer(req.user, message, conversationId);
    res.status(out.status).json(out.body);
  } catch (error) {
    if (error instanceof ModelUnavailable) return res.status(error.reason === "not_configured" ? 503 : 502).json({ error: "the assistant is unavailable right now" });
    next(error);
  }
});

app.post("/api/assistant/approvals/:id/confirm", requireUser, (req, res) => {
  const out = assistant.confirmApproval(req.user, Number(req.params.id));
  res.status(out.status).json(out.body);
});

app.get("/api/assistant/history", requireUser, (req, res) => {
  res.json(assistant.history(req.user));
});

app.use((_req, res) => res.status(404).json({ error: "not found" }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error("request failed:", err.message);
  res.status(500).json({ error: "internal error" });
});

module.exports = { app };
