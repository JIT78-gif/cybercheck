import { randomUUID, createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { ApproveRepairInput, FindingKind, type ApiError, ReviewFindingInput, TargetedRunInput, TestingPolicyInput, type FindingHumanReview, type Obligation, type TestFinding, type TestingRepair, type TestingReport } from "@cybercheck/contracts";
import { notAuthorized, notFound, projectAuthority, requireSession, sendError, snapshotForUser } from "../access.ts";
import { db } from "../db/client.ts";
import { auditLog, findingReview, idempotencyKey, project, snapshot, testFinding, testingRepair, testingRun, testObligation, user } from "../db/schema.ts";
import { env, providers } from "../env.ts";
import { asRepair, repairScope } from "../testing/repair.ts";
import { reviewable, reviewedAssessment } from "../testing/review.ts";
import { effectivePolicy } from "../testing/runtime.ts";
import { ACTIVE, createRerun, runForUser, summaries } from "./testing.ts";

type RunRow = typeof testingRun.$inferSelect;

/** Findings as stored (legacy finding kinds are read as their v2 equivalents). */
const parseFinding = (data: unknown) => {
  const f = data as TestFinding;
  return { ...f, kind: FindingKind.parse(f.kind) } as TestFinding;
};

async function reviewsOf(where: ReturnType<typeof eq>): Promise<FindingHumanReview[]> {
  const rows = await db
    .select({ r: findingReview, name: user.name })
    .from(findingReview)
    .leftJoin(user, eq(user.id, findingReview.reviewerUserId))
    .where(where)
    .orderBy(asc(findingReview.createdAt));
  return rows.map(({ r, name }) => ({
    id: r.id,
    findingId: r.findingId,
    runId: r.runId,
    projectId: r.projectId,
    snapshotId: r.snapshotId,
    reviewerUserId: r.reviewerUserId,
    reviewerName: name ?? null,
    reviewerRole: r.reviewerRole as FindingHumanReview["reviewerRole"],
    decision: r.decision as FindingHumanReview["decision"],
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
    supersedesReviewId: r.supersedesReviewId,
  }));
}

/** The reviewed version of a finished run: computed from the immutable report and the review history. */
async function reviewedReportOf(run: RunRow, userId: string) {
  const [obs, finds, reviews, projectReviews] = await Promise.all([
    db.select().from(testObligation).where(eq(testObligation.runId, run.id)),
    db.select().from(testFinding).where(eq(testFinding.runId, run.id)),
    reviewsOf(eq(findingReview.runId, run.id)),
    reviewsOf(eq(findingReview.projectId, run.projectId)),
  ]);
  // Precision across the project: every reviewed run's findings, so the same finding id in two runs never collides.
  const runIds = [...new Set(projectReviews.map((r) => r.runId))];
  const projectFindings = runIds.length ? await db.select().from(testFinding).where(inArray(testFinding.runId, runIds)) : [];
  const keyed = (runId: string, id: string) => `${runId}/${id}`;
  const policy = TestingPolicyInput.safeParse(run.policy ?? {});
  return reviewedAssessment({
    runId: run.id,
    report: run.report as TestingReport,
    obligations: obs.map((o) => o.data as Obligation),
    findings: finds.map((f) => parseFinding(f.data)),
    reviews,
    projectReviews: {
      findings: projectFindings.map((f) => ({ ...parseFinding(f.data), id: keyed(f.runId, (f.data as TestFinding).id) })),
      reviews: projectReviews.map((r) => ({ ...r, findingId: keyed(r.runId, r.findingId) })),
    },
    allowAcceptedRisk: effectivePolicy(policy.success ? policy.data : {}, env.TESTING_RUN_BUDGET_USD).allowAcceptedRisk,
    canReview: (await projectAuthority(userId, run.projectId)) != null,
  });
}

const needsKey = (key: unknown) => typeof key !== "string" || key.length < 8 || key.length > 200;
const KEY_ERROR = { code: "bad_request", message: "Missing Idempotency-Key header.", fix: "Retry from the app; it sends one automatically." } as const;

export async function testingReviewRoutes(app: FastifyInstance) {
  /** Record a human decision on one finding. Append-only; the latest decision is the effective one. */
  app.post<{ Params: { runId: string; findingId: string } }>("/v1/testing-runs/:runId/findings/:findingId/reviews", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const key = request.headers["idempotency-key"];
    if (needsKey(key)) return sendError(reply, 400, KEY_ERROR);
    const run = await runForUser(session.user.id, request.params.runId);
    if (!run) return sendError(reply, 404, notFound("testing run"));
    const role = await projectAuthority(session.user.id, run.projectId);
    if (!role) return sendError(reply, 403, notAuthorized("review findings"));
    if ((ACTIVE as readonly string[]).includes(run.status) || !run.report) return sendError(reply, 409, { code: "run_not_finished", message: "Findings can be reviewed once the run has finished.", fix: "Wait for the report, then review." });
    const [row] = await db.select().from(testFinding).where(and(eq(testFinding.runId, run.id), eq(testFinding.id, request.params.findingId)));
    if (!row) return sendError(reply, 404, notFound("finding"));
    const finding = parseFinding(row.data);
    if (!reviewable(finding)) return sendError(reply, 409, { code: "not_reviewable", message: "Only product problems are reviewed; this finding is about the testing itself or the environment.", fix: "Review the findings listed under product problems." });
    const body = ReviewFindingInput.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, 400, { code: "bad_request", message: "Choose confirmed, rejected, unsure or accepted risk.", fix: "Pick one of the four decisions." });
    const reason = body.data.reason?.trim() || null;
    const route = `testing/review/${run.id}/${finding.id}`;
    const requestHash = createHash("sha256").update(`${body.data.decision}:${reason ?? ""}`).digest("hex");

    const result = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(idempotencyKey).where(and(eq(idempotencyKey.userId, session.user.id), eq(idempotencyKey.route, route), eq(idempotencyKey.key, key as string))).for("update");
      if (existing) return existing.requestHash === requestHash ? ({ kind: "replay", id: (existing.response as { reviewId: string }).reviewId } as const) : ({ kind: "conflict" } as const);
      // The review this one supersedes: the latest one so far (history is kept, never edited).
      const [latest] = await tx.select({ id: findingReview.id }).from(findingReview).where(and(eq(findingReview.runId, run.id), eq(findingReview.findingId, finding.id))).orderBy(desc(findingReview.createdAt), desc(findingReview.id)).limit(1);
      const id = randomUUID();
      await tx.insert(findingReview).values({ id, runId: run.id, findingId: finding.id, projectId: run.projectId, snapshotId: run.snapshotId, reviewerUserId: session.user.id, reviewerRole: role, decision: body.data.decision, reason, supersedesReviewId: latest?.id ?? null });
      const [proj] = await tx.select({ workspaceId: project.workspaceId }).from(project).where(eq(project.id, run.projectId));
      await tx.insert(auditLog).values({ id: randomUUID(), userId: session.user.id, workspaceId: proj?.workspaceId ?? null, action: "testing.finding.reviewed", targetType: "test_finding", targetId: `${run.id}/${finding.id}`, data: { decision: body.data.decision, reason, role, snapshotId: run.snapshotId, supersedes: latest?.id ?? null, machine: { kind: finding.kind, status: finding.status, severity: finding.severity } } });
      await tx.insert(idempotencyKey).values({ userId: session.user.id, route, key: key as string, requestHash, response: { reviewId: id } });
      return { kind: "created", id } as const;
    });
    if (result.kind === "conflict") return sendError(reply, 422, { code: "idempotency_key_reused", message: "This request ID was already used for a different decision.", fix: "Review the finding again from the app." });
    const [saved] = (await reviewsOf(eq(findingReview.id, result.id))) as FindingHumanReview[];
    return reply.status(result.kind === "created" ? 201 : 200).send({ review: saved, reviewed: await reviewedReportOf(run, session.user.id) });
  });

  /** Every review of the run's findings, oldest first (the full history). */
  app.get<{ Params: { runId: string } }>("/v1/testing-runs/:runId/reviews", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const run = await runForUser(session.user.id, request.params.runId);
    if (!run) return sendError(reply, 404, notFound("testing run"));
    return { reviews: await reviewsOf(eq(findingReview.runId, run.id)) };
  });

  /** The run after human review, as a new version next to the immutable machine report. */
  app.get<{ Params: { runId: string } }>("/v1/testing-runs/:runId/reviewed-report", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const run = await runForUser(session.user.id, request.params.runId);
    if (!run) return sendError(reply, 404, notFound("testing run"));
    if (!run.report) return sendError(reply, 409, { code: "run_not_finished", message: "This run has no report yet.", fix: "Wait for the run to finish." });
    return { reviewed: await reviewedReportOf(run, session.user.id) };
  });

  /** Rerun only selected checks (or the checks behind selected findings, e.g. unsure ones), plus what they need. */
  app.post<{ Params: { runId: string } }>("/v1/testing-runs/:runId/targeted-runs", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const key = request.headers["idempotency-key"];
    if (needsKey(key)) return sendError(reply, 400, KEY_ERROR);
    const parent = await runForUser(session.user.id, request.params.runId);
    if (!parent) return sendError(reply, 404, notFound("testing run"));
    if ((ACTIVE as readonly string[]).includes(parent.status)) return sendError(reply, 409, { code: "run_not_finished", message: "This run is still in progress.", fix: "Rerun once it finishes." });
    const body = TargetedRunInput.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, 400, { code: "bad_request", message: "Say which checks or findings to run again.", fix: "Use the rerun button on a finding or a check." });
    const [newest] = await db.select({ id: snapshot.id }).from(snapshot).where(eq(snapshot.projectId, parent.projectId)).orderBy(desc(snapshot.createdAt)).limit(1);
    if (newest?.id !== parent.snapshotId) return sendError(reply, 409, { code: "snapshot_not_latest", message: "The code has changed since this run, so its results cannot be reused.", fix: "Start a new run for the latest snapshot." });
    const parentObs = new Set((await db.select({ id: testObligation.id }).from(testObligation).where(eq(testObligation.runId, parent.id))).map((o) => o.id));
    let ids: string[];
    if ("findingIds" in body.data) {
      const wanted = new Set(body.data.findingIds);
      const finds = (await db.select().from(testFinding).where(eq(testFinding.runId, parent.id))).map((f) => parseFinding(f.data)).filter((f) => wanted.has(f.id));
      ids = [...new Set(finds.flatMap((f) => f.obligationIds))].filter((id) => parentObs.has(id));
    } else ids = body.data.obligationIds.filter((id) => parentObs.has(id));
    if (!ids.length) return sendError(reply, 409, { code: "nothing_to_rerun", message: "None of those checks belong to this run.", fix: "Choose checks or findings from this report." });
    if (!providers.sandbox) return sendError(reply, 503, { code: "sandbox_not_configured", message: "Testing needs Nebius Sandboxes, which isn't configured on this server.", fix: "Set NEBIUS_API_KEY and NEBIUS_PROJECT_ID in .env and restart the worker." });
    const result = await createRerun(session.user.id, key as string, parent, ids, "checks/testing/targeted");
    if (result.kind === "conflict") return sendError(reply, 422, { code: "idempotency_key_reused", message: "This request ID was already used for a different rerun.", fix: "Start the rerun again from the app." });
    const [row] = await db.select().from(testingRun).where(eq(testingRun.id, result.runId));
    return reply.status(result.kind === "created" ? 201 : 200).send({ run: (await summaries([row!]))[0], obligations: ids.length });
  });

  // ---------------------------------------------------------------- sandbox repair of a confirmed finding

  /** Ask for a repair: shows what may change, what is rerun, the attempt limit and the cost. Nothing runs yet. */
  app.post<{ Params: { runId: string; findingId: string } }>("/v1/testing-runs/:runId/findings/:findingId/repairs", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const run = await runForUser(session.user.id, request.params.runId);
    if (!run) return sendError(reply, 404, notFound("testing run"));
    if (!(await projectAuthority(session.user.id, run.projectId))) return sendError(reply, 403, notAuthorized("try repairs"));
    const gate = await confirmedFinding(run, request.params.findingId);
    if ("error" in gate) return sendError(reply, gate.status, gate.error);
    const [open] = await db.select().from(testingRepair).where(and(eq(testingRepair.runId, run.id), eq(testingRepair.findingId, gate.finding.id), inArray(testingRepair.status, ["awaiting_approval", "running"])));
    if (open) return reply.status(200).send({ repair: asRepair(open) });
    const obligations = (await db.select().from(testObligation).where(eq(testObligation.runId, run.id))).map((o) => o.data as Obligation);
    const scope = repairScope(gate.finding, obligations);
    if (!scope.files.length) return sendError(reply, 409, { code: "no_repair_scope", message: "This problem does not point at a source file that a repair could change.", fix: "Fix it by hand; the finding shows where it was seen." });
    const id = randomUUID();
    await db.insert(testingRepair).values({ id, runId: run.id, findingId: gate.finding.id, projectId: run.projectId, snapshotId: run.snapshotId, status: "awaiting_approval", requestedBy: session.user.id, scope });
    const [row] = await db.select().from(testingRepair).where(eq(testingRepair.id, id));
    return reply.status(201).send({ repair: asRepair(row!) });
  });

  /** Explicit approval: only now does the repair run, in fresh sandboxes, never on the project itself. */
  app.post<{ Params: { runId: string; findingId: string } }>("/v1/testing-runs/:runId/findings/:findingId/repair-approvals", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const key = request.headers["idempotency-key"];
    if (needsKey(key)) return sendError(reply, 400, KEY_ERROR);
    const run = await runForUser(session.user.id, request.params.runId);
    if (!run) return sendError(reply, 404, notFound("testing run"));
    const role = await projectAuthority(session.user.id, run.projectId);
    if (!role) return sendError(reply, 403, notAuthorized("approve repairs"));
    const body = ApproveRepairInput.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, 400, { code: "bad_request", message: "Say which repair to approve.", fix: "Use the approve button on the repair." });
    const gate = await confirmedFinding(run, request.params.findingId);
    if ("error" in gate) return sendError(reply, gate.status, gate.error);
    if (!providers.sandbox) return sendError(reply, 503, { code: "sandbox_not_configured", message: "Repairs run in Nebius Sandboxes, which are not configured on this server.", fix: "Set NEBIUS_API_KEY and NEBIUS_PROJECT_ID in .env and restart the worker." });
    const route = `testing/repair-approval/${body.data.repairId}`;
    const requestHash = createHash("sha256").update(`${body.data.repairId}:${body.data.maxAttempts ?? ""}`).digest("hex");
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(idempotencyKey).where(and(eq(idempotencyKey.userId, session.user.id), eq(idempotencyKey.route, route), eq(idempotencyKey.key, key as string))).for("update");
      if (existing) return existing.requestHash === requestHash ? ({ kind: "replay" } as const) : ({ kind: "conflict" } as const);
      const [rep] = await tx.select().from(testingRepair).where(and(eq(testingRepair.id, body.data.repairId), eq(testingRepair.runId, run.id), eq(testingRepair.findingId, gate.finding.id))).for("update");
      if (!rep) return { kind: "missing" } as const;
      if (rep.status !== "awaiting_approval") return { kind: "state", status: rep.status } as const;
      const scope = rep.scope as TestingRepair["scope"];
      const maxAttempts = body.data.maxAttempts ?? scope.maxAttempts;
      const next = { ...scope, maxAttempts, estimate: { minutes: [4, 10 * maxAttempts] as [number, number], costUsd: [0.03, Math.round(25 * maxAttempts) / 100] as [number, number] } };
      await tx.update(testingRepair).set({ status: "running", approvedBy: session.user.id, scope: next, updatedAt: new Date() }).where(eq(testingRepair.id, rep.id));
      const [proj] = await tx.select({ workspaceId: project.workspaceId }).from(project).where(eq(project.id, run.projectId));
      await tx.insert(auditLog).values({ id: randomUUID(), userId: session.user.id, workspaceId: proj?.workspaceId ?? null, action: "testing.repair.approved", targetType: "testing_repair", targetId: rep.id, data: { runId: run.id, findingId: gate.finding.id, role, maxAttempts, files: next.files, snapshotId: run.snapshotId } });
      await tx.insert(idempotencyKey).values({ userId: session.user.id, route, key: key as string, requestHash, response: { repairId: rep.id } });
      return { kind: "approved" } as const;
    });
    if (result.kind === "conflict") return sendError(reply, 422, { code: "idempotency_key_reused", message: "This request ID was already used for a different approval.", fix: "Approve again from the app." });
    if (result.kind === "missing") return sendError(reply, 404, notFound("repair"));
    if (result.kind === "state") return sendError(reply, 409, { code: "repair_not_awaiting_approval", message: `This repair is already ${result.status.replace(/_/g, " ")}.`, fix: "Open the repair to see its result." });
    const [row] = await db.select().from(testingRepair).where(eq(testingRepair.id, body.data.repairId));
    return reply.status(result.kind === "approved" ? 202 : 200).send({ repair: asRepair(row!) });
  });

  /** The repairs of a run (newest first), with every attempt. */
  app.get<{ Params: { runId: string } }>("/v1/testing-runs/:runId/repairs", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const run = await runForUser(session.user.id, request.params.runId);
    if (!run) return sendError(reply, 404, notFound("testing run"));
    const rows = await db.select().from(testingRepair).where(eq(testingRepair.runId, run.id)).orderBy(desc(testingRepair.createdAt));
    return { repairs: rows.map(asRepair) };
  });

  app.get<{ Params: { repairId: string } }>("/v1/testing-repairs/:repairId", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const [row] = await db.select().from(testingRepair).where(eq(testingRepair.id, request.params.repairId));
    if (!row || !(await snapshotForUser(session.user.id, row.snapshotId))) return sendError(reply, 404, notFound("repair"));
    return { repair: asRepair(row) };
  });

  /** Stop a repair: before approval it is simply cancelled; while running, no new attempt starts and its check stops. */
  app.post<{ Params: { repairId: string } }>("/v1/testing-repairs/:repairId/cancel", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const [row] = await db.select().from(testingRepair).where(eq(testingRepair.id, request.params.repairId));
    if (!row || !(await snapshotForUser(session.user.id, row.snapshotId))) return sendError(reply, 404, notFound("repair"));
    if (!(await projectAuthority(session.user.id, row.projectId))) return sendError(reply, 403, notAuthorized("cancel repairs"));
    if (row.status === "awaiting_approval") await db.update(testingRepair).set({ status: "cancelled", cancelRequested: true, updatedAt: new Date() }).where(eq(testingRepair.id, row.id));
    else if (row.status === "running") {
      await db.update(testingRepair).set({ cancelRequested: true, updatedAt: new Date() }).where(eq(testingRepair.id, row.id));
      const running = ((row.attempts ?? []) as TestingRepair["attempts"]).map((a) => a.validationRunId).filter((x): x is string => Boolean(x));
      if (running.length) await db.update(testingRun).set({ cancelRequested: true }).where(and(inArray(testingRun.id, running), inArray(testingRun.status, ["queued", "running"])));
    }
    const [after] = await db.select().from(testingRepair).where(eq(testingRepair.id, row.id));
    return reply.status(202).send({ repair: asRepair(after!) });
  });
}

/** A repair is only for a product problem whose latest human review is "confirmed", on a finished run. */
async function confirmedFinding(run: RunRow, findingId: string): Promise<{ finding: TestFinding } | { status: number; error: ApiError }> {
  if ((ACTIVE as readonly string[]).includes(run.status) || !run.report) return { status: 409, error: { code: "run_not_finished", message: "Repairs are possible once the run has finished.", fix: "Wait for the report." } };
  const [row] = await db.select().from(testFinding).where(and(eq(testFinding.runId, run.id), eq(testFinding.id, findingId)));
  if (!row) return { status: 404, error: notFound("finding") };
  const finding = parseFinding(row.data);
  const [latest] = await db.select().from(findingReview).where(and(eq(findingReview.runId, run.id), eq(findingReview.findingId, findingId))).orderBy(desc(findingReview.createdAt), desc(findingReview.id)).limit(1);
  if (finding.kind !== "product_defect" || latest?.decision !== "confirmed") return { status: 409, error: { code: "not_confirmed", message: "Only a product problem a reviewer has confirmed can be repaired.", fix: "Confirm the finding first, if it is real." } };
  return { finding };
}

