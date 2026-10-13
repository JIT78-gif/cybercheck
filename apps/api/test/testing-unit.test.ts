import { describe, expect, it } from "vitest";
import { parseJestJson, parseJunit, parseLogSummary, progressFromLog } from "../src/testing/reports.ts";
import { concretePath } from "../src/testing/plan.ts";
import { syntheticValue, validEvidence } from "../src/testing/agents.ts";
import { audit } from "../src/testing/report.ts";
import type { Obligation, TestingReport } from "@cybercheck/contracts";

describe("report parsers", () => {
  it("reads vitest JUnit with one failure", () => {
    const xml = `<?xml version="1.0"?><testsuites name="vitest tests" tests="3" failures="1">
      <testsuite name="src/fees.test.ts" tests="3">
        <testcase classname="src/fees.test.ts" name="fees &gt; rounds half up" time="0.003"><failure message="expected 1.01 to be 1.02" type="AssertionError">AssertionError: expected 1.01 to be 1.02
 ❯ src/fees.test.ts:14:22</failure></testcase>
        <testcase classname="src/fees.test.ts" name="fees &gt; zero" time="0.001"></testcase>
        <testcase classname="src/fees.test.ts" name="fees &gt; skipped one" time="0"><skipped/></testcase>
      </testsuite></testsuites>`;
    const r = parseJunit(xml);
    expect(r).toMatchObject({ source: "report", total: 3, passed: 1, failed: 1, skipped: 1 });
    expect(r.failures[0]!.detail).toContain("src/fees.test.ts:14:22");
    expect(r.cases[0]!.name).toContain("rounds half up");
  });

  it("drops node:test's file-level wrapper case", () => {
    const xml = `<testsuites><testcase name="a.test.js" classname="test" failure="test failed"><failure type="testCodeFailure" message="test failed">x</failure></testcase>
      <testcase name="ms parses" classname="test" file="/work/app/a.test.js"></testcase>
      <testcase name="fails on purpose" classname="test" file="/work/app/a.test.js"><failure message="Expected values to be strictly equal">AssertionError</failure></testcase></testsuites>`;
    const r = parseJunit(xml);
    expect(r.total).toBe(2);
    expect(r.failed).toBe(1);
  });

  it("reads jest JSON, including files that fail to load", () => {
    const json = JSON.stringify({ numTotalTests: 2, testResults: [
      { name: "/work/app/a.test.js", assertionResults: [{ fullName: "adds", status: "passed", duration: 2, failureMessages: [] }, { fullName: "subtracts", status: "failed", duration: 1, failureMessages: ["Expected 1 got 2"] }] },
      { name: "/work/app/b.test.js", message: "Cannot find module './missing'", assertionResults: [] },
    ] });
    const r = parseJestJson(json);
    expect(r).toMatchObject({ total: 3, passed: 1, failed: 2 });
  });

  it("reads runner summaries and recognizes zero-test runs", () => {
    expect(parseLogSummary(" Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 9 passed (10)")).toMatchObject({ total: 10, failed: 1, passed: 9, source: "log_summary" });
    expect(parseLogSummary("Tests:       2 failed, 8 passed, 10 total")).toMatchObject({ total: 10, failed: 2 });
    expect(parseLogSummary("====== 1 failed, 7 passed in 0.31s ======")).toMatchObject({ total: 8, failed: 1 });
    expect(parseLogSummary("No test files found, exiting with code 0")).toMatchObject({ total: 0, source: "log_summary" });
    expect(parseLogSummary("hello")).toMatchObject({ source: "none" });
  });

  it("recovers progress of a run that was stopped", () => {
    const p = progressFromLog(" ✓ src/a.test.ts > adds 3ms\n × src/a.test.ts > breaks 4ms\n");
    expect(p.passed).toEqual(["src/a.test.ts > adds"]);
    expect(p.failed).toEqual(["src/a.test.ts > breaks"]);
  });
});

describe("planning helpers", () => {
  it("turns route patterns into concrete paths", () => {
    expect(concretePath("/api/orders/:id")).toBe("/api/orders/999999");
    expect(concretePath("/items/{item_id}")).toBe("/items/999999");
    expect(concretePath("/users/[userId]/posts/[slug]")).toBe("/users/999999/posts/sample");
    expect(concretePath("/cart/<cart_id>/items/<int:item_id>")).toBe("/cart/999999/items/999999");
  });

  it("never invents secrets that look real and keeps numbers numeric", () => {
    expect(syntheticValue("STRIPE_SECRET_KEY", "run1")).toMatch(/^cc-test-/);
    expect(syntheticValue("DIGEST_HOUR_IST", "run1")).toBe("9");
    expect(syntheticValue("MAX_AUDIO_BYTES", "run1")).toBe("10");
    expect(syntheticValue("ALERT_EMAIL", "run1")).toBe("alert@example.com");
  });

  it("keeps only citations that point at real lines", () => {
    const src = { files: new Map([["src/a.ts", { path: "src/a.ts", text: "a\nb\nc", lines: 3 }]]), allPaths: ["src/a.ts"], skipped: new Map(), excluded: new Map() };
    expect(validEvidence(src, [{ path: "src/a.ts", line: 2 }, { path: "src/a.ts", line: 9 }, { path: "/work/app/src/a.ts", line: 3 }, { path: "nope.ts", line: 1 }])).toEqual([{ path: "src/a.ts", line: 2 }, { path: "src/a.ts", line: 3 }]);
  });
});

