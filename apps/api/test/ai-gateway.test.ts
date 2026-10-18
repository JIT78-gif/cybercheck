import { afterEach, describe, expect, it } from "vitest";
import type { AiApplicability, AiComponentInventory } from "@cybercheck/contracts";
import { liveGatewayStatus, liveModelConfig, callCost } from "../src/ai-evaluator/gateway.ts";
import { planComponents } from "../src/ai-evaluator/run.ts";
// @ts-expect-error plain ESM harness library
import { startGateway, startReplay } from "../src/testing/harness/lib.mjs";

// AI Evaluator step 7: the restricted live-model gateway (built behind an interface, fake-tested loopback to loopback),
// and the mode selection that tells replay, live and auto apart by the gateway's real capability.

type Server = { port: number; close: () => void; since: (n: number) => Array<{ served: string; inputTokens: number; outputTokens: number; costUsd: number; requestedModel: string | null }>; count: number; spentUsd: number; overBudget: boolean };
let upstream: { port: number; close: () => void; setScript: (t: unknown[] | null) => void; since: (n: number) => Array<{ body: string }> } | null = null;
let gw: Server | null = null;
afterEach(() => {
  gw?.close();
  upstream?.close();
  gw = upstream = null;
});

const call = (port: number, model = "gpt-4o-mini") => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer app-key" }, body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 9000 }) });

describe("live gateway (loopback to loopback)", () => {
  it("overrides the model, forwards to the upstream with cybercheck's key, and records usage and cost", async () => {
    upstream = (await startReplay(0));
    upstream!.setScript([{ content: "Hello from the model." }]);
    gw = (await startGateway(0, { upstreamUrl: `http://127.0.0.1:${upstream!.port}/v1`, upstreamKey: "cc-secret", model: "cc-pro", maxRequests: 10, maxTokensPerCall: 256, maxCostUsd: 1, inPricePerMTok: 1, outPricePerMTok: 2, timeoutMs: 3000 }));
    const res = await call(gw!.port);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]!.message.content).toBe("Hello from the model.");
    const rec = gw!.since(0)[0]!;
    expect(rec).toMatchObject({ served: "forwarded", requestedModel: "gpt-4o-mini" });
    expect(rec.inputTokens).toBeGreaterThan(0);
    expect(rec.costUsd).toBeCloseTo(callCost({ inPricePerMTok: 1, outPricePerMTok: 2 }, rec.inputTokens, rec.outputTokens));
    // The app's requested model was overridden to cybercheck's; the upstream saw cc-pro.
    const sent = JSON.parse(upstream!.since(0)[0]!.body) as { model: string; max_tokens: number };
    expect(sent.model).toBe("cc-pro");
    expect(sent.max_tokens).toBe(256); // the app's 9000 was clamped down
  });

  it("stops at the request budget and the cost budget, preserving what it did", async () => {
    upstream = (await startReplay(0));
    upstream!.setScript([{ content: "ok" }]);
    gw = (await startGateway(0, { upstreamUrl: `http://127.0.0.1:${upstream!.port}/v1`, upstreamKey: "k", model: "m", maxRequests: 2, maxTokensPerCall: 64, maxCostUsd: 100, inPricePerMTok: 1, outPricePerMTok: 1, timeoutMs: 3000 }));
    expect((await call(gw!.port)).status).toBe(200);
    expect((await call(gw!.port)).status).toBe(200);
    expect((await call(gw!.port)).status).toBe(429);
    expect(gw!.overBudget).toBe(true);
    expect(gw!.count).toBe(3);
  });

  it("returns a clean 502 when the upstream fails, and does not crash", async () => {
    upstream = (await startReplay(0));
    upstream!.setScript([{ status: 500 }]);
    gw = (await startGateway(0, { upstreamUrl: `http://127.0.0.1:${upstream!.port}/v1`, upstreamKey: "k", model: "m", maxRequests: 5, maxTokensPerCall: 64, maxCostUsd: 100, inPricePerMTok: 1, outPricePerMTok: 1, timeoutMs: 3000 }));
    const res = await call(gw!.port);
    expect(res.status).toBe(502);
    expect(gw!.since(0)[0]!.served).toBe("upstream 500");
  });
});

describe("gateway capability", () => {
  it("requires both configured credentials and an isolated trusted transport", () => {
    expect(liveModelConfig({})).toBeNull();
    expect(liveGatewayStatus({}).available).toBe(false);
    const env = { CC_LIVE_MODEL_BASE_URL: "https://api.example.test/v1", CC_LIVE_MODEL_KEY: "k", CC_LIVE_MODEL: "gpt-x" } as never;
    expect(liveModelConfig(env)).toMatchObject({ model: "gpt-x", baseUrl: "https://api.example.test/v1" });
    expect(liveGatewayStatus(env)).toMatchObject({ available: false, model: "gpt-x", reason: expect.stringMatching(/no isolated gateway sidecar/i) });
    expect(liveGatewayStatus(env, true)).toMatchObject({ available: true, model: "gpt-x" });
  });
});

describe("mode selection", () => {
  const component = (kind: AiComponentInventory["kind"]): AiComponentInventory => ({ id: "ai:1", name: "a", kind, provider: { name: "openai", family: kind === "local_logic" ? "none" : "openai_compatible", baseUrlEnv: kind === "local_logic" ? [] : ["AI_BASE_URL"], apiKeyEnv: ["AI_API_KEY"], hardcodedHosts: [], model: null, interceptable: kind !== "local_logic", reason: null }, files: [], systemPrompts: [], tools: [], retrieval: [], messageTriggers: [], endpoints: ["POST /api/assistant"], evidence: [], limitations: [] });
  const applic = (kind: AiComponentInventory["kind"]): AiApplicability => ({ status: "applicable", reason: "", components: [component(kind)], candidates: [], targets: [{ target: { componentId: "ai:1", transport: "http", method: "POST", path: "/api/assistant", requestTemplate: { message: "{{message}}" }, responseSelector: "reply" }, boundBy: "single_route", auxiliary: { historyPath: null, listPaths: [], approvalPaths: [] } }], unbound: [], unsupported: [], ownership: { ok: true, checked: 0, failed: [] } });
  const up = { available: true, model: "cc-pro", reason: "" };
  const down = { available: false, model: null, reason: "No live model is configured." };

  it("auto uses live when the gateway is available, replay when it is not", () => {
    expect(planComponents(applic("provider_http"), { modelMode: "auto" }, up)[0]!.mode).toBe("live");
    const fallback = planComponents(applic("provider_http"), { modelMode: "auto" }, down)[0]!;
    expect(fallback.mode).toBe("replay");
    expect(fallback.reason).toMatch(/No live gateway/);
  });

  it("live is environment-blocked when the gateway is unavailable", () => {
    expect(planComponents(applic("provider_http"), { modelMode: "live" }, down)[0]!.mode).toBeNull();
    expect(planComponents(applic("provider_http"), { modelMode: "live" }, up)[0]!.mode).toBe("live");
    expect(planComponents(applic("provider_http"), { modelMode: "replay" }, up)[0]!.mode).toBe("replay");
  });

  it("a local-logic component is direct (never live)", () => {
    expect(planComponents(applic("local_logic"), { modelMode: "auto" }, up)[0]!.mode).toBe("direct");
    expect(planComponents(applic("local_logic"), { modelMode: "live" }, up)[0]!.mode).toBeNull();
  });
});
