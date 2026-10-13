import { describe, expect, it } from "vitest";
import { withRetry } from "../src/retry.js";

describe("withRetry", () => {
  it("returns the first successful result", async () => {
    let calls = 0;
    const result = await withRetry(
      async (attempt) => {
        calls++;
        if (attempt < 2) throw new Error("not yet");
        return "ok";
      },
      { retries: 3, delayMs: 1 },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("throws the last error after exhausting retries", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new Error(`fail ${calls}`);
        },
        { retries: 2, delayMs: 1 },
      ),
    ).rejects.toThrow("fail 3");
  });

  it("stops early when shouldRetry returns false", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new TypeError("fatal");
        },
        { retries: 5, delayMs: 1, shouldRetry: (e) => !(e instanceof TypeError) },
      ),
    ).rejects.toThrow("fatal");
    expect(calls).toBe(1);
  });

  it("rejects a negative retry count", async () => {
    await expect(withRetry(async () => 1, { retries: -1 })).rejects.toThrow(RangeError);
  });
});
