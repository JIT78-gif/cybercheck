const express = require("express");
const store = require("./store");
const { issueToken, requireUser, requireAdmin } = require("./auth");

// The hardened hotel management API: every route the vulnerable twin planted a weakness in is fixed here. A security
// control is only credited when the full attack and its oracle ran against this app and the defence held.
const app = express();
app.use(express.json({ limit: "2mb" }));

// A small fixed-window rate limiter for the endpoints an attacker would hammer (sign-in, heavy report).
const hits = new Map();
function limit(key, max, windowMs, req, res) {
  const id = `${key}:${req.ip}`;
  const now = Date.now();
  const rec = hits.get(id) ?? { n: 0, until: now + windowMs };
  if (now > rec.until) { rec.n = 0; rec.until = now + windowMs; }
  rec.n += 1;
  hits.set(id, rec);
  if (rec.n > max) { res.status(429).json({ error: "too many requests, slow down" }); return false; }
  return true;
}

// Sign in. HARDENED: repeated attempts from one source are throttled.
app.post("/api/login", (req, res) => {
  if (!limit("login", 5, 60_000, req, res)) return;
  const u = store.get().users.find((x) => x.email === req.body.email && x.password === req.body.password);
  if (!u) return res.status(401).json({ error: "invalid email or password" });
  res.json({ token: issueToken(u), user: { id: u.id, hotel: u.hotel, role: u.role, name: u.name } });
});

const ownsOrSameHotel = (user, booking) => booking.guestId === user.id || (user.role === "admin" && booking.hotel === user.hotel);

// List bookings. HARDENED: scoped to the caller (their own, or their hotel for an admin).
app.get("/api/bookings", requireUser, (req, res) => res.json(store.get().bookings.filter((b) => ownsOrSameHotel(req.user, b))));

// Read one booking. HARDENED: ownership and hotel are enforced, so a guest cannot read another party's booking.
app.get("/api/bookings/:id", requireUser, (req, res) => {
  const b = store.get().bookings.find((x) => x.id === req.params.id);
  if (!b || !ownsOrSameHotel(req.user, b)) return res.status(403).json({ error: "forbidden" });
  res.json(b);
});

// Update a booking. HARDENED: only an explicit allow-list of fields is bound; privileged fields are ignored.
app.patch("/api/bookings/:id", requireUser, (req, res) => {
  const b = store.get().bookings.find((x) => x.id === req.params.id);
  if (!b || !ownsOrSameHotel(req.user, b)) return res.status(403).json({ error: "forbidden" });
  for (const k of ["room", "nights"]) if (req.body[k] !== undefined) b[k] = req.body[k];
  res.json(b);
});

// Administrator overview. HARDENED: administrators only.
app.get("/api/admin/overview", requireAdmin, (_req, res) => res.json({ bookings: store.get().bookings.length, revenue: store.get().bookings.reduce((n, b) => n + b.amount, 0), users: store.get().users.length }));

// Change a protected hotel setting. HARDENED: administrators only.
app.post("/api/admin/settings", requireAdmin, (req, res) => {
  for (const k of ["checkoutHour", "currency"]) if (req.body[k] !== undefined) store.get().settings[k] = req.body[k];
  res.json(store.get().settings);
});

// Take a payment. HARDENED: the amount is validated, and a replayed idempotency key is rejected so the same payment is
// never captured twice.
const paymentKeys = new Set();
app.post("/api/payments", requireUser, (req, res) => {
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000) return res.status(400).json({ error: "invalid amount" });
  const key = req.body.idempotencyKey;
  if (key && paymentKeys.has(key)) return res.status(409).json({ error: "duplicate payment" });
  if (key) paymentKeys.add(key);
  res.status(201).json({ id: `pay-${Date.now()}`, bookingId: req.body.bookingId ?? null, amount, status: "captured" });
});

// Refund a booking. HARDENED: idempotent and state-checked, so a replay or a concurrent burst cannot refund twice.
const refundKeys = new Set();
app.post("/api/bookings/:id/refund", requireUser, (req, res) => {
  const b = store.get().bookings.find((x) => x.id === req.params.id);
  if (!b || !ownsOrSameHotel(req.user, b)) return res.status(403).json({ error: "forbidden" });
  const key = req.body.idempotencyKey;
  if (key && refundKeys.has(key)) return res.status(409).json({ error: "duplicate request" });
  if (b.status === "refunded") return res.status(409).json({ error: "already refunded" });
  if (key) refundKeys.add(key);
  b.status = "refunded";
  res.json({ bookingId: b.id, refunded: b.amount, idempotencyKey: key ?? null });
});

// Search rooms. HARDENED: the query is a literal substring match, so a boolean clause changes nothing.
app.get("/api/rooms/search", requireUser, (req, res) => {
  const q = String(req.query.q ?? "").toLowerCase();
  res.json(store.get().rooms.filter((r) => r.kind.toLowerCase().includes(q)));
});

// A heavy revenue report. HARDENED: bounded by the rate limiter.
app.get("/api/reports/revenue", requireUser, (req, res) => {
  if (!limit("report", 10, 60_000, req, res)) return;
  const rows = store.get().bookings.map((b) => ({ booking: b.id, amount: b.amount, nights: b.nights }));
  res.json({ rows, total: rows.reduce((n, r) => n + r.amount, 0), generatedAt: Date.now() });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

module.exports = app;
