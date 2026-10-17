const express = require("express");
const helmet = require("helmet");
const path = require("node:path");
const { db } = require("./database");
const { hashPassword, verifyPassword, issueToken, requireUser, requireRole } = require("./auth");
const { loginLimiter } = require("./limits");

const app = express();
const allowedOrigins = new Set((process.env.ALLOWED_ORIGINS ?? "http://localhost:5173").split(",").map((o) => o.trim()));
const filesRoot = path.resolve(__dirname, "..", "files");

const isText = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "100kb" }));
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-headers", "authorization, content-type");
    res.setHeader("vary", "Origin");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/api/register", loginLimiter, (req, res) => {
  const { email, password } = req.body ?? {};
  if (!isText(email, 200) || !isText(password, 200) || password.length < 12) return res.status(400).json({ error: "a valid email and a password of at least 12 characters are required" });
  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (exists) return res.status(409).json({ error: "this email is already registered" });
  const result = db.prepare("INSERT INTO users (email, role, password_hash) VALUES (?, 'member', ?)").run(email, hashPassword(password));
  res.status(201).json({ id: Number(result.lastInsertRowid), email, role: "member" });
});

app.post("/api/login", loginLimiter, (req, res) => {
  const { email, password } = req.body ?? {};
  if (!isText(email, 200) || !isText(password, 200)) return res.status(400).json({ error: "email and password are required" });
  const user = db.prepare("SELECT id, email, role, password_hash FROM users WHERE email = ?").get(email);
  if (!user || !verifyPassword(password, user.password_hash)) return res.status(401).json({ error: "invalid email or password" });
  res.json({ token: issueToken(user), user: { id: user.id, email: user.email, role: user.role } });
});

app.get("/api/notes", requireUser, (req, res) => {
  res.json(db.prepare("SELECT id, title, body FROM notes WHERE owner_id = ? ORDER BY id").all(req.user.id));
});

app.get("/api/notes/search", requireUser, (req, res) => {
  const q = req.query.q;
  if (!isText(q, 100)) return res.status(400).json({ error: "q is required" });
  const pattern = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  res.json(db.prepare("SELECT id, title FROM notes WHERE owner_id = ? AND title LIKE ? ESCAPE '\\' ORDER BY id").all(req.user.id, pattern));
});

app.get("/api/notes/:id", requireUser, (req, res) => {
  const note = db.prepare("SELECT id, title, body FROM notes WHERE id = ? AND owner_id = ?").get(Number(req.params.id), req.user.id);
  if (!note) return res.status(404).json({ error: "not found" });
  res.json(note);
});

app.post("/api/notes", requireUser, (req, res) => {
  const { title, body = "" } = req.body ?? {};
  if (!isText(title, 200) || typeof body !== "string" || body.length > 10000) return res.status(400).json({ error: "a title of up to 200 characters is required" });
  const result = db.prepare("INSERT INTO notes (owner_id, title, body) VALUES (?, ?, ?)").run(req.user.id, title, body);
  res.status(201).json({ id: Number(result.lastInsertRowid), title, body });
});

app.patch("/api/notes/:id", requireUser, (req, res) => {
  const note = db.prepare("SELECT id, title, body FROM notes WHERE id = ? AND owner_id = ?").get(Number(req.params.id), req.user.id);
  if (!note) return res.status(404).json({ error: "not found" });
  const title = req.body?.title ?? note.title;
  const body = req.body?.body ?? note.body;
  if (!isText(title, 200) || typeof body !== "string" || body.length > 10000) return res.status(400).json({ error: "invalid title or body" });
  db.prepare("UPDATE notes SET title = ?, body = ? WHERE id = ? AND owner_id = ?").run(title, body, note.id, req.user.id);
  res.json({ id: note.id, title, body });
});

app.delete("/api/notes/:id", requireUser, (req, res) => {
  const result = db.prepare("DELETE FROM notes WHERE id = ? AND owner_id = ?").run(Number(req.params.id), req.user.id);
  if (!result.changes) return res.status(404).json({ error: "not found" });
  res.status(204).end();
});

app.get("/api/files/:name", requireUser, (req, res) => {
  const full = path.resolve(filesRoot, path.basename(req.params.name));
  if (!full.startsWith(filesRoot + path.sep)) return res.status(400).json({ error: "invalid file name" });
  res.sendFile(full, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "not found" });
  });
});

app.get("/api/admin/users", requireUser, requireRole("admin"), (_req, res) => {
  res.json(db.prepare("SELECT id, email, role FROM users ORDER BY id").all());
});

app.use((_req, res) => res.status(404).json({ error: "not found" }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error("request failed:", err.message);
  res.status(500).json({ error: "internal error" });
});

module.exports = { app };
