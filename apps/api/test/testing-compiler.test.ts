import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CompiledScenario, type Obligation, type TestRequirement } from "@cybercheck/contracts";
import { earnedProofClass, evidenceFactor } from "../src/testing/assurance.ts";
import { compileScenario, endpointKeys, externalSymbols, obligationFromScenario, producerTable, routeKey, type CompileContext, type ScenarioRun } from "../src/testing/scenarios.ts";
// @ts-expect-error: plain JavaScript that runs inside the sandbox
import { client, requestPath, runScenario } from "../src/testing/harness/lib.mjs";

// ---------------------------------------------------------------- a tiny shop: buggy or fixed

function shop(buggy: boolean) {
  const products = new Map([[1, { id: 1, price: 10, stock: 50 }]]);
  let next = 1;
  const orders = new Map<number, { id: number; total: number }>();
  return createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (url.pathname === "/api/crash") return req.socket.destroy();
      if (url.pathname === "/api/echo") return send(200, { q: url.searchParams.get("q"), raw: req.url });
      if (url.pathname === "/api/private") return req.headers.authorization === "Bearer good" ? send(200, { ok: true }) : send(401, { error: "sign in" });
      const p = url.pathname.match(/^\/api\/products\/(\d+)$/);
      if (p && req.method === "GET") return products.has(Number(p[1])) ? send(200, products.get(Number(p[1]))) : send(404, {});
      if (url.pathname === "/api/orders" && req.method === "POST") {
        const body = JSON.parse(raw || "{}") as { items: Array<{ productId: number; quantity: number }> };
        let total = 0;
        for (const line of body.items) {
          const prod = products.get(line.productId)!;
          total += buggy ? prod.price : prod.price * line.quantity;
          prod.stock -= buggy ? 1 : line.quantity;
        }
        const order = { id: next++, total };
        orders.set(order.id, order);
        return send(201, order);
      }
      return send(404, {});
    });
  });
}

const servers: Server[] = [];
const bases: Record<"buggy" | "fixed", string> = { buggy: "", fixed: "" };
beforeAll(async () => {
  for (const kind of ["buggy", "fixed"] as const) {
    const srv = shop(kind === "buggy");
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    servers.push(srv);
    bases[kind] = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  }
});
afterAll(() => servers.forEach((s) => s.close()));

// ---------------------------------------------------------------- the inputs a run would have

const req = (id: string, kind: TestRequirement["source"]["kind"], requiredProof: TestRequirement["requiredProof"]): TestRequirement => ({ id, capability: "Orders", source: { kind, path: "README.md", line: 12 }, expectedBehavior: "x", affectedAssets: ["POST /api/orders"], requiredProof, priority: "critical", template: "calculation" });
const dossier = {
  entryPoints: [
    { kind: "http", method: "POST", path: "/api/orders" },
    { kind: "http", method: "GET", path: "/api/products/:id" },
    { kind: "http", method: "GET", path: "/api/echo" },
    { kind: "http", method: "GET", path: "/api/private" },
  ],
  config: { envVars: [{ name: "ADMIN_TOKEN" }] },
} as never;
const graph = [
  { id: "customer", label: "Sign in as customer", kind: "identity", dependsOn: [], origin: "plan" },
  { id: "product", label: "A product", kind: "request", dependsOn: [], origin: "plan", steps: [{ method: "POST", path: "/api/products", expect: {}, capture: { name: "id", path: "$.id" } }] },
] as never;
const ctx = (): CompileContext => ({ requirements: [req("req:total", "documentation", "response"), req("req:stock", "documentation", "state"), req("req:impl", "implementation", "response")], endpoints: endpointKeys(dossier), producers: producerTable(graph, dossier) });

const orderOfThree = (): Record<string, unknown> => ({
  id: "orders:quantity-three",
  requirementIds: ["req:total", "req:stock"],
  fixtureScope: "isolated",
  bindings: [{ symbol: "product.id", producer: { kind: "fixture", nodeId: "product", jsonPath: "$.id" }, type: "id", scope: "scenario" }],
  requests: [
    { id: "before", role: "setup", method: "GET", path: "/api/products/{id}", pathParams: { id: { $symbol: "product.id" } }, as: null, captures: [{ symbol: "product.price", jsonPath: "$.price" }] },
    { id: "place", role: "action", method: "POST", path: "/api/orders", as: null, body: { kind: "json", value: { items: [{ productId: { $symbol: "product.id" }, quantity: 3 }] } } },
    { id: "after", role: "readback", method: "GET", path: "/api/products/{id}", pathParams: { id: { $symbol: "product.id" } }, as: null },
  ],
  assertions: [
    { id: "total", requirementId: "req:total", requestId: "place", target: { from: "body", jsonPath: "$.total" }, op: "equals", expected: { $expr: { op: "mul", args: [{ $symbol: "product.price" }, 3] } }, says: "the total is the price times three" },
    { id: "stock", requirementId: "req:stock", requestId: "after", target: { from: "body", jsonPath: "$.stock" }, op: "changed_by", expected: -3, baselineRequestId: "before", says: "the stock falls by three" },
  ],
});

