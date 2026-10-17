import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, max, sql } from "drizzle-orm";
import {
  AiEvaluationPolicyInput,
  AiDatasetUploadInput,
  RerunAiEvaluationInput,
  type AiDatasetSummary,
  type AiEvaluationCase,
  type AiEvaluationFinding,
  type AiEvaluationProjectStatus,
  type AiEvaluationReport,
  type AiEvaluationRunDetail,
  type AiEvaluationRunSummary,
  type TestExecution,
  type TestingUsage,
} from "@cybercheck/contracts";
import { isMember, notFound, projectForUser, requireSession, sendError, snapshotForUser } from "../access.ts";
import { db } from "../db/client.ts";
import { aiEvaluationCase, aiEvaluationDataset, idempotencyKey, project, snapshot, testExecution, testFinding, testingRun, testRunEvent } from "../db/schema.ts";
import { aiRunToMarkdown } from "../ai-evaluator/export.ts";
import { validateDataset } from "../ai-evaluator/datasets.ts";
import { redactAiRun } from "../ai-evaluator/redact.ts";
import { AI_EVALUATOR_ENGINE } from "../ai-evaluator/version.ts";
import { selectSecurityRuntime } from "../security/runtime.ts";
import { objectStore } from "../storage/object-store.ts";
import { sandboxProvider } from "../testing/worker.ts";
import { loadEvents } from "../testing/store.ts";
import { analysisOf, ensureUnderstanding } from "../understanding/run.ts";
import { redactSecrets } from "../understanding/source.ts";
import { ACTIVE } from "./testing.ts";

// The AI Evaluator check's API. Runs live in the shared check-run table with check = "ai-evaluator"; these routes only
// ever see AI Evaluator runs. Datasets are per project, immutable and versioned.

type RunRow = typeof testingRun.$inferSelect;
const AI = eq(testingRun.check, "ai-evaluator");
const emptyUsage: TestingUsage = { aiCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, sandboxOperations: 0, sandboxCpuSeconds: 0, models: {} };
const DECISIVE = ["passed", "failed"];

type StoredPolicy = AiEvaluationPolicyInput & { rerun?: { parentRunId: string; caseIds: string[] } };

export async function aiSummaries(rows: RunRow[]): Promise<AiEvaluationRunSummary[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const counts = await db
    .select({
      runId: aiEvaluationCase.runId,
      total: sql<number>`count(*)::int`,
      passed: sql<number>`count(*) filter (where ${aiEvaluationCase.verdict} = 'passed')::int`,
      failed: sql<number>`count(*) filter (where ${aiEvaluationCase.verdict} = 'failed')::int`,
    })
    .from(aiEvaluationCase)
    .where(inArray(aiEvaluationCase.runId, ids))
    .groupBy(aiEvaluationCase.runId);
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
    const report = r.report as AiEvaluationReport | null;
    const policy = (r.policy ?? {}) as StoredPolicy;
    const decided = (c?.passed ?? 0) + (c?.failed ?? 0);
    return {
      id: r.id,
      snapshotId: r.snapshotId,
      projectId: r.projectId,
      status: r.status,
      phase: r.phase as AiEvaluationRunSummary["phase"],
      step: active ? (r.status === "queued" ? "Waiting for a worker" : (last.find((x) => x.runId === r.id)?.message ?? "Starting")) : null,
      progress: active && c?.total ? Math.min(0.99, decided / c.total) : active ? 0 : null,
      headline: report?.headline ?? (r.status === "blocked" || r.status === "failed" ? r.error : null),
      decision: report?.decision ?? null,
      mode: report?.mode.used ?? null,
      profile: policy.profile ?? "standard",
      counts: { cases: c?.total ?? 0, decisive: decided, passed: c?.passed ?? 0, failed: c?.failed ?? 0, confirmed: f?.confirmed ?? 0, suspected: f?.suspected ?? 0 },
      parentRunId: policy.rerun?.parentRunId ?? null,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
    };
  });
}

