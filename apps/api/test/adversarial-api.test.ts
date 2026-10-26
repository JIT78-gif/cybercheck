import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AdversarialRunDetail, SnapshotSummary } from "@cybercheck/contracts";
import { buildApp } from "../src/app.ts";
import { auth } from "../src/auth/auth.ts";
import { db, pool } from "../src/db/client.ts";
import { adversarialCampaign, testingRun, user } from "../src/db/schema.ts";
import { providers } from "../src/env.ts";
import { processRun } from "../src/testing/worker.ts";
import { BENCH, projectFiles } from "./ai-helpers.ts";
import { makeZip } from "./fixtures.ts";

// AI Adversarial Step 4: the API and workflow lifecycle on the shared run model. A project is uploaded and analysed for
// real, then a run is created, claimed, processed by the (stub) engine, read back, exported, cancelled and reruns are
// validated. The engine body itself is built in later steps; here the lifecycle must be sound and idempotent.

let app: FastifyInstance;
type Account = { cookie: string; workspaceId: string; userId: string };

async function account(name: string): Promise<Account> {
  const email = `adv-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;
  const created = await auth.api.signUpEmail({ body: { name, email, password: "adversarial-pass" } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.user.id));
  const res = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers: { origin: "http://localhost:3000", "content-type": "application/json", "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250) + 1}` }, payload: { email, password: "adversarial-pass" } });
  const sc = res.headers["set-cookie"];
  const cookie = (Array.isArray(sc) ? sc : [sc!]).map((c) => c.split(";")[0]).join("; ");
  const me = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
  return { cookie, workspaceId: me.json().workspaces[0].id, userId: created.user.id };
}