describe("report audit", () => {
  const ob = (id: string, status: Obligation["status"], executionIds: string[] = [], reason: string | null = null): Obligation => ({ id, layer: "api", asset: { kind: "endpoint", ref: id, label: id }, objective: "x", priority: "high", oracle: { source: "http_semantics", expected: "x", evidence: [] }, status, reason, origin: "dossier", executionIds, findingIds: [] });
  const report = (headline: string, totals: Partial<TestingReport["totals"]>): TestingReport => ({ headline, verdict: "partial", totals: { planned: 0, running: 0, passed: 0, failed: 0, flaky: 0, blocked: 0, unsupported: 0, skipped: 0, not_applicable: 0, inconclusive: 0, ...totals }, measures: [{ label: "m", numerator: 1, denominator: 2, note: null }], suites: [], untested: [], environment: { provider: "fake", image: "i", runtime: null, cpus: 4, memoryMb: 4096, network: "off", syntheticEnv: [] }, performance: null, limitations: [], audit: [] });

  it("rejects passes without executions and overstated headlines", () => {
    const checks = audit(report("Everything passed", { passed: 1, blocked: 1 }), [ob("a", "passed"), ob("b", "blocked", [], "no network")], [], []);
    expect(checks.find((c) => c.check === "Every pass is backed by a sandbox execution")!.ok).toBe(false);
    expect(checks.find((c) => c.check === "Headline does not overstate")!.ok).toBe(false);
  });

  it("requires a reason for every non-passing status", () => {
    const checks = audit(report("No confirmed defects", { blocked: 1 }), [ob("b", "blocked")], [], []);
    expect(checks.find((c) => c.check === "Every non-passing status has a reason")!.ok).toBe(false);
  });
});

describe("authored probe placeholders", () => {
  it("fills captured values whichever way the author wrote them", async () => {
    const { scenarioToProbe } = await import("../src/testing/agents.ts");
    const probe = scenarioToProbe(
      {
        endpoint: "POST /orders",
        title: "create then read",
        identity: null,
        steps: [
          { method: "post", path: "/orders", json: { qty: 1 }, expect: { status: [201] }, capture: { name: "orderId", path: "id" } },
          { method: "GET", path: "/orders/{orderId}", expect: { status: [200] } },
          { method: "POST", path: "/orders/:orderId/transitions", json: { from: "{{orderId}}" }, expect: { statusClass: ["2xx"] } },
          { method: "GET", path: "/users/:userId", expect: { status: [404] } },
        ],
        oracle: "x",
        evidence: [{ path: "a.ts", line: 1 }],
        priority: "high",
      },
      1,
      ".",
      "api:x",
    );
    expect(probe.steps.map((s) => s.path)).toEqual(["/orders", "/orders/{{orderId}}", "/orders/{{orderId}}/transitions", "/users/999999"]);
    expect(probe.steps[2]!.json).toEqual({ from: "{{orderId}}" });
    expect(probe.steps[0]!.method).toBe("POST");
  });
});

describe("authored expectations are kept", () => {
  it("parses exact codes and classes from the author's output, in any mix", async () => {
    const { parseAuthored } = await import("../src/testing/agents.ts");
    const out = parseAuthored({
      scenarios: [
        { endpoint: "POST /a", title: "t", identity: null, oracle: "o", evidence: ["src/a.ts:3"], steps: [{ method: "POST", path: "/a", expect: { status: [409, "201"] } }] },
        { endpoint: "POST /b", title: "t", identity: null, oracle: "o", evidence: [{ path: "src/a.ts", line: 3 }], steps: [{ method: "POST", path: "/b", expect: { status: ["2xx"] } }] },
        { endpoint: "POST /c", title: "t", identity: null, oracle: "o", evidence: [], steps: [{ method: "POST", path: "/c", expect: { statusClass: ["4XX"], status: 422 } }] },
      ],
    });
    expect(out.map((s) => s.steps[0]!.expect)).toEqual([{ status: [409, 201] }, { statusClass: ["2xx"] }, { status: [422], statusClass: ["4xx"] }]);
  });
});

describe("JUnit names with >", () => {
  it("keeps names whose quoted value contains an unescaped >", () => {
    const xml = `<testsuites><testcase name="POST /todos > creates todos" classname="test" time="0.1"></testcase><testcase name="b" classname="test" time="0.1"><failure message="x">y</failure></testcase></testsuites>`;
    const r = parseJunit(xml);
    expect(r.cases.map((c) => c.name)).toEqual(["test > POST /todos > creates todos", "test > b"]);
    expect(r.failed).toBe(1);
  });
});

