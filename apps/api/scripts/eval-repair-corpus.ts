// Phase 5 release gates for the AI Evaluator and AI Adversarial repair system. For every confirmed finding a parent
// check finds on a vulnerable fixture, a reviewer confirmation is recorded and a real repair model (Gemini or Nebius)
// proposes patches that are validated in fresh sandboxes. Detection and validation run with NO AI session, so the
// model only proposes; deterministic reruns decide.
// Usage (from apps/api):
//   npx tsx --env-file=../../.env scripts/eval-repair-corpus.ts run <round> <fixture> [--repeat=3] [--attempts=2] [--max-usd=3]
// Spending: the whole round (every fixture and repetition, repairs and project analyses) stops at --max-usd, and each
// repair's model session is capped at $0.40. Repetitions reuse the first repetition's snapshot, so it is analysed once.
//   npx tsx --env-file=../../.env scripts/eval-repair-corpus.ts summarize <round>
// Fixtures: hotel (AI Adversarial, general web app), agent (AI Adversarial, AI agent), gauntlet (AI Evaluator).
// Output: ../../.data/eval/repair-corpus-<round>/<fixture>-<rep>.json and scorecard.md
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buffer } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import type { AdversarialCampaign, AdversarialFinding, AiEvaluationCase, AiEvaluationFinding, TestingRepair } from "@cybercheck/contracts";
import { adversarialRepairScope } from "../src/adversarial/repair.ts";
import { AD_ENGINE_VERSION } from "../src/adversarial/version.ts";
import { redactText } from "../src/ai-evaluator/redact.ts";
import { aiRepairScope, caseIdsToRun } from "../src/ai-evaluator/repair.ts";
import { AI_EVALUATOR_ENGINE } from "../src/ai-evaluator/version.ts";
import { db, pool } from "../src/db/client.ts";
import { adversarialCampaign, aiEvaluationCase, findingReview, snapshot, testFinding, testingRepair, testingRun } from "../src/db/schema.ts";
import { objectStore } from "../src/storage/object-store.ts";
import { editableSourceFiles, processRepair, withLocalImports } from "../src/testing/repair.ts";
import { getSnapshotSource } from "../src/understanding/source.ts";
import { processRun, sandboxProvider, sessionFor } from "../src/testing/worker.ts";
import { evalUser, readyUnderstanding, snapshotOf } from "./eval-common.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const args = process.argv.slice(2);
const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
const [mode = "run", round = "0", fixtureName = ""] = args.filter((a) => !a.startsWith("--"));
const repeat = Math.max(1, Number(flag("repeat") ?? 3) || 3);
const maxAttempts = Math.min(3, Math.max(1, Number(flag("attempts") ?? 2) || 2));
const maxUsd = Number(flag("max-usd") ?? 3) || 3;
// Reuse the snapshots (already analysed) of an earlier round, so a rerun of the gates does not pay for analysis again.
const reuseFrom = flag("reuse-from");
// Above the gateway's pre-flight worst case for two attempts (about $0.16 per call at the conservative Gemini prices).
const PER_REPAIR_USD = 0.4;
const outDir = join(root, ".data/eval", `repair-corpus-${round}`);
mkdirSync(outDir, { recursive: true });

// Raw canary values a prompt must never carry (the redacted form is "[canary]").
const CANARY = /CCADVMARK-[\w-]+|sk-agentmart-FIXTURE[\w-]*|CC_SYS_PROMPT_[\w-]+|cc-approval-(?:valid|expired|replayed)[\w-]*|CCXSS[\w-]+/;

type Candidate = { id: string; key: string; title: string; severity: string; scope: TestingRepair["scope"]; runnable: boolean; whyNot: string | null };
type Fixture = { dir: string; check: "adversarial" | "ai-evaluator"; policy: Record<string, unknown>; candidates: (runId: string) => Promise<Candidate[]> };

