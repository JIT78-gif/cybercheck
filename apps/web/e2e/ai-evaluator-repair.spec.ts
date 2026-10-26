import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Route } from "@playwright/test";
import type { AiEvaluationRunDetail, FindingHumanReview, TestingRepair } from "@cybercheck/contracts";
import { giveEachTestItsOwnIp, signedInUser } from "./helpers";

// Human review + safe sandbox repair on the AI Evaluator Findings tab, using the real (redacted) Gauntlet run.

giveEachTestItsOwnIp(test);
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const run = JSON.parse(readFileSync(resolve(__dirname, "fixtures", "ai-run-gauntlet.json"), "utf8")) as AiEvaluationRunDetail;
const now = new Date().toISOString();
// A case-backed confirmed finding (the canary-only rendering finding has no case ids of its own).
const target = run.findings.find((f) => f.status === "confirmed" && f.caseIds.length > 0)!;

const review: FindingHumanReview = { id: "rv1", findingId: target.id, runId: run.id, projectId: run.projectId, snapshotId: run.snapshotId, reviewerUserId: "u1", reviewerName: "Ana", reviewerRole: "owner", decision: "confirmed", reason: null, createdAt: now, supersedesReviewId: null };
const repair: TestingRepair = {
  id: "rp1", runId: run.id, findingId: target.id, projectId: run.projectId, snapshotId: run.snapshotId, status: "awaiting_approval", requestedBy: "u1", approvedBy: null,
  scope: { files: ["src/agent.js"], reproduction: target.caseIds.slice(0, 2), regression: ["builtin.functional.answers"], maxAttempts: 2, estimate: { minutes: [4, 20], costUsd: [0.03, 0.5] } },
  attempts: [], error: null, createdAt: now, updatedAt: now,
};

async function openFindings(page: import("@playwright/test").Page, o: { reviews: FindingHumanReview[]; repairs: TestingRepair[] }) {
  await signedInUser(page, "AI Repair Tester");
  await page.route(`**/v1/ai-evaluation-runs/${run.id}/events**`, (r) => json(r, { events: [] }));
  await page.route(`**/v1/ai-evaluation-runs/${run.id}/reviews`, (r) => json(r, { reviews: o.reviews, canReview: true }));
  await page.route(`**/v1/ai-evaluation-runs/${run.id}/repairs`, (r) => json(r, { repairs: o.repairs }));
  await page.route(`**/v1/ai-evaluation-runs/${run.id}`, (r) => json(r, { run }));
  await page.goto(`/app/projects/${run.projectId}/ai-evaluator/${run.id}?tab=findings`);
  return page.getByRole("region", { name: `Review and repair ${target.id}`, exact: true });
}

test("every AI finding carries review controls and labels its fix as a recommendation", async ({ page }) => {
  const box = await openFindings(page, { reviews: [], repairs: [] });
  await expect(box.getByRole("button", { name: /Confirm/ })).toBeVisible();
  await expect(page.getByText("Recommended fix").first()).toBeVisible();
  await expect(box.getByText(/available after a reviewer confirms this problem/i)).toBeVisible();
});

test("a confirmed AI finding shows the repair panel with the exact AI cases that rerun", async ({ page }) => {
  const box = await openFindings(page, { reviews: [review], repairs: [repair] });
  await expect(box.getByText("AI cases rerun")).toBeVisible();
  await expect(box.getByText(/that showed the problem/)).toBeVisible();
  await box.getByText("Show exactly what reruns").click();
  await expect(box.getByText(`must now pass: ${target.caseIds[0]}`)).toBeVisible();
  await expect(box.getByText("must keep passing: builtin.functional.answers")).toBeVisible();
  await expect(box.getByRole("button", { name: /Approve repair/ })).toBeVisible();
});
