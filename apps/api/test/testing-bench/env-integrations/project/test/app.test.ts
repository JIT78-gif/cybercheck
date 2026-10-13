import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { ProviderError, ProviderUnavailableError } from "../src/clients/errors.js";
import type { Mailer } from "../src/clients/sendgrid.js";
import type { StripeClient } from "../src/clients/stripe.js";
import type { Database } from "../src/db.js";

const TOKEN = "internal-test-token";
const auth = { Authorization: `Bearer ${TOKEN}` };

function makeApp(overrides: { stripe?: StripeClient; mailer?: Mailer; db?: Database } = {}) {
  const stripe: StripeClient = overrides.stripe ?? {
    createPaymentIntent: vi.fn(async () => ({ id: "pi_1", status: "requires_payment_method", clientSecret: "secret" })),
  };
  const mailer: Mailer = overrides.mailer ?? { send: vi.fn(async () => undefined) };
  const db: Database = overrides.db ?? { ping: vi.fn(async () => true), close: vi.fn(async () => undefined) };
  return createApp({ stripe, mailer, db, internalApiToken: TOKEN });
}

const payment = { amountCents: 1999, currency: "usd", customerEmail: "ana@example.com" };

describe("health and readiness", () => {
  it("GET /health is always ok", async () => {
    const res = await request(makeApp()).get("/health");
    expect(res.status).toBe(200);
  });

  it("GET /ready reports 503 when the database is down", async () => {
    const db: Database = { ping: async () => false, close: async () => undefined };
    const res = await request(makeApp({ db })).get("/ready");
    expect(res.status).toBe(503);
    expect(res.body.checks.database).toBe("down");
  });
});

describe("POST /payments", () => {
  it("requires the internal token", async () => {
    const res = await request(makeApp()).post("/payments").send(payment);
    expect(res.status).toBe(401);
  });

  it("creates a payment intent", async () => {
    const res = await request(makeApp()).post("/payments").set(auth).send(payment);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: "pi_1", status: "requires_payment_method", clientSecret: "secret" });
  });

  it("validates the body", async () => {
    const app = makeApp();
    expect((await request(app).post("/payments").set(auth).send({ ...payment, amountCents: 10 })).status).toBe(400);
    expect((await request(app).post("/payments").set(auth).send({ ...payment, currency: "jpy" })).status).toBe(400);
    expect((await request(app).post("/payments").set(auth)).status).toBe(400);
  });

  it("maps a card decline to 402", async () => {
    const stripe: StripeClient = {
      createPaymentIntent: async () => {
        throw new ProviderError("stripe", 402, "Your card was declined.");
      },
    };
    const res = await request(makeApp({ stripe })).post("/payments").set(auth).send(payment);
    expect(res.status).toBe(402);
  });

  it("answers 502 when Stripe is unreachable", async () => {
    const stripe: StripeClient = {
      createPaymentIntent: async () => {
        throw new ProviderUnavailableError("stripe");
      },
    };
    const res = await request(makeApp({ stripe })).post("/payments").set(auth).send(payment);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "stripe_unavailable" });
  });
});

describe("POST /notifications/email", () => {
  it("queues an email", async () => {
    const send = vi.fn(async () => undefined);
    const res = await request(makeApp({ mailer: { send } }))
      .post("/notifications/email")
      .set(auth)
      .send({ to: "ana@example.com", subject: "Receipt", text: "Thanks" });
    expect(res.status).toBe(202);
    expect(send).toHaveBeenCalledWith({ to: "ana@example.com", subject: "Receipt", text: "Thanks" });
  });

  it("rejects an invalid recipient", async () => {
    const res = await request(makeApp())
      .post("/notifications/email")
      .set(auth)
      .send({ to: "not-an-email", subject: "Receipt", text: "Thanks" });
    expect(res.status).toBe(400);
  });
});
