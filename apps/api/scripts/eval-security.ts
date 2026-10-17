// Runs the Security check end to end on benchmark projects and scores it against answer keys (Security Round 1).
// Usage (from apps/api): npm run eval:security -- <round> [project ...] [--with-ai]
//   projects: names under test/security-bench, or testing-bench projects whose key has Security-track defects
//   (default: every project with a Security answer key, plus every Security control).
//   The analysis AI step is switched off unless --with-ai is given: Security Round 1 itself uses no AI, and the
//   sandbox shares its key with the AI provider, so this keeps a real run to sandbox time only.
// Answer keys (expected.json) are read only by the scorer, never by the engine.
// Output: ../../.data/eval/security-round-<n>/{scorecard.md, <project>.run.json, <project>.report.md}
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { ProjectDossier } from "@cybercheck/contracts";
import { db, pool } from "../src/db/client.ts";
import { testingRun } from "../src/db/schema.ts";
import { providers } from "../src/env.ts";
import { securityDetail } from "../src/routes/security.ts";
import { securityRunToMarkdown } from "../src/security/export.ts";
import { SECURITY_ENGINE } from "../src/security/orchestrator.ts";
import { processRun, sandboxProvider } from "../src/testing/worker.ts";
import { redactDeep } from "../src/understanding/source.ts";
import { scoreSecurity, type SecurityExpected } from "../test/security-score.ts";
import { evalUser, readyUnderstanding, snapshotOf, walk } from "./eval-common.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const securityBench = join(here, "../test/security-bench");
const testingBench = join(here, "../test/testing-bench");
const args = process.argv.slice(2);
const withAi = args.includes("--with-ai");
const runtimeArg = (args.find((a) => a.startsWith("--runtime=")) ?? "").split("=")[1] ?? (args.includes("--runtime") ? args[args.indexOf("--runtime") + 1] : undefined);
const runtime = (["auto", "nebius", "local", "static"].includes(runtimeArg ?? "") ? runtimeArg : "auto") as "auto" | "nebius" | "local" | "static";
const repeatArg = args.find((a) => a.startsWith("--repeat"));
const repeat = Math.max(1, Number(repeatArg?.split("=")[1] ?? args[args.indexOf("--repeat") + 1]) || 1);
const [round = "0", ...only] = args.filter((a) => a !== "--with-ai" && a !== "--repeat" && !a.startsWith("--repeat") && a !== "--runtime" && !a.startsWith("--runtime=") && a !== runtime && a !== String(repeat));
const outDir = join(root, ".data/eval", `security-round-${round}`);
mkdirSync(outDir, { recursive: true });
if (!withAi) providers.ai = false;

type Target = { name: string; dir: string; expected: SecurityExpected };

function targets(): Target[] {
  const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as SecurityExpected;
  const fromSecurity = existsSync(securityBench) ? readdirSync(securityBench).filter((n) => existsSync(join(securityBench, n, "expected.json"))) : [];
  const fromTesting = readdirSync(testingBench).filter((n) => existsSync(join(testingBench, n, "expected.json")) && (read(join(testingBench, n, "expected.json")).defects ?? []).some((d) => (d as { track?: string }).track === "security"));
  const all: Target[] = [
    ...fromSecurity.map((n) => ({ name: n, dir: join(securityBench, n, "project"), expected: read(join(securityBench, n, "expected.json")) })),
    ...fromTesting.map((n) => ({ name: n, dir: join(testingBench, n, "project"), expected: read(join(testingBench, n, "expected.json")) })),
  ];
  if (!only.length) return all;
  return only.map((n) => all.find((t) => t.name === n) ?? (() => { throw new Error(`No Security answer key for "${n}". Known: ${all.map((t) => t.name).join(", ")}`); })());
}

/** Every file the scorer may see cited, with its line count, for the evidence-ownership target. */
function lineCounts(dir: string) {
  return new Map(walk(dir).map((f) => [f, readFileSync(join(dir, f), "utf8").split("\n").length] as const));
}

/** A stable signature of a run's classification: each finding's category:status, the confirmed count, and the decision. */
function classification(run: Awaited<ReturnType<typeof securityDetail>>) {
  const findings = run.findings.map((f) => `${f.category}:${f.status}`).sort();
  const proofs = (run.proofs ?? []).map((p) => `${p.type}@${p.target.ref}:${p.verdict}`).sort();
  return JSON.stringify({ decision: run.report?.decision ?? null, confirmed: run.findings.filter((f) => f.status === "confirmed").length, findings, proofs });
}

