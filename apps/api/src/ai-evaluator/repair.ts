import { eq } from "drizzle-orm";
import type { AiEvaluationCase, AiEvaluationFinding, AiEvaluationReport, Obligation, TestingRepair } from "@cybercheck/contracts";
import { db } from "../db/client.ts";
import { aiEvaluationCase, testFinding, testingRun } from "../db/schema.ts";
import { DEFAULT_ATTEMPTS, editableSourceFiles, registerRepairAdapter, repairEstimate, type RepairAdapter, type RepairFindingInput } from "../testing/repair.ts";

// AI Evaluator repairs reuse the shared human-review + sandbox-repair engine. The reproduction unit is a decisive AI
// case; an unsafe-rendering finding settled by the real browser canary (not by a case) gets one synthetic unit read from
// the run report's output_rendering lane. The validation run inherits the parent's authoritative mode (replay, direct
// or live), judge setting and datasets unchanged, and reruns only the reproduction and regression cases with the patch
// overlaid. Blocked or inconclusive never verifies: only a decisive "passed" does.

/** The synthetic reproduction unit for the browser rendering canary. */
export const CANARY_UNIT = "canary:output_rendering";

function caseAsObligation(c: AiEvaluationCase): Obligation {
  const endpoint = c.target.endpoint;
  return {
    id: c.id,
    layer: "api",
    asset: { kind: "endpoint", ref: endpoint, label: endpoint },
    objective: c.title,
    priority: c.priority,
    oracle: { source: "policy", expected: c.oracle.expected, evidence: c.sourceEvidence },
    status: c.verdict,
    reason: c.reason,
    origin: "dossier",
    executionIds: c.executionIds,
    findingIds: c.findingIds,
    reachedTarget: c.verdict === "passed" || c.verdict === "failed",
  };
}

/** The canary's settled state from a run report: passed = the payload reached the page escaped; failed = it executed. */
function canaryUnit(report: AiEvaluationReport | null): Obligation | null {
  const lane = report?.obligations?.find((o) => o.lane === "output_rendering");
  if (!lane) return null;
  const status = lane.status === "passed" || lane.status === "failed" || lane.status === "blocked" ? lane.status : "inconclusive";
  return {
    id: CANARY_UNIT,
    layer: "ui",
    asset: { kind: "module", ref: "output_rendering", label: "Reply rendering in the browser" },
    objective: "Model output stays inert when the page renders it",
    priority: "high",
    oracle: { source: "policy", expected: "The canary payload reaches the page escaped and does not execute.", evidence: [] },
    status,
    reason: lane.reason,
    origin: "dossier",
    executionIds: [],
    findingIds: [],
    reachedTarget: status === "passed" || status === "failed",
  };
}

const isCanaryFinding = (f: AiEvaluationFinding) => f.category === "output_rendering" && f.rootCause.startsWith("output_rendering:");

function findingForRepair(f: AiEvaluationFinding): RepairFindingInput {
  const where = f.sourceEvidence[0] ?? null;
  return {
    title: f.title,
    expected: f.expected,
    actual: f.observed,
    rootCause: f.rootCause,
    location: where ? { path: where.path, line: where.line } : null,
    reproduction: `${f.confirmation}\nObserved: ${f.observed}\nImpact: ${f.impact}\nRecommended control: ${f.remediation}`,
    obligationIds: [...f.caseIds, ...(isCanaryFinding(f) ? [CANARY_UNIT] : [])],
  };
}

