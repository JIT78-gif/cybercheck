import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Obligation, ProjectDossier, TestFinding } from "@cybercheck/contracts";
import { INTERACTIVE, NEEDS_NETWORK, identityFor, journeyProblems, syntaxError, wrongRoleIdentity, type BootApp } from "../src/testing/agents.ts";
import { capabilityOfPath, classify, completeness, evidenceFactor, productHealth, releaseDecision, testedFactor } from "../src/testing/assurance.ts";
import { validateGraph } from "../src/testing/fixtures.ts";
import type { FixtureNode } from "../src/testing/plan.ts";
// @ts-expect-error: plain JavaScript that runs inside the sandbox
import { client, runGraph } from "../src/testing/harness/lib.mjs";

const ob = (id: string, status: Obligation["status"], priority: Obligation["priority"] = "high", extra: Partial<Obligation> = {}): Obligation => {
  const base: Obligation = { id, layer: id.startsWith("env:") ? "environment" : id.startsWith("ui:") ? "ui" : "api", asset: { kind: "endpoint", ref: id, label: id }, objective: id, priority, oracle: { source: "code_contract", expected: "x", evidence: [] }, status, reason: status === "passed" ? null : "because", origin: "dossier", executionIds: ["e1"], findingIds: [] };
  return { ...base, ...classify(base), ...extra };
};

describe("assurance arithmetic (blueprint formulas)", () => {
  it("weights decisive, strong evidence fully and guard-only or inconclusive evidence partly", () => {
    expect(testedFactor(ob("a", "passed"))).toBe(1);
    expect(testedFactor(ob("a", "inconclusive"))).toBe(0.25);
    expect(testedFactor(ob("a", "blocked"))).toBe(0);
    expect(evidenceFactor(ob("api:GET /x:no-server-error", "passed"))).toBe(0.35); // weak: no 5xx only
    expect(evidenceFactor(ob("api:GET /x:unauthenticated", "passed"))).toBe(0.7); // guard: moderate
    expect(evidenceFactor(ob("env:build:.", "passed"))).toBe(1); // static: strong
    expect(evidenceFactor(ob("api:POST /x:authored:1", "passed", "high", { oracleStrength: "strong", proofClass: "state_change", stateVerified: false }))).toBe(0.7);
    expect(evidenceFactor(ob("api:POST /x:authored:1", "passed", "high", { oracleStrength: "strong", proofClass: "state_change", stateVerified: true, reachedTarget: true }))).toBe(1);
  });

  it("computes completeness and product health separately (worked example)", () => {
    const obs = [
      ob("env:build:.", "passed", "high"), // 5 x 1 x 1 = 5
      ob("env:typecheck:.", "failed", "high"), // 5 x 1 x 1 = 5 (a correct failure is full testing evidence)
      ob("api:GET /a:unauthenticated", "passed", "critical"), // 8 x 1 x 0.7 = 5.6
      ob("api:GET /b:no-server-error", "inconclusive", "high"), // 5 x 0.25 x 0.35 = 0.4375
      ob("ui:/:renders", "unsupported", "medium"), // 3 x 0 = 0
      ob("suite:runs:web", "not_applicable", "high"), // not applicable: excluded
    ];
    const c = completeness(obs);
    expect(c.applicableWeight).toBe(26);
    expect(c.earnedWeight).toBe(16);
    expect(c.percent).toBe(61.7);
    expect(c.criticalDecisive).toBe(1);
    expect(c.criticalTotal).toBe(1);
    const h = productHealth(obs);
    expect(h.passedWeight).toBe(13);
    expect(h.decisiveWeight).toBe(18);
    expect(h.percent).toBe(72.2);
    expect(h.excluded).toEqual({ inconclusive: 1, blocked: 0, unsupported: 1, skipped: 0 });
  });

  it("never releases on insufficient evidence, and names a product failure when the code broke the build", () => {
    const obs = [ob("env:install:.", "passed", "critical"), ob("env:build:.", "passed", "high"), ob("api:GET /a:unauthenticated", "passed", "critical"), ob("ui:/:renders", "unsupported", "medium")];
    const r = releaseDecision({ obs, findings: [], completeness: completeness(obs), auditOk: true, thresholdsSet: false });
    expect(r.decision).toBe("not_ready_insufficient_evidence");
    expect(r.gates.find((g) => g.id === "journeys")?.ok).toBe(false);
    const broken = [ob("env:install:.", "passed", "critical"), ob("env:typecheck:.", "failed", "high", { findingIds: ["F1"] })];
    const f: TestFinding = { id: "F1", kind: "product_defect", status: "confirmed", severity: "medium", confidence: "high", title: "Type errors", expected: "", actual: "", reproduction: "", rootCause: null, location: null, obligationIds: ["env:typecheck:."], executionIds: ["e1"], validation: "", limitation: null, layer: "environment" };
    expect(releaseDecision({ obs: broken, findings: [f], completeness: completeness(broken), auditOk: true, thresholdsSet: false }).decision).toBe("not_ready_product_failures");
    const full = [ob("env:install:.", "passed", "critical"), ob("env:build:.", "passed", "high")];
    expect(releaseDecision({ obs: full, findings: [], completeness: completeness(full), auditOk: true, thresholdsSet: false }).decision).toBe("ready");
  });

  it("groups routes and screens by user goal, not by role prefix", () => {
    const roles = new Set(["admin", "staff", "customer"]);
    expect(capabilityOfPath("/admin/menu/items/:id", roles)).toBe("Menu");
    expect(capabilityOfPath("/api/v1/orders", roles)).toBe("Orders");
    expect(capabilityOfPath("/auth/login", roles)).toBe("Sign-in");
    expect(capabilityOfPath("/customer/orders/{id}", roles)).toBe("Orders");
    expect(capabilityOfPath("/admin", roles)).toBe("Admin");
    expect(capabilityOfPath("/", roles)).toBe("Home");
  });
});

