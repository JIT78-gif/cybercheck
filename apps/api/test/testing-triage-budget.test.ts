import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Obligation } from "@cybercheck/contracts";
import { BudgetExceededError, AiSession } from "../src/understanding/ai/gateway.ts";
import { budgetGroup } from "../src/testing/orchestrator.ts";
import { deterministicScenario, rootSignature, triageRank, type Candidate } from "../src/testing/triage.ts";

const kindOf = (id: string) => id.split(":").at(-1) ?? "";
const cand = (over: Partial<Candidate>): Candidate => ({ source: "probe", label: "x", obligationIds: ["api:POST /a:malformed-body"], executionIds: [], reproduced: 2, of: 2, context: "", locations: [], workspace: ".", ...over });
const parserError = (n: number) => `Observed: server error 500. Response body (start): {"error":"Unexpected token o in JSON at position ${n}","stack":"SyntaxError at JSON.parse (/work/app/node_modules/body-parser/lib/types/json.js:${n})"}`;

describe("root-cause clusters before triage", () => {
  it("gives every malformed-JSON 500 from one body parser the same signature", () => {
    const a = rootSignature(cand({ obligationIds: ["api:POST /api/orders:malformed-body"], probe: { request: "POST /api/orders", status: 500 }, context: parserError(1) }), kindOf);
    const b = rootSignature(cand({ obligationIds: ["api:POST /api/payments:malformed-body"], probe: { request: "POST /api/payments", status: 500 }, context: parserError(17) }), kindOf);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    // A different failure (a crash in one handler) stays apart, and so does any business check.
    expect(rootSignature(cand({ obligationIds: ["api:POST /api/preview:empty-body"], probe: { request: "x", status: 500 }, context: 'Response body (start): {"error":"Cannot read properties of undefined (reading \'url\')"}' }), kindOf)).not.toBe(a);
    expect(rootSignature(cand({ obligationIds: ["req:req-total:orders:qty"] }), kindOf)).toBeNull();
  });

  it("analyses business failures first and generic input failures last", () => {
    const ob = (id: string): Obligation | undefined => (id.startsWith("req:") ? ({ id, requirementIds: ["r"], priority: "critical", proofClass: "business_behavior", layer: "api" } as Obligation) : id.startsWith("data:") ? ({ id, layer: "data" } as Obligation) : ({ id, layer: "api" } as Obligation));
    const order = [
      cand({ obligationIds: ["api:POST /a:malformed-body"] }),
      cand({ source: "suite", label: "adds", obligationIds: ["suite:passes:."] }),
      cand({ obligationIds: ["req:req-total:orders:qty"] }),
      cand({ obligationIds: ["api:GET /admin:unauthenticated"] }),
      cand({ obligationIds: ["data:orders:constraints"] }),
    ].sort((x, y) => triageRank(x, ob, kindOf) - triageRank(y, ob, kindOf)).map((c) => c.obligationIds[0] ?? c.label);
    expect(order).toEqual(["req:req-total:orders:qty", "data:orders:constraints", "suite:passes:.", "api:GET /admin:unauthenticated", "api:POST /a:malformed-body"]);
  });

  it("needs no AI critic for a reproduced scenario failure against a documented requirement", () => {
    const sourced = (source: string) => (id: string) => ({ id, scenarioId: "orders:qty", oracle: { source, expected: "", evidence: [] } }) as unknown as Obligation;
    expect(deterministicScenario(cand({ obligationIds: ["req:r:s"], reproduced: 2 }), sourced("documentation"))).toBe(true);
    expect(deterministicScenario(cand({ obligationIds: ["req:r:s"], reproduced: 1 }), sourced("documentation"))).toBe(false);
    expect(deterministicScenario(cand({ obligationIds: ["req:r:s"], reproduced: 2 }), sourced("code_contract"))).toBe(false);
  });
});

describe("AI budget", () => {
  const session = (budgetUsd: number, delayMs = 30) => {
    const fetchImpl = (async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"ok"}' } }], usage: { prompt_tokens: 100, completion_tokens: 100 } }), { status: 200 });
    }) as unknown as typeof fetch;
    // $10 per million tokens each way: a call with maxTokens 1000 reserves about $0.01 in the worst case.
    return new AiSession({ apiKey: "k", baseUrl: "https://x/", models: { author: "m", triage: "m" }, modelPrices: { m: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 } }, budgetUsd, fetchImpl });
  };
  const call = (s: AiSession, purpose = "triage of x") => s.json("triage", { purpose, system: "s", user: "u", schema: z.object({ answer: z.string() }), maxTokens: 1000 });

  it("does not let parallel calls reserve more than the remaining budget", async () => {
    const s = session(0.025);
    const results = await Promise.allSettled([call(s), call(s), call(s)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: expect.any(BudgetExceededError) });
    expect(s.spentUsd).toBeLessThanOrEqual(0.025);
  });

  it("stops a stage at its share, and lets only triage use the reserve", async () => {
    const s = session(1);
    // Each call reserves about $0.0106 and costs $0.002: requirements fits one call; triage fits two only thanks to the reserve.
    s.setStageBudget(budgetGroup, { planning: 0.011, triage: 0.011 }, { usd: 0.002, groups: ["triage"] });
    await call(s, "behaviour requirements");
    await expect(call(s, "behaviour requirements")).rejects.toBeInstanceOf(BudgetExceededError);
    await call(s, "triage of a");
    await expect(call(s, "triage of b")).resolves.toEqual({ answer: "ok" });
    await expect(call(s, "triage of c")).rejects.toBeInstanceOf(BudgetExceededError);
    expect(budgetGroup("review of a finding")).toBe("triage");
    expect(budgetGroup("probe scenarios (behaviour 1)")).toBe("authoring");
    expect(budgetGroup("boot plan")).toBe("planning");
    expect(budgetGroup("behaviour requirements")).toBe("planning");
  });
});