describe("scenario compiler", () => {
  it("normalizes routes so every framework's parameter style compares equal", () => {
    expect(routeKey("get", "/api/orders/:id/")).toBe("GET /api/orders/{}");
    expect(routeKey("GET", "/api/orders/{orderId}")).toBe("GET /api/orders/{}");
    expect(routeKey("GET", "/api/orders/<int:id>")).toBe("GET /api/orders/{}");
  });

  it("compiles a scenario that proves the response and the stored state", () => {
    const r = compileScenario(orderOfThree(), ctx());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.proof).toEqual({ "req:total": "response", "req:stock": "state" });
      expect(externalSymbols(r.scenario)).toEqual(["product.id"]);
    }
  });

  it("refuses made-up endpoints, settings, identities and fixtures, each with the reason", () => {
    const s = orderOfThree() as { requests: Array<Record<string, unknown>>; bindings: unknown[] };
    s.requests.push({ id: "steal", role: "readback", method: "GET", path: "/api/admin/orders", as: "admin", headers: { "x-key": "ALICE_PASSWORD" } });
    s.bindings.push({ symbol: "admin.pass", producer: { kind: "setting", name: "ALICE_PASSWORD" }, type: "secret", scope: "run" });
    s.bindings.push({ symbol: "cart.id", producer: { kind: "fixture", nodeId: "cart", jsonPath: "$.id" }, type: "id", scope: "scenario" });
    const r = compileScenario(s, ctx());
    expect(r.ok).toBe(false);
    const all = r.ok ? "" : r.problems.join(" | ");
    expect(all).toMatch(/GET \/api\/admin\/orders is not an endpoint of this project/);
    expect(all).toMatch(/ALICE_PASSWORD was not found in the project/);
    expect(all).toMatch(/ALICE_PASSWORD is not a setting of this project/);
    expect(all).toMatch(/there is no identity "admin"/);
    expect(all).toMatch(/fixture "cart" does not exist/);
  });

  it("refuses an oracle taken from the implementation, and status-only proof of business behaviour", () => {
    const impl = orderOfThree() as { requirementIds: string[]; assertions: Array<Record<string, unknown>> };
    impl.requirementIds = ["req:impl"];
    impl.assertions = [{ ...impl.assertions[0]!, requirementId: "req:impl" }];
    const r1 = compileScenario(impl, ctx());
    expect(r1.ok ? "" : r1.problems.join(" | ")).toMatch(/comes only from the implementation/);

    const statusOnly = orderOfThree() as { requirementIds: string[]; assertions: Array<Record<string, unknown>> };
    statusOnly.requirementIds = ["req:total"];
    statusOnly.assertions = [{ id: "ok", requirementId: "req:total", requestId: "place", target: { from: "status" }, op: "equals", expected: 201, says: "the order is accepted" }];
    const r2 = compileScenario(statusOnly, ctx());
    expect(r2.ok ? "" : r2.problems.join(" | ")).toMatch(/needs response proof, but the scenario only checks status codes/);
  });
});

