import crypto from "node:crypto";
import express from "express";
import { migrate, pool } from "./db.js";
import { hash } from "./hash.js";
import { cartTotal, validQuantity } from "./pricing.js";

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.FRONTEND_ORIGIN || "http://localhost:4173");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});



async function auth(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  const { rows } = await pool.query("SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1", [token]);
  if (!rows[0]) return res.status(401).json({ error: "sign in first" });
  req.user = rows[0];
  next();
}

function adminOnly(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "admins only" });
  next();
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/register", async (req, res) => {
  const { email, password } = req.body ?? {};
  if (typeof email !== "string" || !email.includes("@") || typeof password !== "string" || password.length < 8) return res.status(400).json({ error: "email and a password of 8 or more characters are required" });
  try {
    const { rows } = await pool.query("INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, role", [email.toLowerCase(), hash(password)]);
    res.status(201).json(rows[0]);
  } catch {
    res.status(409).json({ error: "email already registered" });
  }
});

app.post("/api/login", async (req, res) => {
  const { email, password } = req.body ?? {};
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [String(email ?? "").toLowerCase()]);
  if (!rows[0] || rows[0].password_hash !== hash(String(password ?? ""))) return res.status(401).json({ error: "wrong email or password" });
  const token = crypto.randomBytes(16).toString("hex");
  await pool.query("INSERT INTO sessions (token, user_id) VALUES ($1, $2)", [token, rows[0].id]);
  res.json({ token, role: rows[0].role });
});

app.get("/api/products", async (_req, res) => {
  const { rows } = await pool.query("SELECT id, sku, name, price_cents FROM products ORDER BY id");
  res.json(rows);
});

app.post("/api/products", auth, adminOnly, async (req, res) => {
  const { sku, name, price_cents } = req.body ?? {};
  if (typeof sku !== "string" || !sku || typeof name !== "string" || !name || !Number.isInteger(price_cents) || price_cents < 0) return res.status(400).json({ error: "sku, name and a non-negative whole price_cents are required" });
  try {
    const { rows } = await pool.query("INSERT INTO products (sku, name, price_cents) VALUES ($1, $2, $3) RETURNING *", [sku, name, price_cents]);
    res.status(201).json(rows[0]);
  } catch {
    res.status(409).json({ error: "sku already exists" });
  }
});

async function cartOf(userId) {
  const { rows } = await pool.query("SELECT c.id, c.product_id, p.name, p.price_cents, c.quantity FROM cart_items c JOIN products p ON p.id = c.product_id WHERE c.user_id = $1 ORDER BY c.id", [userId]);
  return { items: rows, total_cents: cartTotal(rows) };
}

app.get("/api/cart", auth, async (req, res) => res.json(await cartOf(req.user.id)));

app.post("/api/cart/items", auth, async (req, res) => {
  const { product_id, quantity } = req.body ?? {};
  if (!Number.isInteger(product_id) || !validQuantity(quantity)) return res.status(400).json({ error: "product_id and a quantity from 1 to 10 are required" });
  const p = await pool.query("SELECT id FROM products WHERE id = $1", [product_id]);
  if (!p.rows[0]) return res.status(404).json({ error: "no such product" });
  const { rows } = await pool.query("INSERT INTO cart_items (user_id, product_id, quantity) VALUES ($1, $2, $3) RETURNING id", [req.user.id, product_id, quantity]);
  res.status(201).json({ id: rows[0].id, ...(await cartOf(req.user.id)) });
});

app.patch("/api/cart/items/:id", auth, async (req, res) => {
  const { quantity } = req.body ?? {};
  if (!Number.isInteger(quantity)) return res.status(400).json({ error: "quantity must be a whole number" });
  const { rowCount } = await pool.query("UPDATE cart_items SET quantity = $1 WHERE id = $2 AND user_id = $3", [quantity, Number(req.params.id), req.user.id]);
  if (!rowCount) return res.status(404).json({ error: "no such cart item" });
  res.json(await cartOf(req.user.id));
});

app.delete("/api/cart/items/:id", auth, async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM cart_items WHERE id = $1 AND user_id = $2", [Number(req.params.id), req.user.id]);
  if (!rowCount) return res.status(404).json({ error: "no such cart item" });
  res.status(204).end();
});

const port = Number(process.env.PORT || 3001);
migrate().then(() => app.listen(port, () => console.log(`shop api on ${port}`)));
