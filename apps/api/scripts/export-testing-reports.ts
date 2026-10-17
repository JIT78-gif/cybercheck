// Writes the same JSON and Markdown downloads the app gives, for stored eval runs (local only).
// Usage (from apps/api): npx tsx scripts/export-testing-reports.ts <round> [<round> ...]
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TestingRunDetail } from "@cybercheck/contracts";
import { testingRunToMarkdown } from "../src/testing/export.ts";
import { redactDeep, redactSecrets } from "../src/understanding/source.ts";

const EVAL = join(import.meta.dirname, "..", "..", "..", ".data", "eval");
const OUT = join(EVAL, "reports");
mkdirSync(OUT, { recursive: true });

for (const round of process.argv.slice(2)) {
  const dir = join(EVAL, `testing-round-${round}`);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".run.json"))) {
    const name = file.replace(/\.run\.json$/, "");
    const run = JSON.parse(readFileSync(join(dir, file), "utf8")) as TestingRunDetail;
    const json = JSON.stringify(redactDeep(run), null, 2);
    JSON.parse(json);
    writeFileSync(join(OUT, `round-${round}-${name}.json`), json);
    writeFileSync(join(OUT, `round-${round}-${name}.md`), redactSecrets(testingRunToMarkdown(run, name)).text);
    console.log(`round-${round}-${name}: ${(json.length / 1024).toFixed(0)} KB, valid JSON`);
  }
}