describe("classification of tool output (real outputs from a user's run)", () => {
  it("recognises an interactive ESLint setup and an offline Google Fonts build", () => {
    expect(INTERACTIVE.test("? How would you like to configure ESLint? https://nextjs.org/docs/basic-features/eslint")).toBe(true);
    expect(NEEDS_NETWORK.test("FetchError: request to https://fonts.googleapis.com/css2?family=Fraunces failed, reason: getaddrinfo EAI_AGAIN fonts.googleapis.com")).toBe(true);
    expect(NEEDS_NETWORK.test("`next/font` error:\nFailed to fetch `Fraunces` from Google Fonts.")).toBe(true);
    expect(INTERACTIVE.test("src/a.ts(3,1): error TS2307: Cannot find module './routes/orders'.")).toBe(false);
    expect(NEEDS_NETWORK.test("src/a.ts(3,1): error TS2307: Cannot find module './routes/orders'.")).toBe(false);
  });

  it("gives settings plausible synthetic values (an ADMIN name is not a MIN number)", async () => {
    const { syntheticValue } = await import("../src/testing/agents.ts");
    expect(syntheticValue("DEMO_ADMIN_EMAIL", "s")).toBe("demo-admin@example.com");
    expect(syntheticValue("DEMO_STAFF_EMAIL", "s")).toBe("demo-staff@example.com");
    expect(syntheticValue("DEMO_ADMIN_PASSWORD", "s")).toMatch(/^cc-test-/);
    expect(syntheticValue("CC_ADMIN_PASSWORD", "s")).toMatch(/^Cc-.{16}-7x$/);
    expect(syntheticValue("TOKEN_TTL", "s")).toBe("10");
    expect(syntheticValue("REMINDER_HOUR_IST", "s")).toBe("9");
    expect(syntheticValue("MAX_ITEMS", "s")).toBe("10");
  });

  it("catches a generated test that does not compile before any sandbox time is spent", async () => {
    expect(await syntaxError('import { test } from "node:test";\ntest("x", () => { const v = await f(); });', true)).toMatch(/await/);
    expect(await syntaxError('import { test } from "node:test";\ntest("x", async () => { const v: number = await f(); });', true)).toBeNull();
  });
});

