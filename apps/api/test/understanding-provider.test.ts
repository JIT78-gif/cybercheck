import { describe, expect, it } from "vitest";
import type { AiInsights } from "@cybercheck/contracts";
import { addAttemptUsage, understandingProviderOrder, understandingProviderUnavailable } from "../src/understanding/ai/provider.ts";

const insight = (costUsd: number, calls: number): AiInsights => ({
  status: "failed",
  error: "The AI step stopped: Model call failed (HTTP 402): Payment Required",
  models: { fast: "f", strong: "s", critic: "c" },
  usage: { calls, inputTokens: calls * 10, outputTokens: calls * 2, costUsd, ms: calls * 100 },
  purpose: null,
  components: [],
  trustBoundaries: [],
  dataFlows: [],
  stateMachines: [],
  sequences: [],
  risks: [],
  aiSurface: null,
  designNotes: [],
  questions: [],
  verification: { claims: 0, verified: 0, relocated: 0, unverified: 0, droppedByCritic: 0 },
});

describe("Understanding AI provider selection", () => {
  it("prefers Nebius and keeps Gemini as the automatic fallback", () => {
    expect(understandingProviderOrder({ preference: "auto", nebius: true, gemini: true })).toEqual(["nebius", "gemini"]);
    expect(understandingProviderOrder({ preference: "auto", nebius: false, gemini: true })).toEqual(["gemini"]);
  });

  it("honours a forced provider without silently switching", () => {
    expect(understandingProviderOrder({ preference: "nebius", nebius: true, gemini: true })).toEqual(["nebius"]);
    expect(understandingProviderOrder({ preference: "gemini", nebius: true, gemini: true })).toEqual(["gemini"]);
    expect(understandingProviderOrder({ preference: "nebius", nebius: false, gemini: true })).toEqual([]);
  });

  it("falls back for payment, throttling, server and transport failures only", () => {
    for (const message of ["HTTP 402: Payment Required", "HTTP 429", "HTTP 503", "fetch failed", "connect ECONNRESET", "request timed out"]) {
      expect(understandingProviderUnavailable(message), message).toBe(true);
    }
    expect(understandingProviderUnavailable("The model did not return JSON.")).toBe(false);
    expect(understandingProviderUnavailable("Stopped at the spending limit")).toBe(false);
  });

  it("keeps usage from both attempts in the final audit", () => {
    const first = insight(0.01, 1);
    const second = { ...insight(0.02, 2), status: "ready" as const, error: null };
    expect(addAttemptUsage(second, [first, second]).usage).toEqual({ calls: 3, inputTokens: 30, outputTokens: 6, costUsd: 0.03, ms: 300 });
  });
});
