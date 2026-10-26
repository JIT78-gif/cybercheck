import { describe, expect, it } from "vitest";
import { seededAccounts } from "../src/testing/fixtures.ts";
import { sourceFromFiles } from "../src/understanding/source.ts";

// Only accounts that exist when the app starts are runtime accounts. An account a test creates through the app itself
// (activation, registration, an admin users endpoint) exists only inside that test's database, and a deliberately
// invalid credential exists nowhere. The Hotel project's pytest suite has five such accounts and no runtime one, which
// is why every adversarial sign-in answered 401.

const accounts = (files: Record<string, string>) => seededAccounts(sourceFromFiles(files)).map((a) => a.account);

const CONFTEST = `
def _bootstrap_admin(client, license_key: str, email="owner@cafe.test", password="owner1234") -> str:
    r = client.post("/auth/activate", json={
        "license_key": license_key,
        "admin_email": email,
        "admin_password": password,
    })
    assert r.status_code == 200, r.text
    return r.json()["staff_token"]


@pytest.fixture
def staff_token_only(client, admin_token):
    r = client.post(
        "/admin/users",
        headers={"Authorization": f"Bearer {admin_token}"},
        json={"email": "waiter@cafe.test", "password": "waiter1234", "role": "staff"},
    )
    assert r.status_code == 201, r.text
    login = client.post("/auth/login", json={"email": "waiter@cafe.test", "password": "waiter1234"})
`;

const NEGATIVE = `
def test_invalid_license_key_rejected(client, cafe):
    r = client.post("/auth/activate", json={
        "license_key": "totally-wrong",
        "admin_email": "x@y.test",
        "admin_password": "pwpwpwpw",
    })
    assert r.status_code == 401
`;

describe("runtime account discovery", () => {
  it("ignores accounts a test creates through the app (activation, an admin users endpoint)", () => {
    expect(accounts({ "tests/conftest.py": CONFTEST })).toEqual([]);
  });

  it("ignores a deliberately invalid credential from a negative test", () => {
    expect(accounts({ "tests/test_auth.py": NEGATIVE })).toEqual([]);
  });

  it("ignores a JavaScript test that registers its own user", () => {
    const test = `it("signs up", async () => {\n  await request(app).post("/api/register").send({ email: "new@example.test", password: "NewPass123!" });\n});`;
    expect(accounts({ "test/auth.test.js": test })).toEqual([]);
  });

  it("ignores a login a test expects to fail", () => {
    const test = `it("rejects a bad password", async () => {\n  const r = await request(app).post("/api/login").send({ email: "alice@example.test", password: "WrongPass999!" });\n  expect(r.status).toBe(401);\n});`;
    expect(accounts({ "test/login.test.js": test })).toEqual([]);
  });

  it("keeps seed records the app's own code or seed script defines", () => {
    const store = `const users = [\n  { id: "u1", email: "alice@example.test", password: "AlicePass123!", role: "customer" },\n  { id: "u2", email: "admin@example.test", password: "AdminPass123!", role: "admin" },\n];`;
    expect(accounts({ "src/store.js": store })).toEqual(["alice@example.test", "admin@example.test"]);
  });

  it("keeps an account a test only signs in with, when the app seeds it", () => {
    const store = `const users = [{ id: "u1", email: "alice@example.test", password: "AlicePass123!", role: "customer" }];`;
    const test = `it("signs in", async () => {\n  const r = await request(app).post("/api/login").send({ email: "alice@example.test", password: "AlicePass123!" });\n  expect(r.status).toBe(200);\n});`;
    expect(accounts({ "src/store.js": store, "test/login.test.js": test })).toEqual(["alice@example.test"]);
  });
});
