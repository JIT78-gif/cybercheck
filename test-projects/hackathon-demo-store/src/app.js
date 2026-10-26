const express = require("express");
const store = require("./store");
const { tokenFor, requireUser } = require("./auth");
const { checkoutQuote } = require("./pricing");
const { askAssistant, assistantMemory } = require("./assistant");

// INTENTIONALLY FLAWED. Synthetic data only. Run on loopback or in Cybercheck's sandbox.
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok", demo: true }));

app.post("/api/login", (req, res) => {
  const user = store.users.find((candidate) => candidate.email === req.body.email && candidate.password === req.body.password);
  if (!user) return res.status(401).json({ error: "email or password is incorrect" });
  res.json({ token: tokenFor(user), user: { id: user.id, name: user.name, tenant: user.tenant } });
});

app.post("/api/checkout/quote", requireUser, (req, res) => {
  res.json(checkoutQuote(Number(req.body.subtotal), req.body.couponCode));
});

app.get("/api/orders/:id", requireUser, (req, res) => {
  const order = store.orders.find((candidate) => candidate.id === req.params.id);
  if (!order) return res.status(404).json({ error: "order not found" });

  // DELIBERATE SECURITY DEFECT: no ownership or tenant check (IDOR).
  res.json(order);
});

app.post("/api/assistant", requireUser, (req, res) => {
  res.json(askAssistant({ message: req.body.message, user: req.user }));
});

app.get("/api/assistant/memory", requireUser, (_req, res) => {
  res.json(assistantMemory());
});

module.exports = app;
