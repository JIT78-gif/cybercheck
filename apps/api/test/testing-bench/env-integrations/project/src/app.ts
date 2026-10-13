import { randomUUID, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { z, ZodError } from "zod";
import { ProviderError, ProviderUnavailableError } from "./clients/errors.js";
import type { Mailer } from "./clients/sendgrid.js";
import type { StripeClient } from "./clients/stripe.js";
import type { Database } from "./db.js";

const PaymentBody = z.object({
  amountCents: z.number().int().min(50).max(99_999_999),
  currency: z.enum(["usd", "eur", "brl"]),
  customerEmail: z.string().trim().email().max(254),
});

const EmailBody = z.object({
  to: z.string().trim().email().max(254),
  subject: z.string().trim().min(1).max(200),
  text: z.string().min(1).max(10_000),
});

export interface AppDeps {
  stripe: StripeClient;
  mailer: Mailer;
  db: Database;
  internalApiToken: string;
}

function requireToken(expected: string) {
  const expectedBytes = Buffer.from(expected);
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.get("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const given = Buffer.from(token);
    if (given.length !== expectedBytes.length || !timingSafeEqual(given, expectedBytes)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

export function createApp({ stripe, mailer, db, internalApiToken }: AppDeps) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "32kb" }));
  const authenticated = requireToken(internalApiToken);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/ready", async (_req, res) => {
    const database = await db.ping();
    res.status(database ? 200 : 503).json({
      status: database ? "ready" : "unavailable",
      checks: { database: database ? "up" : "down" },
    });
  });

  app.post("/payments", authenticated, async (req, res) => {
    const body = PaymentBody.parse(req.body ?? {});
    const intent = await stripe.createPaymentIntent({ ...body, idempotencyKey: randomUUID() });
    res.status(201).json(intent);
  });

  app.post("/notifications/email", authenticated, async (req, res) => {
    const body = EmailBody.parse(req.body ?? {});
    await mailer.send(body);
    res.status(202).json({ status: "queued" });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "validation_failed", issues: err.issues });
      return;
    }
    if (err instanceof ProviderUnavailableError) {
      res.status(502).json({ error: `${err.provider}_unavailable` });
      return;
    }
    if (err instanceof ProviderError) {
      if (err.provider === "stripe" && err.status === 402) {
        res.status(402).json({ error: "payment_failed", message: err.message });
        return;
      }
      res.status(502).json({ error: `${err.provider}_error`, upstreamStatus: err.status });
      return;
    }
    const status = (err as { status?: number }).status;
    if (typeof status === "number" && status >= 400 && status < 500) {
      res.status(status).json({ error: "bad_request" });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
