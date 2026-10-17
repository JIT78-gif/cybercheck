process.env.TOKEN_SECRET ??= "test-only-secret-that-is-long-enough-1234";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { app } = require("../src/app");

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const call = (path, { method = "GET", token, body } = {}) =>
  fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });

async function signUp(email) {
  await call("/api/register", { method: "POST", body: { email, password: "correct horse battery" } });
  const res = await call("/api/login", { method: "POST", body: { email, password: "correct horse battery" } });
  return (await res.json()).token;
}

test("notes need a signed-in user", async () => {
  assert.equal((await call("/api/notes")).status, 401);
});

test("a user cannot read another user's note", async () => {
  const alice = await signUp("alice@example.test");
  const bob = await signUp("bob@example.test");
  const created = await (await call("/api/notes", { method: "POST", token: alice, body: { title: "private" } })).json();
  assert.equal((await call(`/api/notes/${created.id}`, { token: bob })).status, 404);
  assert.equal((await call(`/api/notes/${created.id}`, { token: alice })).status, 200);
});

test("members cannot list users", async () => {
  const carol = await signUp("carol@example.test");
  assert.equal((await call("/api/admin/users", { token: carol })).status, 403);
});

test("a tampered token is refused", async () => {
  const dave = await signUp("dave@example.test");
  assert.equal((await call("/api/notes", { token: `${dave}x` })).status, 401);
});
