import { expect, test, type Route } from "@playwright/test";
import { adversarialRun as run, SECRET_TAIL } from "./adversarial-fixture";
import { giveEachTestItsOwnIp, signedInUser } from "./helpers";

// The AI Adversarial results page must be understandable to a non-security business user. These tests drive a crafted,
// mixed-outcome run through the real page (the API is mocked per request) and assert the plain-language experience, the
// executed-versus-planned counts, grouped blocked attacks, collapsed technical detail, accessibility and redaction.

giveEachTestItsOwnIp(test);
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function open(page: import("@playwright/test").Page) {
  await signedInUser(page, "Adversarial Tester");
  await page.route("**/v1/adversarial-runs/adv-1/events**", (r) => json(r, { events: [{ seq: 1, type: "phase:done", message: "Done", at: new Date().toISOString() }] }));
  await page.route("**/v1/adversarial-runs/adv-1", (r) => json(r, { run: run() }));
  await page.goto("/app/projects/proj-1/adversarial/adv-1");
  await expect(page.getByRole("heading", { name: "AI Adversarial results", level: 1 })).toBeVisible();
}

test("the shared run header links back to the project and uses consistent export labels", async ({ page }) => {
  await open(page);
  await expect(page.getByRole("link", { name: "Back to project" })).toHaveAttribute("href", "/app/projects/proj-1");
  await expect(page.getByRole("link", { name: "Report" })).toHaveAttribute("href", "/v1/adversarial-runs/adv-1/export?format=md");
  await expect(page.getByRole("link", { name: "Data (JSON)" })).toHaveAttribute("href", "/v1/adversarial-runs/adv-1/export?format=json");
});

test("the summary states executed versus planned and explains the decision in plain language", async ({ page }) => {
  await open(page);
  await expect(page.getByText(/planned 4 attacks and successfully ran 3/i)).toBeVisible();
  await expect(page.getByText(/not ready for release because/i)).toBeVisible();
  // Counters: executed / planned is shown, not only the planned total.
  await expect(page.getByText("3 / 4", { exact: true })).toBeVisible();
  await expect(page.getByText("Coverage:", { exact: false })).toBeVisible();
});

test("outcomes use plain-language statuses and never call a successful attack 'successful'", async ({ page }) => {
  await open(page);
  await expect(page.getByText("Vulnerability found").first()).toBeVisible();
  await expect(page.getByText("Protected in this test").first()).toBeVisible();
  await expect(page.getByText("Could not test").first()).toBeVisible();
  await expect(page.getByText("Result unclear").first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("successful attack");
});

test("blocked attacks are grouped by root cause and say security was not established", async ({ page }) => {
  await open(page);
  await expect(page.getByText(/could not run because Cybercheck could not create or sign in the required synthetic test/i)).toBeVisible();
  await expect(page.getByText(/does not mean the application is safe/i).first()).toBeVisible();
  await expect(page.getByText(/Test account "customer-2"/i)).toBeVisible();
});

test("an attack card answers attempted, expected, observed, impact and next action", async ({ page }) => {
  await open(page);
  const card = page.locator("#attack-adv-f1");
  await expect(card.getByText("What Cybercheck attempted")).toBeVisible();
  await expect(card.getByText("What should have happened")).toBeVisible();
  await expect(card.getByText("What actually happened")).toBeVisible();
  await expect(card.getByText(/Business impact:/)).toBeVisible();
  await expect(card.getByText(/Recommended fix:/)).toBeVisible();
});

test("attack chains show every step and do not claim success unless every link is proven", async ({ page }) => {
  await open(page);
  await expect(page.getByText("Function authorization to business-logic abuse")).toBeVisible();
  await expect(page.getByText("Step 1", { exact: false })).toBeVisible();
  await expect(page.getByText("Step 2", { exact: false })).toBeVisible();
  await expect(page.getByText("Not fully proven")).toBeVisible();
});

test("AI participation is explained accurately", async ({ page }) => {
  await open(page);
  await expect(page.getByText(/helped select and prioritize attacks/i)).toBeVisible();
  await expect(page.getByText(/AI was never allowed to confirm a vulnerability/i)).toBeVisible();
  await expect(page.getByText(/second AI review was turned off\. Runtime evidence remains valid/i)).toBeVisible();
});

test("technical details are collapsed by default and reveal on demand", async ({ page }) => {
  await open(page);
  const detail = page.getByText("Engine, versions and identifiers");
  await expect(detail).toBeVisible();
  await expect(page.getByText(/Snapshot/).first()).toBeHidden();
  await detail.click();
  await expect(page.getByText("abcdef0123456789", { exact: false })).toBeVisible();
});

test("raw credentials, tokens and canaries never appear anywhere in the page", async ({ page }) => {
  await open(page);
  // Expand every collapsible section first, then check the whole document.
  for (const s of await page.locator("summary").all()) await s.click().catch(() => {});
  await expect(page.locator("body")).not.toContainText(SECRET_TAIL);
});

test("the environment and cost are described in plain language", async ({ page }) => {
  await open(page);
  await expect(page.getByText(/External internet access was disabled/i)).toBeVisible();
  await expect(page.getByText(/No real customer data was touched/i)).toBeVisible();
  await expect(page.getByText(/Estimated AI cost: \$0\.06/)).toBeVisible();
});

test("the coverage progress has a screen-reader label and the layout works at mobile width", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await open(page);
  await expect(page.getByRole("img", { name: /Coverage 75 percent/i })).toBeVisible();
  // No horizontal overflow at phone width.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test("collapsible technical sections are keyboard accessible", async ({ page }) => {
  await open(page);
  const summary = page.getByText("Evidence and safety checks");
  await summary.focus();
  await expect(summary).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/Every confirmed finding cites an execution/i)).toBeVisible();
});

test("comprehension: every acceptance question is answerable from the default page", async ({ page }) => {
  await open(page);
  const body = page.locator("body");
  // 1. How many attacks were planned? 2. How many actually ran?
  await expect(body).toContainText("planned 4 attacks and successfully ran 3");
  // 3. How many found vulnerabilities?
  await expect(body).toContainText("1 found a vulnerability");
  // 4. Why were some attacks not run?
  await expect(body).toContainText(/could not create or sign in the required synthetic test account/i);
  // 5. Does "could not test" mean the application is safe? (No.)
  await expect(body).toContainText(/does not mean the application is safe/i);
  // 6. What should be fixed first?
  await expect(page.getByText("Fix now").first()).toBeVisible();
  await expect(body).toContainText("Ordinary user tried to open an administrator page");
  // 7. Did AI or deterministic runtime evidence confirm the vulnerability?
  await expect(body).toContainText(/Deterministic runtime checks, not the AI, decided whether each attack actually succeeded/i);
  // 8. Was any production data used? (No.)
  await expect(body).toContainText(/No real customer data was touched/i);
});
