import { readdirSync, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CompiledScenario, type TestRequirement } from "@cybercheck/contracts";
import { compileScenario, endpointKeys, producerTable, type ScenarioRun } from "../src/testing/scenarios.ts";
import { gapsFirst } from "../src/testing/authoring-order.ts";
import { boundaryDates, buildScenario, documentedExamples, firstPageInCode, schemaRequirements, slotContext, slotProblems, templateScenarios, touchedRoutes, type CoreTemplate } from "../src/testing/templates.ts";
// @ts-expect-error: plain JavaScript that runs inside the sandbox
import { client, runScenario } from "../src/testing/harness/lib.mjs";

// ---------------------------------------------------------------- a small shop with every core behaviour, buggy or fixed

const STATES = ["pending", "paid", "packed", "shipped"];
function shop(buggy: boolean) {
  const products = [{ id: "p1", name: "Notebook", price: 4.25, stock: 20 }];
  const orders: Array<{ id: string; status: string; total: number; customerId: number }> = [{ id: "o1", status: "pending", total: 4.25, customerId: 1 }];
  const customers = new Set([1, 2]);
  const payments = new Map<string, number>();
  return createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    const send = (status: number, body: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const p = url.pathname;
      if (p === "/api/catalog" && req.method === "GET") return send(200, products);
      if (p === "/api/orders" && req.method === "POST") {
        let total = 0;
        for (const it of body.items) {
          const prod = products.find((x) => x.id === it.productId)!;
          total += buggy ? prod.price : prod.price * it.quantity;
          prod.stock -= buggy ? 1 : it.quantity;
        }
        const order = { id: `o${orders.length + 1}`, status: "pending", total: Math.round(total * 100) / 100, customerId: 1 };
        orders.push(order);
        return send(201, order);
      }
      if (p === "/api/orders" && req.method === "GET") {
        const page = Number(url.searchParams.get("page") ?? 1);
        const limit = Number(url.searchParams.get("limit") ?? 10);
        const from = buggy ? page * limit : (page - 1) * limit;
        return send(200, { page, limit, items: orders.slice(from, from + limit) });
      }
      const st = p.match(/^\/api\/orders\/(\w+)\/status$/);
      if (st && req.method === "POST") {
        const o = orders.find((x) => x.id === st[1]);
        if (!o) return send(404, {});
        if (!buggy && STATES.indexOf(body.status) < STATES.indexOf(o.status)) return send(409, { error: "status never moves backward" });
        o.status = body.status;
        return send(200, o);
      }
      if (p === "/api/coupons/validate" && req.method === "POST") {
        if (body.code !== "SAVE10") return send(404, { valid: false });
        const expires = "2026-2-01";
        const valid = buggy ? body.today <= expires : new Date(body.today) <= new Date("2026-02-01");
        return send(200, { valid, percent: 10 });
      }
      if (p === "/api/payments" && req.method === "POST") {
        if (!buggy && payments.has(body.id)) return send(409, { error: "duplicate payment" });
        payments.set(`${body.id}:${payments.size}`, body.amount);
        if (!buggy) payments.set(body.id, body.amount);
        return send(201, { id: body.id, status: "captured" });
      }
      const cu = p.match(/^\/api\/customers\/(\d+)$/);
      if (cu && req.method === "DELETE") {
        const id = Number(cu[1]);
        if (!buggy && orders.some((o) => o.customerId === id)) return send(409, { error: "customer has orders" });
        customers.delete(id);
        return send(200, { orphanOrders: orders.filter((o) => !customers.has(o.customerId)).length });
      }
      return send(404, {});
    });
  });
}

