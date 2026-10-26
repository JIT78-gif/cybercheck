import { expect, test, type Route } from "@playwright/test";
import { giveEachTestItsOwnIp, signedInUser } from "./helpers";

// The project page must let a user get back to any check's past result. These tests mock the per-check run lists and
// assert the "Checks" section shows each check's latest result with an "Open results" link (or a way to run it).

giveEachTestItsOwnIp(test);
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const project = {
  id: "proj-1", workspaceId: "ws-1", name: "Hotel Management", description: null, sourceType: "archive", githubRepo: null,
  createdAt: new Date().toISOString(), latestSnapshot: null,
  analysis: { stage: "ready", step: null, progress: null, error: null },
  snapshots: [],
};

const run = (over: Record<string, unknown>) => ({ id: "r", snapshotId: "snap-1", projectId: "proj-1", status: "completed", step: null, progress: null, headline: null, createdAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), ...over });

async function open(page: import("@playwright/test").Page) {
  await signedInUser(page, "Project Tester");
  await page.route("**/v1/projects/proj-1", (r) => json(r, { project }));
  await page.route("**/v1/projects/proj-1/testing-runs", (r) => json(r, { runs: [run({ id: "t1", status: "completed", headline: "Ready to release: all checks passed." })] }));
  await page.route("**/v1/projects/proj-1/security-runs", (r) => json(r, { runs: [run({ id: "s1", status: "running", step: "Scanning for secrets", progress: 0.5 })] }));
  await page.route("**/v1/projects/proj-1/ai-evaluation-runs", (r) => json(r, { runs: [] }));
  await page.route("**/v1/projects/proj-1/adversarial-runs", (r) => json(r, { runs: [run({ id: "a1", status: "completed", headline: "Not ready to release: 2 vulnerabilities found." })] }));
  await page.goto("/app/projects/proj-1");
  await expect(page.getByRole("heading", { name: "Hotel Management", level: 1 })).toBeVisible();
}

test("the project page lists every check with a way back to its latest result", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("heading", { name: "Checks", level: 2 })).toBeVisible();
  for (const name of ["Testing", "Security", "AI Evaluator", "AI Adversarial"]) await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
});

test("a finished run offers 'Open results' linking to that run; a check with no runs offers 'Run'", async ({ page }) => {
  await open(page);
  // Testing finished -> Open results to the run page.
  const testingOpen = page.getByRole("link", { name: /Open results/i }).first();
  await expect(testingOpen).toBeVisible();
  // Adversarial finished -> a link to its run page exists.
  await expect(page.locator('a[href="/app/projects/proj-1/adversarial/a1"]')).toBeVisible();
  await expect(page.locator('a[href="/app/projects/proj-1/testing/t1"]')).toBeVisible();
  // AI Evaluator has no runs -> a "Run AI Evaluator" launch link.
  await expect(page.getByRole("link", { name: /Run AI Evaluator/i })).toHaveAttribute("href", "/app/checks/ai-evaluator?project=proj-1");
});

test("an active run shows 'Watch' and live progress text, not a safety verdict", async ({ page }) => {
  await open(page);
  await expect(page.locator('a[href="/app/projects/proj-1/security/s1"]')).toContainText(/Watch/i);
  await expect(page.getByText("Scanning for secrets")).toBeVisible();
});

test("the headline of a finished run is shown so the decision is visible without opening it", async ({ page }) => {
  await open(page);
  await expect(page.getByText("Not ready to release: 2 vulnerabilities found.")).toBeVisible();
  await expect(page.getByText("Ready to release: all checks passed.")).toBeVisible();
});
