import { expect, test, type Route } from "@playwright/test";
import { demoProject, makeZip } from "../../api/test/fixtures";
import { giveEachTestItsOwnIp, signedInUser } from "./helpers";

giveEachTestItsOwnIp(test);

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

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
  await expect(page.getByText("Add a project once, then run Testing, Security, AI Evaluator and Adversarial checks")).toBeVisible();
  await expect(page.getByText("Check types")).toBeVisible();
  await expect(page.getByText("Check engines arrive in the next step")).toHaveCount(0);
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
  const select = page.getByLabel("Project", { exact: true });
  await expect(select.locator("option:checked")).toHaveText(new RegExp(`^${name}`));
  await expect(page).toHaveURL(/\?project=/);
  const startTesting = page.getByRole("button", { name: "Start Testing check" });
  // Analysis usually continues after upload, but a fast local run may finish before
  // this assertion. In both cases the page must update itself without a reload.
  if (await startTesting.isDisabled()) {
    await expect(page.getByText("Your project is ready.")).toBeVisible({ timeout: 240_000 });
  }
  await expect(startTesting).toBeEnabled();
  await expect(select.locator("option:checked")).toHaveText(name);

  // ...and already selected in Security (shared project, remembered choice).
  await page.getByRole("link", { name: "Security" }).click();
  await expect(page.getByRole("heading", { name: "Run a Security check" })).toBeVisible();
  await expect(page.getByLabel("Project", { exact: true }).locator("option:checked")).toHaveText(name);

  // AI Evaluator applies: the demo uses the OpenAI SDK.
  await page.getByRole("link", { name: "AI Evaluator" }).click();
  await expect(page.getByText("OpenAI").filter({ visible: true })).toBeVisible();
  await expect(page.getByText(/Not applicable/).filter({ visible: true })).toHaveCount(0);

  // Overview lists it as ready.
  await page.getByRole("link", { name: "Overview" }).click();
  await expect(page.getByText("Ready to check")).toBeVisible();
  await expect(page.getByText("1 of 1")).toBeVisible();
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

test("failed projects remain selectable on every check workspace", async ({ page }) => {
  await signedInUser(page, "Failed Project Selector Tester");
  const now = new Date().toISOString();
  let reanalysisStarted = false;
  const snapshot = (id: string, projectId: string) => ({
    id,
    projectId,
    status: "BASELINED",
    sourceType: "archive",
    sourceRef: null,
    resolvedRevision: null,
    contentDigest: "d".repeat(64),
    fileCount: 3,
    totalBytes: 100,
    detection: null,
    warnings: [],
    rejectionReasons: [],
    exclusions: [],
    error: null,
    createdAt: now,
    baselinedAt: now,
  });
  const project = (id: string, name: string) => ({
    id,
    workspaceId: "w",
    name,
    description: null,
    sourceType: "archive",
    githubRepo: null,
    createdAt: now,
    latestSnapshot: snapshot(`snapshot-${id}`, id),
    analysis: { stage: "failed", step: null, progress: null, error: "The previous analysis failed." },
  });
  const projects = [project("failed-a", "First failed project"), project("failed-b", "Second failed project")];

  await page.route("**/v1/workspaces/*/projects", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const current = projects.map((item) =>
      reanalysisStarted && item.id === "failed-b"
        ? { ...item, analysis: { stage: "reading_code", step: "Reading the code", progress: 0.1, error: null } }
        : item,
    );
    return json(route, { projects: current });
  });
  await page.route("**/v1/projects/*/security-runs", (route) => json(route, { runs: [] }));
  const understanding = (route: Route) => {
    const snapshotId = route.request().url().split("/snapshots/")[1]!.split("/")[0]!;
    if (route.request().method() === "POST") reanalysisStarted = true;
    return json(route, {
      run: {
        id: "understanding-rerun",
        snapshotId,
        status: reanalysisStarted ? "queued" : "failed",
        progress: reanalysisStarted ? { step: "Reading the code", progress: 0.1 } : null,
        dossier: null,
        error: reanalysisStarted ? null : "The previous analysis failed.",
        createdAt: now,
        startedAt: reanalysisStarted ? now : null,
        finishedAt: reanalysisStarted ? null : now,
      },
    });
  };
  await page.route("**/v1/snapshots/*/understanding", understanding);
  await page.route("**/v1/snapshots/*/understanding/rerun", understanding);

  await page.goto("/app/checks/security?project=failed-a");
  const select = page.getByLabel("Project", { exact: true });
  await expect(select.locator("option:checked")).toHaveText("First failed project (failed)");

  await select.selectOption("failed-b");

  await expect(select.locator("option:checked")).toHaveText("Second failed project (failed)");
  await expect(page).toHaveURL(/project=failed-b/);
  await expect(page.getByRole("link", { name: "View project details" })).toHaveAttribute("href", "/app/projects/failed-b");
  await expect(page.getByRole("button", { name: "Start Security check" })).toBeDisabled();
  await page.getByRole("button", { name: "Analyze again" }).click();
  await expect.poll(() => reanalysisStarted).toBe(true);
  await expect(page.getByRole("button", { name: "Analysis running" })).toBeDisabled();
});
