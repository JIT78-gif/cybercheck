// Parses Mermaid diagrams with the real Mermaid library in a browser and reports syntax errors.
// Usage (repo root): npx tsx apps/web/scripts/check-diagrams.ts <diagrams.json>
// The JSON is an array of { project, diagrams: { key: mermaidSource } }.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "@playwright/test";

const require = createRequire(import.meta.url);
const runs = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as Array<{ project: string; diagrams: Record<string, string> }>;

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setContent("<html><body></body></html>");
  await page.addScriptTag({ path: require.resolve("mermaid/dist/mermaid.min.js") });
  let bad = 0;
  for (const r of runs) {
    for (const [key, code] of Object.entries(r.diagrams ?? {})) {
      const err = await page.evaluate(async (c) => {
        try {
          await (window as unknown as { mermaid: { parse: (t: string) => Promise<unknown> } }).mermaid.parse(c);
          return null;
        } catch (e) {
          return String((e as Error).message ?? e).slice(0, 400);
        }
      }, code);
      if (err) {
        bad++;
        console.log(`FAIL ${r.project} / ${key}\n${err}\n`);
      }
    }
  }
  console.log(bad ? `${bad} diagram(s) failed` : "all diagrams parse");
  await browser.close();
}

void main();
