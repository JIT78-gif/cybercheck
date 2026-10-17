const crypto = require("node:crypto");
const { exec } = require("node:child_process");
const express = require("express");

// Deliberately vulnerable benchmark. All identities and secrets are synthetic.
const users = [
  { id: "u1", email: "alice@example.test", password: "AlicePass123!", role: "member", displayName: "Alice" },
  { id: "u2", email: "bob@example.test", password: "BobPass123!", role: "member", displayName: "Bob" },
  { id: "u3", email: "admin@example.test", password: "AdminPass123!", role: "admin", displayName: "Admin" },
];
const sessions = new Map();
const uploads = new Map();
const webhookEvents = [];
const SYNTHETIC_SERVICE_TOKEN = "ghp_000000000000000000000000000000000000";

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => part.trim().split("=")).filter((pair) => pair.length === 2));
}

// Looks like session middleware so Analyze can model cookie authentication. It deliberately accepts
// a caller-chosen id, enabling session fixation, and the login route does not rotate it.
function session(_options) {
  return (req, _res, next) => {
    const cookieId = parseCookies(req.get("cookie")).sid;
    const bearerId = req.get("authorization")?.replace(/^Bearer\s+/i, "");
    const sid = cookieId || bearerId || req.get("x-session-id") || null;
    req.session = {
      id: sid,
      userId: sid ? sessions.get(sid) ?? null : null,
      set user(value) {
        if (sid) sessions.set(sid, value);
      },
      get user() {
        return sid ? sessions.get(sid) : null;
      },
    };
    next();
  };
}

function requireUser(req, res, next) {
  const user = users.find((item) => item.id === req.session.userId);
  if (!user) return res.status(401).json({ error: "sign in required" });
  req.user = user;
  next();
}

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(session({ cookie: { httpOnly: false, secure: false, sameSite: "none" } }));
app.use((req, res, next) => {
  // Deliberately reflects every origin while allowing credentials.
  if (req.get("origin")) res.setHeader("access-control-allow-origin", req.get("origin"));
  res.setHeader("access-control-allow-credentials", "true");
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/api/login", (req, res) => {
  const account = users.find((item) => item.email === req.body.email);
  // Deliberate account enumeration: the responses differ for an unknown account and a bad password.
  if (!account) return res.status(404).json({ error: "account does not exist" });
  if (account.password !== req.body.password) return res.status(401).json({ error: "password is incorrect" });
  const sid = req.get("x-session-id") || crypto.randomBytes(12).toString("hex");
  sessions.set(sid, account.id);
  // Deliberately missing HttpOnly, Secure and SameSite protection.
  res.setHeader("set-cookie", `sid=${sid}; Path=/`);
  res.json({ token: sid, id: account.id, user: { id: account.id, role: account.role } });
});

app.post("/api/logout", requireUser, (_req, res) => {
  // Deliberately does not delete the session, so the token can be replayed after logout.
  res.status(204).end();
});

app.get("/api/me", requireUser, (req, res) => {
  res.json({ id: req.user.id, email: req.user.email, role: req.user.role, displayName: req.user.displayName });
});

app.post("/api/profile/email", requireUser, (req, res) => {
  // Deliberately no CSRF token or Origin check for this cookie-authenticated mutation.
  req.user.email = String(req.body.email ?? req.user.email);
  res.json({ id: req.user.id, email: req.user.email });
});

app.get("/api/password-digest", requireUser, (req, res) => {
  // Deliberately weak and fast password hashing.
  res.json({ digest: crypto.createHash("md5").update(req.user.password).digest("hex") });
});

app.get("/api/tools/format", requireUser, (req, res, next) => {
  const label = String(req.query.label ?? "edge-lab");
  // Deliberate command injection. The benchmark runner must never invent or execute a shell payload.
  exec(`printf '%s' ${label}`, (error, stdout) => {
    if (error) return next(error);
    res.type("text/plain").send(stdout);
  });
});

app.post("/api/rules/evaluate", requireUser, (req, res) => {
  // Deliberate code injection from request input.
  const result = eval(String(req.body.expression ?? "false")); // eslint-disable-line no-eval
  res.json({ result });
});

app.post("/api/webhooks/billing", (req, res) => {
  // Deliberately accepts no signature and no replay/idempotency key.
  webhookEvents.push({ id: req.body.id, amount: req.body.amount });
  res.status(202).json({ accepted: true, count: webhookEvents.length });
});

app.post("/api/uploads", requireUser, (req, res) => {
  // Deliberately trusts the uploader's filename and active content type with no allow-list.
  const id = String(uploads.size + 1);
  uploads.set(id, { name: req.body.name, contentType: req.body.contentType, content: String(req.body.content ?? "") });
  res.status(201).json({ id, download: `/api/uploads/${id}` });
});

app.get("/api/uploads/:id", requireUser, (req, res) => {
  const file = uploads.get(req.params.id);
  if (!file) return res.status(404).json({ error: "not found" });
  res.setHeader("content-type", file.contentType);
  res.setHeader("content-disposition", `inline; filename="${file.name}"`);
  res.send(file.content);
});

app.get("/api/internal/config", requireUser, (_req, res) => {
  res.json({ serviceToken: SYNTHETIC_SERVICE_TOKEN });
});

app.use((error, _req, res, _next) => {
  res.status(500).json({ error: error.message });
});

function reset() {
  sessions.clear();
  uploads.clear();
  webhookEvents.length = 0;
  users[0].email = "alice@example.test";
}

module.exports = { app, reset };
