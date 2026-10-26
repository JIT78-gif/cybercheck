import { expect, test, type Page, type Route } from "@playwright/test";
import type { AdversarialRunDetail, FindingHumanReview, TestingRepair } from "@cybercheck/contracts";
import { adversarialRun } from "./adversarial-fixture";
import { giveEachTestItsOwnIp, signedInUser } from "./helpers";

// Human review + safe sandbox repair on the AI Adversarial results page. A repair is offered only for a finding the
// check confirmed AND a reviewer confirmed; the panel shows exactly what may change and what reruns; a verified patch
// is shown for manual application and nothing is ever applied to the project.

giveEachTestItsOwnIp(test);
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const now = new Date().toISOString();

const review = (decision: FindingHumanReview["decision"]): FindingHumanReview => ({ id: "rv1", findingId: "A1", runId: "adv-1", projectId: "proj-1", snapshotId: "snap-1", reviewerUserId: "u1", reviewerName: "Ana", reviewerRole: "owner", decision, reason: null, createdAt: now, supersedesReviewId: null });

function repair(status: TestingRepair["status"]): TestingRepair {
  const verified = status === "verified";
  return {
    id: "rp1", runId: "adv-1", findingId: "A1", projectId: "proj-1", snapshotId: "snap-1", status, requestedBy: "u1", approvedBy: verified ? "u1" : null,
    scope: { files: ["src/app.js"], reproduction: ["adv-f1"], regression: ["adv-p1"], maxAttempts: 2, estimate: { minutes: [4, 20], costUsd: [0.03, 0.5] } },
    attempts: verified
      ? [{ n: 1, status: "verified", summary: "Added the administrator check to the overview route.", diff: "--- a/src/app.js\n+++ b/src/app.js\n@@ -1,1 +1,1 @@\n-app.get('/api/admin/overview', requireUser, overview);\n+app.get('/api/admin/overview', requireUser, requireAdmin, overview);", patchDigest: "abc123def4567890aa", filesChanged: ["src/app.js"], rejectedBecause: [], validationRunId: "adv-2", checks: [{ obligationId: "adv-f1", label: "A non-admin cannot call GET /api/admin/overview", role: "reproduction", before: "failed", after: "passed" }, { obligationId: "adv-p1", label: "Search parameterises input", role: "regression", before: "passed", after: "passed" }], regressions: [], costUsd: 0.04, startedAt: now, finishedAt: now }]
      : [],
    error: null, createdAt: now, updatedAt: now,
  };
}

async function open(page: Page, o: { reviews?: FindingHumanReview[]; repairs?: TestingRepair[]; canReview?: boolean; run?: AdversarialRunDetail }) {
  await signedInUser(page, "Repair Tester");
  await page.route("**/v1/adversarial-runs/adv-1/events**", (r) => json(r, { events: [] }));
  await page.route("**/v1/adversarial-runs/adv-1/reviews", (r) => json(r, { reviews: o.reviews ?? [], canReview: o.canReview ?? true }));
  await page.route("**/v1/adversarial-runs/adv-1/repairs", (r) => json(r, { repairs: o.repairs ?? [] }));
  await page.route("**/v1/adversarial-runs/adv-1", (r) => json(r, { run: o.run ?? adversarialRun() }));
  await page.goto("/app/projects/proj-1/adversarial/adv-1");
  await expect(page.getByRole("heading", { name: "AI Adversarial results", level: 1 })).toBeVisible();
  return page.getByRole("region", { name: "Review and repair A1", exact: true });
}

test("an unreviewed confirmed vulnerability offers the four review decisions, not a repair yet", async ({ page }) => {
  const box = await open(page, {});
  for (const label of ["Confirm", "Reject", "Unsure", "Accept risk"]) await expect(box.getByRole("button", { name: new RegExp(label) })).toBeVisible();
  await expect(box.getByText(/available after a reviewer confirms this problem/i)).toBeVisible();
  await expect(box.getByRole("button", { name: /Try repair in sandbox/ })).toHaveCount(0);
});