describe("the fixture graph is validated before it runs", () => {
  const d = {
    entryPoints: [
      { kind: "http", method: "POST", path: "/auth/activate" },
      { kind: "http", method: "POST", path: "/auth/login" },
      { kind: "http", method: "GET", path: "/admin/me" },
    ],
    config: { envVars: [{ name: "DEMO_ADMIN_PASSWORD" }] },
  } as unknown as ProjectDossier;
  const src = { files: new Map([["seed.py", { path: "seed.py", text: "print('LICENSE_KEY=abc')", lines: 1 }]]), allPaths: [], skipped: new Map(), excluded: new Map() } as never;
  const node = (n: Partial<FixtureNode> & { id: string }): FixtureNode => ({ label: n.id, kind: "request", dependsOn: [], origin: "plan", ...n });

  it("keeps a valid chain in order and drops cycles, invented endpoints, guessed settings and unproduced values", () => {
    const { nodes, problems } = validateGraph(
      [
        node({ id: "admin", kind: "identity", dependsOn: ["activate"], auth: { kind: "login", request: { method: "POST", path: "/auth/login", json: { password: "${ENV:DEMO_ADMIN_PASSWORD}" } } }, verify: { method: "GET", path: "/admin/me" } }),
        node({ id: "activate", dependsOn: ["seed"], steps: [{ method: "POST", path: "/auth/activate", json: { key: "{{LICENSE_KEY}}" }, expect: { statusClass: ["2xx"] } }] }),
        node({ id: "seed", kind: "command", command: "python seed.py", exports: ["LICENSE_KEY"] }),
        node({ id: "loop-a", dependsOn: ["loop-b"], steps: [] }),
        node({ id: "loop-b", dependsOn: ["loop-a"], steps: [] }),
        node({ id: "invented", steps: [{ method: "POST", path: "/admin/license/redeem", expect: {} }] }),
        node({ id: "guessed", kind: "identity", auth: { kind: "bearer", token: "${ENV:MADE_UP_TOKEN}" } }),
        // A password cybercheck invents for an account its own setup creates is allowed (CC_ prefix).
        node({ id: "own-account", steps: [{ method: "POST", path: "/auth/activate", json: { key: "{{LICENSE_KEY}}", password: "${ENV:CC_ADMIN_PASSWORD}" }, expect: { status: [200] } }] }),
        node({ id: "orphan-value", steps: [{ method: "POST", path: "/auth/activate", json: { key: "{{nobody}}" }, expect: {} }] }),
        node({ id: "after-invalid", dependsOn: ["invented"], steps: [] }),
      ],
      d,
      src,
    );
    expect(nodes.map((n) => n.id)).toEqual(["seed", "activate", "own-account", "admin"]);
    // Its exact 200 was relaxed to any 2xx, and its dependency on the seed was inferred from {{LICENSE_KEY}}.
    expect(nodes.find((n) => n.id === "own-account")).toMatchObject({ dependsOn: ["seed"], steps: [{ expect: { statusClass: ["2xx"] } }] });
    const why = Object.fromEntries(problems.map((p) => [p.id, p.reason]));
    expect(why["loop-a"]).toMatch(/cycle/);
    expect(why["invented"]).toMatch(/not an endpoint/);
    expect(why["guessed"]).toMatch(/MADE_UP_TOKEN/);
    expect(why["orphan-value"]).toMatch(/\{\{nobody\}\}/);
    expect(why["after-invalid"]).toMatch(/invalid/);
  });

  it("replaces a guessed id with the one another step captures, and runs after it", () => {
    const { nodes } = validateGraph(
      [
        node({ id: "checkin", steps: [{ method: "POST", path: "/auth/activate", json: { table_id: 1, name: "x" }, expect: { statusClass: ["2xx"] } }] }),
        node({ id: "table", steps: [{ method: "POST", path: "/auth/activate", json: {}, expect: { statusClass: ["2xx"] }, capture: { name: "tableId", path: "id" } }] }),
      ],
      d,
      src,
    );
    const checkin = nodes.find((n) => n.id === "checkin")!;
    expect(checkin.steps![0]!.json).toEqual({ table_id: "{{tableId}}", name: "x" });
    expect(checkin.dependsOn).toEqual(["table"]);
    expect(nodes.map((n) => n.id)).toEqual(["table", "checkin"]);
  });
});

