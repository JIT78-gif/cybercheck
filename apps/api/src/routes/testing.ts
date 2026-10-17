import { randomUUID, createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { FindingKind, RerunTestingInput, StartTestingInput, TestingPolicyInput, type Obligation, type TestExecution, type TestFinding, type TestingPreview, type TestingProjectStatus, type TestingReport, type TestingRunDetail, type TestingRunSummary, type TestingUsage } from "@cybercheck/contracts";
import { isMember, notFound, projectForUser, requireSession, sendError, snapshotForUser } from "../access.ts";
import { db } from "../db/client.ts";
import { idempotencyKey, project, snapshot, testExecution, testFinding, testingRun, testObligation, testRunEvent } from "../db/schema.ts";
import { env, providers } from "../env.ts";
import { objectStore } from "../storage/object-store.ts";
import { testingRunToMarkdown } from "../testing/export.ts";
import { ENGINE_VERSION, POLICY } from "../testing/orchestrator.ts";
import { effectivePolicy } from "../testing/runtime.ts";
import { previewOf } from "../testing/preview.ts";
import { loadEvents } from "../testing/store.ts";
import { TESTING_MODELS } from "../testing/worker.ts";
import { analysisOf, ensureUnderstanding } from "../understanding/run.ts";
import { redactDeep, redactJsonText, redactSecrets } from "../understanding/source.ts";

type RunRow = typeof testingRun.$inferSelect;
export const ACTIVE = ["queued", "running"] as const;
/** The run table holds every check's runs: Testing routes only ever see Testing runs. */
export const TESTING = eq(testingRun.check, "testing");
const emptyUsage: TestingUsage = { aiCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, sandboxOperations: 0, sandboxCpuSeconds: 0, models: {} };

export async function summaries(rows: RunRow[]): Promise<TestingRunSummary[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const counts = await db
    .select({
      runId: testObligation.runId,
      total: sql<number>`count(*)::int`,
      terminal: sql<number>`count(*) filter (where ${testObligation.status} not in ('planned', 'running'))::int`,
      failed: sql<number>`count(*) filter (where ${testObligation.status} = 'failed')::int`,
    })
    .from(testObligation)
    .where(inArray(testObligation.runId, ids))
    .groupBy(testObligation.runId);
  const defects = await db
    .select({ runId: testFinding.runId, n: sql<number>`count(*)::int` })
    .from(testFinding)
    .where(and(inArray(testFinding.runId, ids), sql`${testFinding.data}->>'kind' = 'product_defect'`, sql`${testFinding.data}->>'status' = 'confirmed'`))
    .groupBy(testFinding.runId);
  const last = await db
    .select({ runId: testRunEvent.runId, message: testRunEvent.message })
    .from(testRunEvent)
    .where(and(inArray(testRunEvent.runId, ids), sql`${testRunEvent.seq} = (select max(e2.seq) from test_run_event e2 where e2.run_id = ${testRunEvent.runId})`));
  return rows.map((r) => {
    const c = counts.find((x) => x.runId === r.id);
    const total = c?.total ?? 0;
    const terminal = c?.terminal ?? 0;
    const active = (ACTIVE as readonly string[]).includes(r.status);
    return {
      id: r.id,
      snapshotId: r.snapshotId,
      projectId: r.projectId,
      status: r.status,
      phase: r.phase as TestingRunSummary["phase"],
      step: active ? (r.status === "queued" ? "Waiting for a test worker" : (last.find((x) => x.runId === r.id)?.message ?? "Starting")) : null,
      progress: active && total ? Math.min(0.99, terminal / total) : active ? 0 : null,
      headline: (r.report as TestingReport | null)?.headline ?? (r.status === "blocked" || r.status === "failed" ? r.error : null),
      counts: { obligations: total, terminal, failed: c?.failed ?? 0, confirmedDefects: defects.find((x) => x.runId === r.id)?.n ?? 0 },
      error: r.error,
      createdAt: r.createdAt.toISOString(),
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
      purpose: (r.policy as { repair?: unknown } | null)?.repair ? "repair" : (r.policy as { rerun?: unknown } | null)?.rerun ? "rerun" : "check",
    };
  });
}

/** Everything about one run: summary, ledger, executions, findings, report and usage. */
async function runDetail(r: RunRow): Promise<TestingRunDetail> {
  const [obs, execs, finds] = await Promise.all([
    db.select().from(testObligation).where(eq(testObligation.runId, r.id)).orderBy(asc(testObligation.seq)),
    db.select().from(testExecution).where(eq(testExecution.runId, r.id)).orderBy(asc(testExecution.createdAt)),
    db.select().from(testFinding).where(eq(testFinding.runId, r.id)),
  ]);
  const [summary] = await summaries([r]);
  return {
    ...summary!,
    obligations: obs.map((o) => o.data as Obligation),
    executions: execs.map((e) => e.data as TestExecution),
    // Older runs stored "build" and "environment" findings; they are read as their v2 kinds.
    findings: finds.map((f) => ({ ...(f.data as TestFinding), kind: FindingKind.parse((f.data as TestFinding).kind) })).sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))),
    report: (r.report as TestingReport | null) ?? null,
    usage: (r.usage as TestingUsage | null) ?? emptyUsage,
    profile: policyOf(r).profile,
    parentRunId: policyOf(r).rerun?.parentRunId ?? null,
    projectSpendUsd: await projectSpend(r.projectId),
  };
}

