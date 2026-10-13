import { nightsBetween } from "./dates.js";

export const LODGING_TAX_PERCENT = 12;

export interface StayQuote {
  nights: number;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

export function quoteStay(checkIn: Date, checkOut: Date, nightlyRateCents: number): StayQuote {
  if (!Number.isInteger(nightlyRateCents) || nightlyRateCents <= 0) {
    throw new RangeError("nightlyRateCents must be a positive integer");
  }
  const nights = nightsBetween(checkIn, checkOut);
  const subtotalCents = nights * nightlyRateCents;
  const taxCents = Math.round((subtotalCents * LODGING_TAX_PERCENT) / 100);
  return { nights, subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}