describe("the sandbox harness runs the graph once and never trusts an unverified sign-in", () => {
  let server: Server;
  let base = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/auth/login") {
          // Login "works" (200 and a token) but the account was never activated, so the token is useless.
          return res.end(JSON.stringify({ access_token: "tok" }));
        }
        if (req.url === "/admin/me") {
          res.statusCode = req.headers.authorization === "Bearer good" ? 200 : 401;
          return res.end("{}");
        }
        if (req.url === "/items" && req.method === "POST") return res.end(JSON.stringify({ id: 42, echo: JSON.parse(body || "{}") }));
        if (req.url === "/tables" && req.method === "POST") {
          // FastAPI-style: number must be a string.
          const b = JSON.parse(body || "{}");
          if (typeof b.number !== "string") {
            res.statusCode = 422;
            return res.end(JSON.stringify({ detail: [{ type: "string_type", loc: ["body", "number"], msg: "Input should be a valid string", input: b.number }] }));
          }
          return res.end(JSON.stringify({ id: 7, number: b.number }));
        }
        if (req.url === "/checkin" && req.method === "POST") return res.end(JSON.stringify({ session: "s-123456789", table_id: 7 }));
        res.statusCode = 404;
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("marks the identity failed when a protected request still refuses it, and skips what depends on it", async () => {
    const graph = await runGraph(
      [
        { id: "admin", kind: "identity", dependsOn: [], auth: { kind: "login", request: { method: "POST", path: "/auth/login", json: { password: "${ENV:ADMIN_PASSWORD}" } }, tokenPath: "access_token" }, verify: { method: "GET", path: "/admin/me" } },
        { id: "item", kind: "request", dependsOn: ["admin"], identity: "admin", steps: [{ method: "POST", path: "/items", json: { name: "x-{{$uid}}" }, expect: { statusClass: ["2xx"] }, capture: { name: "itemId", path: "id" } }] },
        { id: "public-item", kind: "request", dependsOn: [], steps: [{ method: "POST", path: "/items", json: { secret: "${ENV:ADMIN_PASSWORD}" }, expect: { statusClass: ["2xx"] }, capture: { name: "itemId2", path: "id" } }] },
      ],
      { request: client(base, null), env: { ADMIN_PASSWORD: "synthetic" }, cwd: ".", base },
    );
    const byId = Object.fromEntries(graph.results.map((r: { id: string }) => [r.id, r]));
    expect(byId.admin.ok).toBe(false);
    expect(byId.admin.note).toMatch(/still refused/);
    expect(byId.item.ok).toBe(false);
    expect(byId.item.skipped).toBe(true);
    expect(byId["public-item"].ok).toBe(true);
    expect(graph.vars.itemId2).toBe(42);
    // Setup steps recover from a planner's small mistakes: a wrong field type after a typed 422, and a capture path
    // the response does not have when exactly one key matches the capture's name.
    const setup = await runGraph(
      [
        { id: "table", kind: "request", dependsOn: [], steps: [{ method: "POST", path: "/tables", json: { number: 1 }, expect: { statusClass: ["2xx"] }, capture: { name: "tableId", path: "id" } }] },
        { id: "checkin", kind: "request", dependsOn: ["table"], steps: [{ method: "POST", path: "/checkin", json: { table_id: "{{tableId}}" }, expect: { statusClass: ["2xx"] }, capture: { name: "customerSession", path: "token" } }] },
      ],
      { request: client(base, null), env: {}, cwd: ".", base },
    );
    expect(setup.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true]);
    expect(setup.results[0].note).toMatch(/body corrected/);
    expect(setup.vars.customerSession).toBe("s-123456789");
    // A sign-in value under another name ("token" asked, "session" returned) is still found; a value that is
    // simply absent fails the step with the fields the answer had, so the setup repair can see them.
    const renamed = await runGraph(
      [
        { id: "checkin", kind: "request", dependsOn: [], steps: [{ method: "POST", path: "/checkin", json: {}, expect: { statusClass: ["2xx"] }, capture: { name: "customerToken", path: "token" } }] },
        { id: "order", kind: "request", dependsOn: [], steps: [{ method: "POST", path: "/checkin", json: {}, expect: { statusClass: ["2xx"] }, capture: { name: "orderId", path: "order.id" } }] },
      ],
      { request: client(base, null), env: {}, cwd: ".", base },
    );
    expect(renamed.vars.customerToken).toBe("s-123456789");
    expect(renamed.results[1].ok).toBe(false);
    expect(renamed.results[1].note).toMatch(/no "order.id".*session, table_id/);
    // Settings are filled in, but captured secrets never appear in the notes.
    expect(JSON.stringify(graph.results)).not.toContain("synthetic");
  });
});

