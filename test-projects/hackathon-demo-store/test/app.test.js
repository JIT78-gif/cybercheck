const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const app = require("../src/app");

let server;
let baseUrl;
let aliceToken;

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await request("/api/login", {
    method: "POST",
    body: JSON.stringify({ email: "alice@example.test", password: "AlicePass!1" }),
  });
  aliceToken = login.body.token;
});

after(() => server.close());

const asAlice = () => ({ authorization: `Bearer ${aliceToken}` });

test("health check works", async () => {
  assert.equal((await request("/health")).status, 200);
});

test("a customer can read their own order", async () => {
  const result = await request("/api/orders/order-alice", { headers: asAlice() });
  assert.equal(result.body.userId, "user-alice");
});

test("coupon discount is applied before tax", async () => {
  const result = await request("/api/checkout/quote", {
    method: "POST",
    headers: asAlice(),
    body: JSON.stringify({ subtotal: 100, couponCode: "SAVE10" }),
  });
  assert.equal(result.body.total, 99, "10% discount, then 10% tax, should total 99");
});

test("assistant follows the documented 30-day refund policy", async () => {
  const message = "How long do I have to request a refund?";
  const result = await request("/api/assistant", {
    method: "POST",
    headers: asAlice(),
    body: JSON.stringify({ message }),
  });
  const reply = result.body.reply;
  assert.ok(reply.includes("30 days"), "the assistant should answer with the documented refund window");
});
