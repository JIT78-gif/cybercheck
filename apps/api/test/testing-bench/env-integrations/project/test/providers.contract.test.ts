import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/clients/errors.js";
import { createSendgridMailer } from "../src/clients/sendgrid.js";
import { createStripeClient } from "../src/clients/stripe.js";

// Talks to the real provider APIs with credentials that are guaranteed to be
// invalid, to confirm our request shape is accepted far enough to reach auth.
describe("provider contract", () => {
  it("Stripe rejects an invalid secret key with 401", async () => {
    const stripe = createStripeClient({ secretKey: "sk_test_contract_invalid_key", timeoutMs: 10_000 });
    const error = await stripe
      .createPaymentIntent({
        amountCents: 1999,
        currency: "usd",
        customerEmail: "contract@example.com",
        idempotencyKey: `contract-${Date.now()}`,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(401);
  }, 20_000);

  it("SendGrid rejects an invalid API key with 401", async () => {
    const mailer = createSendgridMailer({ apiKey: "SG.contract_invalid_key", from: "receipts@example.com", timeoutMs: 10_000 });
    const error = await mailer
      .send({ to: "contract@example.com", subject: "contract", text: "contract" })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).status).toBe(401);
  }, 20_000);
});
