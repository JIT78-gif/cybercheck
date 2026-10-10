// Scores the project analyzer against hand-checked answer keys and hard quality gates.
// Usage (from apps/api): npm run eval:understanding -- <round-number>
// Answer keys: ../../.data/eval/*.golden.json (local only) and test/golden/*.golden.json (fixtures).
// Output: ../../.data/eval/round-<n>/{scorecard.md, <project>.dossier.json, <project>.md}
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeSource } from "../src/understanding/analyze.ts";
import { dossierToMarkdown } from "../src/understanding/export.ts";
import { loadSnapshotSource, type SnapshotSource } from "../src/understanding/source.ts";
import { LocalDiskObjectStore } from "../src/storage/object-store.ts";
import { fixtureSource } from "../test/fixture-source.ts";
import { score, type Golden } from "../test/golden-score.ts";

const pct = (a: number, b: number) => (b === 0 ? 1 : a / b);
const fmt = (x: number) => `${(x * 100).toFixed(1)}%`;

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const evalDir = join(root, ".data/eval");
const round = process.argv[2] ?? "0";
const outDir = join(evalDir, `round-${round}`);
mkdirSync(outDir, { recursive: true });


async function loadGoldens(): Promise<Array<{ golden: Golden; src: SnapshotSource }>> {
  const out: Array<{ golden: Golden; src: SnapshotSource }> = [];
  const store = new LocalDiskObjectStore(join(root, ".data/objects"));
  for (const f of readdirSync(evalDir).filter((x) => x.endsWith(".golden.json"))) {
    const golden = JSON.parse(readFileSync(join(evalDir, f), "utf8"));
    out.push({ golden, src: await loadSnapshotSource(store, golden.archiveKey) });
  }
  const fixtureDir = join(here, "../test/golden");
  for (const f of (existsSync(fixtureDir) ? readdirSync(fixtureDir, { withFileTypes: true }) : []).filter((x) => x.isFile() && x.name.endsWith(".golden.json"))) {
    const golden = JSON.parse(readFileSync(join(fixtureDir, f.name), "utf8"));
    out.push({ golden, src: fixtureSource(golden.fixture) });
  }
  return out;
}

async function main() {
  const rows: string[] = [`# Understanding evaluation, round ${round}`, "", `Generated ${new Date().toISOString()}`, ""];
  let gatesFailed = 0;
  let worst = 1;
  for (const { golden, src } of await loadGoldens()) {
    const d = await analyzeSource(src, { snapshotId: golden.snapshotId ?? golden.fixture, contentDigest: "eval" });
    const name = golden.project ?? golden.fixture;
    writeFileSync(join(outDir, `${name}.dossier.json`), JSON.stringify(d, null, 2));
    writeFileSync(join(outDir, `${name}.md`), dossierToMarkdown(d));
    writeFileSync(join(outDir, `${name}.diagrams.json`), JSON.stringify([{ project: name, diagrams: d.diagrams }]));
    let render = "not checked";
    try {
      const outp = execFileSync("npx", ["tsx", join(root, "apps/web/scripts/check-diagrams.ts"), join(outDir, `${name}.diagrams.json`)], { cwd: root, encoding: "utf8", shell: true });
      render = outp.trim().split("\n").at(-1) ?? "";
    } catch (e) {
      render = `FAILED: ${String((e as { stdout?: string }).stdout ?? e).trim().split("\n").slice(-6).join(" | ")}`;
    }
    const { metrics, gates } = score(d, golden, src);
    gates.push({ name: "diagrams render (real Mermaid)", ok: render === "all diagrams parse", detail: render });
    rows.push(`## ${name}`, "", "| Metric | Score | Found / expected | Notes |", "|---|---|---|---|");
    for (const m of metrics) {
      const r = pct(m.found, m.expected);
      worst = Math.min(worst, r);
      rows.push(`| ${m.name} | ${fmt(r)} | ${m.found}/${m.expected}${m.extra ? ` (+${m.extra} extra)` : ""} | ${(m.detail ?? []).join("; ").replace(/\|/g, "/").slice(0, 300)} |`);
    }
    rows.push("", "| Gate | Result | Detail |", "|---|---|---|");
    for (const g of gates) {
      if (!g.ok) gatesFailed++;
      rows.push(`| ${g.name} | ${g.ok ? "PASS" : "FAIL"} | ${g.detail.replace(/\|/g, "/").slice(0, 300)} |`);
    }
    rows.push("");
  }
  rows.splice(4, 0, `**Lowest metric: ${fmt(worst)} · Gates failed: ${gatesFailed}**`, "");
  writeFileSync(join(outDir, "scorecard.md"), rows.join("\n"));
  console.log(rows.join("\n"));
}

void main();