export async function aiDetail(r: RunRow): Promise<AiEvaluationRunDetail> {
  const [cases, execs, finds] = await Promise.all([
    db.select().from(aiEvaluationCase).where(eq(aiEvaluationCase.runId, r.id)).orderBy(asc(aiEvaluationCase.seq)),
    db.select().from(testExecution).where(eq(testExecution.runId, r.id)).orderBy(asc(testExecution.createdAt)),
    db.select().from(testFinding).where(eq(testFinding.runId, r.id)),
  ]);
  const [summary] = await aiSummaries([r]);
  const { rerun: _rerun, ...policy } = (r.policy ?? {}) as StoredPolicy;
  return {
    ...summary!,
    policy: AiEvaluationPolicyInput.parse(policy),
    cases: cases.map((c) => c.data as AiEvaluationCase),
    findings: finds.map((f) => f.data as AiEvaluationFinding).sort((a, b) => Number(a.id.replace(/\D/g, "")) - Number(b.id.replace(/\D/g, ""))),
    executions: execs.map((e) => e.data as TestExecution),
    report: (r.report as AiEvaluationReport | null) ?? null,
    usage: (r.usage as TestingUsage | null) ?? emptyUsage,
  };
}

export async function aiRunForUser(userId: string, runId: string) {
  const [r] = await db.select().from(testingRun).where(and(AI, eq(testingRun.id, runId)));
  if (!r) return null;
  return (await snapshotForUser(userId, r.snapshotId)) ? r : null;
}

const datasetSummary = (d: typeof aiEvaluationDataset.$inferSelect): AiDatasetSummary => ({ id: d.id, projectId: d.projectId, name: d.name, version: d.version, digest: d.digest, schemaVersion: d.schemaVersion, caseCount: d.caseCount, byCategory: d.byCategory as Record<string, number>, createdBy: d.createdBy, createdAt: d.createdAt.toISOString() });

const idemKey = (h: unknown) => (typeof h === "string" && h.length >= 8 && h.length <= 200 ? h : null);
const missingKey = { code: "bad_request", message: "Missing Idempotency-Key header.", fix: "Retry from the app; it sends one automatically." };

