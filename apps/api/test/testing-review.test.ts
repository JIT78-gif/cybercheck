import { describe, expect, it } from "vitest";
import type { FindingHumanReview, Obligation, TestFinding, TestingReport } from "@cybercheck/contracts";
import { completeness, productHealth, releaseDecision } from "../src/testing/assurance.ts";
import { latestReviews, reviewedAssessment, reviewPrecision } from "../src/testing/review.ts";
import { effectivePolicy } from "../src/testing/runtime.ts";

const ob = (id: string, status: Obligation["status"], findingIds: string[] = [], priority: Obligation["priority"] = "high"): Obligation => ({
  id,
  layer: id.startsWith("env:") ? "environment" : "api",
  asset: { kind: "endpoint", ref: id, label: id },
  objective: id,
  priority,
  oracle: { source: "code_contract", expected: "x", evidence: [] },
  status,
  reason: status === "passed" ? null : "machine reason",
  origin: "dossier",
  executionIds: ["e1"],
  findingIds,
  proofClass: "business_behavior",
  oracleStrength: "strong",
  reachedTarget: true,
});
const finding = (id: string, severity: TestFinding["severity"], obligationIds: string[], kind: TestFinding["kind"] = "product_defect"): TestFinding => ({
  id,
  kind,
  status: "confirmed",
  severity,
  confidence: "high",
  title: `Problem ${id}`,
  expected: "e",
  actual: "a",
  reproduction: "r",
  rootCause: null,
  location: null,
  obligationIds,
  executionIds: ["e1"],
  validation: "v",
  limitation: null,
});
let n = 0;
const review = (findingId: string, decision: FindingHumanReview["decision"], at = n): FindingHumanReview => ({
  id: `R${++n}`,
  findingId,
  runId: "run",
  projectId: "p",
  snapshotId: "s",
  reviewerUserId: "u",
  reviewerRole: "owner",
  decision,
  reason: null,
  createdAt: new Date(Date.UTC(2026, 9, 13, 0, 0, at)).toISOString(),
  supersedesReviewId: null,
});

function machine(obligations: Obligation[], findings: TestFinding[], target = 70): TestingReport {
  const c = completeness(obligations, target);
  return { completeness: c, productHealth: productHealth(obligations), release: releaseDecision({ obs: obligations, findings, completeness: c, auditOk: true, thresholdsSet: false }), audit: [] } as unknown as TestingReport;
}

describe("review precision", () => {
  it("counts only confirmed and rejected product findings, and refuses a percentage below five", () => {
    const fs = ["F1", "F2", "F3", "F4", "F5", "F6", "F7"].map((id) => finding(id, "medium", []));
    fs.push(finding("T1", "low", [], "test_defect"));
    const few = [review("F1", "confirmed"), review("F2", "rejected"), review("F3", "unsure"), review("F4", "accepted_risk")];
    const p = reviewPrecision(fs, few);
    expect([p.confirmed, p.rejected, p.reviewed, p.percent]).toEqual([1, 1, 2, null]);
    expect(p.text).toMatch(/Not enough reviewed findings to estimate precision/);
    const enough = [...few, review("F5", "confirmed"), review("F6", "confirmed"), review("F7", "rejected"), review("T1", "confirmed")];
    const q = reviewPrecision(fs, enough);
    // T1 is a testing-system problem, not a machine product finding: it never counts.
    expect([q.confirmed, q.rejected, q.percent]).toEqual([3, 2, 60]);
    expect(q.text).toBe("3 of 5 reviewed findings confirmed (60%)");
  });

  it("uses the latest review when a decision is changed (history is kept)", () => {
    const a = review("F1", "rejected", 1);
    const b = review("F1", "confirmed", 2);
    expect(latestReviews([b, a]).get("F1")?.id).toBe(b.id);
    expect(reviewPrecision([finding("F1", "low", [])], [a, b]).confirmed).toBe(1);
  });
});