const FIXTURES: Record<string, Fixture> = {
  hotel: {
    dir: "../test/adversarial-bench/hotel-management-gauntlet/project",
    check: "adversarial",
    policy: { engine: AD_ENGINE_VERSION, profile: "standard", aiAttacker: "off", aiCritic: "off", runtime: "local", attackPackIds: [] },
    candidates: adversarialCandidates,
  },
  agent: {
    dir: "../test/adversarial-bench/ai-agent-gauntlet/project",
    check: "adversarial",
    policy: { engine: AD_ENGINE_VERSION, profile: "standard", aiAttacker: "off", aiCritic: "off", runtime: "local", attackPackIds: [] },
    candidates: adversarialCandidates,
  },
  gauntlet: {
    dir: "../test/testing-bench/cybercheck-gauntlet/project",
    check: "ai-evaluator",
    policy: { engine: AI_EVALUATOR_ENGINE, profile: "standard", judge: "auto", modelMode: "auto", runtime: "local", datasetIds: [] },
    candidates: async (runId) => {
      const findings = (await db.select().from(testFinding).where(eq(testFinding.runId, runId))).map((r) => r.data as AiEvaluationFinding);
      const cases = (await db.select().from(aiEvaluationCase).where(eq(aiEvaluationCase.runId, runId))).map((c) => c.data as AiEvaluationCase);
      return findings.filter((f) => f.status === "confirmed").map((f) => {
        const scope = aiRepairScope(f, cases, maxAttempts);
        const whyNot = !scope.files.length ? "no editable source file" : !scope.reproduction.length || !caseIdsToRun(scope).length ? "no decisive reproduction to rerun" : null;
        return { id: f.id, key: `${f.category}|${f.rootCause}`, title: f.title, severity: f.severity, scope, runnable: !whyNot, whyNot };
      });
    },
  },
};

async function adversarialCandidates(runId: string): Promise<Candidate[]> {
  const findings = (await db.select().from(testFinding).where(eq(testFinding.runId, runId))).map((r) => r.data as AdversarialFinding);
  const campaigns = (await db.select().from(adversarialCampaign).where(eq(adversarialCampaign.runId, runId))).map((c) => c.data as AdversarialCampaign);
  return findings.filter((f) => f.status === "confirmed").map((f) => {
    const scope = adversarialRepairScope(f, campaigns, maxAttempts);
    const whyNot = !scope.files.length ? "no editable source file" : !scope.reproduction.length ? "no decisive reproduction to rerun" : null;
    return { id: f.id, key: `${f.lane}|${f.rootCause}|${f.endpoint ?? ""}`, title: f.title, severity: f.severity, scope, runnable: !whyNot, whyNot };
  });
}

const digestOf = async (key: string) => createHash("sha256").update(await buffer(await objectStore.get(key))).digest("hex");

type RepairResult = {
  key: string; id: string; title: string; severity: string; status: string; attempts: number; costUsd: number; seconds: number;
  falseVerified: boolean; regressions: string[]; unauthorized: string[]; ownershipProblems: string[]; redactionProblems: string[]; refused: string[];
  error: string | null;
};

/** AI spend already recorded for this round, across every fixture and repetition. */
function spentInRound(): number {
  if (!existsSync(outDir)) return 0;
  return readdirSync(outDir).filter((f) => /-\d+\.json$/.test(f)).reduce((sum, f) => {
    const o = JSON.parse(readFileSync(join(outDir, f), "utf8")) as { analysisUsd?: number; repairs: Array<{ costUsd: number }> };
    // Results written before analysis cost was recorded count a conservative $0.15 for their analysis.
    return sum + (o.analysisUsd ?? 0.15) + o.repairs.reduce((a, r) => a + r.costUsd, 0);
  }, 0);
}