const policyOf = (r: RunRow) => {
  const p = TestingPolicyInput.safeParse(r.policy ?? {});
  return p.success ? p.data : { profile: "standard" as const, thresholds: undefined, rerun: undefined };
};

/** All Testing AI spend for a project so far. */
async function projectSpend(projectId: string) {
  const [row] = await db.select({ usd: sql<number>`coalesce(sum((${testingRun.usage}->>'costUsd')::numeric), 0)::float` }).from(testingRun).where(and(TESTING, eq(testingRun.projectId, projectId)));
  return Math.round((row?.usd ?? 0) * 10000) / 10000;
}

/** A finished run of the same snapshot with the same engine and policy: a rerun would add no new evidence. */
async function identicalRun(snapshotId: string, profile: string, thresholds: unknown, options: Record<string, unknown> = {}) {
  const rows = await db.select().from(testingRun).where(and(TESTING, eq(testingRun.snapshotId, snapshotId), inArray(testingRun.status, ["completed", "partial"]))).orderBy(desc(testingRun.createdAt)).limit(10);
  return rows.find((r) => {
    const p = r.policy as { engine?: string; profile?: string; thresholds?: unknown; rerun?: unknown; options?: unknown };
    return p.engine === ENGINE_VERSION && (p.profile ?? "standard") === profile && JSON.stringify(p.thresholds ?? null) === JSON.stringify(thresholds ?? null) && JSON.stringify(p.options ?? {}) === JSON.stringify(options) && !p.rerun;
  }) ?? null;
}

/**
 * A targeted rerun of a finished run: decisive results are carried over and only `ids` (plus what they need) run
 * again, with the parent's profile and options. Idempotent per user and key; joins an active run instead of a second.
 */
export async function createRerun(userId: string, key: string, parent: RunRow, ids: string[], route: string) {
  const p = policyOf(parent);
  const pp = parent.policy as { options?: Record<string, unknown>; targetCompleteness?: number; budgetUsd?: number };
  const requestHash = createHash("sha256").update(`${parent.id}:${ids.join(",")}`).digest("hex");
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(idempotencyKey).where(and(eq(idempotencyKey.userId, userId), eq(idempotencyKey.route, route), eq(idempotencyKey.key, key))).for("update");
    if (existing) return existing.requestHash === requestHash ? ({ kind: "replay", runId: (existing.response as { runId: string }).runId } as const) : ({ kind: "conflict" } as const);
    const [active] = await tx.select().from(testingRun).where(and(TESTING, eq(testingRun.snapshotId, parent.snapshotId), inArray(testingRun.status, [...ACTIVE]))).limit(1);
    const runId = active?.id ?? randomUUID();
    if (!active) {
      await tx.insert(testingRun).values({
        id: runId,
        snapshotId: parent.snapshotId,
        projectId: parent.projectId,
        understandingRunId: parent.understandingRunId,
        requestedBy: userId,
        policy: { engine: ENGINE_VERSION, ...POLICY, profile: p.profile, ...(p.thresholds ? { thresholds: p.thresholds } : {}), ...(pp.options ?? {}), ...(pp.options ? { options: pp.options } : {}), ...(pp.targetCompleteness ? { targetCompleteness: pp.targetCompleteness } : {}), rerun: { parentRunId: parent.id, obligationIds: ids }, models: TESTING_MODELS(), budgetUsd: Math.min(env.TESTING_RUN_BUDGET_USD, pp.budgetUsd ?? env.TESTING_RUN_BUDGET_USD) },
      });
    }
    await tx.insert(idempotencyKey).values({ userId, route, key, requestHash, response: { runId } });
    return { kind: active ? "joined" : "created", runId } as const;
  });
}