describe("the human-reviewed assessment", () => {
  const obs = [ob("env:build:.", "passed", [], "high"), ob("api:a", "failed", ["F1"]), ob("api:b", "failed", ["F2"]), ob("api:c", "passed")];
  const fs = [finding("F1", "high", ["api:a"]), finding("F2", "high", ["api:b"])];
  const base = { runId: "run", report: machine(obs, fs), obligations: obs, findings: fs, projectReviews: { findings: fs, reviews: [] }, canReview: true };

  it("never turns a rejected finding's check into a pass, and keeps the machine result untouched", () => {
    const before = JSON.stringify({ obs, fs });
    const r = reviewedAssessment({ ...base, reviews: [review("F1", "confirmed"), review("F2", "rejected")], allowAcceptedRisk: true });
    expect(JSON.stringify({ obs, fs })).toBe(before);
    expect(r.machine.openDefects).toBe(2);
    expect(r.reviewed.openDefects).toBe(1);
    // api:b had no other evidence: it now has no verdict, so completeness falls and health is not inflated.
    expect(r.reviewed.completeness).toBeLessThan(r.machine.completeness);
    expect(r.reviewed.decision).toBe("not_ready_product_failures");
    expect(r.findings.map((f) => [f.findingId, f.queue, f.repairEligible])).toEqual([
      ["F1", "confirmed", true],
      ["F2", "rejected", false],
    ]);
  });

  it("allows ready with accepted risk only when the policy allows it and nothing else blocks", () => {
    const passing = [ob("env:build:.", "passed"), ob("api:a", "failed", ["F1"]), ob("api:c", "passed")];
    const one = [finding("F1", "high", ["api:a"])];
    const input = { ...base, report: machine(passing, one, 10), obligations: passing, findings: one, projectReviews: { findings: one, reviews: [] } };
    const allowed = reviewedAssessment({ ...input, reviews: [review("F1", "accepted_risk")], allowAcceptedRisk: true });
    expect(allowed.machine.decision).toBe("not_ready_product_failures");
    expect(allowed.reviewed.decision).toBe("ready_with_accepted_risk");
    expect(allowed.reviewed.acceptedRisks).toBe(1);
    const refused = reviewedAssessment({ ...input, reviews: [review("F1", "accepted_risk")], allowAcceptedRisk: false });
    expect(refused.reviewed.decision).toBe("not_ready_product_failures");
    expect(refused.reviewed.reasons.join(" ")).toMatch(/does not allow accepting the risk/);
  });

  it("keeps an unsure finding open and counts unreviewed ones as awaiting", () => {
    const r = reviewedAssessment({ ...base, reviews: [review("F1", "unsure")], allowAcceptedRisk: true });
    expect(r.reviewed.unsure).toBe(1);
    expect(r.reviewed.awaitingReview).toBe(1);
    expect(r.reviewed.decision).toBe("not_ready_product_failures");
  });
});

describe("run policy", () => {
  it("defaults Standard to a 70% target and caps the budget at the server's limit", () => {
    expect(effectivePolicy({}, 1.5)).toMatchObject({ profile: "standard", targetCompleteness: 70, budgetUsd: 1.5, browser: true, loadStages: ["smoke"] });
    expect(effectivePolicy({ profile: "fast" }, 1.5)).toMatchObject({ targetCompleteness: 50, loadStages: [] });
    expect(effectivePolicy({ profile: "deep" }, 1.5).targetCompleteness).toBe(90);
    expect(effectivePolicy({ profile: "standard", targetCompleteness: 80, budgetUsd: 9, load: true, browser: false }, 1.5)).toMatchObject({ targetCompleteness: 80, budgetUsd: 1.5, browser: false, loadStages: ["smoke", "average", "stress"] });
  });
});

describe("one root cause seen by two workers", () => {
  it("groups an API 403 and a browser 403 on the same path, and keeps unrelated refusals apart", async () => {
    const { sameRefusal } = await import("../src/testing/triage.ts");
    const api = { ...finding("F3", "medium", ["api:GET /admin/feedback:authored:3"]), layer: "api" as const, title: "Staff get 403 from GET /admin/feedback", actual: "GET /admin/feedback answered 403 for staff" };
    const ui = { ...finding("F9", "medium", ["ui:/staff/feedback:renders"]), layer: "ui" as const, title: "Staff feedback screen is blocked", actual: "GET /admin/feedback?period=week was refused with 403 for \"staff\"" };
    const other = { ...finding("F4", "medium", ["ui:/staff/orders:renders"]), layer: "ui" as const, title: "Orders screen refused", actual: "GET /admin/orders/12 was refused with 403" };
    expect(sameRefusal(api, ui)).toBe(true);
    expect(sameRefusal(api, other)).toBe(false);
    expect(sameRefusal(api, { ...ui, layer: "api" })).toBe(false);
  });
});

describe("the same refusal through a frontend /api prefix", () => {
  it("groups a browser 403 on /api/admin/feedback with the API check of GET /admin/feedback", async () => {
    const { sameRefusal } = await import("../src/testing/triage.ts");
    const ui = { ...finding("F11", "medium", ["ui:/staff/feedback:renders"]), layer: "ui" as const, title: "Staff feedback page requests admin-only endpoint and gets 403", actual: "GET /api/admin/feedback?period=all returns 403 for staff" };
    const api = { ...finding("F15", "medium", ["api:GET /admin/feedback:authored:3"]), layer: "api" as const, title: "Staff cannot access feedback list", actual: "Returns 403 Forbidden with 'admin role required'." };
    const endpoints = (f: { id: string }) => (f.id === "F15" ? ["/admin/feedback"] : []);
    expect(sameRefusal(ui, api, endpoints)).toBe(true);
    expect(sameRefusal(ui, api)).toBe(false);
  });
});