async function upload(a: Account): Promise<SnapshotSummary & { projectId: string }> {
  const files = Object.entries(projectFiles(BENCH.noAi));
  const zip = makeZip(files.map(([name, data]) => ({ name: `app/${name}`, data: Buffer.from(data), deflate: true })));
  const p = await app.inject({ method: "POST", url: `/v1/workspaces/${a.workspaceId}/projects`, headers: { cookie: a.cookie, "content-type": "application/json" }, payload: { name: `adv-${randomUUID().slice(0, 6)}`, sourceType: "archive" } });
  const projectId = p.json().project.id as string;
  const boundary = `----b${randomUUID()}`;
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attest"\r\n\r\ntrue\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="app.zip"\r\nContent-Type: application/zip\r\n\r\n`), zip, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const up = await app.inject({ method: "POST", url: `/v1/projects/${projectId}/snapshots/archive`, headers: { cookie: a.cookie, "content-type": `multipart/form-data; boundary=${boundary}`, "idempotency-key": randomUUID() }, payload });
  const id = up.json().snapshot.id as string;
  for (let i = 0; i < 300; i++) {
    const s = (await app.inject({ method: "GET", url: `/v1/snapshots/${id}`, headers: { cookie: a.cookie } })).json().snapshot as SnapshotSummary;
    const ready = (await app.inject({ method: "GET", url: `/v1/projects/${projectId}`, headers: { cookie: a.cookie } })).json().project.analysis.stage;
    if (s.status === "BASELINED" && ready === "ready") return { ...s, projectId };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("project never became ready");
}

const H = (a: Account, extra: Record<string, string> = {}) => ({ cookie: a.cookie, "content-type": "application/json", ...extra });
async function start(a: Account, snapId: string, body: Record<string, unknown> = {}, key = randomUUID()) {
  // Keep the lifecycle hermetic: the non-AI control now applies to the general attacker track, so without pinning the
  // runtime the engine would try to boot it in a real sandbox. Requesting Nebius with none configured resolves to no
  // runtime (analysis only) deterministically, independent of whether local Docker happens to be present.
  return app.inject({ method: "POST", url: `/v1/snapshots/${snapId}/checks/adversarial`, headers: H(a, { "idempotency-key": key }), payload: { runtime: "nebius", ...body } });
}
/** Emulate a worker claim (generation 1) and run the engine to completion. */
async function process(runId: string) {
  await db.update(testingRun).set({ status: "running", generation: 1, startedAt: new Date(), heartbeatAt: new Date() }).where(eq(testingRun.id, runId));
  await processRun({ id: runId, generation: 1 }, { provider: null, session: null });
}

let owner: Account;
let snap: SnapshotSummary & { projectId: string };
const sandboxWas = providers.sandbox;

beforeAll(async () => {
  (providers as { sandbox: boolean }).sandbox = true;
  app = await buildApp();
  owner = await account("owner");
  snap = await upload(owner);
}, 60_000);

afterAll(async () => {
  (providers as { sandbox: boolean }).sandbox = sandboxWas;
  await app.close();
  await pool.end();
});

describe("AI Adversarial API lifecycle", () => {
  it("creates a run, is idempotent, and rejects a missing idempotency key", async () => {
    const key = randomUUID();
    const first = await start(owner, snap.id, { profile: "standard" }, key);
    expect(first.statusCode).toBe(201);
    const runId = first.json().run.id as string;
    expect(first.json().run.decision).toBeNull();

    const replay = await start(owner, snap.id, { profile: "standard" }, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().run.id).toBe(runId);

    const noKey = await app.inject({ method: "POST", url: `/v1/snapshots/${snap.id}/checks/adversarial`, headers: H(owner), payload: {} });
    expect(noKey.statusCode).toBe(400);

    // A second active run is not created while one is in progress: the same run is joined.
    const joined = await start(owner, snap.id, { profile: "standard" });
    expect(joined.json().run.id).toBe(runId);
  });

  it("runs through the worker, reads back a detail and exports it", async () => {
    const [latest] = await db.select().from(testingRun).where(eq(testingRun.check, "adversarial")).orderBy(desc(testingRun.createdAt)).limit(1);
    const runId = latest!.id;
    await process(runId);

    // The uploaded control is a non-AI web app, so it now applies to the general attacker track. This run was started
    // analysis-only (runtime "static"), so the engine applies but reports the environment as blocked without executing.
    const detail = (await app.inject({ method: "GET", url: `/v1/adversarial-runs/${runId}`, headers: { cookie: owner.cookie } })).json().run as AdversarialRunDetail;
    expect(detail.status).toBe("completed");
    expect(detail.decision).toBe("not_ready_environment_blocked");
    expect(detail.report?.decision).toBe("not_ready_environment_blocked");
    expect(detail.headline).toMatch(/analysis only|no code was executed/i);
    expect(detail.policy.profile).toBe("standard");
    expect(detail.campaigns).toEqual([]);

    const events = (await app.inject({ method: "GET", url: `/v1/adversarial-runs/${runId}/events`, headers: { cookie: owner.cookie } })).json().events as unknown[];
    expect(events.length).toBeGreaterThan(0);

    const json = await app.inject({ method: "GET", url: `/v1/adversarial-runs/${runId}/export?format=json`, headers: { cookie: owner.cookie } });
    expect(json.statusCode).toBe(200);
    expect(json.headers["content-type"]).toMatch(/application\/json/);
    expect(JSON.parse(json.body).id).toBe(runId);

    const md = await app.inject({ method: "GET", url: `/v1/adversarial-runs/${runId}/export`, headers: { cookie: owner.cookie } });
    expect(md.body).toMatch(/AI Adversarial report/);

    // No campaigns ran, so there is nothing to rerun.
    const rerun = await app.inject({ method: "POST", url: `/v1/adversarial-runs/${runId}/rerun`, headers: H(owner, { "idempotency-key": randomUUID() }), payload: { scope: "blocked" } });
    expect(rerun.statusCode).toBe(409);
  });

  it("lists the run on the project and the workspace status", async () => {
    const runs = (await app.inject({ method: "GET", url: `/v1/projects/${snap.projectId}/adversarial-runs`, headers: { cookie: owner.cookie } })).json().runs as unknown[];
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const status = (await app.inject({ method: "GET", url: `/v1/workspaces/${owner.workspaceId}/adversarial-status`, headers: { cookie: owner.cookie } })).json().projects as Array<{ projectId: string; latest: unknown }>;
    expect(status.find((p) => p.projectId === snap.projectId)?.latest).toBeTruthy();
  });

  it("cancels a queued run", async () => {
    const created = await start(owner, snap.id, { profile: "quick" });
    const runId = created.json().run.id as string;
    const res = await app.inject({ method: "POST", url: `/v1/adversarial-runs/${runId}/cancel`, headers: { cookie: owner.cookie } });
    expect(res.statusCode).toBe(202);
    expect(res.json().run.status).toBe("cancelled");
  });

  it("refuses access to another user's run", async () => {
    const [latest] = await db.select().from(testingRun).where(eq(testingRun.check, "adversarial")).orderBy(desc(testingRun.createdAt)).limit(1);
    const stranger = await account("stranger");
    const res = await app.inject({ method: "GET", url: `/v1/adversarial-runs/${latest!.id}`, headers: { cookie: stranger.cookie } });
    expect(res.statusCode).toBe(404);
  });

  it("creates an exact targeted rerun only when every selected id exists in the frozen plan", async () => {
    const [parent] = await db.select().from(testingRun).where(eq(testingRun.check, "adversarial")).orderBy(desc(testingRun.createdAt)).limit(1);
    await db.update(testingRun).set({ status: "completed", plan: { campaignPlan: { key: `adversarial/${parent!.id}/campaign-plan.json`, digest: "a".repeat(64), campaignIds: ["stable-campaign"] } } }).where(eq(testingRun.id, parent!.id));
    const data = { id: "stable-campaign", seq: 1, lane: "broken_access", techniqueId: "function-authz", priority: "high", title: "Stable", target: { componentId: "app", endpoint: "GET /admin" }, attacker: "user", resetStrategy: "fresh_app", steps: [], status: "blocked", reason: "setup", executionIds: [], findingIds: [], limitations: ["setup"], source: "catalogue" } as never;
    await db.insert(adversarialCampaign).values({ runId: parent!.id, id: "stable-campaign", seq: 1, lane: "broken_access", techniqueId: "function-authz", status: "blocked", data });

    const unknown = await app.inject({ method: "POST", url: `/v1/adversarial-runs/${parent!.id}/rerun`, headers: H(owner, { "idempotency-key": randomUUID() }), payload: { scope: "campaigns", campaignIds: ["stable-campaign", "missing"] } });
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json().code).toBe("campaigns_not_resolved");

    const exact = await app.inject({ method: "POST", url: `/v1/adversarial-runs/${parent!.id}/rerun`, headers: H(owner, { "idempotency-key": randomUUID() }), payload: { scope: "campaigns", campaignIds: ["stable-campaign"] } });
    expect(exact.statusCode).toBe(201);
    const childId = exact.json().run.id as string;
    const [child] = await db.select().from(testingRun).where(eq(testingRun.id, childId));
    expect((child!.policy as { rerun: unknown }).rerun).toEqual({ parentRunId: parent!.id, campaignIds: ["stable-campaign"], planKey: `adversarial/${parent!.id}/campaign-plan.json`, planDigest: "a".repeat(64) });
    await db.update(testingRun).set({ status: "cancelled", phase: "done", finishedAt: new Date() }).where(eq(testingRun.id, childId));
  });
});
