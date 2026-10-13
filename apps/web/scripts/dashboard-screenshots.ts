// Signs up a throwaway user, uploads the demo project, and screenshots the dashboard.
// Usage (repo root): npx tsx apps/web/scripts/dashboard-screenshots.ts <outDir>
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { demoProject, makeZip } from "../../api/test/fixtures";
import { latestCode } from "../e2e/helpers";

const outDir = process.argv[2];
if (!outDir) throw new Error("Usage: dashboard-screenshots.ts <outDir>");
mkdirSync(outDir, { recursive: true });
const BASE = "http://localhost:3000";

async function shot(page: Page, name: string, full = false) {
  await page.waitForTimeout(700);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  await page.screenshot({ path: join(outDir, `${name}.png`), fullPage: full });
  console.log(`${name}: horizontalOverflow=${overflow}`);
}

async function main() {
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    baseURL: BASE,
    extraHTTPHeaders: { "X-Forwarded-For": `198.19.${Math.floor(Math.random() * 256)}.7` },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  const email = `shots-${Date.now()}@example.test`;
  const t0 = Date.now() - 1000;
  const headers = { Origin: BASE };
  await page.request.post("/api/auth/sign-up/email", { data: { name: "Jit Guard", email, password: "screenshot-password-1" }, headers });
  await page.request.post("/api/auth/email-otp/verify-email", { data: { email, otp: await latestCode(email, "email-verification", t0) }, headers });

  await page.goto("/app", { waitUntil: "networkidle" });
  await shot(page, "01-overview-empty", true);

  await page.goto("/app/checks/testing", { waitUntil: "networkidle" });
  await shot(page, "02-testing-empty");
  await page.getByRole("button", { name: "Add new project" }).click();
  await shot(page, "03-add-project-source");
  await page.getByRole("button", { name: /Upload an archive/ }).click();
  await shot(page, "04-add-project-file");
  const zip = makeZip(Object.entries(demoProject).map(([name, data]) => ({ name: `acme-storefront/${name}`, data, deflate: true })));
  await page.locator('input[type="file"]').setInputFiles({ name: "acme-storefront.zip", mimeType: "application/zip", buffer: zip });
  await page.getByRole("checkbox").check();
  await shot(page, "05-add-project-details");
  await page.getByRole("button", { name: "Create project and upload" }).click();
  await page.getByRole("heading", { name: "Upload saved, analysis started" }).waitFor({ timeout: 20_000 });
  await shot(page, "06-snapshot-ready", true);
  await page.getByRole("button", { name: "Done" }).click();
  await shot(page, "07-testing-selected", true);

  await page.goto("/app", { waitUntil: "networkidle" });
  await shot(page, "08-overview-with-project", true);
  await page.getByRole("row").filter({ hasText: "acme-storefront" }).getByRole("link", { name: "acme-storefront", exact: true }).click();
  await page.getByRole("heading", { name: "acme-storefront", level: 1 }).waitFor();
  await shot(page, "09-project-detail", true);

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/app", { waitUntil: "networkidle" });
  await shot(page, "10-mobile-overview", true);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await shot(page, "11-mobile-nav");
  await page.goto("/app/checks/security", { waitUntil: "networkidle" });
  await shot(page, "12-mobile-security", true);

  console.log(`console/page errors: ${errors.length}`);
  errors.forEach((e) => console.log(`  ${e}`));
} finally {
  await browser.close();
}
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
