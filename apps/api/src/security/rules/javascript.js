// Semgrep test fixture for javascript.yml: every rule has a buggy line (ruleid) and a fixed one (ok).
const express = require("express");
const fs = require("node:fs/promises");
const path = require("node:path");
const cp = require("node:child_process");
const crypto = require("node:crypto");
const cors = require("cors");
const app = express();

app.get("/sql", (req, res) => {
  // ruleid: cc.js.sql-injection, cc.js.sql-string-built
  db.query(`SELECT * FROM users WHERE name = '${req.query.name}'`);
  // ok: cc.js.sql-injection
  db.query("SELECT * FROM users WHERE name = $1", [req.query.name]);
});

function search(q) {
  // ruleid: cc.js.sql-string-built
  return db.prepare(`SELECT id FROM customers WHERE email LIKE '%${q}%'`).all();
}
function searchSafe(q) {
  // ok: cc.js.sql-string-built
  return db.prepare("SELECT id FROM customers WHERE email LIKE ?").all(`%${q}%`);
}

app.post("/run", (req, res) => {
  // ruleid: cc.js.command-injection
  cp.exec(`convert ${req.body.file} out.png`);
  // ok: cc.js.command-injection
  cp.execFile("convert", [req.body.file, "out.png"]);
});

app.post("/calc", (req, res) => {
  // ruleid: cc.js.code-injection
  res.json({ value: eval(req.body.expr) });
});

app.get("/search", (req, res) => {
  const q = String(req.query.q ?? "");
  // ruleid: cc.js.xss
  res.type("html").send(`<h1>Results for ${q}</h1>`);
});
app.get("/search-safe", (req, res) => {
  const q = escapeHtml(String(req.query.q ?? ""));
  // ok: cc.js.xss
  res.type("html").send(`<h1>Results for ${q}</h1>`);
});

app.get("/files", async (req, res) => {
  const requested = path.join("/uploads", String(req.query.name));
  // ruleid: cc.js.path-traversal
  const text = await fs.readFile(requested, "utf8");
  res.json({ text });
});
app.get("/files-text", async (req, res) => {
  const requested = path.join("/uploads", String(req.query.name));
  // ruleid: cc.js.path-traversal
  const text = await fs.readFile(requested, "utf8");
  // ok: cc.js.xss
  res.type("text").send(text);
});
app.get("/files-safe", async (req, res) => {
  const requested = path.join("/uploads", path.basename(String(req.query.name)));
  // ok: cc.js.path-traversal
  res.json({ text: await fs.readFile(requested, "utf8") });
});

app.post("/preview", async (req, res) => {
  // ruleid: cc.js.ssrf
  const r = await fetch(req.body.url);
  // ok: cc.js.ssrf
  const s = await fetch("https://api.example.test/status");
  res.json({ a: r.status, b: s.status });
});

app.get("/notes/:id", (req, res) => {
  // ruleid: cc.js.ssrf
  http.get(req.params.id);
  // ok: cc.js.ssrf
  const note = db.prepare("SELECT id, title FROM notes WHERE id = ?").get(req.params.id);
  res.json(note);
});

app.get("/go", (req, res) => {
  // ruleid: cc.js.open-redirect
  res.redirect(String(req.query.to ?? "/"));
});
app.get("/go-safe", (req, res) => {
  // ok: cc.js.open-redirect
  res.redirect("/home");
});

function issueToken(user) {
  // ruleid: cc.js.unsigned-token
  return Buffer.from(JSON.stringify({ id: user.id, role: user.role })).toString("base64url");
}
function readToken(raw) {
  // ruleid: cc.js.unsigned-token
  return JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
}
function decodeText(buf) {
  // ok: cc.js.unsigned-token
  return new TextDecoder().decode(buf);
}
function readSigned(raw) {
  // ok: cc.js.unsigned-token
  return jwt.verify(raw, process.env.JWT_SECRET, { algorithms: ["HS256"] });
}

app.patch("/users/:id", (req, res) => {
  const user = users.find((u) => u.id === req.params.id);
  // ruleid: cc.js.mass-assignment
  Object.assign(user, req.body);
  // ok: cc.js.mass-assignment
  Object.assign(user, { name: req.body.name });
  res.json(user);
});

app.post("/login", (req, res) => {
  // ruleid: cc.js.credentials-in-logs
  console.log("login attempt", req.body);
  // ok: cc.js.credentials-in-logs
  console.log("login attempt for", req.body.email);
});

app.use((error, req, res, next) => {
  // ruleid: cc.js.error-disclosure
  res.status(500).json({ error: error.message, stack: error.stack });
});
app.use((error, req, res, next) => {
  // ok: cc.js.error-disclosure
  res.status(500).json({ error: "internal error" });
});

app.use((req, res, next) => {
  // ruleid: cc.js.cors-any-origin
  res.setHeader("access-control-allow-origin", "*");
  // ok: cc.js.cors-any-origin
  res.setHeader("access-control-allow-origin", "https://app.example.test");
  next();
});
// ruleid: cc.js.cors-any-origin
app.use(cors({ origin: true, credentials: true }));
// ok: cc.js.cors-any-origin
app.use(cors({ origin: ["https://app.example.test"], credentials: true }));

// ruleid: cc.js.weak-crypto
const digest = crypto.createHash("md5").update("x").digest("hex");
// ok: cc.js.weak-crypto
const good = crypto.createHash("sha256").update("x").digest("hex");

// ruleid: cc.js.unsafe-deserialization
const obj = serializer.unserialize(cookieValue);
// ok: cc.js.unsafe-deserialization
const data = JSON.parse(cookieValue);
