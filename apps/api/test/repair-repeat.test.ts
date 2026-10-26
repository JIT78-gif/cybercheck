import { describe, expect, it } from "vitest";
import type { RepairAttempt } from "@cybercheck/contracts";
import { repeatOfFailedAttempt } from "../src/testing/repair.ts";

// A model that proposes the exact patch that already failed validation is refused before a sandbox run is spent on
// a known outcome, and told to change something else.

const attempt = (n: number, over: Partial<RepairAttempt> = {}): RepairAttempt => ({
  n, status: "failed_validation", summary: null, diff: "d", patchDigest: "abc", filesChanged: ["src/agent.js"], rejectedBecause: [], validationRunId: `run-${n}`,
  checks: [], regressions: [], costUsd: 0, startedAt: "", finishedAt: null, ...over,
});

describe("repeated repair patches", () => {
  it("finds an identical patch that already failed validation", () => {
    expect(repeatOfFailedAttempt([attempt(1), attempt(2, { status: "running", validationRunId: null })], attempt(2, { status: "running", validationRunId: null }))?.n).toBe(1);
  });

  it("allows a different patch", () => {
    expect(repeatOfFailedAttempt([attempt(1)], attempt(2, { patchDigest: "other", validationRunId: null }))).toBeUndefined();
  });

  it("does not count a patch that was refused before running, or one that has no digest", () => {
    expect(repeatOfFailedAttempt([attempt(1, { status: "rejected_patch", validationRunId: null })], attempt(2, { validationRunId: null }))).toBeUndefined();
    expect(repeatOfFailedAttempt([attempt(1, { patchDigest: null })], attempt(2, { patchDigest: null, validationRunId: null }))).toBeUndefined();
  });
});
