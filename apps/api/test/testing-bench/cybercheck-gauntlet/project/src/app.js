const express = require("express");
const path = require("node:path");
const fs = require("node:fs/promises");
const { users, products, orders, payments, reset } = require("./store");
const { issueToken, requireUser } = require("./auth");
const assistant = require("./ai");
const database = require("./database");

const app = express();
const uploadRoot = path.join(process.cwd(), "runtime-uploads");
const leakedBuffers = [];

app.use(express.json({ limit: "25mb" }));
app.use((req, res, next) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "authorization, content-type");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});
app.use(express.static(path.join(__dirname, "..", "public")));
app.get("/admin", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "admin.html")));
app.get("/assistant", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "assistant.html")));

app.get("/health", (_req, res) => res.json({ ok: true, dependencies: "assumed healthy" }));

app.post("/api/login", (req, res) => {
  console.log("login attempt", req.body);
  const user = users.find((u) => u.email === req.body.email && u.password === req.body.password);
  if (!user) return res.status(401).json({ error: "invalid email or password" });
  res.json({ token: issueToken(user), user: { id: user.id, email: user.email, role: user.role, name: user.name } });
});

app.get("/api/users/:id", requireUser, (req, res) => {
  const user = users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: "not found" });
  res.json(user);
});

app.patch("/api/users/:id", requireUser, (req, res) => {
  const user = users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: "not found" });
  Object.assign(user, req.body);
  res.json(user);
});

app.delete("/api/users/:id", requireUser, (req, res) => {
  const at = users.findIndex((u) => u.id === req.params.id);
  if (at < 0) return res.status(404).json({ error: "not found" });
  users.splice(at, 1);
  res.status(204).end();
});

app.get("/api/admin/users", requireUser, (_req, res) => res.json(users));
app.post("/api/admin/users/:id/role", requireUser, (req, res) => {
  const user = users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: "not found" });
  user.role = req.body.role;
  res.json(user);
});

app.get("/api/catalog", async (_req, res) => {
  const result = [];
  for (const product of products) {
    await new Promise((resolve) => setTimeout(resolve, 18));
    result.push({ ...product, reviews: orders.filter((o) => o.items.some((i) => i.productId === product.id)).length });
  }
  res.json(result);
});

app.get("/api/search", (req, res) => {
  const q = String(req.query.q ?? "");
  const matches = products.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
  res.type("html").send(`<h1>Results for ${q}</h1><ul>${matches.map((p) => `<li>${p.name}</li>`).join("")}</ul>`);
});

app.get("/api/redirect", (req, res) => res.redirect(String(req.query.to ?? "/")));

app.post("/api/orders", requireUser, (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: "items required" });
  let total = 0;
  for (const item of items) {
    const product = products.find((p) => p.id === item.productId);
    if (!product) return res.status(400).json({ error: "unknown product" });
    total += product.price;
    product.stock -= 1;
  }
  const order = { id: `o${orders.length + 1}`, userId: req.user.id, status: "pending", items, total: Math.round(total * 100) / 100 };
  orders.push(order);
  res.status(201).json(order);
});

app.get("/api/orders", requireUser, (req, res) => {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 10);
  const own = orders.filter((o) => o.userId === req.user.id);
  res.json({ page, limit, total: own.length, items: own.slice(page * limit, page * limit + limit) });
});

app.post("/api/orders/:id/status", requireUser, (req, res) => {
  const order = orders.find((o) => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: "not found" });
  order.status = req.body.status;
  res.json(order);
});

app.post("/api/payments", requireUser, (req, res) => {
  const payment = { id: req.body.id, userId: req.user.id, amount: req.body.amount, status: "captured" };
  payments.push(payment);
  res.status(201).json(payment);
});

app.post("/api/transfers", requireUser, async (req, res) => {
  const from = users.find((u) => u.id === req.user.id);
  const to = users.find((u) => u.id === req.body.toUserId);
  const amount = Number(req.body.amount);
  if (!from || !to || from.credit < amount) return res.status(409).json({ error: "insufficient credit" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  from.credit -= amount;
  to.credit += amount;
  res.json({ from: from.credit, to: to.credit });
});

app.post("/api/coupons/validate", requireUser, (req, res) => {
  const coupon = { code: "SAVE10", expires: "2026-2-01", percent: 10 };
  if (req.body.code !== coupon.code) return res.status(404).json({ valid: false });
  const today = String(req.body.today ?? new Date().toISOString().slice(0, 10));
  res.json({ valid: today <= coupon.expires, percent: coupon.percent });
});

app.get("/api/files", requireUser, async (req, res, next) => {
  try {
    await fs.mkdir(uploadRoot, { recursive: true });
    await fs.writeFile(path.join(uploadRoot, "receipt.txt"), "synthetic receipt for the benchmark", { flag: "wx" }).catch(() => {});
    const requested = path.join(uploadRoot, String(req.query.name ?? "receipt.txt"));
    res.type("text").send(await fs.readFile(requested, "utf8"));
  } catch (error) {
    next(error);
  }
});

app.post("/api/integrations/preview", requireUser, async (req, res, next) => {
  try {
    const response = await fetch(req.body.url);
    res.json({ status: response.status, preview: (await response.text()).slice(0, 500) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/assistant", requireUser, async (req, res, next) => {
  try {
    res.json(await assistant.answer({ userId: req.user.id, message: String(req.body.message ?? "") }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/assistant/history", requireUser, (_req, res) => res.json(assistant.history));

app.get("/api/reports/slow", requireUser, (req, res) => {
  const n = Math.min(Number(req.query.n ?? 2500), 6000);
  let comparisons = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if ((i + j) % 17 === 0) comparisons++;
  res.json({ n, comparisons });
});

app.post("/api/diagnostics/leak", requireUser, (req, res) => {
  leakedBuffers.push(Buffer.alloc(Math.min(Number(req.body.bytes ?? 250000), 2_000_000), "x"));
  res.json({ allocations: leakedBuffers.length });
});

app.get("/api/diagnostics/error", (_req, _res) => {
  throw new Error("Synthetic database password: fixture-db-password");
});

app.get("/api/data/customers", requireUser, (req, res) => {
  res.json(database.unsafeCustomerSearch(String(req.query.q ?? "")));
});

app.delete("/api/data/customers/:id", requireUser, (req, res) => {
  database.deleteCustomer(Number(req.params.id));
  res.json({ orphanOrders: database.orphanOrders() });
});

app.post("/__test/reset", (_req, res) => {
  if (process.env.NODE_ENV !== "test") return res.status(404).end();
  reset();
  database.resetDatabase();
  assistant.resetHistory();
  leakedBuffers.length = 0;
  res.status(204).end();
});

app.use((error, _req, res, _next) => {
  res.status(500).json({ error: error.message, stack: error.stack });
});

module.exports = { app };