async function evalProject(t: Target, who: { userId: string; workspaceId: string }, rep = 0) {
  const t0 = Date.now();
  const tag = repeat > 1 ? ` rep ${rep + 1}/${repeat}` : "";
  const log = (m: string) => console.log(`[${t.name}${tag}] ${m}`);
  const snap = await snapshotOf(t.dir, t.name, who, round);
  log(`snapshot ${snap.id.slice(0, 8)} baselined; waiting for the analysis`);
  const ur = await readyUnderstanding(snap.id, t.name);
  log(`analysis ready (AI ${(ur.dossier as ProjectDossier).ai?.status ?? "off"}); starting Security`);
  const runId = randomUUID();
  await db.insert(testingRun).values({ id: runId, check: "security", snapshotId: snap.id, projectId: snap.projectId, understandingRunId: ur.id, requestedBy: who.userId, policy: { engine: SECURITY_ENGINE, runtime }, status: "running", generation: 1, startedAt: new Date(), heartbeatAt: new Date() });
  let last = "";
  await processRun({ id: runId, generation: 1 }, { provider: sandboxProvider(), session: null, onProgress: (s) => s !== last && log((last = s)) });
  const [row] = await db.select().from(testingRun).where(eq(testingRun.id, runId));
  const run = await securityDetail(row!);
  const suffix = rep === 0 ? "" : `.rep${rep + 1}`;
  writeFileSync(join(outDir, `${t.name}${suffix}.run.json`), JSON.stringify(redactDeep(run), null, 2));
  if (rep === 0) writeFileSync(join(outDir, `${t.name}.report.md`), securityRunToMarkdown(run, t.name));
  const minutes = (Date.now() - t0) / 60000;
  log(`finished ${run.status} in ${minutes.toFixed(1)} min: ${run.headline}`);
  return { name: t.name, run, score: scoreSecurity(run, t.expected, lineCounts(t.dir)), minutes, signature: classification(run) };
}

async function main() {
  const who = await evalUser();
  const list = targets();
  const results: Awaited<ReturnType<typeof evalProject>>[] = [];
  const signatures = new Map<string, string[]>();
  for (const t of list) {
    for (let rep = 0; rep < repeat; rep++) {
      try {
        const r = await evalProject(t, who, rep);
        signatures.set(t.name, [...(signatures.get(t.name) ?? []), r.signature]);
        if (rep === 0) results.push(r); // the scorecard shows the first run; later runs feed the stability check only
      } catch (err) {
        console.error(`[${t.name} rep ${rep + 1}] crashed:`, err);
      }
    }
  }
  results.sort((a, b) => a.name.localeCompare(b.name));

  const pct = (n: number | null | undefined) => (n == null ? "n/a" : `${Math.round(n * 100)}%`);
  const mark = (ok: boolean | null) => (ok === null ? "NEEDS REVIEW / n/a" : ok ? "pass" : "FAIL");
  const rows = [`# Security evaluation, round ${round}`, "", `Engine ${SECURITY_ENGINE}. Analysis AI ${withAi ? "on" : "off"}. Generated ${new Date().toISOString()}.`, ""];
  rows.push("| Project | Decision | Found | Must find | Weighted recall | Precision (low to high) | Confirmed true / false / review | Unadjudicated | Duplicates | Abstention | Minutes | AI $ |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of results) {
    const s = r.score;
    rows.push(`| ${r.name}${s.control ? " (control)" : ""} | ${s.decision ?? r.run.status} | ${s.control ? "n/a" : `${s.counts.found}/${s.counts.defects}`} | ${s.control ? "n/a" : `${s.counts.mustFound}/${s.counts.mustFind}`} | ${pct(s.weightedRecall)} | ${pct(s.precision.low)} to ${pct(s.precision.high)} | ${s.counts.confirmedTrue} / ${s.counts.confirmedFalse} / ${s.counts.needsReview} | ${s.counts.unadjudicated} | ${s.counts.duplicates} | ${pct(s.abstention)} | ${r.minutes.toFixed(1)} | ${s.costUsd.toFixed(3)} |`);
  }
  for (const r of results) {
    rows.push("", `## ${r.name}`, "", r.run.headline ?? r.run.error ?? "", "", "| Round 1 target | Result | Detail |", "|---|---|---|");
    for (const g of r.score.targets) rows.push(`| ${g.name} | ${mark(g.ok)} | ${g.detail.replace(/\|/g, "/")} |`);
    rows.push("", ...r.score.notes.map((n) => `- ${n}`));
  }
  if (repeat > 1) {
    rows.push("", `## Stability across ${repeat} repeats`, "", "| Project | Runs | Identical classification |", "|---|---|---|");
    for (const [name, sigs] of signatures) {
      const identical = sigs.every((s) => s === sigs[0]);
      rows.push(`| ${name} | ${sigs.length} | ${identical ? "yes" : "NO (classification flipped between runs)"} |`);
    }
  }
  writeFileSync(join(outDir, "scorecard.md"), rows.join("\n"));
  console.log(rows.join("\n"));
  await pool.end();
  process.exit(0);
}

void main();
