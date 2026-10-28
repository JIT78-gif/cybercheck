import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AiSession, extractJson } from "../src/understanding/ai/gateway.ts";

// Reasoning models (Nemotron 3, DeepSeek) can put their thinking in the answer. Its braces are not the JSON.
describe("answers from reasoning models", () => {
  it("ignores thinking before the JSON", () => {
    expect(extractJson('<think>The shape is {"a": 1} maybe, or [1, 2]?</think>\n{"answer":"ok"}')).toEqual({ answer: "ok" });
  });

  it("ignores thinking whose opening tag was left out", () => {
    expect(extractJson('Need a {"x"} object here.</think>{"answer":"ok"}')).toEqual({ answer: "ok" });
  });

  it("still reads fenced JSON after thinking", () => {
    expect(extractJson('<think>{draft}</think>\n```json\n{"answer":"ok"}\n```')).toEqual({ answer: "ok" });
  });
});

// Gemini returns its error body inside an array; the provider's message must reach the user, not "no details".
describe("provider errors", () => {
  it("shows the message from an error body wrapped in an array", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify([{ error: { code: 403, message: "Your API key was reported as leaked." } }]), { status: 403 })) as unknown as typeof fetch;
    const s = new AiSession({ apiKey: "k", baseUrl: "https://x/", models: { author: "m" }, modelPrices: { m: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } }, budgetUsd: 1, fetchImpl });
    await expect(s.json("author", { purpose: "p", system: "s", user: "u", schema: z.object({ a: z.string() }), maxTokens: 50 })).rejects.toThrow("Model call failed (HTTP 403): Your API key was reported as leaked.");
  });
});
