import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/errors.js";
import { computeInvoiceTotals, parseAmount, transferFee } from "../src/money.js";

describe("parseAmount", () => {
  it("parses decimal strings into cents", () => {
    expect(parseAmount("12.34")).toBe(1234);
    expect(parseAmount("5")).toBe(500);
    expect(parseAmount("0.5")).toBe(50);
    expect(parseAmount(" 7.05 ")).toBe(705);
  });

  it("rejects negative, malformed and over-precise amounts", () => {
    for (const bad of ["-1.00", "1.234", "abc", "", "1,00"]) {
      expect(() => parseAmount(bad)).toThrow(ValidationError);
    }
  });
});

describe("transferFee", () => {
  it("charges the minimum fee on small transfers", () => {
    expect(transferFee(1000)).toBe(25);
  });

  it("charges 0.5% rounded half up on larger transfers", () => {
    expect(transferFee(12_345)).toBe(62);
    expect(transferFee(100_000)).toBe(500);
  });
});

describe("computeInvoiceTotals", () => {
  it("sums line items and adds tax", () => {
    const totals = computeInvoiceTotals(
      [
        { description: "Seat", quantity: 2, unitPriceCents: 500 },
        { description: "Support", quantity: 1, unitPriceCents: 1000 },
      ],
      1000,
    );
    expect(totals).toEqual({ subtotalCents: 2000, taxCents: 200, totalCents: 2200 });
  });

  it("rounds invoice tax to the nearest cent", () => {
    const totals = computeInvoiceTotals([{ description: "Seat", quantity: 3, unitPriceCents: 1999 }], 825);
    expect(totals.subtotalCents).toBe(5997);
    expect(totals.taxCents).toBe(495);
    expect(totals.totalCents).toBe(6492);
  });

  it("returns no tax when the rate is zero", () => {
    const totals = computeInvoiceTotals([{ description: "Seat", quantity: 4, unitPriceCents: 2500 }], 0);
    expect(totals).toEqual({ subtotalCents: 10_000, taxCents: 0, totalCents: 10_000 });
  });
});
