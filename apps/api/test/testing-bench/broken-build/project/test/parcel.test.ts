import { describe, expect, it } from "vitest";
import { billableWeightGrams, volumetricWeightGrams } from "../src/parcel.js";

describe("parcel weights", () => {
  it("computes volumetric weight in grams", () => {
    expect(volumetricWeightGrams({ weightGrams: 1, lengthCm: 30, widthCm: 20, heightCm: 10 })).toBe(1200);
  });

  it("bills the actual weight when it is heavier, rounded up to 100 g", () => {
    expect(billableWeightGrams({ weightGrams: 1850, lengthCm: 10, widthCm: 10, heightCm: 10 })).toBe(1900);
  });

  it("bills the volumetric weight for light, bulky parcels", () => {
    expect(billableWeightGrams({ weightGrams: 500, lengthCm: 40, widthCm: 30, heightCm: 20 })).toBe(4800);
  });

  it("rejects non-positive dimensions", () => {
    expect(() => billableWeightGrams({ weightGrams: 500, lengthCm: 0, widthCm: 30, heightCm: 20 })).toThrow(RangeError);
    expect(() => billableWeightGrams({ weightGrams: -1, lengthCm: 1, widthCm: 1, heightCm: 1 })).toThrow(RangeError);
  });
});