describe("scenario runner", () => {
  const run = async (kind: "buggy" | "fixed", raw = orderOfThree(), extra: Record<string, unknown> = {}) => {
    const s = CompiledScenario.parse(raw);
    return (await runScenario(s, { request: client(bases[kind], null), symbols: { "product.id": 1 }, ...extra })) as ScenarioRun;
  };

  it("finds the quantity bugs with expected and observed values, and passes the fixed shop", async () => {
    const bad = await run("buggy");
    expect(bad.status).toBe("failed");
    const total = bad.proofs.find((p) => p.assertionId === "total")!;
    expect(total).toMatchObject({ passed: false, expected: 30, observed: 10, targetReached: true });
    expect(total.excerpt).toContain('"total":10');
    expect(bad.proofs.find((p) => p.assertionId === "stock")).toMatchObject({ passed: false, observed: { change: -1 } });
    expect(bad.reason).toMatch(/the total is the price times three: expected 30, observed 10/);

    const good = await run("fixed");
    expect(good.status).toBe("passed");
    expect(good.proofs.every((p) => p.passed && p.targetReached)).toBe(true);
    expect(good.proofs.find((p) => p.assertionId === "stock")!.stateVerified).toBe(true);
  });

  it("sends query values and path segments encoded, so <script>, colons and braces arrive unchanged", async () => {
    const q = "<script>{x}:y</script> & more";
    expect(requestPath({ path: "/api/echo", query: [{ name: "q", value: q }] }, {})).toBe(`/api/echo?q=${new URLSearchParams({ q }).toString().slice(2)}`);
    expect(requestPath({ path: "/api/items/{id}", pathParams: { id: "a/b?c" } }, {})).toBe("/api/items/a%2Fb%3Fc");
    const s = { id: "echo", requirementIds: ["req:total"], fixtureScope: "shared", bindings: [], requests: [{ id: "e", role: "action", method: "GET", path: "/api/echo", query: [{ name: "q", value: q }], as: null }], assertions: [{ id: "same", requirementId: "req:total", requestId: "e", target: { from: "body", jsonPath: "$.q" }, op: "equals", expected: q, says: "the value arrives unchanged" }] };
    expect((await run("fixed", s)).status).toBe("passed");
  });

  it("is inconclusive, never failed, when the behaviour was not reached", async () => {
    // Sign-in did not work.
    const signed = { id: "p", requirementIds: ["req:total"], fixtureScope: "shared", bindings: [], requests: [{ id: "a", role: "action", method: "GET", path: "/api/private", as: "customer" }], assertions: [{ id: "x", requirementId: "req:total", requestId: "a", target: { from: "body", jsonPath: "$.ok" }, op: "equals", expected: true, says: "it answers" }] };
    expect((await run("fixed", signed)).reason).toMatch(/Sign-in as customer did not work/);
    // Signed in with a bad token: a 401 means the target was not reached.
    const refused = await run("fixed", signed, { auths: { customer: { headers: { authorization: "Bearer bad" } } } });
    expect(refused).toMatchObject({ status: "inconclusive", targetReached: false });
    // A setup step that finds nothing.
    const missing = await runScenario(CompiledScenario.parse(orderOfThree()), { request: client(bases.fixed, null), symbols: { "product.id": 999 } });
    expect(missing.status).toBe("inconclusive");
    expect(missing.reason).toMatch(/Setup GET \/api\/products\/\{id\} answered 404/);
    // A value nothing produced.
    expect((await runScenario(CompiledScenario.parse(orderOfThree()), { request: client(bases.fixed, null), symbols: {} })).reason).toMatch(/product\.id was not available/);
  });

  it("fails, never calls unreached, an action that crashes the app (no response at all)", async () => {
    const s = { id: "crash", requirementIds: ["req:total"], fixtureScope: "shared", bindings: [], requests: [{ id: "a", role: "action", method: "GET", path: "/api/echo", as: null }, { id: "b", role: "action", method: "POST", path: "/api/orders", as: null, body: { kind: "json", value: {} } }], assertions: [{ id: "x", requirementId: "req:total", requestId: "a", target: { from: "body", jsonPath: "$.q" }, op: "absent", says: "no query" }] };
    (s.requests[1] as Record<string, unknown>).path = "/api/crash";
    const r = await run("fixed", s);
    expect(r).toMatchObject({ status: "failed", targetReached: true });
    expect(r.reason).toMatch(/POST \/api\/crash got no response \(.+\); the app may have crashed/);
  });

  it("counts an expected refusal as reaching the target (an isolation check)", async () => {
    const s = { id: "iso", requirementIds: ["req:total"], fixtureScope: "shared", bindings: [], requests: [{ id: "a", role: "action", method: "GET", path: "/api/private", as: "customer" }], assertions: [{ id: "refused", requirementId: "req:total", requestId: "a", target: { from: "status" }, op: "one_of", expected: [401, 403], says: "another user's data is refused" }] };
    expect(await run("fixed", s, { auths: { customer: { headers: { authorization: "Bearer bad" } } } })).toMatchObject({ status: "passed", targetReached: true });
  });
});

describe("proof gate", () => {
  const base: Obligation = { id: "api:POST /api/orders:total", layer: "api", asset: { kind: "endpoint", ref: "POST /api/orders", label: "POST /api/orders" }, objective: "x", priority: "critical", oracle: { source: "existing_assertion", expected: "x", evidence: [] }, status: "passed", reason: null, origin: "authored", executionIds: [], findingIds: [], proofClass: "business_behavior", oracleStrength: "strong", reachedTarget: true };

  it("gives a status-only business check the weight of an availability check, nothing more", () => {
    expect(evidenceFactor({ ...base, proofLevel: "response" })).toBe(1);
    expect(evidenceFactor({ ...base, proofLevel: "availability" })).toBe(0.35);
    expect(earnedProofClass({ ...base, proofLevel: "availability" })).toBe("availability");
    // Checks from before scenarios keep their own strength.
    expect(evidenceFactor(base)).toBe(1);
  });

  it("turns a run into an obligation with its proofs, and strong evidence only with the state read back", async () => {
    const s = CompiledScenario.parse(orderOfThree());
    const r = (await runScenario(s, { request: client(bases.fixed, null), symbols: { "product.id": 1 } })) as ScenarioRun;
    const stock = obligationFromScenario(s, r, "req:stock", "exec-1");
    expect(stock).toMatchObject({ status: "passed", proofLevel: "state", stateVerified: true, oracleStrength: "strong", scenarioId: s.id, requirementIds: ["req:stock"] });
    expect(stock.proofs![0]).toMatchObject({ executionId: "exec-1", scenarioId: s.id, assertionId: "stock" });
    expect(obligationFromScenario(s, r, "req:total", "exec-1")).toMatchObject({ proofLevel: "response", oracleStrength: "strong" });
  });
});
