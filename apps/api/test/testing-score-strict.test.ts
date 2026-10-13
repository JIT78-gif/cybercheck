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
