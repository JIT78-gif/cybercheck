import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  AdversarialPolicyInput,
  RerunAdversarialInput,
  type AdversarialCampaign,
  type AttackChain,
  type AdversarialFinding,
  type AdversarialProjectStatus,
  type AdversarialReport,
  type AdversarialRunDetail,
  type AdversarialRunSummary,
  type TestExecution,
  type TestingUsage,
} from "@cybercheck/contracts";
import { isMember, notFound, projectForUser, requireSession, sendError, snapshotForUser } from "../access.ts";
import { db } from "../db/client.ts";
import { adversarialAttackPack, adversarialCampaign, adversarialChain, idempotencyKey, project, snapshot, testExecution, testFinding, testingRun, testRunEvent } from "../db/schema.ts";
import { adversarialRunToMarkdown } from "../adversarial/export.ts";
import { AD_CATALOGUE_VERSION, AD_COMPILER_VERSION, AD_ENGINE_VERSION } from "../adversarial/version.ts";
import { loadEvents } from "../testing/store.ts";
import { analysisOf, ensureUnderstanding } from "../understanding/run.ts";
import { redactSecrets } from "../understanding/source.ts";
import { ACTIVE } from "./testing.ts";

// The AI Adversarial check's API. Runs live in the shared check-run table with check = "adversarial"; these routes only
// ever see adversarial runs. Campaigns, steps and chains live in their own tables; findings and executions are shared.

type RunRow = typeof testingRun.$inferSelect;
const ADV = eq(testingRun.check, "adversarial");
const emptyUsage: TestingUsage = { aiCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, sandboxOperations: 0, sandboxCpuSeconds: 0, models: {} };

type StoredPolicy = AdversarialPolicyInput & { engine: string; catalogue: string; compiler: string; rerun?: { parentRunId: string; campaignIds: string[] } };
const idemKey = (h: unknown) => (typeof h === "string" && h.length >= 8 && h.length <= 200 ? h : null);
const missingKey = { code: "bad_request", message: "Missing Idempotency-Key header.", fix: "Retry from the app; it sends one automatically." };

export async function adversarialSummaries(rows: RunRow[]): Promise<AdversarialRunSummary[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const campaigns = await db
    .select({
      runId: adversarialCampaign.runId,
      total: sql<number>`count(*)::int`,
      passed: sql<number>`count(*) filter (where ${adversarialCampaign.status} = 'passed')::int`,
      failed: sql<number>`count(*) filter (where ${adversarialCampaign.status} = 'failed')::int`,
      blocked: sql<number>`count(*) filter (where ${adversarialCampaign.status} = 'blocked')::int`,
    })
    .from(adversarialCampaign)
    .where(inArray(adversarialCampaign.runId, ids))
    .groupBy(adversarialCampaign.runId);
  const chains = await db.select({ runId: adversarialChain.runId, total: sql<number>`count(*)::int` }).from(adversarialChain).where(inArray(adversarialChain.runId, ids)).groupBy(adversarialChain.runId);
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
    const c = campaigns.find((x) => x.runId === r.id);
    const f = findings.find((x) => x.runId === r.id);
    const active = (ACTIVE as readonly string[]).includes(r.status);
    const report = r.report as AdversarialReport | null;
    const policy = (r.policy ?? {}) as StoredPolicy;
    const decided = (c?.passed ?? 0) + (c?.failed ?? 0);
    return {
      id: r.id,
      snapshotId: r.snapshotId,
      projectId: r.projectId,
      status: r.status,
      phase: r.phase as AdversarialRunSummary["phase"],
      step: active ? (r.status === "queued" ? "Waiting for a worker" : (last.find((x) => x.runId === r.id)?.message ?? "Starting")) : null,
      progress: active && c?.total ? Math.min(0.99, decided / c.total) : active ? 0 : null,
      headline: report?.headline ?? (r.status === "blocked" || r.status === "failed" ? r.error : null),
      decision: report?.decision ?? null,
      profile: policy.profile ?? "standard",
      counts: { campaigns: c?.total ?? 0, decisive: decided, chains: chains.find((x) => x.runId === r.id)?.total ?? 0, confirmed: f?.confirmed ?? 0, suspected: f?.suspected ?? 0, blocked: c?.blocked ?? 0 },
      parentRunId: policy.rerun?.parentRunId ?? null,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
      startedAt: r.startedAt?.toISOString() ?? null,
      finishedAt: r.finishedAt?.toISOString() ?? null,
    };
  });
}

