import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { AiSession } from "../src/understanding/ai/gateway.ts";

describe("OpenAI-compatible AI providers", () => {
  it("uses configured prices without calling a provider-specific model catalogue", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"answer":"ok"}' } }], usage: { prompt_tokens: 20, completion_tokens: 5 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const session = new AiSession({
      apiKey: "test-key",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
      models: { author: "gemini-test" },
      modelPrices: { "gemini-test": { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } },
      budgetUsd: 1,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(session.json("author", { purpose: "test", system: "Return JSON", user: "Now", schema: z.object({ answer: z.string() }), maxTokens: 100 })).resolves.toEqual({ answer: "ok" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(session.spentUsd).toBeCloseTo(0.00003);
  });
});
