import { describe, expect, it } from "vitest";
import { cheapestQuote, insuranceFor, quoteShipment } from "../src/quote.js";

const smallBox = { weightGrams: 1800, lengthCm: 30, widthCm: 20, heightCm: 10 };

describe("quoteShipment", () => {
  it("charges the first kg plus each started additional kg", () => {
    const quote = quoteShipment({ carrier: "parcelpro", service: "standard", parcel: smallBox });
    expect(quote).toMatchObject({
      billableWeightGrams: 1800,
      baseCents: 1050,
      insuranceCents: 0,
      totalCents: 1050,
      currency: "USD",
      display: "$10.50",
      estimatedDays: 4,
    });
  });

  it("does not add a kg for exactly one kilogram", () => {
    const quote = quoteShipment({
      carrier: "parcelpro",
      service: "standard",
      parcel: { weightGrams: 1000, lengthCm: 10, widthCm: 10, heightCm: 10 },
    });
    expect(quote.baseCents).toBe(850);
  });

  it("adds insurance and formats the total", () => {
    const quote = quoteShipment({
      carrier: "parcelpro",
      service: "standard",
      parcel: smallBox,
      insuredValueCents: 25_000,
    });
    expect(quote.insuranceCents).toBe(250);
    expect(quote.totalCents).toBe(1300);
    expect(quote.display).toBe("$13.00");
  });
});

describe("insuranceFor", () => {
  it("applies the minimum premium", () => {
    expect(insuranceFor(5_000)).toBe(100);
  });

  it("is free when no value is declared", () => {
    expect(insuranceFor(undefined)).toBe(0);
    expect(insuranceFor(0)).toBe(0);
  });
});

describe("cheapestQuote", () => {
  it("breaks price ties with the faster carrier", () => {
    const quote = cheapestQuote(smallBox, "standard");
    expect(quote.carrier).toBe("parcelpro");
    expect(quote.totalCents).toBe(1050);
  });

  it("picks the lowest express price for heavy parcels", () => {
    const quote = cheapestQuote({ weightGrams: 5000, lengthCm: 20, widthCm: 20, heightCm: 20 }, "express");
    expect(quote.carrier).toBe("parcelpro");
    expect(quote.totalCents).toBe(3000);
  });
});
