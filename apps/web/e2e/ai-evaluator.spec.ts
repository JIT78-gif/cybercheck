import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Route } from "@playwright/test";
import type { AiEvaluationRunDetail } from "@cybercheck/contracts";
import { giveEachTestItsOwnIp, signedInUser } from "./helpers";

// The AI Evaluator run page, fed with real (redacted) runs from the local Docker evaluation of the Gauntlet and the
// clean AI control.

giveEachTestItsOwnIp(test);

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const load = (name: string) => JSON.parse(readFileSync(resolve(__dirname, "fixtures", name), "utf8")) as AiEvaluationRunDetail;

async function mockRun(page: import("@playwright/test").Page, run: AiEvaluationRunDetail) {
  await page.route(`**/v1/ai-evaluation-runs/${run.id}/events**`, (r) => json(r, { events: [] }));
  await page.route(`**/v1/ai-evaluation-runs/${run.id}`, (r) => json(r, { run }));
}

test("a run with findings shows the decision, the confirmed findings and redacted evidence", async ({ page }) => {
  await signedInUser(page, "ai-eval");
  const run = load("ai-run-gauntlet.json");
  await mockRun(page, run);
  await page.goto(`/app/projects/${run.projectId}/ai-evaluator/${run.id}`);
  await expect(page.getByRole("heading", { name: "AI Evaluator check" })).toBeVisible();
  await expect(page.getByText("Not ready: AI findings")).toBeVisible();
  await expect(page.getByRole("tablist", { name: "AI Evaluator results" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Markdown/ })).toHaveAttribute("href", `/v1/ai-evaluation-runs/${run.id}/export?format=md`);

  await page.getByRole("tab", { name: /Findings/ }).click();
  await expect(page.getByRole("heading", { name: "AI replies expose credential-like values" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "AI replies repeat the system prompt" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Model output executes as HTML in the browser (cross-site scripting)" })).toBeVisible();

  await page.getByRole("tab", { name: /summary/i }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Tool permissions and approval" }).getByText("Decisive: failed")).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Output rendering" }).getByText("Decisive: failed")).toBeVisible();

  await page.getByRole("tab", { name: /Cases/ }).click();
  await page.getByText("The assistant answers an ordinary question").click();
  await expect(page.getByText("What the app answered (redacted)").filter({ visible: true })).toHaveCount(1);
  // The Gauntlet's fixture key never reaches the page.
  await expect(page.locator("body")).not.toContainText("sk-fixture");
});

test("a clean run upholds every required safety lane and is ready, with evidence", async ({ page }) => {
  await signedInUser(page, "ai-eval-clean");
  const run = load("ai-run-control.json");
  await mockRun(page, run);
  await page.goto(`/app/projects/${run.projectId}/ai-evaluator/${run.id}`);
  await expect(page.getByText("Ready, with evidence")).toBeVisible();

  // The required-lanes panel shows the critical safety lanes upheld (output rendering does not apply: the reply is text).
  await expect(page.getByRole("heading", { name: "Required evaluation lanes" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Prompt injection" }).getByText("Decisive: upheld")).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "User and tenant isolation" }).getByText("Decisive: upheld")).toBeVisible();

  // Components tab shows the target's selectors checked against a real response, and the live-gateway health.
  await page.getByRole("tab", { name: "Components and targets" }).click();
  await expect(page.getByRole("heading", { name: "Target selectors, checked against a real response" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "responseSelector" }).getByText("resolved", { exact: true })).toBeVisible();
  await expect(page.getByText("Live model gateway")).toBeVisible();

  await page.getByRole("tab", { name: "Categories" }).click();
  await page.getByRole("tab", { name: /Reliability/ }).click();
  await expect(page.getByText("A provider outage is answered cleanly")).toBeVisible();

  // Repository-derived cases (from the project's own tests) are informational: a failure is shown but does not gate.
  await page.getByRole("tab", { name: /Cases/ }).click();
  await page.getByText("From this project's tests:").first().click();
  await expect(page.getByText("The project's own tests or documentation").first()).toBeVisible();

  await page.getByRole("tab", { name: /Untested and audit/ }).click();
  await expect(page.getByText("network off while the app ran")).toBeVisible();
  await expect(page.getByText(/AI judge: (off|unavailable|not_needed)/)).toBeVisible();
});

test("every tab fits a phone screen with no sideways scrolling", async ({ page }) => {
  await signedInUser(page, "ai-eval-phone");
  const run = load("ai-run-gauntlet.json");
  await mockRun(page, run);
  const shots = process.env.CC_SHOTS;
  const errors: string[] = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("pageerror", (e) => errors.push(e.message));
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const tab of ["summary", "findings", "cases", "categories", "performance", "components", "untested"]) {
      await page.goto(`/app/projects/${run.projectId}/ai-evaluator/${run.id}${tab === "summary" ? "" : `?tab=${tab}`}`);
      await expect(page.getByRole("tablist", { name: "AI Evaluator results" })).toBeVisible();
      if (tab === "cases") await page.locator("details summary").first().click();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${tab} at ${width}px`).toBeLessThanOrEqual(0);
      if (shots) await page.screenshot({ path: `${shots}/ai-${tab}-${width}.png`, fullPage: true });
    }
  }
  expect(errors).toEqual([]);
});

test("a running run shows its phases", async ({ page }) => {
  await signedInUser(page, "ai-eval-live");
  const run = { ...load("ai-run-control.json"), status: "running", phase: "executing", report: null, finishedAt: null } as AiEvaluationRunDetail;
  await mockRun(page, run);
  await page.goto(`/app/projects/${run.projectId}/ai-evaluator/${run.id}`);
  await expect(page.locator("[aria-current=step]")).toHaveText("Run cases");
  await expect(page.getByRole("button", { name: "Cancel" })).toBeVisible();
});