export async function aiEvaluatorRoutes(app: FastifyInstance) {
  /** Which runtime an AI Evaluator run would use right now. Applicability alone never needs one. */
  app.get("/v1/ai-evaluation/runtime-status", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const sel = await selectSecurityRuntime("auto", sandboxProvider());
    return { selected: sel.selected, fallbackReason: sel.fallbackReason, health: sel.health, liveGateway: sel.selected === "local" ? "available" : "unavailable", networkIsolation: "The app runs with the network off; model traffic only reaches cybercheck's replay server or, in live mode, its gateway." };
  });

  /** Upload a dataset version. Every case is validated; one invalid case rejects the upload and nothing is stored. */
  app.post<{ Params: { projectId: string } }>("/v1/projects/:projectId/ai-evaluation-datasets", { bodyLimit: 6 * 1024 * 1024 }, async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const p = await projectForUser(session.user.id, request.params.projectId);
    if (!p) return sendError(reply, 404, notFound("project"));
    const parsed = AiDatasetUploadInput.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, { code: "bad_request", message: "Send a dataset name and its JSONL content.", fix: "Names use letters, digits, spaces, dots, dashes and underscores." });
    const v = validateDataset(parsed.data.content);
    if (!v.ok) return reply.status(422).send({ code: "dataset_invalid", message: `The dataset was not accepted: ${v.issues.length} problem(s).`, fix: "Fix the listed lines and upload again; nothing was stored.", issues: v.issues.slice(0, 200) });
    const id = randomUUID();
    const key = `ai-datasets/${p.id}/${id}.jsonl`;
    await objectStore.put(key, Readable.from([v.normalized]));
    const row = await db.transaction(async (tx) => {
      const [m] = await tx.select({ v: max(aiEvaluationDataset.version) }).from(aiEvaluationDataset).where(and(eq(aiEvaluationDataset.projectId, p.id), eq(aiEvaluationDataset.name, parsed.data.name)));
      const [r] = await tx
        .insert(aiEvaluationDataset)
        .values({ id, workspaceId: p.workspaceId, projectId: p.id, name: parsed.data.name, version: (m?.v ?? 0) + 1, digest: v.digest, artifactKey: key, schemaVersion: 1, caseCount: v.cases.length, byCategory: v.byCategory, validation: { accepted: v.cases.length, issues: [] }, createdBy: session.user.id })
        .returning();
      return r!;
    });
    return reply.status(201).send({ dataset: datasetSummary(row) });
  });

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/ai-evaluation-datasets", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const p = await projectForUser(session.user.id, request.params.projectId);
    if (!p) return sendError(reply, 404, notFound("project"));
    const rows = await db.select().from(aiEvaluationDataset).where(eq(aiEvaluationDataset.projectId, p.id)).orderBy(desc(aiEvaluationDataset.createdAt));
    return { datasets: rows.map(datasetSummary) };
  });

  /** Start an AI Evaluator run. Requires an Idempotency-Key; an active run of the same snapshot is joined instead. */
  app.post<{ Params: { id: string } }>("/v1/snapshots/:id/checks/ai-evaluator", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const key = idemKey(request.headers["idempotency-key"]);
    if (!key) return sendError(reply, 400, missingKey);
    const s = await snapshotForUser(session.user.id, request.params.id);
    if (!s) return sendError(reply, 404, notFound("snapshot"));
    const [latest] = await db.select().from(snapshot).where(eq(snapshot.projectId, s.projectId)).orderBy(desc(snapshot.createdAt)).limit(1);
    if (latest?.id !== s.id) return sendError(reply, 409, { code: "snapshot_not_latest", message: "Only the project's latest snapshot can be checked.", fix: "Open the project again and start the check from there." });
    if ((await analysisOf(s)).stage !== "ready") return sendError(reply, 409, { code: "project_not_ready", message: "This project is still being analysed.", fix: "Start the AI Evaluator once the project shows Ready." });
    const parsed = AiEvaluationPolicyInput.omit({ engine: true }).safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, { code: "bad_request", message: `The AI Evaluator options are not valid: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`, fix: "Start the check again from the app." });
    // Datasets must belong to this project; their digests are part of the request identity.
    const datasets = parsed.data.datasetIds.length ? await db.select().from(aiEvaluationDataset).where(and(eq(aiEvaluationDataset.projectId, s.projectId), inArray(aiEvaluationDataset.id, parsed.data.datasetIds))) : [];
    if (datasets.length !== new Set(parsed.data.datasetIds).size) return sendError(reply, 404, notFound("dataset"));
    const policy = { ...parsed.data, engine: AI_EVALUATOR_ENGINE };
    const route = "checks/ai-evaluator";
    const requestHash = createHash("sha256").update(JSON.stringify({ snapshot: s.id, content: s.contentDigest, policy, datasets: datasets.map((d) => d.digest).sort() })).digest("hex");
    const ur = await ensureUnderstanding(s.id);
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(idempotencyKey).where(and(eq(idempotencyKey.userId, session.user.id), eq(idempotencyKey.route, route), eq(idempotencyKey.key, key))).for("update");
      if (existing) return existing.requestHash === requestHash ? ({ kind: "replay", runId: (existing.response as { runId: string }).runId } as const) : ({ kind: "conflict" } as const);
      const [active] = await tx.select().from(testingRun).where(and(AI, eq(testingRun.snapshotId, s.id), inArray(testingRun.status, [...ACTIVE]))).limit(1);
      const runId = active?.id ?? randomUUID();
      if (!active) await tx.insert(testingRun).values({ id: runId, check: "ai-evaluator", snapshotId: s.id, projectId: s.projectId, understandingRunId: ur.id, requestedBy: session.user.id, policy });
      await tx.insert(idempotencyKey).values({ userId: session.user.id, route, key, requestHash, response: { runId } });
      return { kind: active ? "joined" : "created", runId } as const;
    });
    if (result.kind === "conflict") return sendError(reply, 422, { code: "idempotency_key_reused", message: "This request ID was already used for a different check.", fix: "Start the check again from the app." });
    const [row] = await db.select().from(testingRun).where(eq(testingRun.id, result.runId));
    return reply.status(result.kind === "created" ? 201 : 200).send({ run: (await aiSummaries([row!]))[0] });
  });

  app.get<{ Params: { wid: string } }>("/v1/workspaces/:wid/ai-evaluation-status", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    if (!(await isMember(session.user.id, request.params.wid))) return sendError(reply, 404, notFound("workspace"));
    const projects = await db.select({ id: project.id }).from(project).where(eq(project.workspaceId, request.params.wid));
    if (!projects.length) return { projects: [] as AiEvaluationProjectStatus[] };
    const rows = await db.select().from(testingRun).where(and(AI, inArray(testingRun.projectId, projects.map((p) => p.id)))).orderBy(desc(testingRun.createdAt)).limit(400);
    const latest = projects.map((p) => rows.find((r) => r.projectId === p.id)).filter((r): r is RunRow => Boolean(r));
    const sums = new Map((await aiSummaries(latest)).map((s) => [s.projectId, s]));
    return { projects: projects.map((p) => ({ projectId: p.id, latest: sums.get(p.id) ?? null, active: rows.some((r) => r.projectId === p.id && (ACTIVE as readonly string[]).includes(r.status)) })) satisfies AiEvaluationProjectStatus[] };
  });

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/ai-evaluation-runs", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const p = await projectForUser(session.user.id, request.params.projectId);
    if (!p) return sendError(reply, 404, notFound("project"));
    const rows = await db.select().from(testingRun).where(and(AI, eq(testingRun.projectId, p.id))).orderBy(desc(testingRun.createdAt)).limit(20);
    return { runs: await aiSummaries(rows) };
  });

  app.get<{ Params: { runId: string } }>("/v1/ai-evaluation-runs/:runId", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const r = await aiRunForUser(session.user.id, request.params.runId);
    if (!r) return sendError(reply, 404, notFound("AI evaluation run"));
    return { run: await aiDetail(r) };
  });

  app.get<{ Params: { runId: string }; Querystring: { after?: string } }>("/v1/ai-evaluation-runs/:runId/events", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const r = await aiRunForUser(session.user.id, request.params.runId);
    if (!r) return sendError(reply, 404, notFound("AI evaluation run"));
    return { events: await loadEvents(r.id, Number(request.query.after) || 0) };
  });

  app.post<{ Params: { runId: string } }>("/v1/ai-evaluation-runs/:runId/cancel", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const r = await aiRunForUser(session.user.id, request.params.runId);
    if (!r) return sendError(reply, 404, notFound("AI evaluation run"));
    if (!(ACTIVE as readonly string[]).includes(r.status)) return sendError(reply, 409, { code: "not_running", message: "This run has already finished.", fix: "Start a new run if you want fresh results." });
    // A queued run is cancelled at once; a running one stops before its next case or model call.
    await db.update(testingRun).set({ cancelRequested: true }).where(eq(testingRun.id, r.id));
    await db.update(testingRun).set({ status: "cancelled", phase: "done", finishedAt: new Date() }).where(and(eq(testingRun.id, r.id), eq(testingRun.status, "queued")));
    const [row] = await db.select().from(testingRun).where(eq(testingRun.id, r.id));
    return reply.status(202).send({ run: (await aiSummaries([row!]))[0] });
  });

  /** Re-run the undecided cases ("missing") or chosen ones as a new run linked to this one. Nothing is copied: every
   * verdict of the new run comes from new evidence. The original run is never changed. */
  app.post<{ Params: { runId: string } }>("/v1/ai-evaluation-runs/:runId/rerun", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const key = idemKey(request.headers["idempotency-key"]);
    if (!key) return sendError(reply, 400, missingKey);
    const parent = await aiRunForUser(session.user.id, request.params.runId);
    if (!parent) return sendError(reply, 404, notFound("AI evaluation run"));
    if ((ACTIVE as readonly string[]).includes(parent.status)) return sendError(reply, 409, { code: "run_not_finished", message: "This run is still in progress.", fix: "Rerun once it finishes." });
    const parsed = RerunAiEvaluationInput.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, { code: "bad_request", message: "Say which cases to re-run.", fix: "Choose 'missing', or a set of case ids." });
    const cases = (await db.select().from(aiEvaluationCase).where(eq(aiEvaluationCase.runId, parent.id)).orderBy(asc(aiEvaluationCase.seq))).map((c) => c.data as AiEvaluationCase);
    const ids = parsed.data.scope === "missing" ? cases.filter((c) => !DECISIVE.includes(c.verdict)).map((c) => c.id) : (parsed.data.caseIds ?? []).filter((id) => cases.some((c) => c.id === id));
    if (!ids.length) return sendError(reply, 409, { code: "nothing_to_rerun", message: parsed.data.scope === "missing" ? "Every case in that run already has a decisive result." : "None of those cases belong to this run.", fix: "Choose cases from this report, or run the whole check again." });
    const [latest] = await db.select().from(snapshot).where(eq(snapshot.projectId, parent.projectId)).orderBy(desc(snapshot.createdAt)).limit(1);
    if (latest?.id !== parent.snapshotId) return sendError(reply, 409, { code: "snapshot_not_latest", message: "The project has a newer snapshot; this run's cases belong to the old one.", fix: "Run the AI Evaluator on the latest snapshot instead." });
    const policy: StoredPolicy = { ...((parent.policy ?? {}) as StoredPolicy), engine: AI_EVALUATOR_ENGINE, rerun: { parentRunId: parent.id, caseIds: ids } };
    const route = "checks/ai-evaluator/rerun";
    const requestHash = createHash("sha256").update(`${parent.id}:${ids.slice().sort().join(",")}`).digest("hex");
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(idempotencyKey).where(and(eq(idempotencyKey.userId, session.user.id), eq(idempotencyKey.route, route), eq(idempotencyKey.key, key))).for("update");
      if (existing) return existing.requestHash === requestHash ? ({ kind: "replay", runId: (existing.response as { runId: string }).runId } as const) : ({ kind: "conflict" } as const);
      const runId = randomUUID();
      await tx.insert(testingRun).values({ id: runId, check: "ai-evaluator", snapshotId: parent.snapshotId, projectId: parent.projectId, understandingRunId: parent.understandingRunId, requestedBy: session.user.id, policy });
      await tx.insert(idempotencyKey).values({ userId: session.user.id, route, key, requestHash, response: { runId } });
      return { kind: "created", runId } as const;
    });
    if (result.kind === "conflict") return sendError(reply, 422, { code: "idempotency_key_reused", message: "This request ID was already used for a different rerun.", fix: "Start the rerun again from the app." });
    const [row] = await db.select().from(testingRun).where(eq(testingRun.id, result.runId));
    return reply.status(result.kind === "created" ? 201 : 200).send({ run: (await aiSummaries([row!]))[0] });
  });

  /** The run as a download: Markdown, or JSON (structured cases, metrics, findings, datasets, audit), redacted. */
  app.get<{ Params: { runId: string }; Querystring: { format?: string } }>("/v1/ai-evaluation-runs/:runId/export", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const r = await aiRunForUser(session.user.id, request.params.runId);
    if (!r) return sendError(reply, 404, notFound("AI evaluation run"));
    if ((ACTIVE as readonly string[]).includes(r.status)) return sendError(reply, 409, { code: "run_not_finished", message: "This run is still in progress.", fix: "Download the report once it finishes." });
    const run = redactAiRun(await aiDetail(r));
    const [p] = await db.select({ name: project.name }).from(project).where(eq(project.id, r.projectId));
    const base = `${(p?.name ?? "project").replace(/[^\w.-]+/g, "-").slice(0, 60)}-ai-evaluator-${r.createdAt.toISOString().slice(0, 10)}`;
    if (request.query.format === "json") {
      reply.header("content-type", "application/json; charset=utf-8").header("content-disposition", `attachment; filename="${base}.json"`);
      return JSON.stringify(run, null, 2);
    }
    reply.header("content-type", "text/markdown; charset=utf-8").header("content-disposition", `attachment; filename="${base}.md"`);
    return redactSecrets(aiRunToMarkdown(run, p?.name ?? "Project")).text;
  });
}
