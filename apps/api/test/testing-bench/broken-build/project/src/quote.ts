import { formatMoney, percentOf } from "./money.js";
import { billableWeightGrams, type Parcel } from "./parcel.js";
import { CARRIERS, RATE_TABLES, type Carrier, type ServiceLevel } from "./rates.js";

export interface QuoteRequest {
  carrier: Carrier;
  service: ServiceLevel;
  parcel: Parcel;
  insuredValueCents?: number;
}

export interface Quote {
  carrier: Carrier;
  service: ServiceLevel;
  billableWeightGrams: number;
  baseCents: number;
  insuranceCents: number;
  totalCents: number;
  currency: "USD";
  display: string;
  estimatedDays: number;
}

const MIN_INSURANCE_CENTS = 100;

export function insuranceFor(insuredValueCents: number | undefined): number {
  if (!insuredValueCents) return 0;
  return Math.max(MIN_INSURANCE_CENTS, percentOf(insuredValueCents, 1));
}

export function quoteShipment(request: QuoteRequest): Quote {
  const table = RATE_TABLES[request.carrier][request.service];
  const weight = billableWeightGrams(request.parcel);
  const additionalKg = Math.max(0, Math.ceil((weight - 1000) / 1000));

  const baseCents = table.firstKgCents + additionalKg * table.additionalKgCents;
  const insuranceCents = insuranceFor(request.insuredValueCents);
  const totalCents = baseCents + insuranceCents;

  return {
    carrier: request.carrier,
    service: request.service,
    billableWeightGrams: weight,
    baseCents,
    insuranceCents,
    totalCents,
    currency: "USD",
    display: formatMoney(totalCents),
    estimatedDays: table.days,
  };
}

export function cheapestQuote(parcel: Parcel, service: ServiceLevel, insuredValueCents?: number): Quote {
  const quotes = CARRIERS.map((carrier) => quoteShipment({ carrier, service, parcel, insuredValueCents }));
  return quotes.reduce((best, quote) =>
    quote.totalCents < best.totalCents || (quote.totalCents === best.totalCents && quote.estimatedDays < best.estimatedDays)
      ? quote
      : best,
  );
}
