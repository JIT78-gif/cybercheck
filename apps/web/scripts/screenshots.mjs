// Captures full-page screenshots of a route at standard breakpoints.
// Scrolls through the page first so scroll-reveal animations have played.
// Usage: node scripts/screenshots.mjs <outDir> [path=/] [baseUrl=http://localhost:3000]
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const [outDir, path = "/", baseUrl = "http://localhost:3000"] = process.argv.slice(2);
if (!outDir) {
  console.error("Usage: node scripts/screenshots.mjs <outDir> [path] [baseUrl]");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const widths = [375, 768, 1440];
const slug = path === "/" ? "home" : path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");

async function scrollThrough(page) {
  await page.waitForTimeout(1500); // wait for hydration so the reveal observer is attached
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.6;
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo({ top: y, behavior: "instant" });
      await new Promise((r) => setTimeout(r, 120));
    }
    window.scrollTo({ top: 0, behavior: "instant" });
  });
  await page.waitForTimeout(2500); // let the last reveal transitions finish
}

const browser = await chromium.launch();
try {
  for (const width of widths) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    const res = await page.goto(baseUrl + path, { waitUntil: "networkidle" });
    await scrollThrough(page);
    const stats = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      hidden: [...document.querySelectorAll("[data-reveal]")].filter(
        (el) => !el.classList.contains("is-visible"),
      ).length,
    }));
    const file = join(outDir, `${slug}-${width}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(
      `${width}px status=${res?.status()} horizontalOverflow=${stats.overflow} unrevealed=${stats.hidden} consoleErrors=${errors.length} -> ${file}`,
    );
    errors.forEach((e) => console.log(`  error: ${e}`));
    await page.close();
  }
} finally {
  await browser.close();
}
