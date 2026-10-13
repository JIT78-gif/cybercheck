import { describe, expect, it } from "vitest";
import { addDays, eachDay, formatIsoDate, nightsBetween, parseIsoDate, rangesOverlap } from "../src/dates.js";

const d = parseIsoDate;

describe("parseIsoDate", () => {
  it("parses a calendar date at UTC midnight", () => {
    expect(d("2025-03-01").toISOString()).toBe("2025-03-01T00:00:00.000Z");
  });

  it("rejects malformed and impossible dates", () => {
    expect(() => d("2025-02-30")).toThrow(RangeError);
    expect(() => d("03/01/2025")).toThrow(RangeError);
  });
});

describe("addDays", () => {
  it("crosses month and year boundaries", () => {
    expect(formatIsoDate(addDays(d("2025-01-31"), 1))).toBe("2025-02-01");
    expect(formatIsoDate(addDays(d("2024-12-31"), 1))).toBe("2025-01-01");
  });
});

describe("nightsBetween", () => {
  it("counts nights, not days", () => {
    expect(nightsBetween(d("2025-03-01"), d("2025-03-04"))).toBe(3);
  });

  it("rejects a check-out on or before check-in", () => {
    expect(() => nightsBetween(d("2025-03-04"), d("2025-03-04"))).toThrow(RangeError);
    expect(() => nightsBetween(d("2025-03-04"), d("2025-03-01"))).toThrow(RangeError);
  });
});

describe("eachDay", () => {
  it("includes both the start and end day", () => {
    const days = eachDay(d("2025-03-01"), d("2025-03-03")).map(formatIsoDate);
    expect(days).toEqual(["2025-03-01", "2025-03-02", "2025-03-03"]);
  });

  it("rejects an end before the start", () => {
    expect(() => eachDay(d("2025-03-03"), d("2025-03-01"))).toThrow(RangeError);
  });
});

describe("rangesOverlap", () => {
  it("treats ranges as inclusive", () => {
    const march = { start: d("2025-03-01"), end: d("2025-03-10") };
    expect(rangesOverlap(march, { start: d("2025-03-10"), end: d("2025-03-12") })).toBe(true);
    expect(rangesOverlap(march, { start: d("2025-03-11"), end: d("2025-03-12") })).toBe(false);
  });
});
