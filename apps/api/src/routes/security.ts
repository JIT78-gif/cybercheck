import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { RerunSecurityInput, SecurityPolicyInput, type SecurityFinding, type SecurityObligation, type SecurityProjectStatus, type SecurityProof, SecurityReport, SecurityRunDetail, SecurityRunSummary, TestExecution, TestingUsage } from "@cybercheck/contracts";
import { isMember, notFound, projectForUser, requireSession, sendError, snapshotForUser } from "../access.ts";
import { db } from "../db/client.ts";
import { idempotencyKey, project, securityProof, snapshot, testExecution, testFinding, testingRun, testObligation, testRunEvent } from "../db/schema.ts";
import { securityRunToMarkdown } from "../security/export.ts";
import { SECURITY_ENGINE } from "../security/orchestrator.ts";
import { selectSecurityRuntime } from "../security/runtime.ts";
import { sandboxProvider } from "../testing/worker.ts";
import { loadEvents } from "../testing/store.ts";
import { analysisOf, ensureUnderstanding } from "../understanding/run.ts";
import { redactDeep, redactSecrets } from "../understanding/source.ts";
import { ACTIVE } from "./testing.ts";

// The Security check's API. Runs live in the shared check-run table with check = "security"; Security routes only
// ever see Security runs, as Testing routes only see Testing runs.

type RunRow = typeof testingRun.$inferSelect;
const SECURITY = eq(testingRun.check, "security");
const emptyUsage: TestingUsage = { aiCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, sandboxOperations: 0, sandboxCpuSeconds: 0, models: {} };

export async function securitySummaries(rows: RunRow[]): Promise<SecurityRunSummary[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const counts = await db
    .select({ runId: testObligation.runId, total: sql<number>`count(*)::int`, terminal: sql<number>`count(*) filter (where ${testObligation.status} not in ('planned', 'running'))::int` })
    .from(testObligation)
    .where(inArray(testObligation.runId, ids))
    .groupBy(testObligation.runId);
  const findings = await db
    .select({ runId: testFinding.runId, confirmed: sql<number>`count(*) filter (where ${testFinding.data}->>'status' = 'confirmed')::int`, suspected: sql<number>`count(*) filter (where ${testFinding.data}->>'status' = 'suspected')::int` })
    .from(testFinding)
    .where(inArray(testFinding.runId, ids))
    .groupBy(testFinding.runId);
  const last = await db
    .select({ runId: testRunEvent.runId, message: testRunEvent.message })
    .from(testRunEvent)
    .where(and(inArray(testRunEvent.runId, ids), sql`${testRunEvent.seq} = (select max(e2.seq) from test_run_event e2 where e2.run_id = ${testRunEvent.runId})`));
  return rows.map((r) => {
    const c = counts.find((x) => x.runId === r.id);
    const f = findings.find((x) => x.runId === r.id);
    const active = (ACTIVE as readonly string[]).includes(r.status);
    const report = r.report as SecurityReport | null;
    return {
      id: r.id,
      snapshotId: r.snapshotId,
      projectId: r.projectId,
      status: r.status,
      phase: r.phase as SecurityRunSummary["phase"],
      step: active ? (r.status === "queued" ? "Waiting for a worker" : (last.find((x) => x.runId === r.id)?.message ?? "Starting")) : null,
      progress: active && c?.total ? Math.min(0.99, c.terminal / c.total) : active ? 0 : null,
      headline: report?.headline ?? (r.status === "blocked" || r.status === "failed" ? r.error : null),
      decision: report?.decision ?? null,
      counts: { obligations: c?.total ?? 0, terminal: c?.terminal ?? 0, confirmed: f?.confirmed ?? 0, suspected: f?.suspected ?? 0 },
      error: r.error,
      createdAt: r.createdAt.toISOString(),
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
    };
  });
}

