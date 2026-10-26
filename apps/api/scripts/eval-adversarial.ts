// Runs AI Adversarial end to end on the benchmark projects, on a real sandbox runtime.
// Usage (from apps/api): npx tsx --env-file=../../.env scripts/eval-adversarial.ts <round> [general|gauntlet|control|no-ai ...] [--runtime=local] [--profile=standard] [--repeat=1]
//   general: clean-node-control, a non-AI web app => the general attacker track must run and reach ready_with_evidence
//            with no confirmed high/critical.
//   gauntlet: the AI agent gauntlet => the AI attacker track must still confirm the planted AI chains (no regression).
//   control: the clean AI control => ready_with_evidence, no confirmed high/critical.
//   no-ai: an app with no reachable HTTP surface and no AI (if any) => not_applicable.
// The optional AI attacker/critic are off by default (deterministic validation). The app's own model traffic, when the
// target is an AI app, goes to the loopback replay model, so no model credit is used. The analysis AI step is off.
// Output: ../../.data/eval/adversarial-round-<n>/{scorecard.md, <project>.run.json, <project>.report.md}
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db, pool } from "../src/db/client.ts";
import { testingRun } from "../src/db/schema.ts";
import { providers } from "../src/env.ts";
import { adversarialDetail } from "../src/routes/adversarial.ts";
import { adversarialRunToMarkdown } from "../src/adversarial/export.ts";
import { AD_ENGINE_VERSION } from "../src/adversarial/version.ts";
import { scoreAdversarial, type AdversarialAccuracy, type AdversarialTruth } from "../src/adversarial/score.ts";
import { redactSecrets } from "../src/understanding/source.ts";
import { processRun, sandboxProvider } from "../src/testing/worker.ts";
import { evalUser, readyUnderstanding, snapshotOf } from "./eval-common.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const runtime = (flag("runtime") ?? "local") as "auto" | "nebius" | "local";
const repeat = Math.max(1, Number(flag("repeat") ?? 1) || 1);
const profile = (flag("profile") ?? "standard") as "quick" | "standard" | "deep";
const aiAttacker = (flag("attacker") ?? "off") as "auto" | "off";
const [round = "0", ...only] = args.filter((a) => !a.startsWith("--"));
const outDir = join(root, ".data/eval", `adversarial-round-${round}`);
mkdirSync(outDir, { recursive: true });
providers.ai = false;

const TARGETS = {
  general: { dir: join(here, "../test/security-bench/clean-node-control/project"), kind: "general_clean" as const },
  gauntlet: { dir: join(here, "../test/adversarial-bench/ai-agent-gauntlet/project"), kind: "ai_vulnerable" as const },
  control: { dir: join(here, "../test/adversarial-bench/clean-ai-agent-control/project"), kind: "ai_clean" as const },
  "hotel-vuln": { dir: join(here, "../test/adversarial-bench/hotel-management-gauntlet/project"), kind: "general_vulnerable" as const },
  "hotel-fixed": { dir: join(here, "../test/adversarial-bench/hotel-management-fixed/project"), kind: "general_fixed" as const },
  legacy: { dir: join(here, "../test/testing-bench/cybercheck-gauntlet/project"), kind: "legacy_vulnerable" as const },
};
type Name = keyof typeof TARGETS;

type Run = Awaited<ReturnType<typeof adversarialDetail>>;
const confirmedSevere = (r: Run) => r.findings.filter((f) => f.status === "confirmed" && (f.severity === "high" || f.severity === "critical"));
/** A stable signature: decision + each campaign verdict + each finding root cause/status. */
const signature = (r: Run) => JSON.stringify({ decision: r.report?.decision ?? null, campaigns: r.campaigns.map((c) => `${c.techniqueId}:${c.status}`).sort(), findings: r.findings.map((f) => `${f.rootCause}:${f.status}:${f.severity}`).sort() });

