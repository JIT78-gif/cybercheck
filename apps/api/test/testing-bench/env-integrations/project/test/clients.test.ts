import { describe, expect, it, vi } from "vitest";
import { ProviderError, ProviderUnavailableError } from "../src/clients/errors.js";
import { createSendgridMailer } from "../src/clients/sendgrid.js";
import { createStripeClient } from "../src/clients/stripe.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const paymentRequest = {
  amountCents: 1999,
  currency: "usd" as const,
  customerEmail: "ana@example.com",
  idempotencyKey: "key-1",
};

describe("stripe client", () => {
  it("creates a payment intent with form encoded parameters", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { id: "pi_123", status: "requires_payment_method", client_secret: "pi_123_secret" }),
    );
    const stripe = createStripeClient({ secretKey: "sk_test_x", fetchImpl });

    const intent = await stripe.createPaymentIntent(paymentRequest);

    expect(intent).toEqual({ id: "pi_123", status: "requires_payment_method", clientSecret: "pi_123_secret" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.stripe.com/v1/payment_intents");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk_test_x");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("key-1");
    const form = new URLSearchParams(init.body as string);
    expect(form.get("amount")).toBe("1999");
    expect(form.get("currency")).toBe("usd");
    expect(form.get("receipt_email")).toBe("ana@example.com");
  });

  it("raises ProviderError with Stripe's message on an error status", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(402, { error: { message: "Your card was declined." } }));
    const stripe = createStripeClient({ secretKey: "sk_test_x", fetchImpl });

    await expect(stripe.createPaymentIntent(paymentRequest)).rejects.toMatchObject({
      name: "ProviderError",
      status: 402,
      message: "Your card was declined.",
    });
  });

  it("raises ProviderUnavailableError when the network fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const stripe = createStripeClient({ secretKey: "sk_test_x", fetchImpl });

    await expect(stripe.createPaymentIntent(paymentRequest)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe("sendgrid mailer", () => {
  it("posts the message to the v3 mail endpoint", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    const mailer = createSendgridMailer({ apiKey: "SG.x", from: "receipts@example.com", fetchImpl });

    await mailer.send({ to: "ana@example.com", subject: "Receipt", text: "Thanks!" });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.sendgrid.com/v3/mail/send");
    expect(JSON.parse(init.body as string)).toEqual({
      personalizations: [{ to: [{ email: "ana@example.com" }] }],
      from: { email: "receipts@example.com" },
      subject: "Receipt",
      content: [{ type: "text/plain", value: "Thanks!" }],
    });
  });

  it("raises ProviderError when SendGrid rejects the message", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad request", { status: 400 }));
    const mailer = createSendgridMailer({ apiKey: "SG.x", from: "receipts@example.com", fetchImpl });

    await expect(mailer.send({ to: "ana@example.com", subject: "s", text: "t" })).rejects.toBeInstanceOf(ProviderError);
  });
});
