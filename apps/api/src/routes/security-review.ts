import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { ApproveRepairInput, ReviewFindingInput, type ApiError, type FindingHumanReview, type SecurityFinding, type SecurityObligation, type TestingRepair } from "@cybercheck/contracts";
import { notAuthorized, notFound, projectAuthority, requireSession, sendError } from "../access.ts";
import { db } from "../db/client.ts";
import { auditLog, findingReview, idempotencyKey, project, testFinding, testingRepair, testObligation, user } from "../db/schema.ts";
import { providers } from "../env.ts";
import { selectSecurityRuntime } from "../security/runtime.ts";
import { asRepair, securityRepairScope } from "../testing/repair.ts";
import { sandboxProvider } from "../testing/worker.ts";
import { securityRunForUser } from "./security.ts";
import { ACTIVE } from "./testing.ts";

const needsKey = (key: unknown) => typeof key !== "string" || key.length < 8 || key.length > 200;
const KEY_ERROR = { code: "bad_request", message: "Missing Idempotency-Key header.", fix: "Retry from the app; it sends one automatically." } as const;

async function reviewsOf(runId: string): Promise<FindingHumanReview[]> {
  const rows = await db
    .select({ r: findingReview, name: user.name })
    .from(findingReview)
    .leftJoin(user, eq(user.id, findingReview.reviewerUserId))
    .where(eq(findingReview.runId, runId))
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

async function repairGate(run: NonNullable<Awaited<ReturnType<typeof securityRunForUser>>>, findingId: string): Promise<{ finding: SecurityFinding } | { status: number; error: ApiError }> {
  if ((ACTIVE as readonly string[]).includes(run.status) || !run.report) return { status: 409, error: { code: "run_not_finished", message: "Repairs are possible once the Security run has finished.", fix: "Wait for the report." } };
  const [row] = await db.select().from(testFinding).where(and(eq(testFinding.runId, run.id), eq(testFinding.id, findingId)));
  if (!row) return { status: 404, error: notFound("security finding") };
  const finding = row.data as SecurityFinding;
  if (finding.status === "rejected") return { status: 409, error: { code: "finding_rejected", message: "A rejected hypothesis cannot be repaired.", fix: "Choose an active confirmed or suspected finding." } };
  const [latest] = await db.select().from(findingReview).where(and(eq(findingReview.runId, run.id), eq(findingReview.findingId, findingId))).orderBy(desc(findingReview.createdAt), desc(findingReview.id)).limit(1);
  if (latest?.decision !== "confirmed") return { status: 409, error: { code: "not_confirmed", message: "A reviewer must confirm this security finding before a repair can be proposed.", fix: "Confirm the finding first, then request the sandbox repair." } };
  return { finding };
}

/** Human review and approved sandbox repair for Security findings. Machine reports stay immutable. */
export async function securityReviewRoutes(app: FastifyInstance) {
  app.get<{ Params: { runId: string } }>("/v1/security-runs/:runId/reviews", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const run = await securityRunForUser(session.user.id, request.params.runId);
    if (!run) return sendError(reply, 404, notFound("security run"));
    return { reviews: await reviewsOf(run.id), canReview: (await projectAuthority(session.user.id, run.projectId)) != null };
  });

  app.post<{ Params: { runId: string; findingId: string } }>("/v1/security-runs/:runId/findings/:findingId/reviews", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const key = request.headers["idempotency-key"];
    if (needsKey(key)) return sendError(reply, 400, KEY_ERROR);
    const run = await securityRunForUser(session.user.id, request.params.runId);
    if (!run) return sendError(reply, 404, notFound("security run"));
    const role = await projectAuthority(session.user.id, run.projectId);
    if (!role) return sendError(reply, 403, notAuthorized("review security findings"));
    if ((ACTIVE as readonly string[]).includes(run.status) || !run.report) return sendError(reply, 409, { code: "run_not_finished", message: "Findings can be reviewed once the Security run has finished.", fix: "Wait for the report, then review." });
    const [row] = await db.select().from(testFinding).where(and(eq(testFinding.runId, run.id), eq(testFinding.id, request.params.findingId)));
    if (!row) return sendError(reply, 404, notFound("security finding"));
    const finding = row.data as SecurityFinding;
    const body = ReviewFindingInput.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, 400, { code: "bad_request", message: "Choose confirmed, rejected, unsure or accepted risk.", fix: "Pick one of the four decisions." });
    const reason = body.data.reason?.trim() || null;
    const route = `security/review/${run.id}/${finding.id}`;
    const requestHash = createHash("sha256").update(`${body.data.decision}:${reason ?? ""}`).digest("hex");
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(idempotencyKey).where(and(eq(idempotencyKey.userId, session.user.id), eq(idempotencyKey.route, route), eq(idempotencyKey.key, key as string))).for("update");
      if (existing) return existing.requestHash === requestHash ? ({ kind: "replay", id: (existing.response as { reviewId: string }).reviewId } as const) : ({ kind: "conflict" } as const);
      const [latest] = await tx.select({ id: findingReview.id }).from(findingReview).where(and(eq(findingReview.runId, run.id), eq(findingReview.findingId, finding.id))).orderBy(desc(findingReview.createdAt), desc(findingReview.id)).limit(1);
      const id = randomUUID();
      await tx.insert(findingReview).values({ id, runId: run.id, findingId: finding.id, projectId: run.projectId, snapshotId: run.snapshotId, reviewerUserId: session.user.id, reviewerRole: role, decision: body.data.decision, reason, supersedesReviewId: latest?.id ?? null });
      const [proj] = await tx.select({ workspaceId: project.workspaceId }).from(project).where(eq(project.id, run.projectId));
      await tx.insert(auditLog).values({ id: randomUUID(), userId: session.user.id, workspaceId: proj?.workspaceId ?? null, action: "security.finding.reviewed", targetType: "security_finding", targetId: `${run.id}/${finding.id}`, data: { decision: body.data.decision, reason, role, snapshotId: run.snapshotId, machine: { status: finding.status, severity: finding.severity, category: finding.category } } });
      await tx.insert(idempotencyKey).values({ userId: session.user.id, route, key: key as string, requestHash, response: { reviewId: id } });
      return { kind: "created", id } as const;
    });
    if (result.kind === "conflict") return sendError(reply, 422, { code: "idempotency_key_reused", message: "This request ID was already used for a different decision.", fix: "Review the finding again from the app." });
    const review = (await reviewsOf(run.id)).find((r) => r.id === result.id)!;
    return reply.status(result.kind === "created" ? 201 : 200).send({ review });
  });

  app.post<{ Params: { runId: string; findingId: string } }>("/v1/security-runs/:runId/findings/:findingId/repairs", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const run = await securityRunForUser(session.user.id, request.params.runId);
    if (!run) return sendError(reply, 404, notFound("security run"));
    if (!(await projectAuthority(session.user.id, run.projectId))) return sendError(reply, 403, notAuthorized("try security repairs"));
    const gate = await repairGate(run, request.params.findingId);
    if ("error" in gate) return sendError(reply, gate.status, gate.error);
    const [open] = await db.select().from(testingRepair).where(and(eq(testingRepair.runId, run.id), eq(testingRepair.findingId, gate.finding.id), inArray(testingRepair.status, ["awaiting_approval", "running"])));
    if (open) return reply.status(200).send({ repair: asRepair(open) });
    const obligations = (await db.select().from(testObligation).where(eq(testObligation.runId, run.id))).map((o) => o.data as SecurityObligation);
    const scope = securityRepairScope(gate.finding, obligations);
    if (!scope.files.length) return sendError(reply, 409, { code: "no_repair_scope", message: "This finding does not point to editable application source code.", fix: "Dependency, secret and deployment findings must be fixed manually using the remediation shown in the report." });
    const id = randomUUID();
    await db.insert(testingRepair).values({ id, runId: run.id, findingId: gate.finding.id, projectId: run.projectId, snapshotId: run.snapshotId, status: "awaiting_approval", requestedBy: session.user.id, scope });
    const [saved] = await db.select().from(testingRepair).where(eq(testingRepair.id, id));
    return reply.status(201).send({ repair: asRepair(saved!) });
  });

  app.post<{ Params: { runId: string; findingId: string } }>("/v1/security-runs/:runId/findings/:findingId/repair-approvals", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const key = request.headers["idempotency-key"];
    if (needsKey(key)) return sendError(reply, 400, KEY_ERROR);
    const run = await securityRunForUser(session.user.id, request.params.runId);
    if (!run) return sendError(reply, 404, notFound("security run"));
    const role = await projectAuthority(session.user.id, run.projectId);
    if (!role) return sendError(reply, 403, notAuthorized("approve security repairs"));
    const body = ApproveRepairInput.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, 400, { code: "bad_request", message: "Say which repair to approve.", fix: "Use the approve button on the repair." });
    const gate = await repairGate(run, request.params.findingId);
    if ("error" in gate) return sendError(reply, gate.status, gate.error);
    if (!providers.testingAi) return sendError(reply, 503, { code: "repair_ai_not_configured", message: "No repair model is configured.", fix: "Configure Gemini or Nebius for Testing AI, restart the worker, then approve again." });
    const runtime = await selectSecurityRuntime("auto", sandboxProvider());
    if (!runtime.provider) return sendError(reply, 503, { code: "sandbox_not_configured", message: "No isolated runtime is available for validating this repair.", fix: "Start Docker Desktop or configure Nebius Sandboxes, then approve again." });
    const route = `security/repair-approval/${body.data.repairId}`;
    const requestHash = createHash("sha256").update(`${body.data.repairId}:${body.data.maxAttempts ?? ""}`).digest("hex");
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(idempotencyKey).where(and(eq(idempotencyKey.userId, session.user.id), eq(idempotencyKey.route, route), eq(idempotencyKey.key, key as string))).for("update");
      if (existing) return existing.requestHash === requestHash ? ({ kind: "replay" } as const) : ({ kind: "conflict" } as const);
      const [repair] = await tx.select().from(testingRepair).where(and(eq(testingRepair.id, body.data.repairId), eq(testingRepair.runId, run.id), eq(testingRepair.findingId, gate.finding.id))).for("update");
      if (!repair) return { kind: "missing" } as const;
      if (repair.status !== "awaiting_approval") return { kind: "state", status: repair.status } as const;
      const scope = repair.scope as TestingRepair["scope"];
      const maxAttempts = body.data.maxAttempts ?? scope.maxAttempts;
      const next = { ...scope, maxAttempts, estimate: { minutes: [4, 10 * maxAttempts] as [number, number], costUsd: [0.03, Math.round(25 * maxAttempts) / 100] as [number, number] } };
      await tx.update(testingRepair).set({ status: "running", approvedBy: session.user.id, scope: next, updatedAt: new Date() }).where(eq(testingRepair.id, repair.id));
      const [proj] = await tx.select({ workspaceId: project.workspaceId }).from(project).where(eq(project.id, run.projectId));
      await tx.insert(auditLog).values({ id: randomUUID(), userId: session.user.id, workspaceId: proj?.workspaceId ?? null, action: "security.repair.approved", targetType: "testing_repair", targetId: repair.id, data: { runId: run.id, findingId: gate.finding.id, role, maxAttempts, files: next.files, snapshotId: run.snapshotId, runtime: runtime.selected } });
      await tx.insert(idempotencyKey).values({ userId: session.user.id, route, key: key as string, requestHash, response: { repairId: repair.id } });
      return { kind: "approved" } as const;
    });
    if (result.kind === "conflict") return sendError(reply, 422, { code: "idempotency_key_reused", message: "This request ID was already used for a different approval.", fix: "Approve again from the app." });
    if (result.kind === "missing") return sendError(reply, 404, notFound("repair"));
    if (result.kind === "state") return sendError(reply, 409, { code: "repair_not_awaiting_approval", message: `This repair is already ${result.status.replace(/_/g, " ")}.`, fix: "Open the repair to see its result." });
    const [saved] = await db.select().from(testingRepair).where(eq(testingRepair.id, body.data.repairId));
    return reply.status(result.kind === "approved" ? 202 : 200).send({ repair: asRepair(saved!) });
  });

  app.get<{ Params: { runId: string } }>("/v1/security-runs/:runId/repairs", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const run = await securityRunForUser(session.user.id, request.params.runId);
    if (!run) return sendError(reply, 404, notFound("security run"));
    const rows = await db.select().from(testingRepair).where(eq(testingRepair.runId, run.id)).orderBy(desc(testingRepair.createdAt));
    return { repairs: rows.map(asRepair) };
  });
}
