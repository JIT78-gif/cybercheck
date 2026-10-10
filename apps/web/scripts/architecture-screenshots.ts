// Signs up a throwaway user, uploads the Express shop fixture, and screenshots the Architecture area.
// Usage (repo root): npx tsx apps/web/scripts/architecture-screenshots.ts <outDir>
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "@playwright/test";
import { expressShop, makeZip } from "../../api/test/fixtures";
import { latestCode } from "../e2e/helpers";

const outDir = process.argv[2];
if (!outDir) throw new Error("Usage: architecture-screenshots.ts <outDir>");
mkdirSync(outDir, { recursive: true });
const BASE = "http://localhost:3000";

async function shot(page: Page, name: string, full = false) {
  await page.waitForTimeout(900);
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
      extraHTTPHeaders: { "X-Forwarded-For": `198.19.${Math.floor(Math.random() * 256)}.9` },
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

    const email = `arch-shots-${Date.now()}@example.test`;
    const t0 = Date.now() - 1000;
    const headers = { Origin: BASE };
    await page.request.post("/api/auth/sign-up/email", { data: { name: "Arch Viewer", email, password: "screenshot-password-1" }, headers });
    await page.request.post("/api/auth/email-otp/verify-email", { data: { email, otp: await latestCode(email, "email-verification", t0) }, headers });

    const me = await (await page.request.get("/v1/me")).json();
    const { project } = await (await page.request.post(`/v1/workspaces/${me.workspaces[0].id}/projects`, { data: { name: "shop-api", sourceType: "archive" } })).json();
    const zip = makeZip(Object.entries(expressShop).map(([name, data]) => ({ name: `shop/${name}`, data, deflate: true })));
    await page.request.post(`/v1/projects/${project.id}/snapshots/archive`, {
      headers: { "idempotency-key": randomUUID() },
      multipart: { attest: "true", file: { name: "shop.zip", mimeType: "application/zip", buffer: zip } },
    });
    for (let i = 0; i < 100; i++) {
      const p = await (await page.request.get(`/v1/projects/${project.id}`)).json();
      if (p.project.latestSnapshot?.status === "BASELINED") break;
      await page.waitForTimeout(200);
    }

    // Give the AI step time to finish (it reuses an earlier result for identical content).
    for (let i = 0; i < 90; i++) {
      const r = await (await page.request.get(`/v1/projects/${project.id}`)).json();
      const sid = r.project.latestSnapshot?.id;
      const u = sid ? await (await page.request.get(`/v1/snapshots/${sid}/understanding`)).json() : null;
      const st = u?.run?.dossier?.ai?.status;
      if (st && st !== "running") { console.log("AI step:", st); break; }
      await page.waitForTimeout(5000);
    }
    await page.goto(`/app/projects/${project.id}`, { waitUntil: "networkidle" });
    await page.getByText(/areas answered from code/).waitFor({ timeout: 20_000 });
    await shot(page, "01-project-with-understanding");

    const base = `/app/projects/${project.id}/architecture`;
    for (const [hash, name] of [
      ["summary", "02-summary"],
      ["observations", "03-things-to-check"],
      ["structure", "04-code-structure"],
      ["data", "05-data-structures"],
      ["apis", "06-apis"],
      ["security", "07-security"],
      ["config", "08-config"],
      ["runtime", "08b-runtime"],
      ["purpose", "08c-purpose"],
      ["dataflow", "08d-dataflow"],
      ["states", "08e-states"],
      ["risks", "08f-risks"],
      ["aisurface", "08g-ai-surface"],
    ] as const) {
      await page.goto(`${base}#${hash}`, { waitUntil: "networkidle" });
      await page.locator("h2").first().waitFor({ timeout: 20_000 });
      await shot(page, name, true);
    }

    await page.goto(`${base}#apis`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /src\/routes\/orders\.ts:\d+/ }).first().click();
    await page.getByRole("dialog").locator("table").waitFor();
    await shot(page, "09-code-viewer");

    await page.setViewportSize({ width: 375, height: 812 });
    for (const [hash, name] of [
      ["summary", "10-mobile-summary"],
      ["apis", "11-mobile-apis"],
      ["data", "12-mobile-data"],
    ] as const) {
      await page.goto(`${base}#${hash}`, { waitUntil: "networkidle" });
      await page.locator("h2").first().waitFor({ timeout: 20_000 });
      await shot(page, name, true);
    }

    console.log(errors.length ? `console errors:\n${errors.join("\n")}` : "no console errors");
  } finally {
    await browser.close();
  }
}

void main();