function truthFor(name: Name): { truth: AdversarialTruth[]; cleanControl: boolean } {
  if (name === "gauntlet") {
    const key = JSON.parse(readFileSync(join(here, "../test/adversarial-bench/gauntlet-adversarial-frozen.json"), "utf8")) as { aiAdversarialGauntlet: { chains: Array<{ id: string; lane: AdversarialTruth["lane"]; technique: string; entry: string; severity: AdversarialTruth["severity"]; mustFind: boolean; anchor: { path: string } }> } };
    return { cleanControl: false, truth: key.aiAdversarialGauntlet.chains.map((x) => ({ id: x.id, lane: x.lane, techniques: [x.id, x.technique], endpoint: x.entry.includes(" -> ") ? null : x.entry, sourcePath: x.anchor.path, severity: x.severity, mustFind: x.mustFind })) };
  }
  if (name === "hotel-vuln") {
    const key = JSON.parse(readFileSync(join(here, "../test/adversarial-bench/hotel-management-gauntlet/expected.json"), "utf8")) as { defects: AdversarialTruth[] };
    return { cleanControl: false, truth: key.defects };
  }
  if (name === "legacy") {
    const map: Record<string, { lane: AdversarialTruth["lane"]; technique: string; endpoint?: string | null }> = {
      "unsigned-forgeable-token": { lane: "auth_takeover", technique: "token-forgery", endpoint: null },
      "admin-role-missing-authorization": { lane: "broken_access", technique: "function-authz" },
      "indirect-prompt-injection": { lane: "prompt", technique: "indirect-rag-injection" },
      "system-prompt-secret-disclosure": { lane: "leakage", technique: "system-prompt-leak" },
      "unrestricted-ai-file-tool": { lane: "tools_approval", technique: "tool-path-escape" },
      "cross-tenant-ai-history": { lane: "rag_memory", technique: "cross-tenant-memory-leak" },
      "unsafe-ai-output-rendering": { lane: "output_handling", technique: "unsafe-output-rendering" },
      "transfer-check-use-race": { lane: "business_logic", technique: "race-condition" },
      "no-login-rate-limit": { lane: "auth_takeover", technique: "login-throttling" },
      "quadratic-report": { lane: "resource_abuse", technique: "unbounded-requests" },
    };
    const key = JSON.parse(readFileSync(join(here, "../test/testing-bench/cybercheck-gauntlet/expected.json"), "utf8")) as { defects: Array<{ id: string; track: string; endpoint?: string; path?: string; mustFind: boolean; category: string }> };
    const truth = key.defects.filter((x) => map[x.id]).map((x) => ({ id: x.id, lane: map[x.id]!.lane, techniques: [map[x.id]!.technique], endpoint: "endpoint" in map[x.id]! ? map[x.id]!.endpoint! : x.endpoint ?? null, sourcePath: x.path ?? null, severity: (/prompt|secret|file|tenant|race|quadratic|token|authorization/i.test(x.id) ? "high" : "medium") as AdversarialTruth["severity"], mustFind: x.mustFind }));
    // The fixture deliberately accepts a direct "system prompt" request as well as the poisoned retrieval path.
    // It is an optional planted weakness, kept separate so confirming it is not mis-scored as a false positive.
    truth.push({ id: "direct-prompt-injection", lane: "prompt", techniques: ["direct-prompt-injection"], endpoint: "POST /api/assistant", sourcePath: "src/ai.js", severity: "high", mustFind: false });
    return { cleanControl: false, truth };
  }
  return { truth: [], cleanControl: true };
}

function accuracyFor(name: Name, runs: Run[]): AdversarialAccuracy | null {
  const first = runs[0];
  if (!first?.report) return null;
  const key = truthFor(name);
  return scoreAdversarial({ truth: key.truth, cleanControl: key.cleanControl, findings: first.findings, report: first.report, signatures: runs.map(signature) });
}

