import { describe, expect, it } from "vitest";
import { formatMoney } from "../src/money.js";

describe("formatMoney", () => {
  it("formats US dollars with grouping", () => {
    expect(formatMoney(123_456, "USD")).toBe("$1,234.56");
  });

  it("formats euros and pounds", () => {
    expect(formatMoney(1250, "EUR")).toBe("€12.50");
    expect(formatMoney(99, "GBP")).toBe("£0.99");
  });
});
