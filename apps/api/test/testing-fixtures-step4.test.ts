import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProjectDossier } from "@cybercheck/contracts";
import { fixtureSymbols, inventedSettings, settingSources, validateGraph, verifiedGraph } from "../src/testing/fixtures.ts";
import { buildObligations, routeArea, type FixtureNode } from "../src/testing/plan.ts";
// @ts-expect-error: plain JavaScript that runs inside the sandbox
import { client, fill, fillPath, inferCapture, runGraph } from "../src/testing/harness/lib.mjs";

const files = (entries: Record<string, string>) => ({ files: new Map(Object.entries(entries).map(([path, text]) => [path, { text }])) }) as never;
const endpoint = (method: string, path: string, control: string, mutates = false) => ({
  id: `${method} ${path}`,
  status: "confirmed",
  kind: "http",
  method,
  path,
  framework: "express",
  handler: { path: "src/app.js", line: 10 },
  control: { kind: control, reason: control === "none_found" ? "no guard found" : "requireUser middleware", evidence: [] },
  requestSchema: null,
  inputs: { params: null, query: null, body: null, files: false },
  mutates,
  sideEffects: [],
});
const dossier = (eps: unknown[], envVars: string[] = []) =>
  ({ entryPoints: eps, screens: [], background: [], integrations: [], dataModel: { entities: [], sources: [] }, deployment: { dockerfiles: [] }, config: { envVars: envVars.map((name) => ({ name, side: "server" })) } }) as unknown as ProjectDossier;

describe("fixture symbols and settings", () => {
  const graph = [
    { id: "seed", label: "Seed", kind: "command", dependsOn: [], command: "node seed.js", exports: ["ADMIN_EMAIL"], origin: "plan" },
    { id: "admin", label: "Sign in as admin", kind: "identity", dependsOn: ["seed"], auth: { kind: "login", tokenPath: "$.token" }, origin: "plan" },
    { id: "user", label: "A user", kind: "request", dependsOn: ["admin"], identity: "admin", steps: [{ method: "POST", path: "/api/users", expect: {}, capture: { name: "userId", path: "$.id" } }], origin: "plan" },
    { id: "order", label: "An order", kind: "request", dependsOn: ["user"], steps: [{ method: "POST", path: "/api/orders", json: { userId: "{{userId}}" }, expect: {} }], origin: "plan" },
  ] as unknown as FixtureNode[];

  it("lists every produced value with its producer, type and consumers", () => {
    const t = fixtureSymbols(graph);
    expect(t.find((s) => s.symbol === "user.userId")).toMatchObject({ nodeId: "user", jsonPath: "$.id", type: "id", consumers: ["order"] });
    expect(t.find((s) => s.symbol === "admin.token")).toMatchObject({ type: "token" });
    expect(t.find((s) => s.symbol === "seed.ADMIN_EMAIL")).toMatchObject({ type: "string" });
  });

  it("allows settings from the code, seed exports, tests and fixtures, and refuses invented ones", () => {
    const src = files({ "src/app.js": "process.env.JWT_SECRET", "test/login.test.js": "const pw = process.env.E2E_PASSWORD", "README.md": "Set ALICE_PASSWORD to log in" });
    const allowed = settingSources(dossier([], ["JWT_SECRET"]), src, graph);
    expect(["JWT_SECRET", "ADMIN_EMAIL", "E2E_PASSWORD", "CC_USER_PASSWORD"].every(allowed)).toBe(true);
    // Mentioned only in the README, or nowhere: invented.
    expect(inventedSettings({ headers: { "x-pass": "${ENV:ALICE_PASSWORD}", other: "${ENV:MADE_UP_TOKEN}" } }, allowed)).toEqual(["ALICE_PASSWORD", "MADE_UP_TOKEN"]);
  });

  it("refuses an invented setting in the setup graph before any sandbox runs", () => {
    const d = dossier([endpoint("POST", "/api/login", "public_intentional"), endpoint("GET", "/api/me", "session_required")]);
    const g = [{ id: "alice", label: "Sign in as Alice", kind: "identity", dependsOn: [], auth: { kind: "login", request: { method: "POST", path: "/api/login", json: { email: "a@x.test", password: "${ENV:ALICE_PASSWORD}" } }, tokenPath: "$.token" }, verify: { method: "GET", path: "/api/me" }, origin: "plan" }] as unknown as FixtureNode[];
    const { nodes, problems } = validateGraph(g, d, files({ "README.md": "ALICE_PASSWORD=secret" }));
    expect(nodes).toEqual([]);
    expect(problems[0]!.reason).toMatch(/ALICE_PASSWORD, which the code, its tests and its seed scripts never define/);
  });

  it("caches a repaired setup only when every repaired step worked, without the steps that failed", () => {
    const g = [
      { id: "a", dependsOn: [], origin: "plan" },
      { id: "b", dependsOn: ["a"], origin: "repair" },
      { id: "c", dependsOn: [], origin: "plan" },
      { id: "d", dependsOn: ["c"], origin: "plan" },
    ] as unknown as FixtureNode[];
    expect(verifiedGraph(g, [{ id: "a", ok: true }, { id: "b", ok: false }])).toBeNull();
    expect(verifiedGraph(g, [{ id: "a", ok: true }, { id: "b", ok: true }, { id: "c", ok: false }, { id: "d", ok: true }])!.map((n) => n.id)).toEqual(["a", "b"]);
    expect(verifiedGraph(g.filter((n) => n.origin === "plan"), [])).toBeNull();
  });
});