describe("browser journeys are grounded in the frontend code", () => {
  const d = { screens: [{ url: "/login" }, { url: "/admin/menu" }, { url: "/c/:cafeId/:tableId" }] } as unknown as ProjectDossier;
  const corpus = "<label>email</label> <button>sign in</button> <h1>menu</h1> add item";
  it("rejects journeys that go to unknown screens, use invented labels or check nothing", () => {
    const ok = { steps: [{ action: "goto" as const, path: "/login" }, { action: "fill" as const, target: { label: "Email" }, value: "a@example.com" }, { action: "click" as const, target: { role: "button", name: "Sign in" } }, { action: "expectText" as const, value: "Menu" }] };
    expect(journeyProblems(ok, d, corpus)).toBeNull();
    expect(journeyProblems({ steps: [{ action: "goto", path: "/c/12/3" }, { action: "expectText", value: "Menu" }] }, d, corpus)).toBeNull();
    expect(journeyProblems({ steps: [{ action: "goto", path: "/settings" }, { action: "expectText", value: "Menu" }] }, d, corpus)).toMatch(/not a screen/);
    expect(journeyProblems({ steps: [{ action: "goto", path: "/login" }, { action: "click", target: { role: "button", name: "Log in now" } }, { action: "expectText", value: "Menu" }] }, d, corpus)).toMatch(/does not appear/);
    expect(journeyProblems({ steps: [{ action: "goto", path: "/login" }, { action: "click", target: { role: "button", name: "Sign in" } }] }, d, corpus)).toMatch(/visible result/);
  });
});

describe("identities per role", () => {
  const id = (name: string, appliesTo: string[]) => ({ name, kind: "login" as const, appliesTo, dependsOn: [], verify: null, evidence: [] });
  const app = { identities: [id("customer", ["session_required"]), id("staff", ["role_required", "session_required"]), id("admin", ["role_required", "session_required"])] } as unknown as BootApp;

  it("runs a role route as the identity named after its path segment", () => {
    expect(identityFor(app, "role_required", "/admin/menu/items")).toBe("admin");
    expect(identityFor(app, "role_required", "/staff/orders/:id")).toBe("staff");
    expect(identityFor(app, "role_required", "/reports")).toBe("staff");
  });

  it("picks the next lower role for the wrong-role check, and none when nothing ranks lower", () => {
    expect(wrongRoleIdentity(app, "/admin/menu/items")).toBe("staff");
    expect(wrongRoleIdentity(app, "/staff/orders")).toBe("customer");
    expect(wrongRoleIdentity({ identities: [id("admin", ["role_required"])] } as unknown as BootApp, "/admin/x")).toBeNull();
  });
});

describe("findings point at real causes", () => {
  it("finds the source line of an element axe named, from its class or id", async () => {
    const { sourceOf } = await import("../src/testing/browser.ts");
    const files = new Map([
      ["frontend/app/admin/menu/page.tsx", { text: 'export default function P() {\n  return <form>\n    <button className="btn-primary sm:col-span-1"><Plus /></button>\n  </form>;\n}' }],
      ["frontend/components/Nav.tsx", { text: 'export const Nav = () => <nav id="main-nav" className="overflow-x-auto" />;' }],
    ]);
    const ctx = { src: { files } } as never;
    expect(sourceOf(ctx, "frontend/app/admin/menu/page.tsx", '<button class="btn-primary sm:col-span-1">')).toEqual({ path: "frontend/app/admin/menu/page.tsx", line: 3 });
    expect(sourceOf(ctx, "frontend/app/admin/menu/page.tsx", "nav#main-nav.overflow-x-auto (5 px)")).toEqual({ path: "frontend/components/Nav.tsx", line: 1 });
    expect(sourceOf(ctx, "frontend/app/admin/menu/page.tsx", "<div>")).toBeNull();
  });

  it("raises wrong money and crashes to at least high, and leaves accessibility to axe's impact", async () => {
    const { severityFloor } = await import("../src/testing/runtime.ts");
    const f = (title: string, extra = {}) => ({ kind: "product_defect" as const, severity: "medium" as const, title, rootCause: null, expected: "", layer: "api" as const, ...extra });
    expect(severityFloor(f("Order total ignores item quantity"))).toBe("high");
    expect(severityFloor(f("One database error stops the whole server"))).toBe("high");
    expect(severityFloor(f("Cart PATCH accepts quantity 0"))).toBe("medium");
    expect(severityFloor(f("Price input has no label", { layer: "accessibility" }))).toBe("medium");
    expect(severityFloor(f("Total is wrong", { kind: "test_defect" }))).toBe("medium");
  });

  it("groups checks without a verdict by root cause, not by instance", async () => {
    const { causeOf } = await import("../src/testing/report.ts");
    const a = ob("api:GET /a:authored:1", "inconclusive", "high", { reason: "The check itself was wrong: expected 200 for staff" });
    const b = ob("api:GET /b:authored:2", "inconclusive", "high", { reason: "The check itself was wrong: wrong response shape" });
    expect(causeOf(a)).toBe(causeOf(b));
    expect(causeOf(ob("api:GET /c:no-server-error", "blocked", "high", { blockedBy: "fixture", reason: 'Not sent: cybercheck\'s own setup step "Sign in as customer" did not work' }))).toMatch(/could not set up/);
    expect(causeOf(ob("api:GET /d:x", "inconclusive", "high", { reason: "Answered 404 for item 42 after 3 tries; more text here." }))).toBe("Answered N for item N after N tries");
    expect(causeOf(ob("api:GET /d:x", "inconclusive", "high", { reason: "Answered 404 for item 42 after 3 tries; more text here." }), false)).toBe("Answered 404 for item 42 after 3 tries");
  });

  it("never sends a request whose setting was not provided", () => {
    // @ts-expect-error: plain JavaScript
    return import("../src/testing/harness/lib.mjs").then(({ fill, unfilled, missingText }) => {
      const step = fill({ method: "POST", path: "/login", json: { password: "${ENV:UNKNOWN_PASSWORD}" } }, {}, { KNOWN: "x" });
      expect(unfilled(step)).toBe("ENV:UNKNOWN_PASSWORD");
      expect(missingText("ENV:UNKNOWN_PASSWORD")).toMatch(/setting UNKNOWN_PASSWORD was not provided/);
      expect(unfilled(fill({ method: "GET", path: "/x", json: { a: "${ENV:KNOWN}" } }, {}, { KNOWN: "x" }))).toBeNull();
    });
  });
});

