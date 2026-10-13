process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const { app } = require("../src/app");

let server;
let base;

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());
test.beforeEach(async () => fetch(`${base}/__test/reset`, { method: "POST" }));

async function login(email = "alice@example.test", password = "AlicePass123!") {
  const response = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(response.status, 200);
  return (await response.json()).token;
}

test("health endpoint answers", async () => {
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
});

test("known customer can sign in", async () => {
  assert.ok(await login());
});

test("unknown password is rejected", async () => {
  const response = await fetch(`${base}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "alice@example.test", password: "wrong" }) });
  assert.equal(response.status, 401);
});

test("customer can place a one-item order", async () => {
  const token = await login();
  const response = await fetch(`${base}/api/orders`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ items: [{ productId: "p1", quantity: 1 }] }) });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).total, 4.25);
});

test("catalog lists products", async () => {
  const response = await fetch(`${base}/api/catalog`);
  assert.equal(response.status, 200);
  assert.ok((await response.json()).length >= 3);
});

test("customer database search finds a known address", async () => {
  const token = await login();
  const response = await fetch(`${base}/api/data/customers?q=alice`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  assert.equal((await response.json())[0].email, "alice@example.test");
});

