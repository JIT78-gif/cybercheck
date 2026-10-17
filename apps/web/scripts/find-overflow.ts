// Lists elements wider than the viewport on a signed-in page (debug helper).
// Usage (repo root): npx tsx apps/web/scripts/find-overflow.ts /app 375
import { chromium } from "@playwright/test";
import { latestCode } from "../e2e/helpers";

async function main() {
  const [path = "/app", width = "375"] = process.argv.slice(2);
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: Number(width), height: 812 },
    baseURL: "http://localhost:3000",
    extraHTTPHeaders: { "X-Forwarded-For": `198.19.${Math.floor(Math.random() * 256)}.9` },
  });
  const page = await context.newPage();
  const email = `overflow-${Date.now()}@example.test`;
  const t0 = Date.now() - 1000;
  const headers = { Origin: "http://localhost:3000" };
  await page.request.post("/api/auth/sign-up/email", { data: { name: "Over Flow", email, password: "overflow-password-1" }, headers });
  await page.request.post("/api/auth/email-otp/verify-email", { data: { email, otp: await latestCode(email, "email-verification", t0) }, headers });
  await page.goto(path, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const wide = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    return [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((el) => el.getBoundingClientRect().right > vw + 1 && getComputedStyle(el).display !== "none")
      .slice(0, 12)
      .map((el) => `${el.tagName.toLowerCase()}.${(el.className || "").toString().slice(0, 90)} right=${Math.round(el.getBoundingClientRect().right)}`);
  });
  console.log(`viewport ${width}px, elements past the right edge:`);
  wide.forEach((w) => console.log("  " + w));
  await browser.close();
}
main();