function score(name: Name, r: Run): string[] {
  const out: string[] = [];
  const kind = TARGETS[name].kind;
  const rep = r.report;
  const tracks = rep?.applicability.tracks ?? [];
  out.push(`decision: ${rep?.decision ?? r.status} (${rep?.headline ?? r.error ?? ""})`);
  out.push(`tracks: [${tracks.join(", ")}]; campaigns: ${r.campaigns.length}, decided ${rep?.coverage.decisive ?? 0} of ${rep?.coverage.applicable ?? 0}; chains: ${r.chains.length} (${r.chains.filter((c) => c.verdict === "confirmed").length} confirmed)`);
  out.push(`confirmed findings: ${r.findings.filter((f) => f.status === "confirmed").map((f) => `${f.severity} ${f.rootCause}`).join(", ") || "none"}`);
  // Only attack executions must have no network. The dependency-install and browser-install steps legitimately need it.
  const attackNetwork = r.executions.filter((e) => (e.kind === "adversarial_campaign" || e.kind === "adversarial_browser") && e.network && !/install/i.test(e.label ?? "")).length;
  out.push(`audit: ${(rep?.audit ?? []).filter((a) => !a.ok).map((a) => a.check).join(", ") || "all checks passed"}; executions: ${r.executions.length}, network on during an attack: ${attackNetwork} (must be 0)`);
  out.push(`reused Security: ${rep?.reusedSecurity?.note ?? "none"}`);
  if (kind === "general_clean") {
    out.push(`general track ran: ${tracks.includes("general") ? "yes" : "NO"}`);
    out.push(`decision ready_with_evidence: ${rep?.decision === "ready_with_evidence" ? "yes" : `NO (${rep?.decision})`}`);
    out.push(`false confirmed high/critical: ${confirmedSevere(r).length} (target 0)`);
  }
  if (kind === "ai_vulnerable") {
    out.push(`AI track ran: ${tracks.includes("ai") ? "yes" : "NO"}`);
    out.push(`confirmed high/critical findings: ${confirmedSevere(r).length} (target: the planted AI chains still confirm)`);
    out.push(`confirmed chains: ${r.chains.filter((c) => c.verdict === "confirmed").map((c) => c.title).join(", ") || "none"}`);
  }
  if (kind === "ai_clean") out.push(`false confirmed high/critical: ${confirmedSevere(r).length} (target 0); decision: ${rep?.decision}`);
  if (kind === "general_vulnerable" || kind === "general_fixed") {
    const planned = r.campaigns.length;
    const executed = r.campaigns.filter((c) => c.status !== "blocked").length;
    const execRate = planned ? Math.round((executed / planned) * 100) : 0;
    const confirmedTechniques = [...new Set(r.findings.filter((f) => f.status === "confirmed").map((f) => f.rootCause))].sort();
    const blockedReasons = [...new Set(r.campaigns.filter((c) => c.status === "blocked").map((c) => (c.limitations[0] ?? "").slice(0, 60)))];
    out.push(`general track ran: ${tracks.includes("general") ? "yes" : "NO"}`);
    out.push(`executed/planned: ${executed}/${planned} (${execRate}%, target >=95%)`);
    out.push(`confirmed techniques: ${confirmedTechniques.join(", ") || "none"}`);
    out.push(`blocked reasons: ${blockedReasons.join(" | ") || "none (nothing blocked)"}`);
    if (kind === "general_vulnerable") {
      const expected = ["function-authz", "object-authz", "mass-assignment", "token-forgery", "login-throttling", "invalid-quantity", "injection-differential"];
      const reproduced = expected.filter((t) => confirmedTechniques.includes(t));
      out.push(`known vulnerabilities reproduced: ${reproduced.length}/${expected.length} (${reproduced.join(", ")})`);
      out.push(`missing: ${expected.filter((t) => !reproduced.includes(t)).join(", ") || "none"}`);
    }
    if (kind === "general_fixed") {
      out.push(`false confirmed high/critical: ${confirmedSevere(r).length} (target 0)`);
      out.push(`decision ready_with_evidence: ${rep?.decision === "ready_with_evidence" ? "yes" : `NO (${rep?.decision})`}`);
    }
  }
  if (kind === "legacy_vulnerable") out.push("legacy cross-check: prompt injection, prompt leakage, local file tools, history isolation, concurrency and resource abuse are release regressions");
  return out;
}

