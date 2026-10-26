const express = require("express");
const store = require("./store");
const { issueToken, requireUser } = require("./auth");

// A deliberately vulnerable hotel management API. Each route below carries a planted weakness the general attacker is
// expected to confirm. The matched clean control (hotel-management-fixed) hardens every one of them.
const app = express();
app.use(express.json({ limit: "2mb" }));

// Sign in. DELIBERATE: no rate limiting or lockout, so repeated guesses are never throttled (login-throttling).
app.post("/api/login", (req, res) => {
  const u = store.get().users.find((x) => x.email === req.body.email && x.password === req.body.password);
  if (!u) return res.status(401).json({ error: "invalid email or password" });
  res.json({ token: issueToken(u), user: { id: u.id, hotel: u.hotel, role: u.role, name: u.name } });
});

// List bookings. DELIBERATE: returns every hotel's bookings, so it leaks ids an attacker can then read directly.
app.get("/api/bookings", requireUser, (_req, res) => res.json(store.get().bookings));

// Read one booking. DELIBERATE: no ownership or hotel check, so any signed-in guest reads anyone's booking (IDOR).
app.get("/api/bookings/:id", requireUser, (req, res) => {
  const b = store.get().bookings.find((x) => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: "not found" });
  res.json(b);
});

// Update a booking. DELIBERATE: merges the whole body, so a guest can set privileged fields like role (mass assignment).
app.patch("/api/bookings/:id", requireUser, (req, res) => {
  const b = store.get().bookings.find((x) => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: "not found" });
  Object.assign(b, req.body);
  res.json(b);
});

// Administrator overview. DELIBERATE: no role check, so an ordinary guest reaches an administrator-only function.
app.get("/api/admin/overview", requireUser, (_req, res) => res.json({ bookings: store.get().bookings.length, revenue: store.get().bookings.reduce((n, b) => n + b.amount, 0), users: store.get().users.length }));

// Change a protected hotel setting. DELIBERATE: no role check (used as the capstone of a privilege-escalation chain).
app.post("/api/admin/settings", requireUser, (req, res) => {
  Object.assign(store.get().settings, req.body);
  res.json(store.get().settings);
});

// Take a payment. DELIBERATE: no validation, so a negative or oversized amount is accepted (business-logic abuse).
app.post("/api/payments", requireUser, (req, res) => {
  const amount = Number(req.body.amount);
  const payment = { id: `pay-${Date.now()}`, bookingId: req.body.bookingId ?? null, amount, status: "captured" };
  res.status(201).json(payment);
});

// Refund a booking. DELIBERATE: no idempotency and no state check, so it can be replayed to refund repeatedly (race /
// duplicate consequential action).
app.post("/api/bookings/:id/refund", requireUser, (req, res) => {
  const b = store.get().bookings.find((x) => x.id === req.params.id);
  if (!b) return res.status(404).json({ error: "not found" });
  b.status = "refunded";
  res.json({ bookingId: b.id, refunded: b.amount, idempotencyKey: req.body.idempotencyKey ?? null });
});

// Search rooms. DELIBERATE: the query is interpreted as a boolean clause, so a true clause returns every room and a
// false clause returns none (classic boolean injection differential).
app.get("/api/rooms/search", requireUser, (req, res) => {
  const q = String(req.query.q ?? "");
  if (/'1'\s*=\s*'1/.test(q) || /\bor\b/i.test(q)) return res.json(store.get().rooms);
  if (/'1'\s*=\s*'2/.test(q) || /\band\b/i.test(q)) return res.json([]);
  res.json(store.get().rooms.filter((r) => r.kind.includes(q.toLowerCase())));
});

// A heavy revenue report any guest can call. DELIBERATE: no limit, so it can be hammered (resource abuse).
app.get("/api/reports/revenue", requireUser, (_req, res) => {
  const rows = store.get().bookings.map((b) => ({ booking: b.id, amount: b.amount, nights: b.nights }));
  res.json({ rows, total: rows.reduce((n, r) => n + r.amount, 0), generatedAt: Date.now() });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

module.exports = app;
