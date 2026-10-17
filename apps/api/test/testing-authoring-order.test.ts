import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AiSession } from "../src/understanding/ai/gateway.ts";
import { budgetGroup } from "../src/testing/orchestrator.ts";
import { authorInOrder, gapsFirst } from "../src/testing/authoring-order.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("authoring order", () => {
  it("runs each tier only after the one before it, and the steps of one tier together", async () => {
    const log: string[] = [];
    const step = (name: string, ms: number) => ({ name, run: async () => { log.push(`start ${name}`); await wait(ms); log.push(`end ${name}`); } });
    const steps = await authorInOrder({ shareUsd: Infinity, spent: () => 0, refused: () => 0 }, [[step("critical scenarios", 30), step("journeys", 10)], [], [step("probes", 5)], [step("unit tests", 1)]]);
    expect(log).toEqual(["start critical scenarios", "start journeys", "end journeys", "end critical scenarios", "start probes", "end probes", "start unit tests", "end unit tests"]);
    expect(steps.map((s) => `${s.name}: ${s.status}`)).toEqual(["critical scenarios: done", "journeys: done", "probes: done", "unit tests: done"]);
  });

  it("skips a later tier when the share is used up and says after what, but always starts the first", async () => {
    let spent = 0.29;
    const ran: string[] = [];
    const step = (name: string, cost: number) => ({ name, run: async () => { ran.push(name); spent += cost; } });
    const steps = await authorInOrder({ shareUsd: 0.3, spent: () => spent, refused: () => 0 }, [[step("critical scenarios", 0.005)], [step("probes", 0)], [step("unit tests", 0)]]);
    expect(ran).toEqual(["critical scenarios"]);
    expect(steps[1]).toEqual({ name: "probes", status: "skipped", reason: "the authoring share ($0.300) was used up after critical scenarios" });
    expect(steps[2]!.status).toBe("skipped");
  });

  it("marks a step cut short when the gateway refused some of its calls", async () => {
    let refused = 0;
    const steps = await authorInOrder({ shareUsd: 1, spent: () => 0, refused: () => refused }, [[{ name: "critical scenarios", run: async () => {} }], [{ name: "probes", run: async () => { refused += 2; } }]]);
    expect(steps[0]!.status).toBe("done");
    expect(steps[1]).toMatchObject({ status: "partial", reason: expect.stringMatching(/^2 AI call\(s\) in this step were refused/) });
  });

  it("gives critical work its calls first with a real budget, and the big probe step only what is left", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"ok"}' } }], usage: { prompt_tokens: 100, completion_tokens: 100 } }), { status: 200 })) as unknown as typeof fetch;
    const s = new AiSession({ apiKey: "k", baseUrl: "https://x/", models: { author: "m", triage: "m" }, modelPrices: { m: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 } }, budgetUsd: 1, fetchImpl });
    s.setStageBudget(budgetGroup, { planning: 0.2, authoring: 0.03, triage: 0.35, reconcile: 0.1 });
    const call = (purpose: string) => s.json("author", { purpose, system: "s", user: "u", schema: z.object({ answer: z.string() }), maxTokens: 1000 });
    const got: string[] = [];
    const steps = await authorInOrder({ shareUsd: 0.03, spent: () => s.stageSpent("authoring"), refused: () => s.refusedCalls("authoring") }, [
      [{ name: "critical scenarios", run: async () => { for (const i of [1, 2]) got.push(`critical ${i}: ${(await call(`probe scenarios (behaviour ${i})`)).answer}`); } }, { name: "browser journeys", run: async () => { got.push(`journeys: ${(await call("browser journeys")).answer}`); } }],
      // A step that would happily use everything: it gets only what is left, and stops at the share.
      [{ name: "request probes", run: async () => { for (let i = 0; i < 40; i++) await call(`probe scenarios for f${i}.js`).catch(() => undefined); } }],
    ]);
    expect([...got].sort()).toEqual(["critical 1: ok", "critical 2: ok", "journeys: ok"]);
    expect(steps.map((x) => x.status)).toEqual(["done", "done", "partial"]);
    expect(s.stageSpent("authoring")).toBeLessThanOrEqual(0.03);
  });

  it("puts endpoints no requirement scenario covers first", () => {
    const targets = [{ method: "POST", path: "/api/orders" }, { method: "GET", path: "/api/products" }, { method: "GET", path: "/api/orders/:id" }, { method: "DELETE", path: "/api/customers/:id" }];
    const proposals = [{ requests: [{ role: "action", method: "POST", path: "/api/orders" }, { role: "readback", method: "GET", path: "/api/orders/{orderId}" }] }, { requests: "not a list" }];
    expect(gapsFirst(targets, proposals).map((t) => `${t.method} ${t.path}`)).toEqual(["GET /api/products", "DELETE /api/customers/:id", "POST /api/orders", "GET /api/orders/:id"]);
  });
});