async function runOnce(name: string, fx: Fixture, rep: number) {
  const who = await evalUser();
  const firstFile = rep > 1 ? join(outDir, `${name}-1.json`) : reuseFrom ? join(root, ".data/eval", `repair-corpus-${reuseFrom}`, `${name}-1.json`) : "";
  const reuse = firstFile && existsSync(firstFile) ? (JSON.parse(readFileSync(firstFile, "utf8")) as { snapshotId?: string }).snapshotId : undefined;
  const [reused] = reuse ? await db.select().from(snapshot).where(eq(snapshot.id, reuse)) : [];
  const snap = reused ?? (await snapshotOf(join(here, fx.dir), `corpus-${name}`, who, `${round}-${rep}`));
  const ur = await readyUnderstanding(snap.id, `corpus-${name}`);
  const analysisUsd = reused ? 0 : ((ur.dossier as { ai?: { usage?: { costUsd?: number } } } | null)?.ai?.usage?.costUsd ?? 0);
  let spent = spentInRound() + analysisUsd;
  let budgetStopped = false;
  const archiveBefore = await digestOf(snap.archiveObjectKey!);
  const provider = sandboxProvider();
  // Detection and every validation rerun use no AI session: the gates must hold without AI credits.
  const runValidation = (id: string) => processRun({ id, generation: 1 }, { provider, session: null });
  const parentId = randomUUID();
  const t0 = Date.now();
  await db.insert(testingRun).values({ id: parentId, check: fx.check, snapshotId: snap.id, projectId: snap.projectId, understandingRunId: ur.id, requestedBy: who.userId, policy: fx.policy, status: "running", generation: 1, startedAt: new Date(), heartbeatAt: new Date() });
  await runValidation(parentId);
  const [parent] = await db.select().from(testingRun).where(eq(testingRun.id, parentId));
  // The same scope the review route offers: the evidence files plus their direct local imports.
  const source = await getSnapshotSource(objectStore, snap.archiveObjectKey!);
  const candidates = (await fx.candidates(parentId)).map((c) => ({ ...c, scope: { ...c.scope, files: withLocalImports(c.scope.files, source) } }));
  console.log(`[${name} #${rep}] parent ${parent?.status} in ${((Date.now() - t0) / 1000).toFixed(0)}s; ${candidates.length} confirmed, ${candidates.filter((c) => c.runnable).length} repairable`);

  const repairs: RepairResult[] = [];
  for (const c of candidates.filter((x) => x.runnable)) {
    if (maxUsd - spent < PER_REPAIR_USD) {
      budgetStopped = true;
      console.log(`[${name} #${rep}] stopping: $${spent.toFixed(3)} of the $${maxUsd} round budget is spent`);
      break;
    }
    await db.insert(findingReview).values({ id: randomUUID(), runId: parentId, findingId: c.id, projectId: snap.projectId, snapshotId: snap.id, reviewerUserId: who.userId, reviewerRole: "owner", decision: "confirmed", reason: "repair corpus", supersedesReviewId: null });
    const id = randomUUID();
    await db.insert(testingRepair).values({ id, runId: parentId, findingId: c.id, projectId: snap.projectId, snapshotId: snap.id, status: "running", requestedBy: who.userId, approvedBy: who.userId, scope: c.scope });
    const session = sessionFor();
    if (!session) throw new Error("No repair model is configured (TESTING_AI_PROVIDER with a Gemini or Nebius key).");
    session.limitBudget(Math.min(PER_REPAIR_USD, maxUsd - spent));
    const sent: string[] = [];
    const json = session.json.bind(session);
    session.json = ((role: Parameters<typeof json>[0], req: Parameters<typeof json>[1]) => { sent.push(`${req.system}\n${req.user}`); return json(role, req); }) as typeof session.json;
    const r0 = Date.now();
    let r: TestingRepair;
    try {
      r = await processRepair(id, { provider, session, objects: objectStore, runValidation });
    } catch (err) {
      repairs.push({ key: c.key, id: c.id, title: c.title, severity: c.severity, status: "crashed", attempts: 0, costUsd: 0, seconds: 0, falseVerified: false, regressions: [], unauthorized: [], ownershipProblems: [], redactionProblems: [], refused: [], error: (err as Error).message.slice(0, 300) });
      continue;
    }
    const last = r.attempts.at(-1);
    const falseVerified = r.status === "verified" && !!last && last.checks.some((k) => k.role === "reproduction" && k.after !== "passed");
    const regressions = r.status === "verified" ? (last?.checks ?? []).filter((k) => k.role === "regression" && k.before === "passed" && k.after !== "passed").map((k) => k.obligationId) : [];
    // A patch that reached a sandbox must only touch files in scope that are ordinary source (no tests, config or lockfiles).
    const unauthorized = r.attempts.filter((a) => a.validationRunId).flatMap((a) => a.filesChanged.filter((p) => !c.scope.files.includes(p) || editableSourceFiles([p]).length !== 1));
    const ownershipProblems: string[] = [];
    for (const a of r.attempts.filter((x) => x.validationRunId)) {
      const [child] = await db.select().from(testingRun).where(eq(testingRun.id, a.validationRunId!));
      const pol = (child?.policy ?? {}) as { repair?: { repairId?: string; files?: Array<{ key: string }> }; rerun?: { parentRunId?: string } };
      if (!child) ownershipProblems.push(`attempt ${a.n}: validation run missing`);
      else {
        if (child.snapshotId !== snap.id || child.projectId !== snap.projectId) ownershipProblems.push(`attempt ${a.n}: validation run belongs to another snapshot or project`);
        if (child.check !== fx.check) ownershipProblems.push(`attempt ${a.n}: validation run is a ${child.check} run`);
        if (pol.repair?.repairId !== id || pol.rerun?.parentRunId !== parentId) ownershipProblems.push(`attempt ${a.n}: validation run not linked to this repair and parent run`);
        if ((pol.repair?.files ?? []).some((f) => !f.key.startsWith(`testing-repairs/${id}/`))) ownershipProblems.push(`attempt ${a.n}: patched file stored outside this repair`);
      }
    }
    const redactionProblems = sent.flatMap((p, i) => [...(CANARY.test(p) ? [`prompt ${i + 1} carries a raw canary`] : []), ...(redactText(p, [], 1_000_000) !== p ? [`prompt ${i + 1} carries an unredacted secret`] : [])]);
    const refused = r.attempts.filter((a) => a.status === "rejected_patch").flatMap((a) => a.rejectedBecause);
    const res: RepairResult = { key: c.key, id: c.id, title: c.title, severity: c.severity, status: r.status, attempts: r.attempts.length, costUsd: r.attempts.reduce((s, a) => s + (a.costUsd ?? 0), 0), seconds: Math.round((Date.now() - r0) / 1000), falseVerified, regressions, unauthorized, ownershipProblems, redactionProblems, refused, error: r.error };
    repairs.push(res);
    spent += res.costUsd;
    console.log(`[${name} #${rep}] ${c.id} ${c.key}: ${r.status} after ${r.attempts.length} attempt(s), ${res.seconds}s`);
  }
  const [snapNow] = await db.select().from(snapshot).where(eq(snapshot.id, snap.id));
  const immutable = archiveBefore === (await digestOf(snap.archiveObjectKey!)) && snapNow?.contentDigest === snap.contentDigest;
  const out = { fixture: name, check: fx.check, rep, snapshotId: snap.id, analysisUsd, budgetStopped, parentStatus: parent?.status ?? "missing", confirmed: candidates.length, excluded: candidates.filter((c) => !c.runnable).map((c) => ({ key: c.key, id: c.id, whyNot: c.whyNot })), repairs, immutable };
  writeFileSync(join(outDir, `${name}-${rep}.json`), JSON.stringify(out, null, 2));
  return out;
}

