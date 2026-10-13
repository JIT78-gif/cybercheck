import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { demoProject } from "../../api/test/fixtures";
import { giveEachTestItsOwnIp, signedInUser } from "./helpers";

giveEachTestItsOwnIp(test);

test("upload a local folder: dependencies are left out and it becomes a snapshot", async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), "cc-folder-"));
  const folder = join(root, "acme-folder");
  const files: Record<string, string> = {
    ...demoProject,
    "node_modules/react/index.js": "module.exports = {}",
    "node_modules/react/package.json": "{}",
    ".git/HEAD": "ref: refs/heads/main",
  };
  for (const [path, data] of Object.entries(files)) {
    await mkdir(dirname(join(folder, path)), { recursive: true });
    await writeFile(join(folder, path), data);
  }

  try {
    await signedInUser(page, "Folder Tester");
    await page.goto("/app/checks/testing");
    await page.getByRole("button", { name: "Add new project" }).click();
    await page.getByRole("button", { name: /Upload from your computer/ }).click();
    await page.getByTestId("folder-input").setInputFiles(folder);

    await expect(page.getByText("acme-folder/")).toBeVisible();
    await expect(page.getByText(`${Object.keys(demoProject).length} files`)).toBeVisible();
    await expect(page.getByText(/3 items left out/)).toBeVisible();
    await page.getByLabel("Project name").fill(`folder-${Date.now()}`);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Create project and upload" }).click();

    await expect(page.getByRole("heading", { name: "Upload saved, analysis started" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(`${Object.keys(demoProject).length} files`).first()).toBeVisible();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// ---------- GitHub UI (GitHub itself is stubbed at our API boundary) ----------

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function stubGithub(page: Page, opts: { connected: boolean }) {
  const calls: Array<{ url: string; body: unknown }> = [];
  await page.route("**/v1/github/status", (r) =>
    json(r, {
      configured: true,
      installUrl: "https://github.com/apps/cybercheck/installations/new",
      connected: opts.connected,
      authorized: opts.connected,
      login: opts.connected ? "octo-test" : null,
      avatarUrl: null,
      installations: opts.connected
        ? [{ id: 42, account: { login: "octo-test", type: "User", avatarUrl: "x" }, selection: "selected", settingsUrl: "https://github.com/settings/installations/42" }]
        : [],
    }),
  );
  await page.route("**/v1/github/installations/42/repos**", (r) => {
    const q = new URL(r.request().url()).searchParams.get("q") ?? "";
    const repos = [
      { fullName: "octo-test/storefront", name: "storefront", owner: "octo-test", private: true, defaultBranch: "main", pushedAt: new Date().toISOString(), language: "TypeScript", description: null, importedProjectId: null },
      { fullName: "octo-test/old-site", name: "old-site", owner: "octo-test", private: false, defaultBranch: "main", pushedAt: "2024-01-01T00:00:00Z", language: "JavaScript", description: null, importedProjectId: "existing-project" },
    ].filter((x) => x.fullName.includes(q));
    return json(r, { repos, total: repos.length });
  });
  await page.route("**/v1/github/repos/octo-test/storefront/branches", (r) =>
    json(r, { branches: [{ name: "main", sha: "a".repeat(40), isDefault: true }, { name: "dev", sha: "b".repeat(40), isDefault: false }] }),
  );
  const project = { id: "gh-project", workspaceId: "w", name: "storefront", description: null, sourceType: "github", githubRepo: "octo-test/storefront", createdAt: new Date().toISOString(), latestSnapshot: null, analysis: { stage: "none", step: null, progress: null, error: null } };
  await page.route("**/v1/workspaces/*/projects", (r) => {
    if (r.request().method() !== "POST") return r.fallback();
    calls.push({ url: r.request().url(), body: r.request().postDataJSON() });
    return json(r, { project }, 201);
  });
  const snapshot = {
    id: "gh-snap", projectId: "gh-project", status: "BASELINED", sourceType: "github", sourceRef: "dev", resolvedRevision: "b".repeat(40),
    contentDigest: "c".repeat(64), fileCount: 6, totalBytes: 441,
    detection: { languages: ["TypeScript"], packageManager: "npm", lockfile: "package-lock.json", typescript: true, frameworks: ["Next.js"], aiSdks: [], scripts: {}, nodeEngine: null, packageName: "storefront" },
    warnings: [], rejectionReasons: [], exclusions: [], error: null, createdAt: new Date().toISOString(), baselinedAt: new Date().toISOString(),
  };
  await page.route("**/v1/projects/gh-project/snapshots/github", (r) => {
    calls.push({ url: r.request().url(), body: r.request().postDataJSON() });
    return json(r, { snapshot: { ...snapshot, status: "RECEIVED" } }, 202);
  });
  await page.route("**/v1/snapshots/gh-snap/events**", (r) => r.fulfill({ status: 404, body: "" })); // forces polling
  await page.route("**/v1/snapshots/gh-snap", (r) =>
    json(r, {
      snapshot,
      events: ["received", "resolving", "downloading", "validating", "extracting", "normalizing", "detecting", "baselined"].map((type, i) => ({
        seq: i + 1, type, payload: type === "downloading" ? { sha: "b".repeat(40) } : {}, createdAt: new Date().toISOString(),
      })),
    }),
  );
  await page.route("**/v1/projects/gh-project", (r) => json(r, { project: { ...project, latestSnapshot: snapshot, snapshots: [snapshot], analysis: { stage: "ready", step: null, progress: null, error: null } } }));
  return calls;
}

test("GitHub not connected: the import step offers to connect", async ({ page }) => {
  await signedInUser(page, "Gh Tester");
  await stubGithub(page, { connected: false });
  await page.goto("/app/projects");
  await page.getByRole("button", { name: "Add project" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: /Import from GitHub/ }).click();
  await expect(page.getByRole("dialog").getByRole("button", { name: "Connect GitHub" })).toBeVisible();
});

test("GitHub connected: pick a repository from the list, choose a branch, import it", async ({ page }) => {
  await signedInUser(page, "Gh Importer");
  const calls = await stubGithub(page, { connected: true });
  await page.goto("/app/projects");
  await page.getByRole("button", { name: "Add project" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("@octo-test")).toBeVisible();
  await dialog.getByRole("button", { name: /Import from GitHub/ }).click();

  await expect(dialog.getByText("storefront", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Private")).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Imported · Open" })).toHaveAttribute("href", "/app/projects/existing-project");
  await expect(dialog.getByRole("link", { name: /Adjust GitHub access/ })).toHaveAttribute("href", "https://github.com/settings/installations/42");

  await dialog.getByRole("searchbox", { name: "Search repositories" }).fill("store");
  await expect(dialog.getByText("old-site")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Import octo-test/storefront" }).click();
  await expect(dialog.getByLabel("Branch")).toHaveValue("main");
  await dialog.getByLabel("Branch").selectOption("dev");
  await expect(dialog.getByRole("button", { name: "Import repository" })).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Import repository" }).click();

  await expect(dialog.getByRole("heading", { name: "Upload saved, analysis started" })).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByText("Pinning the branch to an exact commit")).toBeVisible();
  await expect(dialog.getByText("bbbbbbb").first()).toBeVisible();

  expect(calls[0]!.body).toMatchObject({ name: "storefront", sourceType: "github", githubRepo: "octo-test/storefront" });
  expect(calls[1]!.body).toEqual({ repo: "octo-test/storefront", ref: "dev", attest: true });
});

test("returning from GitHub (?add=github) reopens the import step", async ({ page }) => {
  await signedInUser(page, "Gh Return");
  await stubGithub(page, { connected: true });
  await page.goto("/app/projects?add=github");
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Import a GitHub repository" })).toBeVisible();
});
