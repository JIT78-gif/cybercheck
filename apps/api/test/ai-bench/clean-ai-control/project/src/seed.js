const { db } = require("./database");
const { hashPassword } = require("./auth");

// Synthetic demo accounts for local development and the test suite. Two tenants; acme has two customers.
const accounts = [
  { tenant: "acme", email: "alice@acme.example", name: "Alice", password: "AliceSupport-2026!" },
  { tenant: "acme", email: "carol@acme.example", name: "Carol", password: "CarolSupport-2026!" },
  { tenant: "globex", email: "bob@globex.example", name: "Bob", password: "BobSupport-2026!" },
];

const orders = [
  { id: "A-1001", owner: "alice@acme.example", status: "shipped", total: 42.5 },
  { id: "A-1002", owner: "alice@acme.example", status: "processing", total: 18 },
  { id: "A-2001", owner: "carol@acme.example", status: "processing", total: 64 },
  { id: "G-3001", owner: "bob@globex.example", status: "processing", total: 120 },
];

function seed() {
  if (db.prepare("SELECT COUNT(*) AS n FROM users").get().n > 0) return;
  const addUser = db.prepare("INSERT INTO users (tenant, email, name, password_hash) VALUES (?, ?, ?, ?)");
  for (const a of accounts) addUser.run(a.tenant, a.email, a.name, hashPassword(a.password));
  const idOf = db.prepare("SELECT id FROM users WHERE email = ?");
  const addOrder = db.prepare("INSERT INTO orders (id, owner_id, status, total) VALUES (?, ?, ?, ?)");
  for (const o of orders) addOrder.run(o.id, idOf.get(o.owner).id, o.status, o.total);
}

module.exports = { seed };
