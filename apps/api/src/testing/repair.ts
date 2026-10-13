import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { FindingKind, RepairEdit, type Obligation, type RepairAttempt, type TestFinding, type TestingRepair } from "@cybercheck/contracts";
import { db } from "../db/client.ts";
import { snapshot, testFinding, testingRepair, testingRun, testObligation } from "../db/schema.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { BudgetExceededError, type AiSession } from "../understanding/ai/gateway.ts";
import { getSnapshotSource, type SnapshotSource } from "../understanding/source.ts";
import type { SandboxProvider } from "./sandbox/provider.ts";

/**
 * Sandbox repair of one human-confirmed finding. A model proposes a small patch; it is checked for unsafe edits,
 * then validated by a targeted Testing run of the same snapshot with the patched files mounted over the project in
 * fresh sandboxes only. The snapshot, the user's project and cybercheck's own checks are never changed.
 */

export const DEFAULT_ATTEMPTS = 2;
const TEST_FILE = /(^|\/)(tests?|__tests__|spec|e2e|cypress|playwright)\/|(\.|_)(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|(^|\/)conftest\.py$/i;
const CONFIG_FILE = /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|tsconfig[^/]*\.json|\.eslintrc[^/]*|eslint\.config\.[a-z]+|\.prettierrc[^/]*|vitest\.config\.[a-z]+|jest\.config\.[a-z]+|pytest\.ini|setup\.cfg|\.github\/.*|Dockerfile|docker-compose[^/]*)$/i;
const SOURCE_FILE = /\.(py|ts|tsx|js|jsx|mjs|cjs|go|rb|java|kt|cs|php|rs|vue|svelte|html)$/i;

// ---------------------------------------------------------------- scope (shown before approval)

