import { ProviderError, safeFetch, type FetchLike } from "./errors.js";

export interface PaymentIntentRequest {
  amountCents: number;
  currency: "usd" | "eur" | "brl";
  customerEmail: string;
  idempotencyKey: string;
}

export interface PaymentIntent {
  id: string;
  status: string;
  clientSecret: string;
}

export interface StripeClient {
  createPaymentIntent(request: PaymentIntentRequest): Promise<PaymentIntent>;
}

export interface StripeClientOptions {
  secretKey: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

interface StripeErrorBody {
  error?: { message?: string; type?: string };
}

export function createStripeClient(options: StripeClientOptions): StripeClient {
  const baseUrl = options.baseUrl ?? "https://api.stripe.com";
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    async createPaymentIntent(request) {
      const form = new URLSearchParams({
        amount: String(request.amountCents),
        currency: request.currency,
        receipt_email: request.customerEmail,
        "automatic_payment_methods[enabled]": "true",
      });

      const response = await safeFetch(
        "stripe",
        fetchImpl,
        `${baseUrl}/v1/payment_intents`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.secretKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
            "Idempotency-Key": request.idempotencyKey,
          },
          body: form.toString(),
        },
        timeoutMs,
      );

      const body = (await response.json().catch(() => ({}))) as Record<string, unknown> & StripeErrorBody;
      if (!response.ok) {
        throw new ProviderError("stripe", response.status, body.error?.message ?? `Stripe returned ${response.status}`);
      }

      return {
        id: String(body.id),
        status: String(body.status),
        clientSecret: String(body.client_secret),
      };
    },
  };
}