test("after a reviewer confirms, a sandbox repair can be requested and recommended fix text is distinguished from it", async ({ page }) => {
  let requested = false;
  const box = await open(page, { reviews: [review("confirmed")] });
  await page.route("**/v1/adversarial-runs/adv-1/findings/A1/repairs", (r) => { requested = true; return json(r, { repair: repair("awaiting_approval") }, 201); });
  await expect(box.getByText(/recommended fix above is advice/i)).toBeVisible();
  await box.getByRole("button", { name: /Try repair in sandbox/ }).click();
  await expect.poll(() => requested).toBe(true);
});

test("the approval panel shows the files allowed to change and exactly which attacks rerun", async ({ page }) => {
  const box = await open(page, { reviews: [review("confirmed")], repairs: [repair("awaiting_approval")] });
  await expect(box.getByText("src/app.js")).toBeVisible();
  await expect(box.getByText("Attacks rerun")).toBeVisible();
  await expect(box.getByText(/1 that succeeded and must now be blocked, 1 that were blocked before and must stay blocked/)).toBeVisible();
  await box.getByText("Show exactly what reruns").click();
  await expect(box.getByText("must now pass: adv-f1")).toBeVisible();
  await expect(box.getByText("must keep passing: adv-p1")).toBeVisible();
  await expect(box.getByRole("button", { name: /Approve repair/ })).toBeVisible();
  await expect(box.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(box.getByText(/Your project and your code are never changed/)).toBeVisible();
});

test("approval explains plainly when repair AI is unavailable", async ({ page }) => {
  const box = await open(page, { reviews: [review("confirmed")], repairs: [repair("awaiting_approval")] });
  await page.route("**/v1/adversarial-runs/adv-1/findings/A1/repair-approvals", (r) => json(r, { code: "repair_ai_not_configured", message: "Repair AI is unavailable: no repair model is configured.", fix: "Configure Gemini or Nebius for Testing AI." }, 503));
  await box.getByRole("button", { name: /Approve repair/ }).click();
  await expect(box.getByText(/Repair AI is unavailable/)).toBeVisible();
});

test("a verified repair shows before/after, the diff and that it must be applied manually", async ({ page }) => {
  const box = await open(page, { reviews: [review("confirmed")], repairs: [repair("verified")] });
  await expect(box.getByText("Repair verified")).toBeVisible();
  await expect(box.getByText(/digest abc123def456/)).toBeVisible();
  await expect(box.getByText("+app.get('/api/admin/overview', requireUser, requireAdmin, overview);")).toBeVisible();
  await expect(box.getByText(/apply the patch above yourself/i)).toBeVisible();
  await expect(box.getByText(/Nothing was applied to your project/)).toBeVisible();
  await expect(box.getByRole("button", { name: /apply automatically/i })).toHaveCount(0);
});

test("a finding the check did not confirm is not offered an automatic repair", async ({ page }) => {
  const run = adversarialRun();
  run.findings = run.findings.map((f) => ({ ...f, status: "suspected" as const }));
  const box = await open(page, { run, reviews: [review("confirmed")] });
  await expect(box.getByText(/Not repairable automatically/)).toBeVisible();
  await expect(box.getByRole("button", { name: /Try repair in sandbox/ })).toHaveCount(0);
});

test("review and repair controls are keyboard reachable and sized for touch", async ({ page }) => {
  const box = await open(page, { reviews: [review("confirmed")], repairs: [repair("awaiting_approval")] });
  const approve = box.getByRole("button", { name: /Approve repair/ });
  await approve.focus();
  await expect(approve).toBeFocused();
  const h = await approve.evaluate((el) => el.getBoundingClientRect().height);
  expect(h).toBeGreaterThanOrEqual(32);
});