describe("triage sees the declared schema", () => {
  it("adds the CREATE TABLE of tables the handler writes", async () => {
    const { schemaContext } = await import("../src/testing/probes.ts");
    const files = new Map([
      ["app/routers/admin.py", { text: '@router.post("/tables")\ndef create_table(req):\n    conn.execute("INSERT INTO tables (cafe_id, table_number) VALUES (?, ?)", (1, 2))\n' }],
      ["app/db.py", { text: "SCHEMA = '''\nCREATE TABLE IF NOT EXISTS tables (\n    id INTEGER PRIMARY KEY,\n    UNIQUE (cafe_id, table_number)\n);\n'''" }],
    ]);
    const out = schemaContext({ src: { files } } as never, "app/routers/admin.py", 1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/UNIQUE \(cafe_id, table_number\)/);
  });
});

describe("elements on several screens are located in their shared component", () => {
  it("looks in shared files before the screen when asked", async () => {
    const { sourceOf } = await import("../src/testing/browser.ts");
    const files = new Map([
      ["frontend/app/admin/menu/page.tsx", { text: 'export default () => <div className="flex items-center">menu</div>;' }],
      ["frontend/components/DashboardShell.tsx", { text: 'export const Shell = () => (\n  <header>\n    <div className="flex items-center">bar</div>\n  </header>\n);' }],
    ]);
    const ctx = { src: { files } } as never;
    expect(sourceOf(ctx, "frontend/app/admin/menu/page.tsx", "div.flex.items-center")).toEqual({ path: "frontend/app/admin/menu/page.tsx", line: 1 });
    expect(sourceOf(ctx, "frontend/app/admin/menu/page.tsx", "div.flex.items-center", true)).toEqual({ path: "frontend/components/DashboardShell.tsx", line: 3 });
  });
});

describe("two defects in one handler stay two findings", () => {
  it("merges findings that describe the same behaviour, not ones that are merely close", async () => {
    const { sameSubject } = await import("../src/testing/triage.ts");
    const crash = { title: "Malformed cart item id crashes the server", rootCause: "Number(req.params.id) gives NaN; the database rejects it and the unhandled rejection stops Node." };
    const range = { title: "Cart item PATCH accepts quantity 0 and 11", rootCause: "The handler only checks Number.isInteger(quantity), not the documented 1 to 10 range." };
    const crash2 = { title: "Invalid id stops the process", rootCause: "NaN from Number(req.params.id) reaches the database; the unhandled rejection crashes Node." };
    expect(sameSubject(crash, range)).toBe(false);
    expect(sameSubject(crash, crash2)).toBe(true);
  });
});

