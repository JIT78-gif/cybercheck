import { eachDay, formatIsoDate, parseIsoDate, quoteStay } from "@tripdesk/core";
import express, { type NextFunction, type Request, type Response } from "express";

const MAX_ITINERARY_DAYS = 366;

class BadRequest extends Error {}

function dateParam(value: unknown, name: string): Date {
  if (typeof value !== "string") {
    throw new BadRequest(`${name} is required (YYYY-MM-DD)`);
  }
  try {
    return parseIsoDate(value);
  } catch {
    throw new BadRequest(`${name} must be a valid YYYY-MM-DD date`);
  }
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "8kb" }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/itinerary/days", (req, res) => {
    const start = dateParam(req.query.start, "start");
    const end = dateParam(req.query.end, "end");
    if (end < start) throw new BadRequest("end must not be before start");
    if ((end.getTime() - start.getTime()) / 86_400_000 >= MAX_ITINERARY_DAYS) {
      throw new BadRequest(`itineraries are limited to ${MAX_ITINERARY_DAYS} days`);
    }
    const days = eachDay(start, end).map(formatIsoDate);
    res.json({ start: formatIsoDate(start), end: formatIsoDate(end), count: days.length, days });
  });

  app.post("/quotes", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const checkIn = dateParam(body.checkIn, "checkIn");
    const checkOut = dateParam(body.checkOut, "checkOut");
    const rate = body.nightlyRateCents;
    if (typeof rate !== "number" || !Number.isInteger(rate) || rate <= 0 || rate > 10_000_000) {
      throw new BadRequest("nightlyRateCents must be a positive integer");
    }
    if (checkOut <= checkIn) throw new BadRequest("checkOut must be after checkIn");
    res.json(quoteStay(checkIn, checkOut, rate));
  });

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof BadRequest) {
      res.status(400).json({ error: "bad_request", message: err.message });
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