export function repairScope(finding: TestFinding, obligations: Obligation[], maxAttempts = DEFAULT_ATTEMPTS): TestingRepair["scope"] {
  const byId = new Map(obligations.map((o) => [o.id, o]));
  const mine = finding.obligationIds.map((id) => byId.get(id)).filter((o): o is Obligation => Boolean(o));
  const files = [...new Set([finding.location?.path, ...mine.flatMap((o) => o.oracle.evidence.map((e) => e.path))].filter((p): p is string => Boolean(p)))]
    .filter((p) => SOURCE_FILE.test(p) && !TEST_FILE.test(p) && !CONFIG_FILE.test(p))
    // A deterministic finding may represent the same rule on several screens. The proposal format allows twelve
    // edits, so hiding the seventh source file makes the repair impossible before the model even starts.
    .slice(0, 12);
  const accessibilityRule =
    finding.layer === "accessibility"
      ? finding.rootCause?.match(/axe-core rule\s+["']?([\w-]+)/i)?.[1] ?? finding.reproduction.match(/rule\s+["']([\w-]+)["']/i)?.[1]
      : undefined;
  // Regression scope: build, typecheck and start, the project's own tests, and every check of the same endpoints or
  // screens that passed before. A repair must keep all of them passing.
  const assets = new Set(mine.map((o) => o.asset.ref));
  const regression = obligations
    .filter((o) => !finding.obligationIds.includes(o.id) && o.status === "passed" && (/^env:(install|build|typecheck|lint|boot):/.test(o.id) || o.id.startsWith("suite:") || assets.has(o.asset.ref)))
    .map((o) => o.id)
    .slice(0, 80);
  return {
    files,
    reproduction: finding.obligationIds,
    regression,
    ...(accessibilityRule ? { targetFailure: { marker: accessibilityRule, label: `axe-core rule ${accessibilityRule}` } } : {}),
    maxAttempts,
    // Per attempt: one patch proposal and one targeted validation run (most of the time is the sandboxes).
    estimate: { minutes: [4, 10 * maxAttempts], costUsd: [0.03, round2(0.25 * maxAttempts)] },
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- patch safety

const SUPPRESS = /eslint-disable|@ts-ignore|@ts-nocheck|@ts-expect-error|#\s*type:\s*ignore|#\s*noqa|pytest\.mark\.skip|\.skip\(|xit\(|xdescribe\(|istanbul ignore/;
const GUARD = /require_\w+|Depends\(|login_required|permission|isAdmin|is_admin|authorize|authenticate|\brole\b|guard|requireAuth|requireRole|verify_token|current_user/i;
const A11Y = /aria-[\w-]+=|\balt=|<label\b|htmlFor=|\brole="/g;

/** Reasons a proposed patch is refused before it runs. Empty means it may be validated. */
export function reviewEdits(edits: RepairEdit[], allowed: string[], files: Map<string, string>): string[] {
  const problems: string[] = [];
  if (!edits.length) problems.push("The patch changes nothing.");
  for (const e of edits) {
    if (TEST_FILE.test(e.path)) problems.push(`${e.path}: tests may not be edited to make a failure go away.`);
    else if (CONFIG_FILE.test(e.path)) problems.push(`${e.path}: configuration, dependencies and lint or type settings may not be changed.`);
    else if (!allowed.includes(e.path)) problems.push(`${e.path}: not one of the files this repair may change (${allowed.join(", ") || "none"}).`);
    const text = files.get(e.path);
    if (text == null) {
      problems.push(`${e.path}: no such file in the snapshot.`);
      continue;
    }
    const count = text.split(e.find).length - 1;
    if (count !== 1) problems.push(`${e.path}: the text to replace appears ${count} times; it must appear exactly once.`);
    if (SUPPRESS.test(e.replace) && !SUPPRESS.test(e.find)) problems.push(`${e.path}: adds a suppression (skip, ignore or disable), which hides a problem instead of fixing it.`);
    const removedGuards = e.find.split("\n").filter((l) => GUARD.test(l) && !e.replace.includes(l.trim()));
    if (removedGuards.length) problems.push(`${e.path}: removes or changes an access check (${removedGuards[0]!.trim().slice(0, 80)}); a repair may not weaken authorization.`);
    if ((e.replace.match(A11Y) ?? []).length < (e.find.match(A11Y) ?? []).length) problems.push(`${e.path}: removes accessibility attributes (labels, alt text or ARIA).`);
    if (e.replace.trim() === "" && e.find.trim().split("\n").length > 3) problems.push(`${e.path}: deletes a block of code instead of fixing it.`);
  }
  return [...new Set(problems)];
}

/** Applies exact replacements; returns the patched files and a unified diff of the change. */
export function applyEdits(files: Map<string, string>, edits: RepairEdit[]): { patched: Map<string, string>; diff: string; changed: string[] } {
  const patched = new Map<string, string>();
  for (const e of edits) {
    const before = patched.get(e.path) ?? files.get(e.path)!;
    patched.set(e.path, before.replace(e.find, () => e.replace));
  }
  const diff = [...patched].map(([path, after]) => unifiedDiff(path, files.get(path)!, after)).join("\n");
  return { patched, diff, changed: [...patched.keys()] };
}

/** A unified diff of one file (one hunk around the changed lines, with three lines of context). */
export function unifiedDiff(path: string, before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  const from = Math.max(0, start - 3);
  const toA = Math.min(a.length - 1, endA + 3);
  const toB = Math.min(b.length - 1, endB + 3);
  const lines = [
    ...a.slice(from, start).map((l) => ` ${l}`),
    ...a.slice(start, endA + 1).map((l) => `-${l}`),
    ...b.slice(start, endB + 1).map((l) => `+${l}`),
    ...a.slice(endA + 1, toA + 1).map((l) => ` ${l}`),
  ];
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -${from + 1},${toA - from + 1} +${from + 1},${toB - from + 1} @@`, ...lines].join("\n");
}

// ---------------------------------------------------------------- judging an attempt

const DECISIVE_PASS = new Set(["passed"]);

/** Verified only when every reproduction check passes and no regression check that passed before fails now. */
export function judgeAttempt(scope: TestingRepair["scope"], before: Map<string, Obligation>, after: Map<string, Obligation>): Pick<RepairAttempt, "status" | "checks" | "regressions"> {
  const row = (id: string, role: "reproduction" | "regression") => {
    const old = before.get(id);
    const fresh = after.get(id);
    const marker = scope.targetFailure?.marker.toLowerCase();
    const reached = fresh?.reachedTarget !== false && (fresh?.status === "passed" || fresh?.status === "failed" || fresh?.status === "flaky");
    const targetResolved =
      role === "reproduction" && marker
        ? Boolean(reached && old?.reason?.toLowerCase().includes(marker) && !fresh?.reason?.toLowerCase().includes(marker))
        : undefined;
    return { obligationId: id, label: old?.objective ?? id, role, before: old?.status ?? "missing", after: fresh?.status ?? "not run", ...(targetResolved !== undefined ? { targetResolved } : {}) };
  };
  const checks = [...scope.reproduction.map((id) => row(id, "reproduction")), ...scope.regression.map((id) => row(id, "regression"))];
  const regressions = checks.filter((c) => c.role === "regression" && c.before === "passed" && c.after === "failed").map((c) => c.obligationId);
  const fixed = checks.filter((c) => c.role === "reproduction").every((c) => DECISIVE_PASS.has(c.after) || c.targetResolved === true);
  return { status: regressions.length ? "regression_introduced" : fixed ? "verified" : "failed_validation", checks, regressions };
}

// ---------------------------------------------------------------- proposing a patch

const ProposalOut = z.object({ summary: z.string(), edits: z.array(RepairEdit).max(12) });
export type Proposal = z.infer<typeof ProposalOut>;
export type ProposalInput = { finding: TestFinding; files: Array<{ path: string; text: string }>; targets?: Array<{ id: string; objective: string; reason: string | null; evidence: Array<{ path: string; line: number | null }> }>; feedback: string | null };

const REPAIR_PATCH_SYSTEM = `You fix ONE confirmed defect in a project with the smallest safe change.
Reply with JSON: {"summary":"one or two sentences: what was wrong and what you changed","edits":[{"path":"...","find":"exact text copied from the file","replace":"the new text"}]}.
Rules:
- Edit only the files shown, and only source code. Never edit tests, configuration, dependency files, lint or type settings.
- "find" must be copied exactly from the file (including indentation) and must appear exactly once; keep it short but unique.
- Fix the cause shown by the evidence. Do not hide the failure: no skip, ignore, eslint-disable, @ts-ignore, noqa; do not delete checks.
- When the defect is reported on several reproduction targets, repair EVERY listed occurrence in one proposal. A fix
  for only the first screen, endpoint or module is incomplete.
- Never weaken authorization (sign-in, role or permission checks) or accessibility (labels, alt text, ARIA).
- Keep every other behaviour the same; the project's own tests and the checks of the same endpoint must keep passing.`;

export async function proposePatch(session: AiSession, input: ProposalInput): Promise<Proposal> {
  const f = input.finding;
  const user = [
    `Defect: ${f.title}`,
    `Expected: ${f.expected}`,
    `Actual: ${f.actual}`,
    f.rootCause ? `Likely cause: ${f.rootCause}` : "",
    f.location ? `Where: ${f.location.path}:${f.location.line}` : "",
    `How it is reproduced:\n${f.reproduction.slice(0, 2500)}`,
    input.targets?.length
      ? `Every reproduction target that this one defect must be removed from:\n${input.targets.map((t) => `- ${t.id}: ${t.objective}\n  Current result: ${t.reason ?? "failed"}\n  Source evidence: ${t.evidence.map((e) => `${e.path}${e.line ? `:${e.line}` : ""}`).join(", ") || "not mapped"}`).join("\n")}`
      : "",
    input.feedback ? `Your previous attempt did not work:\n${input.feedback}` : "",
    "Files you may change:",
    ...input.files.map((x) => `<project_data file="${x.path}">\n${x.text.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n").slice(0, 24_000)}\n</project_data>\nThe line numbers are for reference only; never copy them into "find".`),
  ]
    .filter(Boolean)
    .join("\n\n");
  const req = { purpose: "sandbox repair", system: REPAIR_PATCH_SYSTEM, user, schema: ProposalOut, maxTokens: 10000 };
  try {
    return await session.json("author", req);
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    // Another model family answers when the first one does not return a usable patch.
    return session.json("triage", { ...req, purpose: "sandbox repair (fallback)" });
  }
}

// ---------------------------------------------------------------- the repair workflow

type Deps = {
  provider: SandboxProvider | null;
  session: AiSession | null;
  objects: ObjectStore;
  /** Runs a Testing run to the end (the worker's processRun); passed in to avoid an import cycle. */
  runValidation: (runId: string) => Promise<void>;
  /** For tests: a fixed proposal instead of a model call. */
  propose?: (input: ProposalInput) => Promise<Proposal>;
};

const asRepair = (r: typeof testingRepair.$inferSelect): TestingRepair => ({
  id: r.id,
  runId: r.runId,
  findingId: r.findingId,
  projectId: r.projectId,
  snapshotId: r.snapshotId,
  status: r.status as TestingRepair["status"],
  requestedBy: r.requestedBy,
  approvedBy: r.approvedBy,
  scope: r.scope as TestingRepair["scope"],
  attempts: (r.attempts ?? []) as RepairAttempt[],
  error: r.error,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});
export { asRepair };

async function save(id: string, patch: Partial<typeof testingRepair.$inferInsert>) {
  await db.update(testingRepair).set({ ...patch, updatedAt: new Date(), heartbeatAt: new Date() }).where(eq(testingRepair.id, id));
}

const cancelled = async (id: string) => (await db.select({ c: testingRepair.cancelRequested }).from(testingRepair).where(eq(testingRepair.id, id)))[0]?.c === true;

export async function processRepair(repairId: string, deps: Deps): Promise<TestingRepair> {
  const [row] = await db.select().from(testingRepair).where(eq(testingRepair.id, repairId));
  if (!row) throw new Error("repair not found");
  const repair = asRepair(row);
  const [parent] = await db.select().from(testingRun).where(eq(testingRun.id, repair.runId));
  const [snap] = await db.select().from(snapshot).where(eq(snapshot.id, repair.snapshotId));
  const [fRow] = await db.select().from(testFinding).where(and(eq(testFinding.runId, repair.runId), eq(testFinding.id, repair.findingId)));
  if (!parent || !snap?.archiveObjectKey || !fRow) {
    await save(repairId, { status: "failed_validation", error: "The run, snapshot or finding of this repair no longer exists." });
    return asRepair((await db.select().from(testingRepair).where(eq(testingRepair.id, repairId)))[0]!);
  }
  const finding = { ...(fRow.data as TestFinding), kind: FindingKind.parse((fRow.data as TestFinding).kind) } as TestFinding;
  const before = new Map((await db.select().from(testObligation).where(eq(testObligation.runId, parent.id))).map((o) => [o.id, o.data as Obligation]));
  const src: SnapshotSource = await getSnapshotSource(deps.objects, snap.archiveObjectKey);
  const files = new Map(repair.scope.files.filter((p) => src.files.has(p)).map((p) => [p, src.files.get(p)!.text]));
  const attempts: RepairAttempt[] = [...repair.attempts];
  let feedback: string | null = null;
  let final: TestingRepair["status"] = "failed_validation";
  let error: string | null = null;

  if (!files.size) {
    await save(repairId, { status: "failed_validation", error: "None of the files this problem points to could be found in the snapshot, so no patch can be proposed." });
    return asRepair((await db.select().from(testingRepair).where(eq(testingRepair.id, repairId)))[0]!);
  }
  if (!deps.propose && !deps.session) {
    await save(repairId, { status: "failed_validation", error: "AI is not configured on this server, so no patch can be proposed." });
    return asRepair((await db.select().from(testingRepair).where(eq(testingRepair.id, repairId)))[0]!);
  }

  for (let n = attempts.length + 1; n <= repair.scope.maxAttempts; n++) {
    if (await cancelled(repairId)) {
      final = "cancelled";
      break;
    }
    const startedAt = new Date().toISOString();
    const spentBefore = deps.session?.spentUsd ?? 0;
    const attempt: RepairAttempt = { n, status: "running", summary: null, diff: null, patchDigest: null, filesChanged: [], rejectedBecause: [], validationRunId: null, checks: [], regressions: [], costUsd: 0, startedAt, finishedAt: null };
    attempts.push(attempt);
    await save(repairId, { attempts });
    let proposal: Proposal;
    try {
      const input = {
        finding,
        files: [...files].map(([path, text]) => ({ path, text })),
        targets: repair.scope.reproduction.map((id) => {
          const o = before.get(id)!;
          return { id, objective: o?.objective ?? id, reason: o?.reason ?? null, evidence: (o?.oracle.evidence ?? []).map((e) => ({ path: e.path, line: e.line ?? null })) };
        }),
        feedback,
      };
      proposal = deps.propose ? await deps.propose(input) : await proposePatch(deps.session!, input);
    } catch (err) {
      const budget = err instanceof BudgetExceededError;
      Object.assign(attempt, { status: budget ? "budget_exhausted" : "rejected_patch", rejectedBecause: [budget ? "The AI budget for this repair ran out." : `No patch could be proposed: ${(err as Error).message.slice(0, 200)}`], finishedAt: new Date().toISOString() });
      await save(repairId, { attempts });
      if (budget) {
        final = "budget_exhausted";
        break;
      }
      continue;
    }
    attempt.summary = proposal.summary.slice(0, 600);
    const problems = reviewEdits(proposal.edits, repair.scope.files, files);
    if (problems.length) {
      Object.assign(attempt, { status: "rejected_patch", rejectedBecause: problems, costUsd: round4((deps.session?.spentUsd ?? 0) - spentBefore), finishedAt: new Date().toISOString() });
      await save(repairId, { attempts });
      feedback = `The patch was refused before running: ${problems.join(" ")}`;
      continue;
    }
    const { patched, diff, changed } = applyEdits(files, proposal.edits);
    Object.assign(attempt, { diff: diff.slice(0, 60_000), patchDigest: createHash("sha256").update(diff).digest("hex"), filesChanged: changed });
    // The patched files are stored as cybercheck objects; the snapshot archive is never touched.
    const overlay: Array<{ path: string; key: string }> = [];
    for (const [path, text] of patched) {
      const key = `testing-repairs/${repairId}/${n}/${path}`;
      await deps.objects.put(key, Readable.from([Buffer.from(text)]));
      overlay.push({ path, key });
    }
    // Validation: a targeted run of the reproduction and regression checks, in fresh sandboxes, with the patch mounted.
    const validationId = randomUUID();
    const policy = { ...(parent.policy as Record<string, unknown>), rerun: { parentRunId: parent.id, obligationIds: [...repair.scope.reproduction, ...repair.scope.regression] }, repair: { repairId, attempt: n, files: overlay } };
    await db.insert(testingRun).values({ id: validationId, snapshotId: parent.snapshotId, projectId: parent.projectId, understandingRunId: parent.understandingRunId, requestedBy: repair.approvedBy ?? repair.requestedBy, policy, status: "running", generation: 1, startedAt: new Date(), heartbeatAt: new Date() });
    attempt.validationRunId = validationId;
    await save(repairId, { attempts });
    await deps.runValidation(validationId);
    const after = new Map((await db.select().from(testObligation).where(eq(testObligation.runId, validationId))).map((o) => [o.id, o.data as Obligation]));
    const judged = judgeAttempt(repair.scope, before, after);
    Object.assign(attempt, judged, { costUsd: round4((deps.session?.spentUsd ?? 0) - spentBefore), finishedAt: new Date().toISOString() });
    await save(repairId, { attempts });
    final = judged.status as TestingRepair["status"];
    if (judged.status === "verified") break;
    feedback =
      judged.status === "regression_introduced"
        ? `The patch broke checks that passed before: ${judged.regressions.map((id) => `${id} (${after.get(id)?.reason ?? "failed"})`).join("; ")}.`
        : `After the patch the problem is still there: ${judged.checks
            .filter((c) => c.role === "reproduction" && c.after !== "passed" && c.targetResolved !== true)
            .map((c) => `${c.obligationId}: ${after.get(c.obligationId)?.reason ?? c.after}`)
            .join("; ")}.`;
  }
  if (await cancelled(repairId)) final = "cancelled";
  if (final === "failed_validation" && attempts.every((a) => a.status === "rejected_patch")) error ="Every proposed patch was refused as unsafe or invalid before running; see the reasons per attempt.";
  await save(repairId, { status: final, attempts, error, workerId: null });
  return asRepair((await db.select().from(testingRepair).where(eq(testingRepair.id, repairId)))[0]!);
}

const round4 = (n: number) => Math.round(n * 10000) / 10000;