export async function securityDetail(r: RunRow): Promise<SecurityRunDetail> {
  const [obs, execs, finds, proofs] = await Promise.all([
    db.select().from(testObligation).where(eq(testObligation.runId, r.id)).orderBy(asc(testObligation.seq)),
    db.select().from(testExecution).where(eq(testExecution.runId, r.id)).orderBy(asc(testExecution.createdAt)),
    db.select().from(testFinding).where(eq(testFinding.runId, r.id)),
    db.select().from(securityProof).where(eq(securityProof.runId, r.id)).orderBy(asc(securityProof.seq)),
  ]);
  const [summary] = await securitySummaries([r]);
  return {
    ...summary!,
    obligations: obs.map((o) => o.data as SecurityObligation),
    executions: execs.map((e) => e.data as TestExecution),
    findings: finds.map((f) => f.data as SecurityFinding).sort((a, b) => Number(a.id.replace(/\D/g, "")) - Number(b.id.replace(/\D/g, ""))),
    proofs: proofs.map((p) => p.data as SecurityProof),
    report: (r.report as SecurityReport | null) ?? null,
    usage: (r.usage as TestingUsage | null) ?? emptyUsage,
  };
}

export async function securityRunForUser(userId: string, runId: string) {
  const [r] = await db.select().from(testingRun).where(and(SECURITY, eq(testingRun.id, runId)));
  if (!r) return null;
  return (await snapshotForUser(userId, r.snapshotId)) ? r : null;
}