describe("fixtures put robustness checks on real data", () => {
  it("creates the parent first and fills the path parameter from the capture", async () => {
    const { fixtureSteps } = await import("../src/testing/agents.ts");
    const { recordNodes, withRecord } = await import("../src/testing/fixtures.ts");
    const [fx, notes] = recordNodes(
      [
        { resource: "/cart/<cart_id>", identity: null, steps: [{ method: "POST", path: "/cart", json: {}, expect: {}, capture: { name: "cart_id", path: "id" } }] },
        // A single parameter captured under another name still matches.
        { resource: "/api/notes/:id", identity: "dash", steps: [{ method: "POST", path: "/api/notes", json: { t: 1 }, expect: { status: [201] }, capture: { name: "noteId", path: "id" } }] },
      ],
      new Set(["dash"]),
      fixtureSteps,
    );
    expect(fx!.captureFor).toEqual({ cart_id: "fx1_cart_id" });
    expect(fx!.steps![0]).toMatchObject({ expect: { statusClass: ["2xx"] }, capture: { name: "fx1_cart_id" } });
    expect(notes!.dependsOn).toEqual(["dash"]);
    const used = withRecord("/cart/<cart_id>/discount", [fx!, notes!]);
    expect(used).toEqual({ path: "/cart/{{fx1_cart_id}}/discount", needs: ["record-1"] });
    expect(withRecord("/products/<sku>", [fx!])).toBeNull();
    expect(withRecord("/api/notes/:id", [fx!, notes!])?.path).toBe("/api/notes/{{fx2_noteId}}");
  });
});

describe("authored checks are validated before they run", () => {
  it("knows which endpoints exist and which names a module exports", async () => {
    const { knownEndpoint, importsExist } = await import("../src/testing/agents.ts");
    const d = { entryPoints: [
      { kind: "http", method: "POST", path: "/api/notes" },
      { kind: "http", method: "PATCH", path: "/api/notes/:id" },
      { kind: "http", method: "POST", path: "/cart/<cart_id>/discount" },
    ] } as unknown as import("@cybercheck/contracts").ProjectDossier;
    expect(knownEndpoint(d, "post", "/api/notes")).toBe(true);
    expect(knownEndpoint(d, "PATCH", "/api/notes/{{fx1_id}}")).toBe(true);
    expect(knownEndpoint(d, "PATCH", "/api/notes/42")).toBe(true);
    expect(knownEndpoint(d, "POST", "/cart/abc123ef/discount")).toBe(true);
    expect(knownEndpoint(d, "POST", "/api/notes/1/takeover")).toBe(false);
    expect(knownEndpoint(d, "DELETE", "/api/notes/1")).toBe(false);
    const src = { files: new Map([["src/q.ts", { path: "src/q.ts", text: "export function add() {}\nexport const size = 1;\nfunction hidden() {}\nexport { hidden as visible };", lines: 4 }]]), allPaths: [], skipped: new Map(), excluded: new Map() };
    expect(importsExist({ target: "src/q.ts", code: 'import { add, size, visible } from "../src/q.ts";' }, "../src/q.ts", src)).toBe(true);
    expect(importsExist({ target: "src/q.ts", code: 'import { add, hidden } from "../src/q.ts";' }, "../src/q.ts", src)).toBe(false);
    expect(importsExist({ target: "src/q.ts", code: 'import type { Nope } from "../src/q.ts";\nimport { add } from "../src/q.ts";' }, "../src/q.ts", src)).toBe(true);
  });
});

describe("scenarios that assume data are dropped", () => {
  it("flags literal record ids that were never created, but not values or captured ids", async () => {
    const { assumesExistingData } = await import("../src/testing/agents.ts");
    const d = { entryPoints: [
      { kind: "http", method: "POST", path: "/api/conversations/:phone/disqualify" },
      { kind: "http", method: "GET", path: "/api/leads/status/:status" },
      { kind: "http", method: "GET", path: "/orders/:id" },
    ] } as unknown as import("@cybercheck/contracts").ProjectDossier;
    expect(assumesExistingData(d, [{ method: "POST", path: "/api/conversations/15550100/disqualify", expect: {} }])).toBe(true);
    expect(assumesExistingData(d, [{ method: "POST", path: "/api/conversations/15550100/disqualify", expect: { status: [404] } }])).toBe(false);
    expect(assumesExistingData(d, [{ method: "GET", path: "/api/leads/status/open", expect: {} }])).toBe(false);
    expect(assumesExistingData(d, [{ method: "GET", path: "/orders/{{orderId}}", expect: {} }])).toBe(false);
    expect(assumesExistingData(d, [{ method: "GET", path: "/orders/999999", expect: {} }])).toBe(false);
  });
});
