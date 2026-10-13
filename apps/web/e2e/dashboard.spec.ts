import { expect, test } from "@playwright/test";
import { demoProject, makeZip } from "../../api/test/fixtures";
import { giveEachTestItsOwnIp, signedInUser } from "./helpers";

giveEachTestItsOwnIp(test);


const demoZip = makeZip(Object.entries(demoProject).map(([name, data]) => ({ name: `acme-demo/${name}`, data, deflate: true })));
const hostileZip = makeZip([{ name: "../../evil.js", data: "x" }]);

test("signed-out visitors can't open a check tab", async ({ page }) => {
  await page.goto("/app/checks/testing");
  await expect(page).toHaveURL(/\/login\?next=%2Fapp%2Fchecks%2Ftesting$/);
});

test("add a project from the Testing tab; it is shared with every tab and the Overview", async ({ page }) => {
  test.setTimeout(300_000); // waits for the full analysis, including the AI step
  await signedInUser(page, "Grace Tester");

  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
  await expect(page.getByText("No projects yet")).toBeVisible();

  await page.getByRole("link", { name: "Testing" }).click();
  await expect(page.getByRole("heading", { name: "Run a Testing check" })).toBeVisible();
  await page.getByRole("button", { name: "Add new project" }).click();
  await page.getByRole("button", { name: /Upload from your computer/ }).click();
  await page.getByTestId("archive-input").setInputFiles({ name: "acme-demo.zip", mimeType: "application/zip", buffer: demoZip });

  await expect(page.getByLabel("Project name")).toHaveValue("acme-demo");
  const name = `acme-demo-${Date.now()}`;
  await page.getByLabel("Project name").fill(name);
  const upload = page.getByRole("button", { name: "Create project and upload" });
  await expect(upload).toBeDisabled(); // ownership confirmation required
  await page.getByRole("checkbox").check();
  await upload.click();

  await expect(page.getByRole("heading", { name: "Upload saved, analysis started" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("is saved as a frozen snapshot")).toBeVisible();
  await expect(page.getByText("Next.js", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Done" }).click();

  // Selected in Testing, but not checkable until the full analysis (code + AI step) has finished.
  const select = page.getByLabel("Project");
  await expect(select.locator("option:checked")).toHaveText(new RegExp(`^${name}`));
  await expect(page).toHaveURL(/\?project=/);
  await expect(page.getByRole("button", { name: "Start Testing check" })).toBeDisabled();
  // The status updates by itself (no reload) until the project is ready.
  await expect(page.getByText("Your project is ready.")).toBeVisible({ timeout: 240_000 });
  await expect(select.locator("option:checked")).toHaveText(name);

  // ...and already selected in Security (shared project, remembered choice).
  await page.getByRole("link", { name: "Security" }).click();
  await expect(page.getByRole("heading", { name: "Run a Security check" })).toBeVisible();
  await expect(page.getByLabel("Project").locator("option:checked")).toHaveText(name);

  // AI Evaluator applies: the demo uses the OpenAI SDK.
  await page.getByRole("link", { name: "AI Evaluator" }).click();
  await expect(page.getByText("OpenAI").filter({ visible: true })).toBeVisible();
  await expect(page.getByText(/Not applicable/).filter({ visible: true })).toHaveCount(0);

  // Overview lists it as ready.
  await page.getByRole("link", { name: "Overview" }).click();
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row.getByText("Ready")).toBeVisible();

  // Project page shows the frozen file list.
  await row.getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
  await expect(page.getByText("src/routes/orders.ts")).toBeVisible();
});

test("a hostile archive is rejected with reasons and fixes", async ({ page }) => {
  await signedInUser(page, "Mallory Tester");
  await page.goto("/app/projects");
  await page.getByRole("button", { name: "Add project" }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: /Upload from your computer/ }).click();
  await dialog.getByTestId("archive-input").setInputFiles({ name: "evil.zip", mimeType: "application/zip", buffer: hostileZip });
  await dialog.getByLabel("Project name").fill(`evil-${Date.now()}`);
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Create project and upload" }).click();

  await expect(dialog.getByRole("heading", { name: "We couldn't accept this archive" })).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByText(/could escape the project folder/)).toBeVisible();
  await expect(dialog.getByText("How to fix:")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Try another file" })).toBeVisible();
});

test("files that aren't archives are refused before uploading", async ({ page }) => {
  await signedInUser(page);
  await page.goto("/app/checks/security");
  await page.getByRole("button", { name: "Add new project" }).click();
  await page.getByRole("button", { name: /Upload from your computer/ }).click();
  await page.getByTestId("archive-input").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hi") });
  await expect(page.getByRole("alert").filter({ hasText: "Choose a project folder, or a .zip" })).toBeVisible();
});
