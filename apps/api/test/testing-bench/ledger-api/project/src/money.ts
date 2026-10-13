import { ValidationError } from "./errors.js";

export const TRANSFER_FEE_BPS = 50;
export const MIN_TRANSFER_FEE_CENTS = 25;

const AMOUNT_PATTERN = /^\d{1,9}(\.\d{1,2})?$/;

/** Parses a decimal string such as "12.30" into integer cents. */
export function parseAmount(value: string): number {
  const trimmed = value.trim();
  if (!AMOUNT_PATTERN.test(trimmed)) {
    throw new ValidationError(`Invalid amount: ${JSON.stringify(value)}`);
  }
  const [whole, fraction = ""] = trimmed.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

export function transferFee(amountCents: number): number {
  const fee = Math.round((amountCents * TRANSFER_FEE_BPS) / 10_000);
  return Math.max(MIN_TRANSFER_FEE_CENTS, fee);
}

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPriceCents: number;
}

export interface InvoiceTotals {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

export function computeInvoiceTotals(lines: InvoiceLine[], taxRateBps: number): InvoiceTotals {
  const subtotalCents = lines.reduce((sum, line) => sum + line.quantity * line.unitPriceCents, 0);
  const taxCents = Math.floor((subtotalCents * taxRateBps) / 10_000);
  return {
    subtotalCents,
    taxCents,
    totalCents: subtotalCents + taxCents,
  };
}

export function formatCents(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}