const APP_TEXT = `// handlers (the text the slot checks read)
app.get("/api/catalog", (req, res) => res.json(products)); // id name price stock p1 Notebook
app.post("/api/orders", requireUser, (req, res) => { items productId quantity total status id });
app.get("/api/orders", requireUser, (req, res) => {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 10);
  res.json({ page, limit, items });
});
app.post("/api/orders/:id/status", requireUser, (req, res) => { status pending paid packed shipped });
app.post("/api/coupons/validate", requireUser, (req, res) => { code SAVE10 today expires "2026-2-01" valid percent });
app.post("/api/payments", requireUser, (req, res) => { id amount captured });
app.delete("/api/customers/:id", requireUser, (req, res) => { orphanOrders customerId });
`;
const src = { files: new Map([["src/app.js", { path: "src/app.js", text: APP_TEXT, lines: APP_TEXT.split("\n").length }], ["README.md", { path: "README.md", text: "Three notebooks at $4.25 each cost $12.75 before tax.", lines: 1 }]]), allPaths: ["src/app.js", "README.md"] } as never;
const ep = (method: string, path: string, line: number) => ({ id: `${method} ${path}`, kind: "http", method, path, handler: { path: "src/app.js", line }, control: { kind: "session_required" } });
const dossier = {
  entryPoints: [ep("GET", "/api/catalog", 2), ep("POST", "/api/orders", 3), ep("GET", "/api/orders", 4), ep("POST", "/api/orders/:id/status", 9), ep("POST", "/api/coupons/validate", 10), ep("POST", "/api/payments", 11), ep("DELETE", "/api/customers/:id", 12)],
  config: { envVars: [] },
} as never;
const graph = [{ id: "customer", label: "Sign in as customer", kind: "identity", dependsOn: [], origin: "plan" }] as never;
const ctx = slotContext(dossier, src, ["customer"]);

const R = (id: string, template: CoreTemplate, requiredProof: TestRequirement["requiredProof"], asset: string): TestRequirement => ({ id, capability: "Shop", source: { kind: "documentation", path: "README.md", line: 1 }, expectedBehavior: id, affectedAssets: [asset], requiredProof, priority: "critical", template });
const req = (method: string, path: string, extra: Record<string, unknown> = {}) => ({ method, path, as: "customer", ...extra });

/** What the AI would name for each template, for this shop. */
const SLOTS: Record<CoreTemplate, { req: TestRequirement; slots: Record<string, unknown> }> = {
  calculation: { req: R("req-order-total", "calculation", "state", "POST /api/orders"), slots: { action: req("POST", "/api/orders", { body: { items: [{ productId: "p1", quantity: "$quantity" }] } }), totalPath: "$.total", unitPrice: 4.25, stockRead: { request: { method: "GET", path: "/api/catalog", as: null }, path: "$.0.stock" } } },
  pagination: { req: R("req-pages", "pagination", "response", "GET /api/orders"), slots: { list: req("GET", "/api/orders"), pageParam: "page", sizeParam: "limit", itemsPath: "$.items", idField: "id", firstPage: 0, create: req("POST", "/api/orders", { body: { items: [{ productId: "p1", quantity: 1 }] } }) } },
  state_transition: { req: R("req-status-order", "state_transition", "state", "POST /api/orders/:id/status"), slots: { create: req("POST", "/api/orders", { body: { items: [{ productId: "p1", quantity: 1 }] } }), idPath: "$.id", transition: req("POST", "/api/orders/:id/status", { pathParams: { id: "$id" }, body: { status: "$state" } }), states: STATES, read: { request: req("GET", "/api/orders", { query: { page: 1, limit: 100 } }), statePath: "$.items[id=$id].status" } } },
  date_boundary: { req: R("req-coupon-expiry", "date_boundary", "response", "POST /api/coupons/validate"), slots: { action: req("POST", "/api/coupons/validate", { body: { code: "SAVE10", today: "$date" } }), expiry: "2026-2-01", decision: { kind: "field", path: "$.valid", acceptedValue: true } } },
  idempotency: { req: R("req-payment-once", "idempotency", "response", "POST /api/payments"), slots: { action: req("POST", "/api/payments", { body: { id: "$key", amount: 5 } }) } },
  referential_integrity: { req: R("req-no-orphans", "referential_integrity", "response", "DELETE /api/customers/:id"), slots: { parentId: 1, delete: req("DELETE", "/api/customers/:id", { pathParams: { id: "$parent" } }), check: { on: "delete", kind: "zero", path: "$.orphanOrders" } } },
};
const requirements = Object.values(SLOTS).map((x) => x.req);