async function evalOne(name: Name, who: { userId: string; workspaceId: string }, rep: number) {
  const t0 = Date.now();
  const log = (m: string) => console.log(`[${name}${repeat > 1 ? ` rep ${rep + 1}/${repeat}` : ""}] ${m}`);
  const snap = await snapshotOf(TARGETS[name].dir, `adv-${name}`, who, round);
  const ur = await readyUnderstanding(snap.id, name);
  log("analysis ready; starting AI Adversarial");
  const runId = randomUUID();
  await db.insert(testingRun).values({ id: runId, check: "adversarial", snapshotId: snap.id, projectId: snap.projectId, understandingRunId: ur.id, requestedBy: who.userId, policy: { engine: AD_ENGINE_VERSION, profile, aiAttacker, aiCritic: "off", runtime, attackPackIds: [] }, status: "running", generation: 1, startedAt: new Date(), heartbeatAt: new Date() });
  let last = "";
  await processRun({ id: runId, generation: 1 }, { provider: sandboxProvider(), session: null, onProgress: (s) => s !== last && log((last = s)) });
  const [row] = await db.select().from(testingRun).where(eq(testingRun.id, runId));
  const run = await adversarialDetail(row!);
  const suffix = rep ? `.rep${rep + 1}` : "";
  writeFileSync(join(outDir, `${name}${suffix}.run.json`), redactSecrets(JSON.stringify(run, null, 2)).text);
  if (!rep) writeFileSync(join(outDir, `${name}.report.md`), redactSecrets(adversarialRunToMarkdown(run, name)).text);
  log(`finished ${run.status} in ${((Date.now() - t0) / 60000).toFixed(1)} min: ${run.report?.decision ?? run.error}`);
  return run;
}

async function main() {
  const who = await evalUser();
  const names = (only.length ? only : Object.keys(TARGETS)) as Name[];
  const lines = [`# AI Adversarial round ${round}`, "", `Engine ${AD_ENGINE_VERSION}, runtime ${runtime}, profile ${profile}, AI attacker ${aiAttacker}, ${repeat} repeat(s).`, ""];
  let allPassed = true;
  for (const name of names) {
    if (!TARGETS[name]) throw new Error(`Unknown target "${name}". Known: ${Object.keys(TARGETS).join(", ")}`);
    const runs: Run[] = [];
    for (let rep = 0; rep < repeat; rep++) runs.push(await evalOne(name, who, rep));
    lines.push(`## ${name}`, "", ...score(name, runs[0]!).map((l) => `- ${l}`));
    const accuracy = accuracyFor(name, runs);
    if (accuracy) {
      allPassed &&= accuracy.passed;
      lines.push(`- balanced accuracy score: ${accuracy.score}/100 (${accuracy.passed ? "PASS" : "FAIL"})`);
      for (const gate of accuracy.gates) lines.push(`- ${gate.ok ? "PASS" : "FAIL"} ${gate.name}: ${typeof gate.actual === "number" && gate.actual <= 1 ? `${Math.round(gate.actual * 100)}%` : gate.actual} (required ${gate.required})`);
      const missed = accuracy.matched.filter((x) => !x.findingId).map((x) => x.truthId);
      lines.push(`- missed ground-truth defects: ${missed.join(", ") || "none"}`);
    }
    lines.push("");
  }
  writeFileSync(join(outDir, "scorecard.md"), lines.join("\n"));
  console.log(`\n${lines.join("\n")}\nWritten to ${outDir}`);
  await pool.end();
  process.exit(allPassed ? 0 : 2);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