type Out = Awaited<ReturnType<typeof runOnce>>;
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : "n/a");

function summarize() {
  const outs = readdirSync(outDir).filter((f) => /-\d+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(outDir, f), "utf8")) as Out);
  if (!outs.length) throw new Error(`No results in ${outDir}`);
  const all = outs.flatMap((o) => o.repairs.map((r) => ({ ...r, fixture: o.fixture })));
  const mandatory = all.filter((r) => r.severity === "critical" || r.severity === "high");
  const verified = (xs: typeof all) => xs.filter((r) => r.status === "verified").length;
  const byKey = new Map<string, Map<number, string>>();
  for (const o of outs) for (const r of o.repairs) {
    const k = `${o.fixture} ${r.key}`;
    if (!byKey.has(k)) byKey.set(k, new Map());
    byKey.get(k)!.set(o.rep, r.status);
  }
  const reps = new Set(outs.map((o) => o.rep)).size;
  const unstable = [...byKey].filter(([, m]) => m.size !== reps || new Set(m.values()).size > 1);
  const gates: Array<[string, boolean, string]> = [
    ["At least 90% verified-repair success on mandatory (critical/high) findings", mandatory.length > 0 && verified(mandatory) / mandatory.length >= 0.9, `${verified(mandatory)}/${mandatory.length} (${pct(verified(mandatory), mandatory.length)})`],
    ["At least 85% verified-repair success across the corpus", all.length > 0 && verified(all) / all.length >= 0.85, `${verified(all)}/${all.length} (${pct(verified(all), all.length)})`],
    ["Zero repairs verified while the reproduction still fails", all.every((r) => !r.falseVerified), `${all.filter((r) => r.falseVerified).length} found`],
    ["Zero high/critical regressions in verified repairs", all.every((r) => !r.regressions.length), `${all.filter((r) => r.regressions.length).length} verified repairs with a regression`],
    ["Zero unauthorized, out-of-scope or test-only edits accepted", all.every((r) => !r.unauthorized.length), `${all.flatMap((r) => r.unauthorized).length} found`],
    ["100% snapshot, run, execution and patch ownership", all.every((r) => !r.ownershipProblems.length), `${all.flatMap((r) => r.ownershipProblems).length} problems`],
    ["100% original-snapshot immutability", outs.every((o) => o.immutable), `${outs.filter((o) => o.immutable).length}/${outs.length} snapshots unchanged`],
    ["All secrets and synthetic canaries redacted before reaching the model", all.every((r) => !r.redactionProblems.length), `${all.flatMap((r) => r.redactionProblems).length} problems`],
    [`Identical repair classifications across ${reps} repeated runs`, reps >= 3 && unstable.length === 0, `${byKey.size - unstable.length}/${byKey.size} findings stable over ${reps} run(s)`],
    ["Detection usable without AI credits (parent checks ran with no AI session)", outs.every((o) => o.parentStatus === "completed" || o.parentStatus === "partial") && outs.every((o) => o.confirmed > 0), outs.map((o) => `${o.fixture}#${o.rep} ${o.parentStatus}, ${o.confirmed} confirmed`).join("; ")],
    ["Ran to the end within the round budget", outs.every((o) => !o.budgetStopped), `$${outs.reduce((s, o) => s + (o.analysisUsd ?? 0) + o.repairs.reduce((a, r) => a + r.costUsd, 0), 0).toFixed(3)} of $${maxUsd}`],
    ["No repair crashed", all.every((r) => r.status !== "crashed"), `${all.filter((r) => r.status === "crashed").length} crashed`],
  ];
  const lines = [
    `# Repair release gates, round ${round}`, "",
    `Fixtures: ${[...new Set(outs.map((o) => o.fixture))].join(", ")}; ${reps} repetition(s); up to ${outs[0]!.repairs[0]?.attempts ?? maxAttempts} attempts per repair; detection and validation with no AI session; patches proposed by the configured repair model.`, "",
    "| Gate | Result | Measured |", "|---|---|---|",
    ...gates.map(([g, ok, m]) => `| ${g} | ${ok ? "PASS" : "FAIL"} | ${m} |`), "",
    `AI cost: repairs $${all.reduce((s, r) => s + r.costUsd, 0).toFixed(3)}, project analyses $${outs.reduce((s, o) => s + (o.analysisUsd ?? 0), 0).toFixed(3)}.`, "",
    "## Per finding", "", "| Fixture | Finding | Severity | Statuses per run | Attempts | Refused patch reasons |", "|---|---|---|---|---|---|",
    ...[...byKey].map(([k, m]) => {
      const rs = all.filter((r) => `${r.fixture} ${r.key}` === k);
      return `| ${k.split(" ")[0]} | ${rs[0]!.id} ${rs[0]!.title.replace(/\|/g, "/")} | ${rs[0]!.severity} | ${[...m.entries()].sort().map(([n, s]) => `#${n} ${s}`).join(", ")} | ${rs.map((r) => r.attempts).join("/")} | ${[...new Set(rs.flatMap((r) => r.refused))].join(" ").replace(/\|/g, "/").slice(0, 200) || "-"} |`;
    }), "",
    "## Not repairable automatically (excluded from the corpus)", "",
    ...[...new Map(outs.flatMap((o) => o.excluded.map((e) => [`${o.fixture} ${e.key}`, `- ${o.fixture} ${e.id} ${e.key}: ${e.whyNot}`] as const))).values()],
    "", ...all.filter((r) => r.error && r.status !== "verified").map((r) => `- ${r.fixture} ${r.id} (${r.status}): ${r.error}`),
    "", `**Overall: ${gates.every(([, ok]) => ok) ? "PASS" : "FAIL"}.**`,
  ];
  writeFileSync(join(outDir, "scorecard.md"), lines.join("\n"));
  console.log(lines.join("\n"));
  return gates.every(([, ok]) => ok);
}

async function main() {
  if (mode === "summarize") {
    const ok = summarize();
    await pool.end();
    process.exit(ok ? 0 : 1);
  }
  const fx = FIXTURES[fixtureName];
  if (!fx) throw new Error(`Unknown fixture "${fixtureName}". Known: ${Object.keys(FIXTURES).join(", ")}`);
  for (let i = 1; i <= repeat; i++) if (!existsSync(join(outDir, `${fixtureName}-${i}.json`))) await runOnce(fixtureName, fx, i);
  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  await pool.end().catch(() => {});
  process.exit(1);
});
