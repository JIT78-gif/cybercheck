import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { expressShop, makeZip } from "../../api/test/fixtures";
import { giveEachTestItsOwnIp, signedInUser } from "./helpers";

giveEachTestItsOwnIp(test);

/** Creates a project from the Express + Prisma fixture through the API and waits for its snapshot. */
async function uploadShop(page: Page) {
  const me = await (await page.request.get("/v1/me")).json();
  const created = await page.request.post(`/v1/workspaces/${me.workspaces[0].id}/projects`, {
    data: { name: `shop-${Date.now()}`, sourceType: "archive" },
  });
  const { project } = await created.json();
  const zip = makeZip(Object.entries(expressShop).map(([name, data]) => ({ name: `shop/${name}`, data, deflate: true })));
  const up = await page.request.post(`/v1/projects/${project.id}/snapshots/archive`, {
    headers: { "idempotency-key": randomUUID() },
    multipart: { attest: "true", file: { name: "shop.zip", mimeType: "application/zip", buffer: zip } },
  });
  expect(up.ok()).toBeTruthy();
  await expect
    .poll(async () => (await (await page.request.get(`/v1/projects/${project.id}`)).json()).project.latestSnapshot?.status, { timeout: 20_000 })
    .toBe("BASELINED");
  return project.id as string;
}

test("architecture: sections, diagrams, evidence and export", async ({ page }) => {
  const mermaidErrors: string[] = [];
  page.on("console", (m) => m.type() === "error" && /mermaid|syntax|parse/i.test(m.text()) && mermaidErrors.push(m.text()));

  await signedInUser(page, "Architect");
  const id = await uploadShop(page);

  // The project page shows the understanding status and links to the Architecture area.
  await page.goto(`/app/projects/${id}`);
  await expect(page.getByText(/areas answered from code/)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("link", { name: "Open architecture" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/projects/${id}/architecture`), { timeout: 30_000 });

  const nav = page.getByRole("navigation", { name: "Architecture sections" });
  await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Purpose", { exact: true })).toBeVisible();

  // API section: the unprotected DELETE route is listed and filterable.
  await nav.getByRole("button", { name: /API and payloads/ }).click();
  await expect(page.getByRole("heading", { name: "API and payloads" })).toBeVisible();
  await page.getByRole("button", { name: /No protection found/ }).click();
  const row = page.getByRole("row").filter({ hasText: "/api/orders/:id" }).filter({ hasText: "DELETE" });
  await expect(row).toContainText("No protection found");
  await expect(page.locator("figure svg").first()).toBeVisible({ timeout: 20_000 });

  // Evidence opens the code viewer at the right line.
  await row.getByRole("button", { name: /src\/routes\/orders\.ts:\d+/ }).last().click(); // the handler column
  const viewer = page.getByRole("dialog");
  await expect(viewer.getByRole("heading", { name: "src/routes/orders.ts" })).toBeVisible();
  await expect(viewer.locator("tr.bg-accent\\/10").first()).toContainText('router.delete("/:id"');
  await viewer.getByRole("button", { name: "Close code viewer" }).click();
  await expect(viewer).toBeHidden();

  // Every section with a diagram draws it without falling back to source text.
  const withDiagrams = [
    ["Code structure", "Code structure"],
    ["Data structures", "Data structures"],
    ["Domain types", "Domain types"],
    ["Auth and security", "Auth and security model"],
    ["Integrations", "Integrations"],
    ["Infrastructure", "Infrastructure"],
    ["Quality and tests", "Quality and tests"],
  ];
  for (const [label, heading] of withDiagrams) {
    await nav.getByRole("button", { name: new RegExp(`^${label}`) }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    const figures = page.locator("figure");
    if (await figures.count()) await expect(figures.first().locator("svg").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("This diagram couldn't be drawn")).toHaveCount(0);
    if (label === "Data structures") await expect(page.locator("p", { hasText: /^Order/ }).first()).toBeVisible();
  }

  // Back returns to the previous section.
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Infrastructure", exact: true })).toBeVisible();
  await page.goForward();

  // Deep links keep the section.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Quality and tests" })).toBeVisible({ timeout: 20_000 });

  // Exports download.
  const md = await page.request.get((await page.getByRole("link", { name: "Markdown" }).getAttribute("href"))!);
  expect(md.ok()).toBeTruthy();
  expect(await md.text()).toContain("```mermaid");

  expect(mermaidErrors).toEqual([]);
});
