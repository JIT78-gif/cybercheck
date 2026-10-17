import { describe, expect, it } from "vitest";
import { CompiledScenario, type TestRequirement } from "@cybercheck/contracts";
import { behaviourObligations, compileBehaviour, requirementAliases, validRequirements } from "../src/testing/behaviour.ts";
import { templateProblems } from "../src/testing/scenarios.ts";

const README = `# Shop\n\n## Required behavior\n\n- Three notebooks at $4.25 each cost $12.75 before tax; inventory decreases by the ordered quantity.\n- Order status follows pending -> paid -> packed -> shipped; it never moves backward.\n`;
const src = { files: new Map([["README.md", { text: README }], ["src/app.js", { text: "app.post('/api/orders', h)" }]]), allPaths: [] } as never;
const d = {
  entryPoints: [
    { id: "e1", kind: "http", method: "POST", path: "/api/orders", control: { kind: "session_required" }, handler: { path: "src/app.js", line: 1 } },
    { id: "e2", kind: "http", method: "GET", path: "/api/catalog", control: { kind: "public_intentional" }, handler: { path: "src/app.js", line: 2 } },
    { id: "e3", kind: "http", method: "POST", path: "/api/orders/:id/status", control: { kind: "session_required" }, handler: { path: "src/app.js", line: 3 } },
  ],
  screens: [],
  config: { envVars: [] },
} as never;

describe("documented requirements", () => {
  it("keeps a requirement whose quote is really in the cited file, at the right line", () => {
    const [r] = validRequirements([{ id: "Order Total", capability: "Orders", source: { kind: "documentation", path: "README.md", line: 2, quote: "Three notebooks at $4.25 each cost $12.75 before tax" }, expectedBehavior: "total is price times quantity", affectedAssets: ["POST /api/orders", "GET /api/catalog"], requiredProof: "state", priority: "critical", template: "calculation" }], src, d);
    expect(r).toMatchObject({ id: "req-order-total", source: { kind: "documentation", path: "README.md", line: 5 }, affectedAssets: ["POST /api/orders", "GET /api/catalog"], template: "calculation" });
  });

  it("turns an invented citation into an implementation hint, and drops requirements with no real endpoint", () => {
    const out = validRequirements(
      [
        { id: "made-up", capability: "Orders", source: { kind: "documentation", path: "README.md", line: 9, quote: "Refunds are processed within one hour always" }, expectedBehavior: "x", affectedAssets: ["POST /api/orders"], requiredProof: "response", priority: "high" },
        { id: "ghost", capability: "Orders", source: { kind: "documentation", path: "README.md", line: 5, quote: "Three notebooks at $4.25 each cost" }, expectedBehavior: "x", affectedAssets: ["POST /api/refunds"], requiredProof: "response", priority: "high" },
      ],
      src,
      d,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.source.kind).toBe("implementation");
  });
});

const scenario = (over: Record<string, unknown> = {}) =>
  CompiledScenario.parse({
    id: "orders:qty",
    requirementIds: ["req-order-total"],
    fixtureScope: "isolated",
    bindings: [],
    requests: [{ id: "place", role: "action", method: "POST", path: "/api/orders", as: "customer", body: { kind: "json", value: { items: [{ productId: "p1", quantity: 1 }] } } }],
    assertions: [{ id: "total", requirementId: "req-order-total", requestId: "place", target: { from: "body", jsonPath: "$.total" }, op: "equals", expected: 4.25, says: "the total is right" }],
    ...over,
  });

describe("requirement field names from different models", () => {
  it("reads Gemini's statement and a missing capability as the fields they mean", () => {
    // Round 49: {"statement": ...} with no capability failed the shape check twice and left the run without requirements.
    const gemini = { id: "order-cost-calculation", priority: "critical", statement: "Three notebooks at $4.25 each cost $12.75.", affectedAssets: ["POST /api/orders"], requiredProof: "response", source: { kind: "documentation", path: "README.md", line: 33 } };
    expect(requirementAliases(gemini)).toMatchObject({ expectedBehavior: "Three notebooks at $4.25 each cost $12.75.", capability: "order" });
    // Fields already named right are kept as they are.
    expect(requirementAliases({ ...gemini, expectedBehavior: "kept", capability: "Orders" })).toMatchObject({ expectedBehavior: "kept", capability: "Orders" });
    expect(requirementAliases("not an object")).toBe("not an object");
  });
});