export async function adversarialDetail(r: RunRow): Promise<AdversarialRunDetail> {
  const [campaigns, chains, execs, finds] = await Promise.all([
    db.select().from(adversarialCampaign).where(eq(adversarialCampaign.runId, r.id)).orderBy(asc(adversarialCampaign.seq)),
    db.select().from(adversarialChain).where(eq(adversarialChain.runId, r.id)).orderBy(asc(adversarialChain.seq)),
    db.select().from(testExecution).where(eq(testExecution.runId, r.id)).orderBy(asc(testExecution.createdAt)),
    db.select().from(testFinding).where(eq(testFinding.runId, r.id)),
  ]);
  const [summary] = await adversarialSummaries([r]);
  const { engine: _e, catalogue: _c, compiler: _co, rerun: _r, ...policy } = (r.policy ?? {}) as StoredPolicy;
  return {
    ...summary!,
    policy: AdversarialPolicyInput.parse(policy),
    campaigns: campaigns.map((c) => c.data as AdversarialCampaign),
    chains: chains.map((c) => c.data as AttackChain),
    findings: finds.map((f) => f.data as AdversarialFinding),
    executions: execs.map((e) => e.data as TestExecution),
    report: (r.report as AdversarialReport | null) ?? null,
    usage: (r.usage as TestingUsage | null) ?? emptyUsage,
  };
}

export async function adversarialRunForUser(userId: string, runId: string) {
  const [r] = await db.select().from(testingRun).where(and(ADV, eq(testingRun.id, runId)));
  if (!r) return null;
  return (await snapshotForUser(userId, r.snapshotId)) ? r : null;
}

