import { describe, expect, it } from "vitest";
import type { Obligation, TestFinding, TestingRunDetail } from "@cybercheck/contracts";
import { endpointPattern, scoreStrict, type StrictExpected } from "./testing-score-strict.ts";

let n = 0;
const finding = (over: Partial<TestFinding>): TestFinding =>
  ({ id: `F${++n}`, kind: "product_defect", status: "confirmed", severity: "high", confidence: "high", title: "", expected: "", actual: "", reproduction: "", rootCause: null, location: null, obligationIds: [], executionIds: [], validation: "", limitation: null, layer: "api", ...over }) as TestFinding;
const ob = (over: Partial<Obligation>): Obligation =>
  ({ id: "api:x", layer: "api", asset: { kind: "endpoint", ref: "x", label: "x" }, objective: "", priority: "high", oracle: { source: "code_contract", expected: "", evidence: [] }, status: "passed", reason: null, origin: "dossier", executionIds: [], findingIds: [], ...over }) as Obligation;
const run = (findings: TestFinding[], obligations: Obligation[] = [], extra: Partial<TestingRunDetail> = {}): TestingRunDetail =>
  ({ id: "r", status: "completed", findings, obligations, executions: [], usage: { costUsd: 0.4 }, report: { audit: [{ check: "a", ok: true, detail: "" }], profile: "deep", release: { decision: "not_ready_product_failures", gates: [], reasons: [] }, fixtures: { digest: "d", nodes: [{ id: "n", label: "n", ok: true, detail: "" }] } }, ...extra }) as unknown as TestingRunDetail;

const KEY: StrictExpected = {
  project: "shop",
  commands: {},
  expectedOutcomes: {},
  release: "not_ready_product_failures",
  mustNotReport: ["A database connection failure"],
  defects: [
    { id: "total", track: "testing", summary: "", path: "src/app.js", line: 84, detectableBy: "api_probe", endpoint: "POST /api/orders", title: "total|quantity", mustFind: true },
    { id: "stock", track: "testing", summary: "", path: "src/app.js", line: 85, detectableBy: "api_probe", endpoint: "POST /api/orders", title: "stock|inventory|quantity", mustFind: true },
    { id: "status", track: "testing", summary: "", path: "src/app.js", line: 102, detectableBy: "api_probe", endpoint: "POST /api/orders/:id/status", title: "status|transition", mustFind: false },
    { id: "labels", track: "testing", summary: "", path: "public/index.html", line: 16, detectableBy: "browser", endpoint: null, title: "label|accessible name", mustFind: true },
    { id: "sqli", track: "security", summary: "", path: "src/app.js", line: 60, detectableBy: "api_probe", endpoint: "GET /api/search", title: "injection|sql", mustFind: true },
  ],
};

