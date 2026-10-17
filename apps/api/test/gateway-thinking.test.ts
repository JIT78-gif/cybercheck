import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AiSession } from "../src/understanding/ai/gateway.ts";

// Gemini's OpenAI-compatible API (round 48): thinking counts against max_tokens and is billed as output, but it is
// left out of completion_tokens. An answer cut off by it came back as a broken JSON fragment with finish_reason "length".
describe("AI gateway with a thinking model", () => {
  it("sends the provider's extra fields, asks again with room when cut off, and bills the thinking", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const answers = [
      { choices: [{ finish_reason: "length", message: { content: '{"requirements":[{"id":' } }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 800 } },
      { choices: [{ finish_reason: "stop", message: { content: '{"answer":"ok"}' } }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 330 } },
    ];
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify(answers[sent.length - 1]), { status: 200 });
    }) as unknown as typeof fetch;
    const s = new AiSession({ apiKey: "k", baseUrl: "https://x/", models: { author: "m" }, modelPrices: { m: { inputUsdPerMillion: 1, outputUsdPerMillion: 10 } }, budgetUsd: 1, fetchImpl, extraBody: { reasoning_effort: "low" } });
    const out = await s.json("author", { purpose: "behaviour requirements", system: "s", user: "u", schema: z.object({ answer: z.string() }), maxTokens: 700 });
    expect(out).toEqual({ answer: "ok" });
    expect(sent.map((b) => [b.max_tokens, b.reasoning_effort])).toEqual([[700, "low"], [1400, "low"]]);
    // The cut-off answer's messages are not repeated back to the model: the same question is asked with more room.
    expect((sent[1]!.messages as unknown[]).length).toBe(2);
    // Output billed: 700 (800 total minus 100 prompt, thinking included) and 230, not 20 and 30.
    expect(s.usage.map((u) => [u.ok, u.outputTokens])).toEqual([[false, 700], [true, 230]]);
    expect(s.spentUsd).toBeCloseTo((200 + 930 * 10) / 1_000_000, 9);
  });

  it("says the answer was cut off when it still does not fit", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "{" } }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }), { status: 200 })) as unknown as typeof fetch;
    const s = new AiSession({ apiKey: "k", baseUrl: "https://x/", models: { author: "m" }, modelPrices: { m: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } }, budgetUsd: 1, fetchImpl });
    await expect(s.json("author", { purpose: "boot plan", system: "s", user: "u", schema: z.object({ a: z.string() }), maxTokens: 50 })).rejects.toThrow(/after a retry \(its answer was cut off at the token limit\)/);
  });
});
