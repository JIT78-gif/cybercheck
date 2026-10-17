import { describe, expect, it } from "vitest";
import { BrowserTarget, CompiledScenario, Obligation, TestRequirement, TestingReport, TypedRequest, badReferences, canDefineOracle, proofSuffices, scenarioProofLevel, symbolsIn } from "@cybercheck/contracts";

/** Placing an order for three units: the total is price times three, and the stock falls by three. */
const orderOfThree = (): Record<string, any> => ({
  id: "orders:quantity-three",
  requirementIds: ["req:order-total", "req:stock"],
  fixtureScope: "isolated",
  bindings: [
    { symbol: "customer.token", producer: { kind: "fixture", nodeId: "customer", jsonPath: "$.token" }, type: "token", scope: "run" },
    { symbol: "product.id", producer: { kind: "fixture", nodeId: "product", jsonPath: "$.id" }, type: "id", scope: "scenario" },
    { symbol: "product.price", producer: { kind: "fixture", nodeId: "product", jsonPath: "$.price" }, type: "number", scope: "scenario" },
  ],
  requests: [
    { id: "stock-before", role: "setup", method: "GET", path: "/api/products/{id}", pathParams: { id: { $symbol: "product.id" } }, as: null },
    { id: "place", role: "action", method: "POST", path: "/api/orders", as: "customer", body: { kind: "json", value: { items: [{ productId: { $symbol: "product.id" }, quantity: 3 }] } }, captures: [{ symbol: "order.id", jsonPath: "$.id" }] },
    { id: "stock-after", role: "readback", method: "GET", path: "/api/products/{id}", pathParams: { id: { $symbol: "product.id" } }, as: null },
  ],
  assertions: [
    { id: "created", requirementId: "req:order-total", requestId: "place", target: { from: "status" }, op: "one_of", expected: [200, 201], says: "the order is accepted" },
    { id: "total", requirementId: "req:order-total", requestId: "place", target: { from: "body", jsonPath: "$.total" }, op: "equals", expected: { $expr: { op: "mul", args: [{ $symbol: "product.price" }, 3] } }, says: "the total is the price times three" },
    { id: "stock", requirementId: "req:stock", requestId: "stock-after", target: { from: "body", jsonPath: "$.stock" }, op: "changed_by", expected: -3, baselineRequestId: "stock-before", says: "the stock falls by three" },
  ],
});

describe("behaviour-first contracts", () => {
  it("accepts a typed scenario and knows it proves the response and the stored state", () => {
    const s = CompiledScenario.parse(orderOfThree());
    expect(scenarioProofLevel(s, "req:order-total")).toBe("response");
    expect(scenarioProofLevel(s, "req:stock")).toBe("state");
    expect(proofSuffices("response", "response")).toBe(true);
    expect(proofSuffices("response", "state")).toBe(false);
    expect(symbolsIn(s.assertions[1]!.expected)).toEqual(["product.price"]);
  });

  it("treats a status-only scenario as availability, never as proof of business behaviour", () => {
    const raw = orderOfThree();
    raw.assertions = [raw.assertions[0]!];
    raw.requirementIds = ["req:order-total"];
    const s = CompiledScenario.parse(raw);
    expect(scenarioProofLevel(s, "req:order-total")).toBe("availability");
    for (const need of ["response", "state", "integrity"] as const) expect(proofSuffices("availability", need)).toBe(false);
  });

  it("refuses symbols used before anything produces them, and assertions on requests it never sends", () => {
    const raw = orderOfThree();
    raw.requests[0]!.pathParams = { id: { $symbol: "order.id" } }; // captured only later, by "place"
    raw.assertions.push({ id: "ghost", requirementId: "req:stock", requestId: "missing", target: { from: "status" }, op: "equals", expected: 200, says: "x" });
    const r = CompiledScenario.safeParse(raw);
    expect(r.success).toBe(false);
    const messages = r.error!.issues.map((i) => i.message).join(" | ");
    expect(messages).toMatch(/stock-before uses order\.id before anything produces it/);
    expect(messages).toMatch(/reads request missing, which the scenario does not send/);
  });

  it("keeps query values apart from the path, so <script>, colons and braces are never parsed as a route", () => {
    const q = TypedRequest.parse({ id: "search", role: "action", method: "GET", path: "/api/search", query: [{ name: "q", value: "<script>{x}:y</script>" }], as: null });
    expect(q.query[0]!.value).toBe("<script>{x}:y</script>");
    expect(TypedRequest.safeParse({ id: "s", role: "action", method: "GET", path: "/api/search?q=<script>", as: null }).success).toBe(false);
    // A placeholder must be a whole segment, and every placeholder needs a value.
    expect(TypedRequest.safeParse({ id: "s", role: "action", method: "GET", path: "/api/orders/order-{id}", pathParams: { id: 1 }, as: null }).success).toBe(false);
    expect(TypedRequest.safeParse({ id: "s", role: "action", method: "GET", path: "/api/orders/{id}", as: null }).success).toBe(false);
    expect(TypedRequest.safeParse({ id: "s", role: "action", method: "GET", path: "/api/orders", body: { kind: "json", value: {} }, as: null }).success).toBe(false);
  });

  it("refuses malformed references inside values", () => {
    expect(badReferences({ a: { $symbol: "Customer Id" } })).toHaveLength(1);
    expect(badReferences({ a: { $generated: "random_password" } })).toHaveLength(1);
    expect(badReferences({ a: { $expr: { op: "pow", args: [2, 3] } } })).toHaveLength(1);
    expect(badReferences({ a: { $symbol: "user.id", extra: 1 } })).toHaveLength(1);
    expect(badReferences({ a: [{ $generated: "days_from_today", days: -1 }, { $expr: { op: "add", args: [1, { $symbol: "x.y" }] } }] })).toEqual([]);
  });

  it("lets only documentation, tests, protocol, policy or the user define correct behaviour", () => {
    const req = (kind: string) => TestRequirement.parse({ id: "r", capability: "Orders", source: { kind, path: "src/app.js", line: 84 }, expectedBehavior: "The total is price times quantity", affectedAssets: ["POST /api/orders"], requiredProof: "response", priority: "critical", template: "calculation" });
    expect(canDefineOracle(req("documentation"))).toBe(true);
    expect(canDefineOracle(req("existing_test"))).toBe(true);
    expect(canDefineOracle(req("implementation"))).toBe(false);
  });

  it("describes backend-served pages without a frontend build", () => {
    expect(BrowserTarget.parse({ kind: "backend_served", appWorkspace: ".", port: 3000 }).kind).toBe("backend_served");
    expect(BrowserTarget.safeParse({ kind: "backend_served", port: 3000 }).success).toBe(false);
  });

  it("still reads checks and reports made before these fields existed", () => {
    const old = { id: "api:GET /x:ok", layer: "api", asset: { kind: "endpoint", ref: "GET /x", label: "GET /x" }, objective: "answers", priority: "high", oracle: { source: "http_semantics", expected: "no 5xx", evidence: [] }, status: "passed", reason: null, origin: "dossier", executionIds: [], findingIds: [] };
    expect(Obligation.parse(old).proofLevel).toBeUndefined();
    const report = TestingReport.shape.requirements.safeParse(undefined);
    expect(report.success).toBe(true);
  });
});
