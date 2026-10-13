export type Carrier = "parcelpro" | "swiftship" | "northpost";
export type ServiceLevel = "standard" | "express";

export interface RateTable {
  firstKgCents: number;
  additionalKgCents: number;
  days: number;
}

export const CARRIERS: readonly Carrier[] = ["parcelpro", "swiftship", "northpost"];

export const RATE_TABLES: Record<Carrier, Record<ServiceLevel, RateTable>> = {
  parcelpro: {
    standard: { firstKgCents: 850, additionalKgCents: 200, days: 4 },
    express: { firstKgCents: 1600, additionalKgCents: 350, days: 1 },
  },
  swiftship: {
    standard: { firstKgCents: 790, additionalKgCents: 260, days: 5 },
    express: { firstKgCents: 1450, additionalKgCents: 400, days: 2 },
  },
  northpost: {
    standard: { firstKgCents: 990, additionalKgCents: 150, days: 3 },
    express: { firstKgCents: 1900, additionalKgCents: 300, days: 1 },
  },
};
