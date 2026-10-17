const test = require("node:test");
const assert = require("node:assert/strict");
const { app, reset } = require("../src/app");

let server;
let base;

test.before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());
test.beforeEach(reset);

test("health and synthetic sign-in work", async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
  const response = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "alice@example.test", password: "AlicePass123!" }),
  });
  assert.equal(response.status, 200);
  assert.equal(typeof (await response.json()).token, "string");
});

test("unknown account and wrong password deliberately produce different responses", async () => {
  const send = (email, password) => fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal((await send("nobody@example.test", "WrongPass123!")).status, 404);
  assert.equal((await send("alice@example.test", "WrongPass123!")).status, 401);
});
