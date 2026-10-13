// Drives the real Testing flow in a browser and saves screenshots (debug helper; needs web, API and worker running).
// Usage (repo root): npx tsx apps/web/scripts/testing-screenshots.ts <bench-project> <out-dir>
import { readFileSync, readdirSync, statSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "@playwright/test";
import { makeZip } from "../../api/test/fixtures";
import { latestCode } from "../e2e/helpers";

const [bench = "notes-zero-tests", out = "testing-shots"] = process.argv.slice(2);
const dir = join(__dirname, "../../api/test/testing-bench", bench, "project");
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const zip = makeZip(walk(dir).map((f) => ({ name: `${bench}/${relative(dir, f).replace(/\\/g, "/")}`, data: readFileSync(f, "utf8"), deflate: true })));

async function main() {
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ baseURL: "http://localhost:3000", viewport: { width: 1440, height: 1000 } });
  await page.setExtraHTTPHeaders({ "X-Forwarded-For": `198.18.9.${1 + Math.floor(Math.random() * 250)}` });
  const email = `shots-${Date.now()}@example.test`;
  const headers = { Origin: "http://localhost:3000" };
  const t0 = Date.now() - 1000;
  await page.request.post("/api/auth/sign-up/email", { data: { name: "Shots", email, password: "dashboard-test-password-1" }, headers });
  await page.request.post("/api/auth/email-otp/verify-email", { data: { email, otp: await latestCode(email, "email-verification", t0) }, headers });
  const me = await (await page.request.get("/v1/me")).json();
  const { project } = await (await page.request.post(`/v1/workspaces/${me.workspaces[0].id}/projects`, { data: { name: bench, sourceType: "archive" } })).json();
  await page.request.post(`/v1/projects/${project.id}/snapshots/archive`, { headers: { "idempotency-key": randomUUID() }, multipart: { attest: "true", file: { name: `${bench}.zip`, mimeType: "application/zip", buffer: zip } } });
  console.log("uploaded; waiting for the analysis");
  for (let i = 0; i < 300; i++) {
    const res = await page.request.get(`/v1/projects/${project.id}`).catch(() => null);
    if (!res?.ok()) {
      await page.waitForTimeout(2000); // the API may be restarting
      continue;
    }
    const p = (await res.json()).project;
    if (p.analysis.stage === "ready") break;
    if (["failed", "rejected"].includes(p.analysis.stage)) throw new Error(`analysis ${p.analysis.stage}`);
    await page.waitForTimeout(2000);
  }
  await page.goto(`/app/checks/testing?project=${project.id}`);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: join(out, "0-testing-tab.png"), fullPage: true });
  await page.getByText("Your project is ready.").waitFor({ timeout: 30_000 });
  await page.screenshot({ path: join(out, "1-testing-tab-ready.png"), fullPage: true });
  await page.getByRole("button", { name: "Start Testing check" }).click();
  await page.waitForURL(/\/testing\//, { timeout: 30_000 });
  await page.waitForTimeout(15_000);
  await page.screenshot({ path: join(out, "2-run-live.png"), fullPage: true });
  console.log("run started:", page.url());
  await page.getByText(/Finished|Could not test|Stopped with an error|Blocked/).first().waitFor({ timeout: 900_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(out, "3-run-report.png"), fullPage: true });
  // Open the first finding to show its evidence.
  const first = page.locator("details summary").filter({ hasText: /F\d+/ }).first();
  if (await first.count()) {
    await first.click();
    await page.screenshot({ path: join(out, "4-finding-open.png"), fullPage: true });
  }
  await page.setViewportSize({ width: 375, height: 800 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(out, "5-run-report-375.png"), fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  console.log("horizontal overflow at 375px:", overflow);
  await page.goto(`/app/checks/testing?project=${project.id}`);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(out, "6-testing-tab-results-375.png"), fullPage: true });
  await browser.close();
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