describe("strict Testing scorer", () => {
  it("matches endpoints exactly, with route parameters as one segment", () => {
    expect(endpointPattern("POST /api/orders").test("POST /api/orders with body {}")).toBe(true);
    expect(endpointPattern("POST /api/orders").test("api:POST /api/orders:quantity")).toBe(true);
    expect(endpointPattern("POST /api/orders").test("POST /api/orders/12/status")).toBe(false);
    expect(endpointPattern("POST /api/orders/:id/status").test("POST /api/orders/12/status")).toBe(true);
    expect(endpointPattern("GET /api/orders").test("POST /api/orders")).toBe(false);
  });

  it("gives one finding credit for one defect only, and none for being near the right line", () => {
    const both = finding({ title: "Order total ignores quantity", reproduction: "POST /api/orders with quantity 3", location: { path: "src/app.js", line: 84 } });
    // Right file and line, right words, but it never executed the order endpoint: a proposal, not proof.
    const nearOnly = finding({ title: "Order status can be changed freely", location: { path: "src/app.js", line: 101 } });
    const s = scoreStrict(run([both, nearOnly]), KEY);
    expect(s.notes).toContain('defect total (must find, api_probe): confirmed as F1 "Order total ignores quantity"');
    expect(s.notes.some((x) => x.startsWith("defect stock") && x.endsWith("MISSED"))).toBe(true);
    expect(s.notes.some((x) => x.startsWith("defect status") && x.endsWith("MISSED"))).toBe(true);
    expect(s.counts.unadjudicated).toBe(1);
    expect(s.parts.mandatoryRecall).toBeCloseTo(1 / 3);
  });

  it("merges repeated reports of one root cause and flags the duplicate", () => {
    const a = finding({ title: "Form field has no label", layer: "accessibility", actual: "missing label", location: { path: "public/index.html", line: 16 } });
    const b = finding({ title: "Form field has no label", layer: "accessibility", actual: "missing label on /admin", location: { path: "public/index.html", line: 17 } });
    const s = scoreStrict(run([a, b]), KEY);
    expect(s.counts.duplicates).toBe(1);
    expect(s.notes.some((x) => x.startsWith("defect labels") && !x.endsWith("MISSED"))).toBe(true);
    expect(s.gates.find((g) => g.name.startsWith("no duplicated"))?.ok).toBe(false);
  });

  it("never credits a malformed-input crash for a business defect, and counts all of them as one root cause", () => {
    const a = finding({ title: "Malformed JSON body on POST /api/orders returns 500", reproduction: "POST /api/orders with body {", actual: "500; quantity was never read" });
    const b = finding({ title: "Malformed JSON body causes 500 on /api/integrations/preview", reproduction: "POST /api/integrations/preview" });
    const s = scoreStrict(run([a, b]), KEY);
    expect(s.counts.found).toBe(0);
    expect(s.counts.duplicates).toBe(1);
    expect(s.notes.some((x) => x.startsWith("DUPLICATE root cause reported 2 times"))).toBe(true);
  });

  it("credits a business defect whose title calls the app's data malformed, and keeps it apart from bad-input crashes", () => {
    // Round 49: F14 explained the coupon text comparison but was merged with the malformed-JSON 500 and got no credit.
    const coupon = finding({ title: "Coupon expiration date string is malformed causing invalid lexicographical comparison", reproduction: "POST /api/coupons/validate with JSON body", actual: "'2026-12-31' <= '2026-2-01' is true as text" });
    const json = finding({ title: "Unhandled SyntaxError on malformed JSON body returns 500 instead of 400", reproduction: "POST /api/orders with raw body {" });
    const id = finding({ title: "DELETE /api/data/customers/:id accepts malformed non-numeric ID without validation", reproduction: "DELETE /api/data/customers/abc" });
    const key: StrictExpected = { ...KEY, defects: [{ id: "coupon", track: "testing", summary: "", path: "src/app.js", line: 125, detectableBy: "api_probe", endpoint: "POST /api/coupons/validate", title: "coupon|expir", mustFind: true }] };
    const s = scoreStrict(run([coupon, json, id]), key);
    expect(s.notes).toContain(`defect coupon (must find, api_probe): confirmed as ${coupon.id} "${coupon.title}"`);
    expect(s.counts.duplicates).toBe(0);
  });

  it("calls only documented non-defects false positives; other tracks' real defects count as true", () => {
    const db = finding({ title: "Database connection failure on start", actual: "the database connection failed" });
    const sqli = finding({ title: "Search is open to SQL injection", reproduction: "GET /api/search?q='", actual: "sql error" });
    const extra = finding({ title: "Profile page shows wrong currency" });
    const s = scoreStrict(run([db, sqli, extra]), KEY);
    expect(s.counts).toMatchObject({ confirmedFalse: 1, outOfTrack: 1, unadjudicated: 1, confirmedTrue: 1 });
    expect(s.gates.find((g) => g.name === "no known confirmed false positive")?.ok).toBe(false);
    expect(s.score).toBeLessThanOrEqual(8.9);
  });

  it("flags business behaviour proven by a status code, and checks that passed on a seeded defect", () => {
    const statusOnly = ob({ id: "api:POST /api/orders:creates", proofClass: "state_change", stateVerified: false, objective: "Creates an order" });
    const wrong = ob({ id: "api:POST /api/orders:total", proofClass: "business_behavior", oracleStrength: "strong", stateVerified: true, objective: "Order total is computed", oracle: { source: "existing_assertion", expected: "total equals price times quantity", evidence: [] } });
    const s = scoreStrict(run([], [statusOnly, wrong]), KEY);
    expect(s.counts.statusOnly).toBe(1);
    expect(s.notes.some((x) => x.startsWith("WRONG ORACLE api:POST /api/orders:total"))).toBe(true);
    expect(s.parts.oracle).toBe(0);
  });

  it("passes no gate on a suspected finding, though it earns half recall credit", () => {
    const fs = [
      finding({ title: "Order total ignores quantity", reproduction: "POST /api/orders", status: "suspected" }),
      finding({ title: "Stock decremented once regardless of quantity", reproduction: "POST /api/orders" }),
      finding({ title: "Inputs without a label", layer: "accessibility", actual: "label missing" }),
    ];
    const s = scoreStrict(run(fs), { ...KEY, mustNotReport: [] });
    expect(s.parts.mandatoryRecall).toBeCloseTo(2.5 / 3);
    expect(s.gates.find((g) => g.name.startsWith("all 3 mandatory"))).toMatchObject({ ok: false, detail: "2 of 3 confirmed (1 only suspected)" });
  });

  it("blocks the precision gate until every confirmed finding outside the key is reviewed, and scores the lower bound", () => {
    const fs = [finding({ title: "Order total ignores quantity", reproduction: "POST /api/orders" }), finding({ title: "Profile page shows wrong currency" })];
    const s = scoreStrict(run(fs), { ...KEY, mustNotReport: [] });
    expect(s.counts.needsReview).toBe(1);
    expect(s.notes).toContain("NEEDS REVIEW confirmed F" + fs[1]!.id.slice(1) + ": Profile page shows wrong currency (not in the answer key: a real defect or a false positive?)");
    expect(s.gates.find((g) => g.name.startsWith("confirmed-finding precision"))).toMatchObject({ ok: false, detail: expect.stringMatching(/^1 confirmed finding\(s\) need review/) });
    expect(s.parts.precision).toBe(0.5);
  });

  it("counts invalid setup steps and fails the gate when a critical check was blocked by setup", () => {
    // Round 45: "1 of 1" in the list, 4 invalid steps only in cybercheck's own finding, and blocked critical checks.
    const invalid = finding({ kind: "test_defect", title: "4 planned setup step(s) were invalid and not used (61 check(s) could not run)" });
    const blocked = ob({ id: "api:GET /api/orders:own", status: "blocked", blockedBy: "fixture", priority: "critical" });
    const s = scoreStrict(run([invalid], [blocked]), KEY);
    expect(s.meta).toMatchObject({ invalidFixtureNodes: 4, fixtureBlocked: 1 });
    expect(s.gates.find((g) => g.name.startsWith("fixture success"))).toMatchObject({ ok: false, detail: "1 of 5 planned step(s) worked (4 invalid, never used); 1 check(s) blocked by setup (1 critical)" });
  });

  it("scores a project without Testing defects as a control, never 0 to 10", () => {
    const control: StrictExpected = { project: "todo", commands: {}, expectedOutcomes: {}, defects: [] };
    const clean = scoreStrict(run([]), control);
    expect(clean.score).toBeNull();
    expect(clean.control).toEqual({ ok: true, detail: "no confirmed finding to question" });
    const noisy = scoreStrict(run([finding({ title: "Todo list shows wrong count" })]), control);
    expect(noisy.control).toEqual({ ok: false, detail: "0 known false positive(s), 1 confirmed finding(s) to review" });
  });

  it("checks the expected suite outcome, also a flaky one", () => {
    const flakyKey: StrictExpected = { ...KEY, expectedOutcomes: { testSuite: "flaky", flakyTests: ["retries the payment"] } };
    const passedSuite = ob({ id: "suite:passes:.", layer: "existing_suite", status: "passed" });
    const wrong = scoreStrict(run([], [passedSuite]), flakyKey);
    expect(wrong.notes).toContain("WRONG own suite flaky: expected flaky; obligations runs= passes=passed; report=");
    expect(wrong.notes).toContain("WRONG flaky test flagged: retries the payment: not flagged");
    const right = scoreStrict(run([finding({ kind: "flaky", title: "retries the payment passed 2 of 3 runs" })], [{ ...passedSuite, status: "flaky" }]), flakyKey);
    expect(right.notes.filter((x) => x.startsWith("WRONG"))).toEqual([]);
  });

  it("says what the run was: engine, plan source and the review's success criteria", () => {
    const r = run([finding({ kind: "test_defect", title: "2 behaviour scenario(s) cybercheck wrote did not compile and were not sent" })], [ob({ id: "req:req-total:tpl:req-total" }), ob({ id: "req:req-pages:template", status: "inconclusive" }), ob({ id: "ui:journey:1", layer: "ui" })], { usage: { costUsd: 0.4, planSource: "cache", planSourceRunId: "run-7" } as never });
    (r.report as unknown as { environment: unknown }).environment = { engine: "2026-10-14.v3e" };
    expect(scoreStrict(r, KEY).meta).toEqual({ engine: "2026-10-14.v3e", planSource: "cache", planSourceRunId: "run-7", invalidFixtureNodes: 0, fixtureBlocked: 0, requirementChecks: 2, compileFailures: 2, templatesNotBuilt: 1, journeys: 1 });
  });

  it("scores a run that finds every defect with evidence above 9", () => {
    const fs = [
      finding({ title: "Order total ignores quantity", reproduction: "POST /api/orders" }),
      finding({ title: "Stock decremented once regardless of quantity", reproduction: "POST /api/orders then GET /api/products/1" }),
      finding({ title: "Shipped order moved back to pending", expected: "Order status only moves forward", reproduction: "POST /api/orders/7/status" }),
      finding({ title: "Inputs without a label", layer: "accessibility", actual: "label missing" }),
    ];
    const s = scoreStrict(run(fs), { ...KEY, mustNotReport: [] });
    expect(s.counts.found).toBe(4);
    expect(s.failedGates).toBe(0);
    expect(s.score).toBeGreaterThan(9);
  });
});