describe("routes and sign-in expectations", () => {
  it("groups routes by their first meaningful segment", () => {
    expect(routeArea("/api/search")).toBe("search");
    expect(routeArea("/api/v2/admin/users/:id")).toBe("admin");
    expect(routeArea("/:tenant/orders")).toBe("orders");
  });

  it("does not expect a public search to require sign-in because other /api routes do, and checks /api/admin roles", () => {
    const d = dossier([endpoint("GET", "/api/search", "none_found"), endpoint("GET", "/api/orders", "session_required"), endpoint("POST", "/api/orders", "session_required", true), endpoint("GET", "/api/admin/users", "session_required"), endpoint("GET", "/api/admin/stats", "none_found")]);
    const ids = buildObligations(d, [], { browser: false, database: false, load: [], viewports: [] }).map((o) => o.id);
    expect(ids).not.toContain("api:GET /api/search:unauthenticated");
    expect(ids).toContain("api:GET /api/orders:unauthenticated");
    // An unguarded route next to guarded ones in the same area is still expected to refuse anonymous users.
    expect(ids).toContain("api:GET /api/admin/stats:unauthenticated");
    expect(ids).toContain("api:GET /api/admin/users:wrong-role");
  });
});

describe("request values in the harness", () => {
  it("encodes values put into a path, and leaves text written into the path alone", () => {
    expect(fillPath("/api/files/{{name}}?q={{q}}", { name: "a/b c", q: "x&y=#1" }, {})).toBe("/api/files/a%2Fb%20c?q=x%26y%3D%231");
    expect(fillPath("/api/search?q=<script>{x}:y</script>", {}, {})).toBe("/api/search?q=<script>{x}:y</script>");
    expect(fillPath("/api/u/{{$uid}}", { $uid: "123456" }, {})).toBe("/api/u/123456");
    expect(fillPath("/api/u/{{customer-2.id}}", { "customer-2.id": "u/2" }, {})).toBe("/api/u/u%2F2");
    expect(fillPath("/api/{{missing}}", {}, {})).toBe("/api/{{missing}}");
    // Only a request's path is encoded; body fields named "path" keep their value.
    expect(fill({ method: "POST", path: "/x/{{id}}", json: { path: "{{dir}}/file" } }, { id: "1/2", dir: "a/b" }, {})).toEqual({ method: "POST", path: "/x/1%2F2", json: { path: "a/b/file" } });
  });

  it("finds a nested value under the name a setup step asked for", () => {
    expect(inferCapture({ user: { id: 5, email: "x" }, token: "t" }, "userId", "$.id")).toEqual({ path: "$.user.id", value: 5 });
    expect(inferCapture({ data: { order: { number: "A-1" } } }, "orderNumber", "$.orderNumber")).toEqual({ path: "$.data.order.number", value: "A-1" });
    expect(inferCapture({ items: [{ product: { id: 9 } }] }, "productId", "$.id")).toEqual({ path: "$.items.0.product.id", value: 9 });
    // Two candidates: no guess.
    expect(inferCapture({ user: { id: 5 }, owner: { user: { id: 6 } } }, "userId", "$.id")).toBeNull();
  });
});

describe("nested captures in a running setup", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/api/users" && req.method === "POST") return res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ user: { id: 7, email: "u@x.test" } }));
      if (req.url === "/api/users/7/orders") return res.writeHead(200, { "content-type": "application/json" }).end("[]");
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it("resolves userId from {user: {id}} and uses it in the next step", async () => {
    const nodes = [
      { id: "user", kind: "request", dependsOn: [], steps: [{ method: "POST", path: "/api/users", json: { email: "u@x.test" }, expect: { statusClass: ["2xx"] }, capture: { name: "userId", path: "$.id" } }] },
      { id: "orders", kind: "request", dependsOn: ["user"], steps: [{ method: "GET", path: "/api/users/{{userId}}/orders", expect: { statusClass: ["2xx"] } }] },
    ];
    const g = await runGraph(nodes, { request: client(base, null), env: {}, cwd: ".", base });
    expect(g.vars.userId).toBe(7);
    expect(g.ok.get("orders")).toBe(true);
  });
});

describe("credentials from the project's own tests", () => {
  it("repairs an invented password setting with the one the tests use for that account, never one from the docs", async () => {
    const { credentialFromTests } = await import("../src/testing/fixtures.ts");
    const { readFileSync } = await import("node:fs");
    const testText = readFileSync(new URL("./testing-bench/cybercheck-gauntlet/project/test/app.test.js", import.meta.url), "utf8");
    const src = files({ "test/app.test.js": testText, "README.md": "| customer | bob@example.test | BobPass123! |", "src/app.js": "app.post('/api/login', h)" });
    expect(credentialFromTests(src, "alice@example.test")).toBe("AlicePass123!");
    // Only the README knows Bob's password: documentation is not a credential source.
    expect(credentialFromTests(src, "bob@example.test")).toBeNull();

    const d = dossier([endpoint("POST", "/api/login", "public_intentional"), endpoint("GET", "/api/me", "session_required")]);
    const g = [{ id: "alice", label: "Sign in as Alice", kind: "identity", dependsOn: [], auth: { kind: "login", request: { method: "POST", path: "/api/login", json: { email: "alice@example.test", password: "${ENV:ALICE_PASSWORD}" } }, tokenPath: "$.token" }, verify: { method: "GET", path: "/api/me" }, origin: "plan" }] as unknown as FixtureNode[];
    const { nodes, problems } = validateGraph(g, d, src);
    expect(problems).toEqual([]);
    expect((nodes[0]!.auth!.request as { json: { password: string } }).json.password).toBe("AlicePass123!");
  });
});
