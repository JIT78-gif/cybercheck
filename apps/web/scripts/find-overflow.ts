// Lists elements wider than the viewport on a signed-in page (debug helper).
// Usage (repo root): MSYS_NO_PATHCONV=1 npx tsx apps/web/scripts/find-overflow.ts /app 375
import { chromium } from "@playwright/test";
import { demoProject, makeZip } from "../../api/test/fixtures";
import { latestCode } from "../e2e/helpers";

async function main() {
  const [path = "/app", width = "375"] = process.argv.slice(2);
  const browser = await chromium.launch();
  try {
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
    await page.request.post("/api/auth/email-otp/verify-email", {
      data: { email, otp: await latestCode(email, "email-verification", t0) },
      headers,
    });
    if (process.argv.includes("--with-project")) {
      const me = await (await page.request.get("/v1/me")).json();
      const wid = me.workspaces[0].id as string;
      const proj = await (
        await page.request.post(`/v1/workspaces/${wid}/projects`, { data: { name: "acme-storefront", sourceType: "archive" } })
      ).json();
      const zip = makeZip(Object.entries(demoProject).map(([name, data]) => ({ name, data, deflate: true })));
      await page.request.post(`/v1/projects/${proj.project.id}/snapshots/archive`, {
        headers: { "Idempotency-Key": crypto.randomUUID() },
        multipart: { attest: "true", file: { name: "acme.zip", mimeType: "application/zip", buffer: zip } },
      });
      await page.waitForTimeout(1500);
    }
    await page.goto(path, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    const wide = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      return [...document.querySelectorAll<HTMLElement>("body *")]
        .filter((el) => el.getBoundingClientRect().right > vw + 1 && getComputedStyle(el).display !== "none")
        // ignore content clipped by a scroll container (e.g. wide tables)
        .filter((el) => { for (let p = el.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o !== "visible") return false; } return true; })
        .slice(0, 12)
        .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 90)} right=${Math.round(el.getBoundingClientRect().right)}`);
    });
    const dims = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, body: document.body.scrollWidth }));
    console.log(`viewport ${width}px, document scrollWidth=${dims.scroll} clientWidth=${dims.client} body=${dims.body}; elements past the right edge:`);
    wide.forEach((w) => console.log("  " + w));
    const ancestry = await page.evaluate(() => { const out: string[] = []; let el = document.querySelector("table")?.parentElement ?? null; while (el) { const cs = getComputedStyle(el); out.push(`${el.tagName.toLowerCase()} w=${Math.round(el.getBoundingClientRect().width)} ox=${cs.overflowX} d=${cs.display} ${String(el.className).slice(0, 60)}`); el = el.parentElement; } return out; });
    ancestry.forEach((a) => console.log("  ^ " + a));
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