export async function securityRoutes(app: FastifyInstance) {
  /** Which runtime a Security run would use right now, with the preflight reason for each provider. */
  app.get("/v1/security/runtime-status", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const sel = await selectSecurityRuntime("auto", sandboxProvider());
    return { selected: sel.selected, fallbackReason: sel.fallbackReason, health: sel.health, networkIsolation: "Every scan and proof runs with the network off; the project's code never runs on the host." };
  });

  /** Start a Security run for a snapshot. Requires an Idempotency-Key; an active Security run is returned instead of a second one. */
  app.post<{ Params: { id: string } }>("/v1/snapshots/:id/checks/security", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8 || key.length > 200) {
      return sendError(reply, 400, { code: "bad_request", message: "Missing Idempotency-Key header.", fix: "Retry from the app; it sends one automatically." });
    }
    const s = await snapshotForUser(session.user.id, request.params.id);
    if (!s) return sendError(reply, 404, notFound("snapshot"));
    const [latest] = await db.select().from(snapshot).where(eq(snapshot.projectId, s.projectId)).orderBy(desc(snapshot.createdAt)).limit(1);
    if (latest?.id !== s.id) return sendError(reply, 409, { code: "snapshot_not_latest", message: "Only the project's latest snapshot can be checked.", fix: "Open the project again and start the check from there." });
    if ((await analysisOf(s)).stage !== "ready") return sendError(reply, 409, { code: "project_not_ready", message: "This project is still being analysed.", fix: "Start the Security check once the project shows Ready." });
    const parsed = SecurityPolicyInput.omit({ engine: true }).safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, { code: "bad_request", message: "The Security options are not valid.", fix: "Start the check again from the app." });
    const policy = { engine: SECURITY_ENGINE, aiCritic: parsed.data.aiCritic, runtime: parsed.data.runtime };
    const route = "checks/security";
    // The options are part of the request: the same key with different options is a different request.
    const requestHash = createHash("sha256").update(`${s.id}:${JSON.stringify(policy)}`).digest("hex");
    const ur = await ensureUnderstanding(s.id);
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(idempotencyKey).where(and(eq(idempotencyKey.userId, session.user.id), eq(idempotencyKey.route, route), eq(idempotencyKey.key, key))).for("update");
      if (existing) return existing.requestHash === requestHash ? ({ kind: "replay", runId: (existing.response as { runId: string }).runId } as const) : ({ kind: "conflict" } as const);
      // One active Security run per snapshot: a second click joins it. A Testing run of the same snapshot is unrelated.
      const [active] = await tx.select().from(testingRun).where(and(SECURITY, eq(testingRun.snapshotId, s.id), inArray(testingRun.status, [...ACTIVE]))).limit(1);
      const runId = active?.id ?? randomUUID();
      if (!active) await tx.insert(testingRun).values({ id: runId, check: "security", snapshotId: s.id, projectId: s.projectId, understandingRunId: ur.id, requestedBy: session.user.id, policy });
      await tx.insert(idempotencyKey).values({ userId: session.user.id, route, key, requestHash, response: { runId } });
      return { kind: active ? "joined" : "created", runId } as const;
    });
    if (result.kind === "conflict") return sendError(reply, 422, { code: "idempotency_key_reused", message: "This request ID was already used for a different check.", fix: "Start the check again from the app." });
    const [row] = await db.select().from(testingRun).where(eq(testingRun.id, result.runId));
    return reply.status(result.kind === "created" ? 201 : 200).send({ run: (await securitySummaries([row!]))[0] });
  });

  app.get<{ Params: { wid: string } }>("/v1/workspaces/:wid/security-status", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    if (!(await isMember(session.user.id, request.params.wid))) return sendError(reply, 404, notFound("workspace"));
    const projects = await db.select({ id: project.id }).from(project).where(eq(project.workspaceId, request.params.wid));
    if (!projects.length) return { projects: [] as SecurityProjectStatus[] };
    const rows = await db.select().from(testingRun).where(and(SECURITY, inArray(testingRun.projectId, projects.map((p) => p.id)))).orderBy(desc(testingRun.createdAt)).limit(400);
    const latest = projects.map((p) => rows.find((r) => r.projectId === p.id)).filter((r): r is RunRow => Boolean(r));
    const sums = new Map((await securitySummaries(latest)).map((s) => [s.projectId, s]));
    return { projects: projects.map((p) => ({ projectId: p.id, latest: sums.get(p.id) ?? null, active: rows.some((r) => r.projectId === p.id && (ACTIVE as readonly string[]).includes(r.status)) })) satisfies SecurityProjectStatus[] };
  });

  app.get<{ Params: { id: string } }>("/v1/projects/:id/security-runs", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const p = await projectForUser(session.user.id, request.params.id);
    if (!p) return sendError(reply, 404, notFound("project"));
    const rows = await db.select().from(testingRun).where(and(SECURITY, eq(testingRun.projectId, p.id))).orderBy(desc(testingRun.createdAt)).limit(20);
    return { runs: await securitySummaries(rows) };
  });

  app.get<{ Params: { runId: string } }>("/v1/security-runs/:runId", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const r = await securityRunForUser(session.user.id, request.params.runId);
    if (!r) return sendError(reply, 404, notFound("security run"));
    return { run: await securityDetail(r) };
  });

  /** The run as a downloadable report: Markdown, or JSON (the full ledger, redacted field by field so it stays valid). */
  app.get<{ Params: { runId: string }; Querystring: { format?: string } }>("/v1/security-runs/:runId/export", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const r = await securityRunForUser(session.user.id, request.params.runId);
    if (!r) return sendError(reply, 404, notFound("security run"));
    if ((ACTIVE as readonly string[]).includes(r.status)) return sendError(reply, 409, { code: "run_not_finished", message: "This run is still in progress.", fix: "Download the report once it finishes." });
    const run = await securityDetail(r);
    const [p] = await db.select({ name: project.name }).from(project).where(eq(project.id, r.projectId));
    const base = `${(p?.name ?? "project").replace(/[^\w.-]+/g, "-").slice(0, 60)}-security-${r.createdAt.toISOString().slice(0, 10)}`;
    if (request.query.format === "json") {
      reply.header("content-type", "application/json; charset=utf-8").header("content-disposition", `attachment; filename="${base}.json"`);
      return JSON.stringify(redactDeep(run), null, 2);
    }
    reply.header("content-type", "text/markdown; charset=utf-8").header("content-disposition", `attachment; filename="${base}.md"`);
    return redactSecrets(securityRunToMarkdown(run, p?.name ?? "Project")).text;
  });

  app.get<{ Params: { runId: string }; Querystring: { after?: string } }>("/v1/security-runs/:runId/events", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const r = await securityRunForUser(session.user.id, request.params.runId);
    if (!r) return sendError(reply, 404, notFound("security run"));
    return { events: await loadEvents(r.id, Number(request.query.after) || 0) };
  });

  app.post<{ Params: { runId: string } }>("/v1/security-runs/:runId/cancel", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const r = await securityRunForUser(session.user.id, request.params.runId);
    if (!r) return sendError(reply, 404, notFound("security run"));
    if (!(ACTIVE as readonly string[]).includes(r.status)) return sendError(reply, 409, { code: "not_running", message: "This run has already finished.", fix: "Start a new run if you want fresh results." });
    // A queued run is cancelled at once; a running one stops at the worker's next heartbeat.
    await db.update(testingRun).set({ cancelRequested: true }).where(eq(testingRun.id, r.id));
    await db.update(testingRun).set({ status: "cancelled", phase: "done", finishedAt: new Date() }).where(and(eq(testingRun.id, r.id), eq(testingRun.status, "queued")));
    const [row] = await db.select().from(testingRun).where(eq(testingRun.id, r.id));
    return reply.status(202).send({ run: (await securitySummaries([row!]))[0] });
  });

  /** Re-check only the undecided obligations ("missing") or a chosen set, as a new focused run. The original run is a
   * separate record and is never changed. Requires an Idempotency-Key. */
  app.post<{ Params: { runId: string } }>("/v1/security-runs/:runId/rerun", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8 || key.length > 200) return sendError(reply, 400, { code: "bad_request", message: "Missing Idempotency-Key header.", fix: "Retry from the app; it sends one automatically." });
    const parent = await securityRunForUser(session.user.id, request.params.runId);
    if (!parent) return sendError(reply, 404, notFound("security run"));
    if ((ACTIVE as readonly string[]).includes(parent.status)) return sendError(reply, 409, { code: "run_not_finished", message: "This run is still in progress.", fix: "Rerun once it finishes." });
    const parsed = RerunSecurityInput.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, { code: "bad_request", message: "Say which obligations to re-check.", fix: "Choose 'missing', or a set of obligation ids." });
    const obs = (await db.select().from(testObligation).where(eq(testObligation.runId, parent.id)).orderBy(asc(testObligation.seq))).map((o) => o.data as SecurityObligation);
    const DECISIVE = new Set(["passed", "failed", "not_applicable"]);
    const ids = parsed.data.scope === "missing"
      ? obs.filter((o) => !DECISIVE.has(o.status)).map((o) => o.id)
      : (parsed.data.obligationIds ?? []).filter((id) => obs.some((o) => o.id === id));
    if (!ids.length) return sendError(reply, 409, { code: "nothing_to_rerun", message: parsed.data.scope === "missing" ? "Every obligation in that run already has a decisive result." : "None of those obligations belong to this run.", fix: "Choose obligations from this report, or rerun the whole check." });
    const policy = { ...((parent.policy ?? {}) as Record<string, unknown>), engine: SECURITY_ENGINE, rerun: { parentRunId: parent.id, obligationIds: ids } };
    const route = "checks/security/rerun";
    const requestHash = createHash("sha256").update(`${parent.id}:${ids.slice().sort().join(",")}`).digest("hex");
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(idempotencyKey).where(and(eq(idempotencyKey.userId, session.user.id), eq(idempotencyKey.route, route), eq(idempotencyKey.key, key))).for("update");
      if (existing) return existing.requestHash === requestHash ? ({ kind: "replay", runId: (existing.response as { runId: string }).runId } as const) : ({ kind: "conflict" } as const);
      const runId = randomUUID();
      await tx.insert(testingRun).values({ id: runId, check: "security", snapshotId: parent.snapshotId, projectId: parent.projectId, understandingRunId: parent.understandingRunId, requestedBy: session.user.id, policy });
      await tx.insert(idempotencyKey).values({ userId: session.user.id, route, key, requestHash, response: { runId } });
      return { kind: "created", runId } as const;
    });
    if (result.kind === "conflict") return sendError(reply, 422, { code: "idempotency_key_reused", message: "This request ID was already used for a different rerun.", fix: "Start the rerun again from the app." });
    const [row] = await db.select().from(testingRun).where(eq(testingRun.id, result.runId));
    return reply.status(result.kind === "created" ? 201 : 200).send({ run: (await securitySummaries([row!]))[0] });
  });
}