describe("journey texts with generated values", () => {
  it("checks the fixed pieces of a text that contains {{$uid}}", () => {
    const d = { screens: [{ url: "/admin" }] } as unknown as ProjectDossier;
    const corpus = "<li>table {t.number} (guest link: /c/{t.id})</li> <label>number</label> <button>add table</button>";
    const steps = (expect: string) => ({ steps: [{ action: "goto" as const, path: "/admin" }, { action: "fill" as const, target: { label: "Number" }, value: "T{{$uid}}" }, { action: "click" as const, target: { role: "button", name: "Add table" } }, { action: "expectText" as const, value: expect }] });
    expect(journeyProblems(steps("Table {{$uid}} (guest link: /c/"), d, corpus)).toBeNull();
    expect(journeyProblems(steps("Seat {{$uid}} reserved for tonight"), d, corpus)).toMatch(/appears nowhere/);
  });
});

describe("credential placeholders bind to existing sign-ins", () => {
  it("runs a step as the identity its unproduced token names or whose header it sends", async () => {
    const { bindCredentialPlaceholders } = await import("../src/testing/fixtures.ts");
    const nodes = [
      { id: "admin", label: "admin", kind: "identity", dependsOn: [], origin: "plan", auth: { kind: "login" } },
      { id: "staff", label: "staff", kind: "identity", dependsOn: [], origin: "plan", auth: { kind: "login" } },
      { id: "customer", label: "customer", kind: "identity", dependsOn: [], origin: "plan", auth: { kind: "header", header: "X-Session-Token", value: "{{session}}" } },
    ] as unknown as FixtureNode[];
    const steps = [
      { method: "GET", path: "/admin/tables", headers: { Authorization: "Bearer {{admin_token}}" }, expect: {} },
      { method: "POST", path: "/customer/orders", headers: { "x-session-token": "{{session_token}}" }, expect: {} },
      { method: "GET", path: "/x", headers: { Authorization: "Bearer {{tok}}" }, expect: {} },
    ] as never[];
    expect(bindCredentialPlaceholders(steps, nodes, new Set(["tok"]))).toBe("admin");
    expect(steps.map((s: { as?: string; headers?: object }) => [s.as ?? null, s.headers ?? null])).toEqual([["admin", null], ["customer", null], [null, { Authorization: "Bearer {{tok}}" }]]);
  });
});

describe("placeholder spellings", () => {
  it("renames a placeholder to the one produced value with the same name in another style", async () => {
    const { aliasPlaceholders } = await import("../src/testing/fixtures.ts");
    const steps = [{ path: "/staff/orders/{{orderId}}", json: { menu_item_id: "{{menuItemId}}", x: "{{$uid}}", y: "{{nobody}}" } }];
    expect(aliasPlaceholders(steps, new Set(["order_id", "item_id", "session"]))).toEqual([{ path: "/staff/orders/{{order_id}}", json: { menu_item_id: "{{item_id}}", x: "{{$uid}}", y: "{{nobody}}" } }]);
    // Two possible matches: left alone rather than guessed.
    expect(aliasPlaceholders([{ path: "/x/{{itemId}}" }], new Set(["menu_item_id", "cart_item_id"]))).toEqual([{ path: "/x/{{itemId}}" }]);
  });
});

describe("live actions from the sandbox output", () => {
  it("reads each @@cc line once, skips malformed ones, and keeps them out of the saved output", async () => {
    const { liveActions, describeAction, withoutLiveLines } = await import("../src/testing/runtime.ts");
    const seen = new Set<string>();
    const first = 'boot ok\n@@cc {"k":"req","method":"GET","path":"/a","status":200,"ms":5,"ok":true,"as":null,"check":"api:GET /a:x"}\n@@cc {not json}\n@@cc {"k":"bogus"}\n@@cc {"k":"note","text":"Setup';
    const a = liveActions(first, seen);
    expect(a).toHaveLength(1);
    expect(describeAction(a[0]!)).toBe("GET /a answered 200");
    // The next poll repeats the earlier lines and completes the cut one: only the new action comes back.
    const second = `${first} \"seed\": done"}\n@@cc {"k":"note","text":"Setup \\"seed\\": done"}\n`;
    const b = liveActions(second, seen);
    expect(b.map((x) => x.k)).toEqual(["note"]);
    expect(withoutLiveLines(first)).toBe("boot ok");
  });
});