export async function adversarialRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string } }>("/v1/snapshots/:id/checks/adversarial", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const key = idemKey(request.headers["idempotency-key"]);
    if (!key) return sendError(reply, 400, missingKey);
    const s = await snapshotForUser(session.user.id, request.params.id);
    if (!s) return sendError(reply, 404, notFound("snapshot"));
    const [latest] = await db.select().from(snapshot).where(eq(snapshot.projectId, s.projectId)).orderBy(desc(snapshot.createdAt)).limit(1);
    if (latest?.id !== s.id) return sendError(reply, 409, { code: "snapshot_not_latest", message: "Only the project's latest snapshot can be checked.", fix: "Open the project again and start the check from there." });
    if ((await analysisOf(s)).stage !== "ready") return sendError(reply, 409, { code: "project_not_ready", message: "This project is still being analysed.", fix: "Start AI Adversarial once the project shows Ready." });
    const parsed = AdversarialPolicyInput.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, { code: "bad_request", message: `The AI Adversarial options are not valid: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`, fix: "Start the check again from the app." });
    // Attack packs must belong to this project; their digests are part of the request identity.
    const packs = parsed.data.attackPackIds.length ? await db.select().from(adversarialAttackPack).where(and(eq(adversarialAttackPack.projectId, s.projectId), inArray(adversarialAttackPack.id, parsed.data.attackPackIds))) : [];
    if (packs.length !== new Set(parsed.data.attackPackIds).size) return sendError(reply, 404, notFound("attack pack"));
    const policy: StoredPolicy = { ...parsed.data, engine: AD_ENGINE_VERSION, catalogue: AD_CATALOGUE_VERSION, compiler: AD_COMPILER_VERSION };
    const route = "checks/adversarial";
    const requestHash = createHash("sha256").update(JSON.stringify({ snapshot: s.id, content: s.contentDigest, policy, rulesOfEngagement: parsed.data.rulesOfEngagement ?? null, catalogue: AD_CATALOGUE_VERSION, packs: packs.map((p) => p.digest).sort() })).digest("hex");
    const ur = await ensureUnderstanding(s.id);
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(idempotencyKey).where(and(eq(idempotencyKey.userId, session.user.id), eq(idempotencyKey.route, route), eq(idempotencyKey.key, key))).for("update");
      if (existing) return existing.requestHash === requestHash ? ({ kind: "replay", runId: (existing.response as { runId: string }).runId } as const) : ({ kind: "conflict" } as const);
      const [active] = await tx.select().from(testingRun).where(and(ADV, eq(testingRun.snapshotId, s.id), inArray(testingRun.status, [...ACTIVE]))).limit(1);
      const runId = active?.id ?? randomUUID();
      if (!active) await tx.insert(testingRun).values({ id: runId, check: "adversarial", snapshotId: s.id, projectId: s.projectId, understandingRunId: ur.id, requestedBy: session.user.id, policy });
      await tx.insert(idempotencyKey).values({ userId: session.user.id, route, key, requestHash, response: { runId } });
      return { kind: active ? "joined" : "created", runId } as const;
    });
    if (result.kind === "conflict") return sendError(reply, 422, { code: "idempotency_key_reused", message: "This request ID was already used for a different check.", fix: "Start the check again from the app." });
    const [row] = await db.select().from(testingRun).where(eq(testingRun.id, result.runId));
    return reply.status(result.kind === "created" ? 201 : 200).send({ run: (await adversarialSummaries([row!]))[0] });
  });

  app.get<{ Params: { wid: string } }>("/v1/workspaces/:wid/adversarial-status", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    if (!(await isMember(session.user.id, request.params.wid))) return sendError(reply, 404, notFound("workspace"));
    const projects = await db.select({ id: project.id }).from(project).where(eq(project.workspaceId, request.params.wid));
    if (!projects.length) return { projects: [] as AdversarialProjectStatus[] };
    const rows = await db.select().from(testingRun).where(and(ADV, inArray(testingRun.projectId, projects.map((p) => p.id)))).orderBy(desc(testingRun.createdAt)).limit(400);
    const latest = projects.map((p) => rows.find((r) => r.projectId === p.id)).filter((r): r is RunRow => Boolean(r));
    const sums = new Map((await adversarialSummaries(latest)).map((x) => [x.projectId, x]));
    return { projects: projects.map((p) => ({ projectId: p.id, latest: sums.get(p.id) ?? null, active: rows.some((r) => r.projectId === p.id && (ACTIVE as readonly string[]).includes(r.status)) })) satisfies AdversarialProjectStatus[] };
  });

  app.get<{ Params: { projectId: string } }>("/v1/projects/:projectId/adversarial-runs", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const p = await projectForUser(session.user.id, request.params.projectId);
    if (!p) return sendError(reply, 404, notFound("project"));
    const rows = await db.select().from(testingRun).where(and(ADV, eq(testingRun.projectId, p.id))).orderBy(desc(testingRun.createdAt)).limit(20);
    return { runs: await adversarialSummaries(rows) };
  });

  app.get<{ Params: { runId: string } }>("/v1/adversarial-runs/:runId", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const r = await adversarialRunForUser(session.user.id, request.params.runId);
    if (!r) return sendError(reply, 404, notFound("adversarial run"));
    return { run: await adversarialDetail(r) };
  });

  app.get<{ Params: { runId: string }; Querystring: { after?: string } }>("/v1/adversarial-runs/:runId/events", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const r = await adversarialRunForUser(session.user.id, request.params.runId);
    if (!r) return sendError(reply, 404, notFound("adversarial run"));
    return { events: await loadEvents(r.id, Number(request.query.after) || 0) };
  });

  app.post<{ Params: { runId: string } }>("/v1/adversarial-runs/:runId/cancel", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const r = await adversarialRunForUser(session.user.id, request.params.runId);
    if (!r) return sendError(reply, 404, notFound("adversarial run"));
    if (!(ACTIVE as readonly string[]).includes(r.status)) return sendError(reply, 409, { code: "not_running", message: "This run has already finished.", fix: "Start a new run if you want fresh results." });
    await db.update(testingRun).set({ cancelRequested: true }).where(eq(testingRun.id, r.id));
    await db.update(testingRun).set({ status: "cancelled", phase: "done", finishedAt: new Date() }).where(and(eq(testingRun.id, r.id), eq(testingRun.status, "queued")));
    const [row] = await db.select().from(testingRun).where(eq(testingRun.id, r.id));
    return reply.status(202).send({ run: (await adversarialSummaries([row!]))[0] });
  });

  /** Re-run a scope of a finished run's campaigns as a new linked run. Nothing is copied: every verdict of the new run
   * comes from new evidence. The original run is never changed. */
  app.post<{ Params: { runId: string } }>("/v1/adversarial-runs/:runId/rerun", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const key = idemKey(request.headers["idempotency-key"]);
    if (!key) return sendError(reply, 400, missingKey);
    const parent = await adversarialRunForUser(session.user.id, request.params.runId);
    if (!parent) return sendError(reply, 404, notFound("adversarial run"));
    if ((ACTIVE as readonly string[]).includes(parent.status)) return sendError(reply, 409, { code: "run_not_finished", message: "This run is still in progress.", fix: "Rerun once it finishes." });
    const parsed = RerunAdversarialInput.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, { code: "bad_request", message: "Say which campaigns to re-run.", fix: "Choose 'failed', 'inconclusive', 'blocked', or a set of campaign ids." });
    const rows = await db.select().from(adversarialCampaign).where(eq(adversarialCampaign.runId, parent.id)).orderBy(asc(adversarialCampaign.seq));
    const ids = parsed.data.scope === "campaigns" ? (parsed.data.campaignIds ?? []).filter((id) => rows.some((c) => c.id === id)) : rows.filter((c) => c.status === parsed.data.scope).map((c) => c.id);
    if (!ids.length) return sendError(reply, 409, { code: "nothing_to_rerun", message: parsed.data.scope === "campaigns" ? "None of those campaigns belong to this run." : `That run has no ${parsed.data.scope} campaign.`, fix: "Choose campaigns from this report, or run the whole check again." });
    const [latest] = await db.select().from(snapshot).where(eq(snapshot.projectId, parent.projectId)).orderBy(desc(snapshot.createdAt)).limit(1);
    if (latest?.id !== parent.snapshotId) return sendError(reply, 409, { code: "snapshot_not_latest", message: "The project has a newer snapshot; this run's campaigns belong to the old one.", fix: "Run AI Adversarial on the latest snapshot instead." });
    const policy: StoredPolicy = { ...((parent.policy ?? {}) as StoredPolicy), engine: AD_ENGINE_VERSION, catalogue: AD_CATALOGUE_VERSION, compiler: AD_COMPILER_VERSION, rerun: { parentRunId: parent.id, campaignIds: ids } };
    const route = "checks/adversarial/rerun";
    const requestHash = createHash("sha256").update(`${parent.id}:${ids.slice().sort().join(",")}`).digest("hex");
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(idempotencyKey).where(and(eq(idempotencyKey.userId, session.user.id), eq(idempotencyKey.route, route), eq(idempotencyKey.key, key))).for("update");
      if (existing) return existing.requestHash === requestHash ? ({ kind: "replay", runId: (existing.response as { runId: string }).runId } as const) : ({ kind: "conflict" } as const);
      const runId = randomUUID();
      await tx.insert(testingRun).values({ id: runId, check: "adversarial", snapshotId: parent.snapshotId, projectId: parent.projectId, understandingRunId: parent.understandingRunId, requestedBy: session.user.id, policy });
      await tx.insert(idempotencyKey).values({ userId: session.user.id, route, key, requestHash, response: { runId } });
      return { kind: "created", runId } as const;
    });
    if (result.kind === "conflict") return sendError(reply, 422, { code: "idempotency_key_reused", message: "This request ID was already used for a different rerun.", fix: "Start the rerun again from the app." });
    const [row] = await db.select().from(testingRun).where(eq(testingRun.id, result.runId));
    return reply.status(result.kind === "created" ? 201 : 200).send({ run: (await adversarialSummaries([row!]))[0] });
  });

  /** The run as a download: Markdown, or JSON (campaigns, chains, findings, audit), redacted. */
  app.get<{ Params: { runId: string }; Querystring: { format?: string } }>("/v1/adversarial-runs/:runId/export", async (request, reply) => {
    const session = await requireSession(request, reply);
    if (!session) return;
    const r = await adversarialRunForUser(session.user.id, request.params.runId);
    if (!r) return sendError(reply, 404, notFound("adversarial run"));
    if ((ACTIVE as readonly string[]).includes(r.status)) return sendError(reply, 409, { code: "run_not_finished", message: "This run is still in progress.", fix: "Download the report once it finishes." });
    const run = await adversarialDetail(r);
    const [p] = await db.select({ name: project.name }).from(project).where(eq(project.id, r.projectId));
    const base = `${(p?.name ?? "project").replace(/[^\w.-]+/g, "-").slice(0, 60)}-adversarial-${r.createdAt.toISOString().slice(0, 10)}`;
    if (request.query.format === "json") {
      reply.header("content-type", "application/json; charset=utf-8").header("content-disposition", `attachment; filename="${base}.json"`);
      return redactSecrets(JSON.stringify(run, null, 2)).text;
    }
    reply.header("content-type", "text/markdown; charset=utf-8").header("content-disposition", `attachment; filename="${base}.md"`);
    return redactSecrets(adversarialRunToMarkdown(run, p?.name ?? "Project")).text;
  });
}
