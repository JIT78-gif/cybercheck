import { describe, expect, it } from "vitest";
import { parseIsoDate } from "../src/dates.js";
import { quoteStay } from "../src/pricing.js";

describe("quoteStay", () => {
  it("prices each night and adds lodging tax", () => {
    const quote = quoteStay(parseIsoDate("2025-03-01"), parseIsoDate("2025-03-04"), 12_000);
    expect(quote).toEqual({ nights: 3, subtotalCents: 36_000, taxCents: 4_320, totalCents: 40_320 });
  });

  it("rejects a non-positive rate", () => {
    expect(() => quoteStay(parseIsoDate("2025-03-01"), parseIsoDate("2025-03-02"), 0)).toThrow(RangeError);
  });
});
