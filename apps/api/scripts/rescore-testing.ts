// Re-scores saved run files of a round with the current scorers (no runs).
// Usage: npx tsx scripts/rescore-testing.ts <round> [--notes]
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { scoreRun, type Expected } from "../test/testing-score.ts";
import { scoreStrict } from "../test/testing-score-strict.ts";

const dir = join(import.meta.dirname, "../../../.data/eval", `testing-round-${process.argv[2]}`);
const verbose = process.argv.includes("--notes");
for (const f of readdirSync(dir).filter((x) => x.endsWith(".run.json"))) {
  const name = f.replace(".run.json", "");
  const key = name.startsWith("holdout-") ? join(import.meta.dirname, "../test/testing-holdout", name.slice(8), "expected.json") : join(import.meta.dirname, "../test/testing-bench", name, "expected.json");
  if (!existsSync(key)) continue;
  const run = JSON.parse(readFileSync(join(dir, f), "utf8"));
  const exp = JSON.parse(readFileSync(key, "utf8")) as Expected;
  const legacy = scoreRun(run, exp);
  const s = scoreStrict(run, exp);
  console.log(`${name.padEnd(24)} strict ${s.score.toFixed(1)} (composite ${s.composite.toFixed(1)}, ${s.failedGates} gate(s) failed, ${s.counts.mandatoryFound}/${s.counts.mandatory} mandatory, ${s.counts.found}/${s.counts.testingDefects} Testing defects)  legacy ${legacy.score.toFixed(1)}`);
  for (const n of s.notes.filter((x) => verbose || /GATE FAILED|MISSED|FALSE POSITIVE|WRONG|DUPLICATE/.test(x))) console.log(`    ${n}`);
}