const servers: Server[] = [];
const start = async (buggy: boolean) => {
  const srv = shop(buggy);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  servers.push(srv);
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
};
afterAll(() => servers.forEach((s) => s.close()));

const build = (t: CoreTemplate) => {
  const { slots, problems } = slotProblems(t, SLOTS[t].slots, ctx);
  expect(problems, t).toEqual([]);
  const compiled = compileScenario(buildScenario(SLOTS[t].req, t, slots, ctx), { requirements, endpoints: endpointKeys(dossier), producers: producerTable(graph, dossier) });
  if (!compiled.ok) throw new Error(`${t} did not compile: ${compiled.problems.join("; ")}`);
  return compiled.scenario;
};
const run = async (base: string, s: CompiledScenario) => (await runScenario(s, { request: client(base, null), auths: { customer: { headers: {} } } })) as ScenarioRun;

describe("core templates against a buggy and a fixed shop", () => {
  const templates = Object.keys(SLOTS) as CoreTemplate[];
  // A fresh shop per template, so one scenario's records cannot hide or cause another's result.
  const bases: Record<string, { buggy: string; fixed: string }> = {};
  beforeAll(async () => {
    for (const t of templates) bases[t] = { buggy: await start(true), fixed: await start(false) };
  });

  for (const t of templates) {
    it(`${t}: finds the bug and passes the fixed app`, async () => {
      const s = build(t);
      const bad = await run(bases[t]!.buggy, s);
      expect(bad.status, `${t} buggy: ${bad.reason}`).toBe("failed");
      expect(bad.targetReached).toBe(true);
      const good = await run(bases[t]!.fixed, s);
      expect(good.status, `${t} fixed: ${good.reason}`).toBe("passed");
    });
  }

  it("uses the documented example and the values that expose each bug", () => {
    const calc = build("calculation");
    expect(calc.assertions.find((a) => a.id === "total")).toMatchObject({ expected: 12.75, says: expect.stringMatching(/as documented \(README.md:1\)/) });
    expect(JSON.stringify(calc.requests.find((r) => r.id === "order")!.body)).toContain('"quantity":3');
    // The handler's default page (page ?? 1) decides over the AI's guess of 0.
    expect(build("pagination").requests.find((r) => r.id === "page-a")!.query).toEqual([{ name: "page", value: 1 }, { name: "limit", value: 2 }]);
    expect(boundaryDates("2026-2-01")).toEqual({ valid: "2026-01-31", expired: "2026-02-02", discriminating: true });
    expect(boundaryDates("2026-10-15")).toMatchObject({ valid: "2026-10-14", expired: "2026-10-16", discriminating: false });
  });

  it("passes a delete the app refuses: the children keep their parent", async () => {
    const r = await run(bases.referential_integrity!.fixed, build("referential_integrity"));
    expect(r).toMatchObject({ status: "passed", reason: expect.stringMatching(/answered 409: the app refused it/) });
  });
});