describe("behaviour templates", () => {
  it("refuses quantity 1 for a calculation, and accepts quantity 3", () => {
    expect(templateProblems(scenario(), "calculation")[0]).toMatch(/quantity of 3/);
    const three = scenario({ requests: [{ id: "place", role: "action", method: "POST", path: "/api/orders", as: "customer", body: { kind: "json", value: { items: [{ productId: "p1", quantity: 3 }] } } }] });
    expect(templateProblems(three, "calculation")).toEqual([]);
  });

  it("asks for two pages, a refused backward move with a readback, two dates, a repeated request and a delete with readback", () => {
    expect(templateProblems(scenario(), "pagination")[0]).toMatch(/two consecutive pages/);
    expect(templateProblems(scenario(), "state_transition")[0]).toMatch(/forbidden move/);
    expect(templateProblems(scenario(), "date_boundary")[0]).toMatch(/both sides of the boundary/);
    expect(templateProblems(scenario(), "idempotency")[0]).toMatch(/identical request twice/);
    expect(templateProblems(scenario(), "referential_integrity")[0]).toMatch(/delete a parent/);
    const pages = scenario({ requests: [1, 2].map((p) => ({ id: `p${p}`, role: p === 1 ? "action" : "readback", method: "GET", path: "/api/orders", query: [{ name: "page", value: p }], as: "customer" })), assertions: [{ id: "x", requirementId: "req-order-total", requestId: "p2", target: { from: "body", jsonPath: "$[0].id" }, op: "exists", says: "page 2 has records" }] });
    expect(templateProblems(pages, "pagination")).toEqual([]);
    const dates = scenario({ requests: [{ id: "place", role: "action", method: "POST", path: "/api/orders", as: null, body: { kind: "json", value: { today: "2026-10-15", expires: "2026-2-01" } } }] });
    expect(templateProblems(dates, "date_boundary")).toEqual([]);
  });
});

describe("behaviour obligations", () => {
  const req: TestRequirement = { id: "req-order-total", capability: "Orders", source: { kind: "documentation", path: "README.md", line: 5 }, expectedBehavior: "Three notebooks cost $12.75", affectedAssets: ["POST /api/orders"], requiredProof: "response", priority: "critical", template: "calculation" };

  it("compiles against the project and makes one obligation per requirement, citing the documentation", async () => {
    const three = { ...JSON.parse(JSON.stringify(scenario())), requests: [{ id: "place", role: "action", method: "POST", path: "/api/orders", as: "customer", body: { kind: "json", value: { items: [{ productId: "p1", quantity: 3 }] } } }], assertions: [{ id: "total", requirementId: "req-order-total", requestId: "place", target: { from: "body", jsonPath: "$.total" }, op: "equals", expected: 12.75, says: "three notebooks cost $12.75" }] };
    const b = await compileBehaviour(null, [three, scenario()], [req], d, [{ id: "customer", label: "c", kind: "identity", dependsOn: [], origin: "plan" }] as never);
    expect(b.scenarios.map((s) => s.id)).toEqual(["orders:qty"]);
    // The quantity-1 copy has the same id: the compiled one wins, and the refusal is not duplicated.
    const { obligations, jobs } = behaviourObligations(b, { ...(d as object), entryPoints: (d as { entryPoints: unknown[] }).entryPoints } as never);
    expect(obligations[0]).toMatchObject({ id: "req:req-order-total:orders:qty", layer: "api", proofClass: "business_behavior", oracle: { source: "documentation", expected: "three notebooks cost $12.75", evidence: [{ path: "README.md", line: 5 }] }, requirementIds: ["req-order-total"], scenarioId: "orders:qty" });
    expect(jobs[0]!.obligations).toEqual({ "req-order-total": "req:req-order-total:orders:qty" });
  });
});

describe("templates from a requirement's own words", () => {
  it("names the template the sentence is about", async () => {
    const { templateFromWords } = await import("../src/testing/behaviour.ts");
    expect(templateFromWords("Three notebooks at $4.25 each cost $12.75 before tax; inventory decreases by the ordered quantity.")).toBe("calculation");
    expect(templateFromWords("Inventory decreases by the ordered quantity")).toBe("calculation");
    expect(templateFromWords("Money is rounded to cents and pagination never skips or duplicates records.")).toBe("pagination");
    expect(templateFromWords("Order status follows pending -> paid -> packed -> shipped; it never moves backward.")).toBe("state_transition");
    expect(templateFromWords("expired coupons are rejected")).toBe("date_boundary");
    expect(templateFromWords("Only an administrator may list users")).toBeUndefined();
  });
});

describe("proposal shape slips", () => {
  it("fixes path for jsonPath and inlines literal bindings, nothing else", async () => {
    const { normalizeProposal } = await import("../src/testing/behaviour.ts");
    const out = normalizeProposal({ bindings: [{ symbol: "product.id", producer: { kind: "literal", value: "p1" } }, { symbol: "c.token", producer: { kind: "fixture", nodeId: "c", jsonPath: "$.token" } }], requests: [{ id: "a", body: { kind: "json", value: { items: [{ productId: { $symbol: "product.id" } }] } } }], assertions: [{ target: { from: "body", path: "$.total" } }] }) as { bindings: unknown[]; requests: Array<{ body: { value: { items: Array<{ productId: unknown }> } } }>; assertions: Array<{ target: { jsonPath?: string } }> };
    expect(out.requests[0]!.body.value.items[0]!.productId).toBe("p1");
    expect(out.bindings).toHaveLength(1);
    expect(out.assertions[0]!.target.jsonPath).toBe("$.total");
  });
});
