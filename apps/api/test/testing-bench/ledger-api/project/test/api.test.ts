import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authHeaders, createAccount, depositCents, makeApp } from "./helpers.js";

let app: FastifyInstance;

beforeEach(async () => {
  app = makeApp();
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("health and auth", () => {
  it("serves GET /health without a token", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });

  it("rejects requests without a bearer token", async () => {
    const res = await app.inject({ method: "GET", url: "/accounts/1" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects requests with the wrong token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/accounts/1",
      headers: { authorization: "Bearer not-the-token" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("accounts", () => {
  it("creates an account with a zero balance", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/accounts",
      headers: authHeaders,
      payload: { name: "Operations", currency: "USD" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ name: "Operations", currency: "USD", balanceCents: 0 });
  });

  it("rejects an unsupported currency", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/accounts",
      headers: authHeaders,
      payload: { name: "Operations", currency: "XYZ" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("records deposits in the balance and the entry list", async () => {
    const id = await createAccount(app, "Treasury");
    await depositCents(app, id, 15_000);

    const account = await app.inject({ method: "GET", url: `/accounts/${id}`, headers: authHeaders });
    expect(account.json().balanceCents).toBe(15_000);

    const entries = await app.inject({ method: "GET", url: `/accounts/${id}/entries`, headers: authHeaders });
    expect(entries.json().entries).toHaveLength(1);
    expect(entries.json().entries[0]).toMatchObject({ kind: "deposit", amountCents: 15_000 });
  });

  it("returns 404 for an unknown account", async () => {
    const res = await app.inject({ method: "GET", url: "/accounts/999", headers: authHeaders });
    expect(res.statusCode).toBe(404);
  });
});

describe("transfers", () => {
  it("moves money between accounts and charges the fee to the sender", async () => {
    const a = await createAccount(app, "A");
    const b = await createAccount(app, "B");
    await depositCents(app, a, 10_000);

    const res = await app.inject({
      method: "POST",
      url: "/transfers",
      headers: authHeaders,
      payload: { fromAccountId: a, toAccountId: b, amount: "20.00", reference: "rent" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      fromAccountId: a,
      toAccountId: b,
      amountCents: 2000,
      feeCents: 25,
      fromBalanceCents: 7975,
      toBalanceCents: 2000,
    });
  });

  it("refuses a transfer the sender cannot cover", async () => {
    const a = await createAccount(app, "A");
    const b = await createAccount(app, "B");
    await depositCents(app, a, 1000);

    const res = await app.inject({
      method: "POST",
      url: "/transfers",
      headers: authHeaders,
      payload: { fromAccountId: a, toAccountId: b, amount: "10.00" },
    });
    expect(res.statusCode).toBe(422);

    const account = await app.inject({ method: "GET", url: `/accounts/${a}`, headers: authHeaders });
    expect(account.json().balanceCents).toBe(1000);
  });

  it("returns 404 when the destination account does not exist", async () => {
    const a = await createAccount(app, "A");
    await depositCents(app, a, 5000);

    const res = await app.inject({
      method: "POST",
      url: "/transfers",
      headers: authHeaders,
      payload: { fromAccountId: a, toAccountId: 4242, amount: "1.00" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("invoices", () => {
  it("creates an invoice with computed totals", async () => {
    const id = await createAccount(app, "Customer");
    const res = await app.inject({
      method: "POST",
      url: "/invoices",
      headers: authHeaders,
      payload: {
        accountId: id,
        taxRateBps: 1000,
        lines: [{ description: "Seat", quantity: 2, unitPriceCents: 2500 }],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ subtotalCents: 5000, taxCents: 500, totalCents: 5500 });

    const fetched = await app.inject({ method: "GET", url: `/invoices/${res.json().id}`, headers: authHeaders });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().lines).toHaveLength(1);
  });

  it("rejects an invoice without lines", async () => {
    const id = await createAccount(app, "Customer");
    const res = await app.inject({
      method: "POST",
      url: "/invoices",
      headers: authHeaders,
      payload: { accountId: id, taxRateBps: 1000, lines: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});