/** Which source files a repair may change, and the cases (plus the canary) the validation run must rerun. */
export function aiRepairScope(finding: AiEvaluationFinding, cases: AiEvaluationCase[], maxAttempts = DEFAULT_ATTEMPTS): TestingRepair["scope"] {
  const mine = cases.filter((c) => finding.caseIds.includes(c.id));
  const files = editableSourceFiles([...finding.sourceEvidence.map((e) => e.path), ...mine.flatMap((c) => c.sourceEvidence.map((e) => e.path))]);
  const sameTarget = (c: AiEvaluationCase) => c.target.componentId === finding.componentId && (c.target.endpoint === finding.endpoint || c.category === finding.category || isCanaryFinding(finding));
  const regression = cases.filter((c) => !finding.caseIds.includes(c.id) && c.verdict === "passed" && sameTarget(c)).map((c) => c.id).slice(0, 80);
  const reproduction = [...finding.caseIds, ...(isCanaryFinding(finding) ? [CANARY_UNIT] : [])];
  return { files, reproduction, regression, maxAttempts, estimate: repairEstimate(maxAttempts) };
}

/** The real case ids the validation run must execute (the canary is not a case; it runs whenever a case produces a reply). */
export const caseIdsToRun = (scope: TestingRepair["scope"]) => [...scope.reproduction, ...scope.regression].filter((id) => id !== CANARY_UNIT);

const defectKey = (f: Pick<AiEvaluationFinding, "category" | "rootCause">) => `${f.category}|${f.rootCause}`;

/** The defects (category and root cause) each case was failed for in one run, from that run's findings. */
export function defectsByCase(findings: AiEvaluationFinding[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const f of findings) for (const id of f.caseIds) {
    if (!out.has(id)) out.set(id, new Set());
    out.get(id)!.add(defectKey(f));
  }
  return out;
}

/**
 * One case can fail for several defects at once (a cross-user case whose replies also leak a credential). For a repair
 * of ONE defect, a still-failing case counts as passed when this defect is gone from it and every remaining failure is
 * another defect the original run already had for that case. A failure for a new reason stays failed.
 */
export function judgeCaseForDefect(c: AiEvaluationCase, target: AiEvaluationFinding, here: Set<string> | undefined, original: Set<string> | undefined): Obligation {
  const o = caseAsObligation(c);
  if (c.verdict !== "failed" || !here || !original) return o;
  const key = defectKey(target);
  if (here.has(key) || [...here].some((k) => !original.has(k))) return o;
  const others = [...here].map((k) => k.split("|")[1]).join(", ");
  return { ...o, status: "passed", reason: `This defect no longer reproduces in this case; it still fails only for other confirmed problem(s) already found before the repair (${others}).` };
}

const aiAdapter: RepairAdapter = {
  finding: (d) => findingForRepair(d as AiEvaluationFinding),
  results: async (runId, data) => {
    const target = data as AiEvaluationFinding;
    const rows = await db.select().from(aiEvaluationCase).where(eq(aiEvaluationCase.runId, runId));
    const findingsOf = async (id: string) => (await db.select().from(testFinding).where(eq(testFinding.runId, id))).map((r) => r.data as AiEvaluationFinding);
    const here = defectsByCase(await findingsOf(runId));
    const [self] = await db.select({ parentRunId: testingRun.policy }).from(testingRun).where(eq(testingRun.id, runId));
    const parentId = (self?.parentRunId as { rerun?: { parentRunId?: string } } | null)?.rerun?.parentRunId;
    const original = parentId ? defectsByCase(await findingsOf(parentId)) : here;
    const map = new Map(rows.map((r) => [r.id, judgeCaseForDefect(r.data as AiEvaluationCase, target, here.get(r.id), original.get(r.id))] as const));
    const [run] = await db.select({ report: testingRun.report }).from(testingRun).where(eq(testingRun.id, runId));
    const canary = canaryUnit((run?.report as AiEvaluationReport | null) ?? null);
    if (canary) map.set(CANARY_UNIT, canary);
    return map;
  },
  rerun: (scope, parentRunId) => ({ parentRunId, caseIds: caseIdsToRun(scope) }),
  // Same authoritative mode as the run that confirmed the problem: nothing is forced.
  extraPolicy: () => ({}),
};

registerRepairAdapter("ai-evaluator", aiAdapter);