export async function runForUser(userId: string, runId: string) {
  const [r] = await db.select().from(testingRun).where(and(TESTING, eq(testingRun.id, runId)));
  if (!r) return null;
  return (await snapshotForUser(userId, r.snapshotId)) ? r : null;
}

export async function testingRoutes(app: FastifyInstance) {
  /** Start a Testing run for a snapshot. Requires an Idempotency-Key; an active run is returned instead of a second one. */
  app.post<{ Params: { id: string } }>("/v1/snapshots/:id/checks/testing", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8 || key.length > 200) {
      return sendError(reply, 400, { code: "bad_request", message: "Missing Idempotency-Key header.", fix: "Retry from the app; it sends one automatically." });
    }
    const s = await snapshotForUser(session.user.id, request.params.id);
    if (!s) return sendError(reply, 404, notFound("snapshot"));
    const [latest] = await db.select().from(snapshot).where(eq(snapshot.projectId, s.projectId)).orderBy(desc(snapshot.createdAt)).limit(1);
    if (latest?.id !== s.id) return sendError(reply, 409, { code: "snapshot_not_latest", message: "Only the project's latest snapshot can be tested.", fix: "Open the project again and start the check from there." });
    const analysis = await analysisOf(s);
    if (analysis.stage !== "ready") {
      return sendError(reply, 409, { code: "project_not_ready", message: "This project is still being analysed.", fix: "Start the Testing check once the project shows Ready." });
    }
    if (!providers.sandbox) {
      return sendError(reply, 503, { code: "sandbox_not_configured", message: "Testing needs Nebius Sandboxes, which isn't configured on this server.", fix: "Set NEBIUS_API_KEY and NEBIUS_PROJECT_ID in .env and restart the worker." });
    }

    const body = StartTestingInput.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, 400, { code: "bad_request", message: "The testing options are not valid.", fix: "Choose a profile and thresholds again." });
    const profile = body.data.profile ?? "standard";
    const thresholds = body.data.thresholds && (body.data.thresholds.p95Ms || body.data.thresholds.errorRatePct != null) ? body.data.thresholds : undefined;
    // The user's run options (target, budget, time limit, lanes), only those actually chosen, in a stable order.
    const { profile: _p, thresholds: _t, force: _f, ...chosen } = body.data;
    const options = Object.fromEntries(Object.entries(chosen).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));
    const ep = effectivePolicy({ profile, ...options }, env.TESTING_RUN_BUDGET_USD);
    // An unchanged paid rerun adds no evidence: refuse it unless the user explicitly asks for it.
    const same = body.data.force ? null : await identicalRun(s.id, profile, thresholds, options);
    if (same) return reply.status(409).send({ code: "identical_run", message: "This exact code was already tested with the same engine and settings.", fix: "Open that run and rerun only the missing checks, or run everything again anyway.", runId: same.id });
    const route = "checks/testing";
    const requestHash = createHash("sha256").update(`${s.id}:${ENGINE_VERSION}:${profile}:${JSON.stringify(thresholds ?? null)}:${JSON.stringify(options)}`).digest("hex");
    const ur = await ensureUnderstanding(s.id);
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(idempotencyKey).where(and(eq(idempotencyKey.userId, session.user.id), eq(idempotencyKey.route, route), eq(idempotencyKey.key, key))).for("update");
      if (existing) return existing.requestHash === requestHash ? ({ kind: "replay", runId: (existing.response as { runId: string }).runId } as const) : ({ kind: "conflict" } as const);
      // One active run per snapshot: a second click joins the running one.
      const [active] = await tx.select().from(testingRun).where(and(TESTING, eq(testingRun.snapshotId, s.id), inArray(testingRun.status, [...ACTIVE]))).limit(1);
      const runId = active?.id ?? randomUUID();
      if (!active) {
        await tx.insert(testingRun).values({
          id: runId,
          snapshotId: s.id,
          projectId: s.projectId,
          understandingRunId: ur.id,
          requestedBy: session.user.id,
          policy: { engine: ENGINE_VERSION, ...POLICY, profile, ...(thresholds ? { thresholds } : {}), ...options, options, targetCompleteness: ep.targetCompleteness, models: TESTING_MODELS(), budgetUsd: ep.budgetUsd },
        });
      }
      await tx.insert(idempotencyKey).values({ userId: session.user.id, route, key, requestHash, response: { runId } });
      return { kind: active ? "joined" : "created", runId } as const;
    });
    if (result.kind === "conflict") return sendError(reply, 422, { code: "idempotency_key_reused", message: "This request ID was already used for a different check.", fix: "Start the check again from the app." });
    const [row] = await db.select().from(testingRun).where(eq(testingRun.id, result.runId));
    return reply.status(result.kind === "created" ? 201 : 200).send({ run: (await summaries([row!]))[0] });
  });

  /** What a run would do and roughly cost, before anything is paid for (rules only: no AI, no sandbox). */
  app.post<{ Params: { id: string } }>("/v1/snapshots/:id/checks/testing/preview", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const s = await snapshotForUser(session.user.id, request.params.id);
    if (!s) return sendError(reply, 404, notFound("snapshot"));
    const body = StartTestingInput.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, 400, { code: "bad_request", message: "The testing options are not valid.", fix: "Choose a profile again." });
    const analysis = await analysisOf(s);
    if (analysis.stage !== "ready" || !s.archiveObjectKey || !s.contentDigest) return sendError(reply, 409, { code: "project_not_ready", message: "This project is still being analysed.", fix: "Preview the check once the project shows Ready." });
    const ur = await ensureUnderstanding(s.id);
    const profile = body.data.profile ?? "standard";
    const { profile: _p, thresholds: _t, force: _f, ...chosen } = body.data;
    const options = Object.fromEntries(Object.entries(chosen).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));
    const same = await identicalRun(s.id, profile, body.data.thresholds && (body.data.thresholds.p95Ms || body.data.thresholds.errorRatePct != null) ? body.data.thresholds : undefined, options);
    const preview: TestingPreview = await previewOf({ snapshotId: s.id, projectId: s.projectId, archiveKey: s.archiveObjectKey, digest: s.contentDigest, d: ur.dossier as never, objects: objectStore, profile, options, identical: same ? { id: same.id, finishedAt: same.finishedAt } : null });
    return { preview };
  });

  /** A targeted rerun: only the checks without a decisive verdict (or the ones listed); everything else is carried over. */
  app.post<{ Params: { runId: string } }>("/v1/testing-runs/:runId/rerun", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8 || key.length > 200) return sendError(reply, 400, { code: "bad_request", message: "Missing Idempotency-Key header.", fix: "Retry from the app; it sends one automatically." });
    const parent = await runForUser(session.user.id, request.params.runId);
    if (!parent) return sendError(reply, 404, notFound("testing run"));
    if ((ACTIVE as readonly string[]).includes(parent.status)) return sendError(reply, 409, { code: "run_not_finished", message: "This run is still in progress.", fix: "Rerun once it finishes." });
    const body = RerunTestingInput.safeParse(request.body ?? {});
    if (!body.success) return sendError(reply, 400, { code: "bad_request", message: "Say which checks to run again.", fix: "Use the rerun button on the report." });
    const [latest] = await db.select().from(snapshot).where(eq(snapshot.projectId, parent.projectId)).orderBy(desc(snapshot.createdAt)).limit(1);
    if (latest?.id !== parent.snapshotId) return sendError(reply, 409, { code: "snapshot_not_latest", message: "The code has changed since this run, so its results cannot be reused.", fix: "Start a new run for the latest snapshot." });
    const parentObs = await db.select().from(testObligation).where(eq(testObligation.runId, parent.id));
    const valid = new Set(parentObs.map((o) => o.id));
    // Missing evidence: anything without a pass or fail verdict that a rerun can change (not unsupported, not "not applicable").
    const ids = body.data.scope === "missing" ? parentObs.filter((o) => ["inconclusive", "blocked", "skipped"].includes(o.status)).map((o) => o.id) : body.data.scope.filter((id) => valid.has(id));
    if (!ids.length) return sendError(reply, 409, { code: "nothing_to_rerun", message: "Every check in this run already has a verdict or cannot be tested here.", fix: "Fix the reported problems and test the new snapshot." });
    if (!providers.sandbox) return sendError(reply, 503, { code: "sandbox_not_configured", message: "Testing needs Nebius Sandboxes, which isn't configured on this server.", fix: "Set NEBIUS_API_KEY and NEBIUS_PROJECT_ID in .env and restart the worker." });
    const result = await createRerun(session.user.id, key, parent, ids, "checks/testing/rerun");
    if (result.kind === "conflict") return sendError(reply, 422, { code: "idempotency_key_reused", message: "This request ID was already used for a different rerun.", fix: "Start the rerun again from the app." });
    const [row] = await db.select().from(testingRun).where(eq(testingRun.id, result.runId));
    return reply.status(result.kind === "created" ? 201 : 200).send({ run: (await summaries([row!]))[0], obligations: ids.length });
  });

  /** Every project of a workspace with its latest check: tested, testing now, or not tested yet. */
  app.get<{ Params: { wid: string } }>("/v1/workspaces/:wid/testing-status", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    if (!(await isMember(session.user.id, request.params.wid))) return sendError(reply, 404, notFound("workspace"));
    const projects = await db.select({ id: project.id }).from(project).where(eq(project.workspaceId, request.params.wid));
    if (!projects.length) return { projects: [] as TestingProjectStatus[] };
    const rows = await db.select().from(testingRun).where(and(TESTING, inArray(testingRun.projectId, projects.map((p) => p.id)))).orderBy(desc(testingRun.createdAt)).limit(400);
    const isCheck = (x: RunRow) => !(x.policy as { rerun?: unknown; repair?: unknown } | null)?.rerun && !(x.policy as { repair?: unknown } | null)?.repair;
    const recent = new Map<string, RunRow[]>();
    for (const x of rows.filter(isCheck)) {
      const list = recent.get(x.projectId) ?? [];
      if (list.length < 8) recent.set(x.projectId, [...list, x]);
    }
    const sums = new Map((await summaries([...recent.values()].flat())).map((s) => [s.id, s]));
    const out: TestingProjectStatus[] = projects.map((p) => {
      const list = recent.get(p.id) ?? [];
      const latest = list[0];
      return {
        projectId: p.id,
        latest: latest ? (sums.get(latest.id) ?? null) : null,
        decision: (latest?.report as TestingReport | null)?.release?.decision ?? null,
        active: rows.some((x) => x.projectId === p.id && (ACTIVE as readonly string[]).includes(x.status)),
        history: list
          .filter((x) => x.report)
          .reverse()
          .map((x) => ({ runId: x.id, createdAt: x.createdAt.toISOString(), problems: sums.get(x.id)?.counts.confirmedDefects ?? 0 })),
      };
    });
    return { projects: out };
  });

  app.get<{ Params: { id: string } }>("/v1/projects/:id/testing-runs", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const p = await projectForUser(session.user.id, request.params.id);
    if (!p) return sendError(reply, 404, notFound("project"));
    const rows = await db.select().from(testingRun).where(and(TESTING, eq(testingRun.projectId, p.id))).orderBy(desc(testingRun.createdAt)).limit(20);
    return { runs: await summaries(rows) };
  });

  app.get<{ Params: { runId: string } }>("/v1/testing-runs/:runId", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const r = await runForUser(session.user.id, request.params.runId);
    if (!r) return sendError(reply, 404, notFound("testing run"));
    return { run: await runDetail(r) };
  });

  /** The run as a downloadable report: Markdown (to read or share) or JSON (the full ledger). */
  app.get<{ Params: { runId: string }; Querystring: { format?: string } }>("/v1/testing-runs/:runId/export", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const r = await runForUser(session.user.id, request.params.runId);
    if (!r) return sendError(reply, 404, notFound("testing run"));
    if ((ACTIVE as readonly string[]).includes(r.status)) {
      return sendError(reply, 409, { code: "run_not_finished", message: "This run is still in progress.", fix: "Download the report once it finishes." });
    }
    const run = await runDetail(r);
    const [p] = await db.select({ name: project.name }).from(project).where(eq(project.id, r.projectId));
    const base = `${(p?.name ?? "project").replace(/[^\w.-]+/g, "-").slice(0, 60)}-testing-${r.createdAt.toISOString().slice(0, 10)}`;
    if (request.query.format === "json") {
      reply.header("content-type", "application/json; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="${base}.json"`);
      // Secrets never reach the ledger (only setting names), but outputs are redacted once more on the way out.
      return JSON.stringify(redactDeep(run), null, 2);
    }
    reply.header("content-type", "text/markdown; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="${base}.md"`);
    return redactSecrets(testingRunToMarkdown(run, p?.name ?? "Project")).text;
  });

  app.get<{ Params: { runId: string }; Querystring: { after?: string } }>("/v1/testing-runs/:runId/events", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const r = await runForUser(session.user.id, request.params.runId);
    if (!r) return sendError(reply, 404, notFound("testing run"));
    return { events: await loadEvents(r.id, Number(request.query.after) || 0) };
  });

  app.post<{ Params: { runId: string } }>("/v1/testing-runs/:runId/cancel", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const r = await runForUser(session.user.id, request.params.runId);
    if (!r) return sendError(reply, 404, notFound("testing run"));
    if (!(ACTIVE as readonly string[]).includes(r.status)) return sendError(reply, 409, { code: "not_running", message: "This run has already finished.", fix: "Start a new run if you want fresh results." });
    // A queued run is cancelled at once; a running one stops at the worker's next heartbeat.
    await db.update(testingRun).set({ cancelRequested: true }).where(eq(testingRun.id, r.id));
    await db.update(testingRun).set({ status: "cancelled", phase: "done", finishedAt: new Date() }).where(and(eq(testingRun.id, r.id), eq(testingRun.status, "queued")));
    const [row] = await db.select().from(testingRun).where(eq(testingRun.id, r.id));
    return reply.status(202).send({ run: (await summaries([row!]))[0] });
  });

  /** Full output of one execution (owner only, secrets redacted again on the way out). */
  app.get<{ Params: { runId: string; execId: string; name: string } }>("/v1/testing-runs/:runId/executions/:execId/artifacts/:name", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const r = await runForUser(session.user.id, request.params.runId);
    if (!r) return sendError(reply, 404, notFound("testing run"));
    const [e] = await db.select().from(testExecution).where(and(eq(testExecution.id, request.params.execId), eq(testExecution.runId, r.id)));
    const art = (e?.data as TestExecution | undefined)?.artifacts.find((a) => a.name === request.params.name);
    if (!art) return sendError(reply, 404, notFound("artifact"));
    const chunks: Buffer[] = [];
    for await (const c of objectStore.get(art.key)) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    // Images and archives are sent as bytes (screenshots for the live view, traces); text is redacted as before.
    const binary: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", zip: "application/zip" };
    const ext = art.name.split(".").pop()?.toLowerCase() ?? "";
    if (binary[ext]) {
      reply.header("content-type", binary[ext]).header("cache-control", "private, max-age=3600").header("x-content-type-options", "nosniff");
      return reply.send(body);
    }
    if (ext === "html") {
      // k6's own report holds scripts: always a file to save, and sandboxed should a browser open it anyway.
      reply.header("content-type", "text/html; charset=utf-8").header("content-disposition", `attachment; filename="${art.name}"`).header("content-security-policy", "sandbox").header("x-content-type-options", "nosniff");
      return redactSecrets(body.toString("utf8")).text;
    }
    reply.header("content-type", "text/plain; charset=utf-8");
    if (ext === "json") return redactJsonText(body.toString("utf8"));
    return /\.(txt|log|xml)$/.test(art.name) ? redactSecrets(body.toString("utf8")).text : body.toString("utf8");
  });
}