describe("checking what the AI named", () => {
  it("refuses unknown endpoints and sign-ins, invented fields and values, and a missing marker", () => {
    const bad = { action: { method: "POST", path: "/api/checkout", as: "admin", body: { items: [{ sku: "zz-unknown", quantity: 3 }] } }, totalPath: "$.grandTotal", unitPrice: 9.99 };
    const { problems } = slotProblems("calculation", bad, ctx);
    const all = problems.join(" | ");
    expect(all).toMatch(/POST \/api\/checkout is not an endpoint of this project/);
    expect(all).toMatch(/no sign-in named "admin"/);
    expect(all).toMatch(/the field "sku" does not appear/);
    expect(all).toMatch(/the value "zz-unknown" does not appear/);
    expect(all).toMatch(/must carry the marker "\$quantity"/);
    expect(all).toMatch(/the field "grandTotal" in \$.grandTotal does not appear/);
    expect(all).toMatch(/unitPrice: 9.99 does not appear/);
  });

  it("turns a fill that cannot be used into an unfilled requirement with its reason", () => {
    const { proposals, unfilled } = templateScenarios(
      [
        { requirementId: "req-order-total", template: "calculation", slots: SLOTS.calculation.slots, problem: null },
        { requirementId: "req-pages", template: "pagination", slots: null, problem: "the app has no paginated list" },
        { requirementId: "req-coupon-expiry", template: "date_boundary", slots: { ...SLOTS.date_boundary.slots, expiry: "someday" }, problem: null },
      ],
      requirements,
      ctx,
    );
    expect(proposals.map((p) => p.requirementId)).toEqual(["req-order-total"]);
    expect(unfilled).toEqual([
      { requirementId: "req-pages", reason: "the app has no paginated list" },
      { requirementId: "req-coupon-expiry", reason: expect.stringMatching(/"someday" does not appear in the project.*not a year-month-day date/) },
    ]);
  });
});

describe("probes after templates", () => {
  it("sends request probes to the endpoints no template touches first", () => {
    const fills = [{ requirementId: "req-order-total", template: "calculation" as const, slots: SLOTS.calculation.slots, problem: null }];
    const targets = [{ method: "POST", path: "/api/orders" }, { method: "GET", path: "/api/catalog" }, { method: "POST", path: "/api/payments" }];
    expect(gapsFirst(targets, touchedRoutes(fills)).map((t) => `${t.method} ${t.path}`)).toEqual(["POST /api/payments", "POST /api/orders", "GET /api/catalog"]);
  });
});

describe("values from the project", () => {
  it("reads the documented worked example and the handler's first page", () => {
    expect(documentedExamples(src)).toEqual([{ quantity: 3, unit: 4.25, total: 12.75, path: "README.md", line: 1 }]);
    expect(firstPageInCode(dossier, src, "GET", "/api/orders", "page")).toBe(1);
    expect(firstPageInCode(dossier, src, "GET", "/api/orders", "offset")).toBeNull();
  });

  it("makes a referential-integrity requirement from each declared foreign key the API can delete the parent of", () => {
    const dir = join(import.meta.dirname, "testing-bench/cybercheck-gauntlet/project");
    const files = new Map<string, { path: string; text: string; lines: number }>();
    const walkDir = (d: string) => {
      for (const n of readdirSync(d)) {
        const full = join(d, n);
        if (n === "node_modules") continue;
        if (statSync(full).isDirectory()) walkDir(full);
        else {
          const p = relative(dir, full).replace(/\\/g, "/");
          const text = readFileSync(full, "utf8");
          files.set(p, { path: p, text, lines: text.split("\n").length });
        }
      }
    };
    walkDir(dir);
    const gauntlet = { files, allPaths: [...files.keys()] } as never;
    const d = { entryPoints: [{ method: "DELETE", path: "/api/data/customers/:id" }, { method: "DELETE", path: "/api/users/:id" }, { method: "GET", path: "/api/data/customers" }] } as never;
    expect(schemaRequirements(d, gauntlet)).toEqual([
      expect.objectContaining({ id: "req-fk-data-orders-customer-id", template: "referential_integrity", requiredProof: "response", affectedAssets: ["DELETE /api/data/customers/:id"], source: expect.objectContaining({ kind: "protocol", path: "src/database.js", line: 7, quote: expect.stringContaining("REFERENCES customers(id)") }) }),
    ]);
  });
});
