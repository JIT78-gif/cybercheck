// Screenshots of the Testing report page for a saved run (debug helper; needs the web app and API running).
// The run's JSON is served through a route mock, so no test runs and nothing is sent anywhere.
// Usage (repo root): npx tsx apps/web/scripts/report-shots.ts <run.json> <out-dir>
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { latestCode } from "../e2e/helpers";

const [file, out = "report-shots"] = process.argv.slice(2);
const run = JSON.parse(readFileSync(file!, "utf8"));

async function main() {
  mkdirSync(out, { recursive: true });
  const browser = await browserFor();
  for (const width of [1440, 375]) {
    const page = await browser.newPage({ baseURL: "http://localhost:3000", viewport: { width, height: width < 500 ? 812 : 1000 } });
    await page.setExtraHTTPHeaders({ "X-Forwarded-For": `198.18.7.${1 + Math.floor(Math.random() * 250)}` });
    const email = `report-shots-${Date.now()}@example.test`;
    const headers = { Origin: "http://localhost:3000" };
    const t0 = Date.now() - 1000;
    await page.request.post("/api/auth/sign-up/email", { data: { name: "Shots", email, password: "dashboard-test-password-1" }, headers });
    await page.request.post("/api/auth/email-otp/verify-email", { data: { email, otp: await latestCode(email, "email-verification", t0) }, headers });
    await page.route(`**/v1/testing-runs/${run.id}/events**`, (r) => r.fulfill({ json: { events: [] } }));
    await page.route(`**/v1/testing-runs/${run.id}`, (r) => r.fulfill({ json: { run: { ...run, projectSpendUsd: 0.42 } } }));
    await page.goto(`/app/projects/${run.projectId}/testing/${run.id}`);
    await page.getByRole("heading", { name: "Testing run" }).waitFor();
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(out, `report-${width}.png`), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    console.log(`${width}px: horizontal overflow ${overflow}px`);
    await page.close();
  }
  await browser.close();
}

const browserFor = () => chromium.launch();
void main();
