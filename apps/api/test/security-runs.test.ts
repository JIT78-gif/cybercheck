import { randomUUID } from "node:crypto";
import { buffer } from "node:stream/consumers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { SecurityFinding, SecurityObligation, SecurityProof, SecurityRunDetail, SecurityRunSummary, SnapshotSummary, TestingRunSummary } from "@cybercheck/contracts";
import { buildApp } from "../src/app.ts";
import { auth } from "../src/auth/auth.ts";
import { db, pool } from "../src/db/client.ts";
import { securityProof, testFinding, testingRepair, testingRun, testObligation, testRunEvent, user } from "../src/db/schema.ts";
import type { SandboxProvider, SandboxRunRequest, SandboxRunResult } from "../src/testing/sandbox/provider.ts";
import { processRun } from "../src/testing/worker.ts";
import { providers } from "../src/env.ts";
import { objectStore } from "../src/storage/object-store.ts";
import { expressShop, makeZip } from "./fixtures.ts";

// One run model for every check (Security Round 1, step 1): Security runs live in the shared run table with
// check = "security", are handed to the Security engine, and never appear in Testing's lists or routes.

let app: FastifyInstance;
type Account = { cookie: string; workspaceId: string };

async function account(name: string): Promise<Account> {
  const email = `sec-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;
  const password = "security-check-pass";
  const created = await auth.api.signUpEmail({ body: { name, email, password } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.user.id));
  const res = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers: { origin: "http://localhost:3000", "content-type": "application/json", "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250) + 1}` }, payload: { email, password } });
  const sc = res.headers["set-cookie"];
  const cookie = (Array.isArray(sc) ? sc : [sc!]).map((c) => c.split(";")[0]).join("; ");
  const me = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
  return { cookie, workspaceId: me.json().workspaces[0].id };
}

async function uploadProject(a: Account): Promise<SnapshotSummary & { projectId: string }> {
  const zip = makeZip(Object.entries(expressShop).map(([name, data]) => ({ name: `shop/${name}`, data, deflate: true })));
  const p = await app.inject({ method: "POST", url: `/v1/workspaces/${a.workspaceId}/projects`, headers: { cookie: a.cookie, "content-type": "application/json" }, payload: { name: `sec-${randomUUID().slice(0, 6)}`, sourceType: "archive" } });
  const projectId = p.json().project.id as string;
  const boundary = `----b${randomUUID()}`;
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attest"\r\n\r\ntrue\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="shop.zip"\r\nContent-Type: application/zip\r\n\r\n`), zip, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const up = await app.inject({ method: "POST", url: `/v1/projects/${projectId}/snapshots/archive`, headers: { cookie: a.cookie, "content-type": `multipart/form-data; boundary=${boundary}`, "idempotency-key": randomUUID() }, payload });
  const id = up.json().snapshot.id as string;
  for (let i = 0; i < 200; i++) {
    const s = (await app.inject({ method: "GET", url: `/v1/snapshots/${id}`, headers: { cookie: a.cookie } })).json().snapshot as SnapshotSummary;
    const ready = (await app.inject({ method: "GET", url: `/v1/projects/${projectId}`, headers: { cookie: a.cookie } })).json().project.analysis.stage;
    if (s.status === "BASELINED" && ready === "ready") return { ...s, projectId };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("project never became ready");
}

/** A sandbox that must never be used in this step: the Security engine runs no command yet. */
const noSandbox: SandboxProvider = {
  name: "none",
  preflight: async () => ({ ok: true, status: "available" as const, detail: "fake" }),
  image: async () => {
    throw new Error("unexpected sandbox use");
  },
  upload: async () => {
    throw new Error("unexpected sandbox use");
  },
  run: async () => {
    throw new Error("unexpected sandbox use");
  },
  readFile: async () => null,
};

/** A scripted sandbox for the Security run: it answers the tool install or verify, and the scan, with clean outputs. */
class FakeSecuritySandbox implements SandboxProvider {
  readonly name = "fake-security";
  readonly commands: SandboxRunRequest[] = [];
  private readonly versions = JSON.stringify({ semgrep: "1.95.0", gitleaks: "8.21.2", osvScanner: "1.9.1", trivy: "0.74.0", osvDatabaseAt: "2026-10-14T00:00:00Z", trivyChecksAt: "2026-10-14T00:00:00Z" });
  async preflight() {
    return { ok: true, status: "available" as const, detail: "fake" };
  }
  async image() {
    return "base";
  }
  async upload() {
    return "file-1";
  }
  async run(req: SandboxRunRequest): Promise<SandboxRunResult> {
    this.commands.push(req);
    const scan = req.command.includes("CC_SCAN");
    return { operationId: `op-${this.commands.length}`, status: "ok", exitCode: 0, stdout: scan ? "gitleaks=0 semgrep=0 osv=0 trivy=0" : this.versions, stderr: "", truncated: false, resultImage: req.keep ? (scan ? "scan-image" : "tools-image") : null, durationMs: 10, cpuSeconds: 1, maxRssKb: null, error: null };
  }
  async readFile(image: string, path: string) {
    if (image !== "scan-image") return null;
    const name = path.split("/").pop()!;
    const files: Record<string, string> = { "gitleaks.json": "[]", "semgrep.json": '{"results":[],"errors":[]}', "osv.json": '{"results":[]}', "trivy.json": '{"Results":[]}', "gitleaks.exit": "0", "semgrep.exit": "0", "osv.exit": "0", "trivy.exit": "0" };
    return files[name] !== undefined ? Buffer.from(files[name]!) : null;
  }
}

const startSecurity = (a: Account, snapshotId: string, key = randomUUID()) => app.inject({ method: "POST", url: `/v1/snapshots/${snapshotId}/checks/security`, headers: { cookie: a.cookie, "idempotency-key": key } });
const startTesting = (a: Account, snapshotId: string) => app.inject({ method: "POST", url: `/v1/snapshots/${snapshotId}/checks/testing`, headers: { cookie: a.cookie, "idempotency-key": randomUUID() } });

let owner: Account;
let other: Account;
let snap: SnapshotSummary & { projectId: string };
const sandboxWas = providers.sandbox;

beforeAll(async () => {
  (providers as { sandbox: boolean }).sandbox = true;
  app = await buildApp();
  owner = await account("owner");
  other = await account("other");
  snap = await uploadProject(owner);
}, 60_000);
afterAll(async () => {
  (providers as { sandbox: boolean }).sandbox = sandboxWas;
  await app.close();
  await pool.end();
});

describe("Security runs on the shared run model", () => {
  it("starts a Security run, joins it on a second click, and keeps it apart from Testing", async () => {
    const key = randomUUID();
    const first = await startSecurity(owner, snap.id, key);
    expect(first.statusCode).toBe(201);
    const run = first.json().run as SecurityRunSummary;
    expect(run).toMatchObject({ snapshotId: snap.id, decision: null, counts: { obligations: 0, confirmed: 0, suspected: 0 } });
    const [row] = await db.select().from(testingRun).where(eq(testingRun.id, run.id));
    expect(row).toMatchObject({ check: "security", policy: { engine: expect.stringMatching(/^\d{4}-\d{2}-\d{2}\.s\d/) } });
    // The same key replays; a second click with another key joins the active Security run.
    expect((await startSecurity(owner, snap.id, key)).json().run.id).toBe(run.id);
    expect((await startSecurity(owner, snap.id)).json().run.id).toBe(run.id);

    // A Testing start on the same snapshot is a separate run, never joined to the Security one.
    const testing = await startTesting(owner, snap.id);
    expect(testing.statusCode).toBe(201);
    // Cancelled at once, so no worker spends sandbox time on it.
    await db.update(testingRun).set({ status: "cancelled", cancelRequested: true, phase: "done" }).where(eq(testingRun.id, testing.json().run.id));
    expect((testing.json().run as TestingRunSummary).id).not.toBe(run.id);

    // Each check's lists and routes see only its own runs.
    const tList = (await app.inject({ method: "GET", url: `/v1/projects/${snap.projectId}/testing-runs`, headers: { cookie: owner.cookie } })).json().runs as TestingRunSummary[];
    const sList = (await app.inject({ method: "GET", url: `/v1/projects/${snap.projectId}/security-runs`, headers: { cookie: owner.cookie } })).json().runs as SecurityRunSummary[];
    expect(tList.map((r) => r.id)).not.toContain(run.id);
    expect(sList.map((r) => r.id)).toEqual([run.id]);
    expect((await app.inject({ method: "GET", url: `/v1/testing-runs/${run.id}`, headers: { cookie: owner.cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/v1/security-runs/${testing.json().run.id}`, headers: { cookie: owner.cookie } })).statusCode).toBe(404);
    const status = (await app.inject({ method: "GET", url: `/v1/workspaces/${owner.workspaceId}/security-status`, headers: { cookie: owner.cookie } })).json().projects;
    expect(status).toEqual([{ projectId: snap.projectId, latest: expect.objectContaining({ id: run.id }), active: expect.any(Boolean) }]);

    // Another user sees nothing.
    expect((await app.inject({ method: "GET", url: `/v1/security-runs/${run.id}`, headers: { cookie: other.cookie } })).statusCode).toBe(404);
    expect((await startSecurity(other, snap.id)).statusCode).toBe(404);

    // Clean up: neither run should be picked up later by a worker.
    for (const id of [run.id, testing.json().run.id]) await db.update(testingRun).set({ status: "cancelled", cancelRequested: true, phase: "done" }).where(eq(testingRun.id, id));
  });

  it("records the run's options in its idempotency key, and returns stored runtime proofs in detail and exports", async () => {
    const start = (key: string, payload: unknown) => app.inject({ method: "POST", url: `/v1/snapshots/${snap.id}/checks/security`, headers: { cookie: owner.cookie, "idempotency-key": key, "content-type": "application/json" }, payload: JSON.stringify(payload) });
    const key = randomUUID();
    const first = await start(key, { aiCritic: "off" });
    expect(first.statusCode).toBe(201);
    const runId = first.json().run.id as string;
    const [row] = await db.select().from(testingRun).where(eq(testingRun.id, runId));
    expect(row!.policy).toMatchObject({ aiCritic: "off" });
    // The same key with other options is a different request; nonsense options are refused.
    expect((await start(key, { aiCritic: "auto" })).statusCode).toBe(422);
    expect((await start(randomUUID(), { aiCritic: "always" })).statusCode).toBe(400);

    const proof: SecurityProof = { id: "P1", type: "authz_object", target: { kind: "endpoint", ref: "GET /api/products/:id" }, obligationIds: ["sec:endpoint:GET /api/products/:id:object-authorization"], identities: ["customer", "customer-2"], preconditions: [{ what: "both identities signed in", met: true }], reset: "none_needed", payloadClass: "another identity's object id", expected: "403 or 404 for the other customer's record", observed: "404", evidence: [{ kind: "http", label: "GET as customer-2", excerpt: "404 {}" }], source: [], executionIds: [], artifacts: [], verdict: "passed", reason: "The control held for this exact target.", limitations: [], redacted: true, requests: 2 };
    await db.insert(securityProof).values({ id: proof.id, runId, seq: 1, data: proof });
    await db.update(testingRun).set({ status: "cancelled", cancelRequested: true, phase: "done" }).where(eq(testingRun.id, runId));
    const detail = (await app.inject({ method: "GET", url: `/v1/security-runs/${runId}`, headers: { cookie: owner.cookie } })).json().run as SecurityRunDetail;
    expect(detail.proofs).toEqual([proof]);
    const json = await app.inject({ method: "GET", url: `/v1/security-runs/${runId}/export?format=json`, headers: { cookie: owner.cookie } });
    expect(JSON.parse(json.body).proofs).toHaveLength(1);
  });

  it("runs a claimed Security run through the Security engine: readiness, obligations, scanners and verdicts", async () => {
    // Inserted as already claimed (generation 1), so no dev worker can pick it up and spend real sandbox time.
    const [first] = await db.select().from(testingRun).where(and(eq(testingRun.snapshotId, snap.id), eq(testingRun.check, "security")));
    const id = randomUUID();
    await db.insert(testingRun).values({ id, check: "security", snapshotId: snap.id, projectId: snap.projectId, understandingRunId: first!.understandingRunId, requestedBy: first!.requestedBy, policy: { engine: "test" }, status: "running", generation: 1, startedAt: new Date(), heartbeatAt: new Date() });
    const sandbox = new FakeSecuritySandbox();
    await processRun({ id, generation: 1 }, { provider: sandbox, session: null });
    const run = { id };

    const detail = (await app.inject({ method: "GET", url: `/v1/security-runs/${run.id}`, headers: { cookie: owner.cookie } })).json().run as SecurityRunDetail;
    expect(detail.status).toBe("partial");
    expect(detail.error).toBeNull();
    // The report: a decision, coverage with both numbers, the tools with their versions, and a clean audit.
    expect(detail.report).toMatchObject({ engine: expect.any(String), decision: "not_ready_environment_blocked", headline: expect.stringMatching(/^Not ready: the environment blocked the check\. \d+ of \d+ applicable obligations produced decisive evidence/), proofRuntime: { stage: "no_startable_app", attempted: true, appBooted: false } });
    expect(detail.decision).toBe("not_ready_environment_blocked");
    expect(detail.report!.tools.map((t) => [t.name, t.version])).toEqual([["Gitleaks", "8.21.2"], ["Semgrep", "1.95.0"], ["OSV-Scanner", "1.9.1"], ["Trivy", "0.74.0"]]);
    expect(detail.report!.audit.filter((a) => !a.ok)).toEqual([]);
    // The tools were prepared (installed or reused), then one scan ran with the network off.
    expect(detail.executions.map((e) => e.kind)).toEqual(["security_tools", "security_scan"]);
    expect(detail.executions.find((e) => e.kind === "security_scan")).toMatchObject({ network: false, outcome: "ok" });
    expect(sandbox.commands.find((c) => c.command.includes("CC_SCAN"))).toMatchObject({ network: false });
    // Scanner obligations got verdicts with their scope; runtime obligations say exactly why this fixture could not run.
    expect(detail.obligations.find((o) => o.id === "sec:secrets:repository")).toMatchObject({ status: "passed", executionIds: [detail.executions[1]!.id] });
    expect(detail.obligations.find((o) => o.id === "sec:sast:sql-injection")).toMatchObject({ status: "passed", reason: expect.stringMatching(/rule pack [0-9a-f]{16}/) });
    expect(detail.obligations.filter((o) => o.proofStrategy === "runtime_proof").every((o) => ["blocked", "inconclusive", "not_applicable"].includes(o.status))).toBe(true);
    expect(detail.obligations.some((o) => o.status === "planned")).toBe(false);
    const events = await db.select().from(testRunEvent).where(eq(testRunEvent.runId, run.id));
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["phase:admission", "phase:readiness", "readiness", "phase:planning", "phase:preparing", "phase:scanning", "phase:validating", "phase:critic", "phase:reporting"]));
    // The readiness result and the four artifacts are kept with the run, plus the scan summary.
    const [row] = await db.select().from(testingRun).where(eq(testingRun.id, run.id));
    const plan = row!.plan as { readiness: { level: string }; artifacts: Record<string, string> };
    expect(Object.keys(plan.artifacts).sort()).toEqual(["analysis-manifest.json", "evidence.ndjson", "project-analysis.md", "project-facts.json"]);
    for (const key of Object.values(plan.artifacts)) expect(await objectStore.exists(key)).toBe(true);
    expect(await objectStore.exists(`security/${run.id}/scan-summary.json`)).toBe(true);
    const manifest = JSON.parse((await buffer(objectStore.get(plan.artifacts["analysis-manifest.json"]!))).toString("utf8"));
    expect(manifest).toMatchObject({ snapshotId: snap.id, readiness: { level: plan.readiness.level } });
    // Never handed to Testing: no Testing-only phase ran, and Security's own phases did.
    expect(events.map((e) => e.type)).not.toContain("phase:executing");
    expect(events.map((e) => e.type)).toContain("phase:planning");

    // Both exports work on a finished run, and the JSON one parses.
    const json = await app.inject({ method: "GET", url: `/v1/security-runs/${run.id}/export?format=json`, headers: { cookie: owner.cookie } });
    expect(JSON.parse(json.body).id).toBe(run.id);
    const md = await app.inject({ method: "GET", url: `/v1/security-runs/${run.id}/export?format=md`, headers: { cookie: owner.cookie } });
    expect(md.body).toMatch(/^# Security report: /);
  });

  it("a targeted rerun re-checks only the undecided obligations, as a separate run that leaves the original untouched", async () => {
    const [seed] = await db.select().from(testingRun).where(and(eq(testingRun.snapshotId, snap.id), eq(testingRun.check, "security")));
    const parentId = randomUUID();
    await db.insert(testingRun).values({ id: parentId, check: "security", snapshotId: snap.id, projectId: snap.projectId, understandingRunId: seed!.understandingRunId, requestedBy: seed!.requestedBy, policy: { engine: "test" }, status: "running", generation: 1, startedAt: new Date(), heartbeatAt: new Date() });
    await processRun({ id: parentId, generation: 1 }, { provider: new FakeSecuritySandbox(), session: null });
    const parent = (await app.inject({ method: "GET", url: `/v1/security-runs/${parentId}`, headers: { cookie: owner.cookie } })).json().run as SecurityRunDetail;
    const missing = parent.obligations.filter((o) => !["passed", "failed", "not_applicable"].includes(o.status)).map((o) => o.id);
    expect(missing.length).toBeGreaterThan(0);

    // "missing" scope: a new focused run naming exactly the undecided obligations; the original is a separate record.
    const res = await app.inject({ method: "POST", url: `/v1/security-runs/${parentId}/rerun`, headers: { cookie: owner.cookie, "content-type": "application/json", "idempotency-key": randomUUID() }, payload: { scope: "missing" } });
    expect(res.statusCode).toBe(201);
    const rerunId = res.json().run.id as string;
    expect(rerunId).not.toBe(parentId);
    const [rerunRow] = await db.select().from(testingRun).where(eq(testingRun.id, rerunId));
    const stored = (rerunRow!.policy as { rerun?: { parentRunId: string; obligationIds: string[] } }).rerun!;
    expect(stored.parentRunId).toBe(parentId);
    expect([...stored.obligationIds].sort()).toEqual([...missing].sort());

    // Processing the focused rerun scopes its obligations to exactly the named set; nothing else is re-checked.
    await db.update(testingRun).set({ status: "running", generation: 1, startedAt: new Date(), heartbeatAt: new Date() }).where(eq(testingRun.id, rerunId));
    await processRun({ id: rerunId, generation: 1 }, { provider: new FakeSecuritySandbox(), session: null });
    const rerun = (await app.inject({ method: "GET", url: `/v1/security-runs/${rerunId}`, headers: { cookie: owner.cookie } })).json().run as SecurityRunDetail;
    expect(rerun.obligations.map((o) => o.id).sort()).toEqual([...missing].sort());
    // The original run still has its full obligation set.
    const after = (await app.inject({ method: "GET", url: `/v1/security-runs/${parentId}`, headers: { cookie: owner.cookie } })).json().run as SecurityRunDetail;
    expect(after.obligations.length).toBeGreaterThan(missing.length);

    // An all-decisive scope has nothing to do; naming unknown ids is rejected.
    const none = await app.inject({ method: "POST", url: `/v1/security-runs/${parentId}/rerun`, headers: { cookie: owner.cookie, "content-type": "application/json", "idempotency-key": randomUUID() }, payload: { scope: "obligations", obligationIds: ["sec:not:a:real:obligation"] } });
    expect(none.statusCode).toBe(409);
  });

  it("keeps Security review append-only and creates no sandbox repair before explicit confirmation and approval", async () => {
    const [seed] = await db.select().from(testingRun).where(and(eq(testingRun.snapshotId, snap.id), eq(testingRun.check, "security")));
    const runId = randomUUID();
    await db.insert(testingRun).values({ id: runId, check: "security", snapshotId: snap.id, projectId: snap.projectId, understandingRunId: seed!.understandingRunId, requestedBy: seed!.requestedBy, policy: { engine: "test" }, status: "completed", phase: "done", report: { headline: "test report" }, finishedAt: new Date() });
    const obligation: SecurityObligation = {
      id: "sec:repair:sql",
      lane: "injection",
      category: "sql-injection",
      asset: { kind: "endpoint", ref: "POST /orders", label: "POST /orders" },
      requirement: "Order lookup parameterizes SQL",
      expectedControl: "Bound SQL parameters",
      applicabilityEvidence: [{ path: "src/server.ts", line: 1 }],
      standards: ["CWE-89"],
      priority: "high",
      proofStrategy: "runtime_proof",
      dependencies: [],
      status: "failed",
      reason: "A controlled boolean differential reproduced the issue.",
      executionIds: [],
      findingIds: ["S1"],
    };
    const finding: SecurityFinding = {
      id: "S1",
      status: "confirmed",
      severity: "high",
      lane: "injection",
      category: "sql-injection",
      title: "SQL input changes the query",
      cwe: ["CWE-89"],
      owasp: ["A03:2021"],
      expected: "Input is bound as data.",
      observed: "A boolean differential changed the result set.",
      impact: "Another customer's records may be read.",
      location: { path: "src/server.ts", line: 1 },
      evidence: [{ path: "src/server.ts", line: 1 }],
      trust: "controlled_reproduction",
      detector: { tool: "Cybercheck", version: "test", rule: "sql" },
      secret: null,
      confirmation: "Reproduced in this run.",
      obligationIds: [obligation.id],
      executionIds: [],
      remediation: "Use a bound parameter.",
      rootCause: "sql:string-built",
    };
    await db.insert(testObligation).values({ runId, id: obligation.id, seq: 1, status: obligation.status, data: obligation });
    await db.insert(testFinding).values({ runId, id: finding.id, data: finding });

    const repairs = () => app.inject({ method: "POST", url: `/v1/security-runs/${runId}/findings/${finding.id}/repairs`, headers: { cookie: owner.cookie } });
    expect((await repairs()).statusCode).toBe(409);
    const review = await app.inject({ method: "POST", url: `/v1/security-runs/${runId}/findings/${finding.id}/reviews`, headers: { cookie: owner.cookie, "content-type": "application/json", "idempotency-key": randomUUID() }, payload: { decision: "confirmed", reason: "Reviewed the proof" } });
    expect(review.statusCode).toBe(201);
    expect(review.json().review).toMatchObject({ findingId: finding.id, decision: "confirmed", reason: "Reviewed the proof" });
    const requested = await repairs();
    expect(requested.statusCode).toBe(201);
    expect(requested.json().repair).toMatchObject({ runId, findingId: finding.id, status: "awaiting_approval", approvedBy: null, scope: { files: ["src/server.ts"] } });
    const repairId = requested.json().repair.id as string;
    const [stored] = await db.select().from(testingRepair).where(eq(testingRepair.id, repairId));
    expect(stored).toMatchObject({ status: "awaiting_approval", workerId: null, approvedBy: null });

    const cancelled = await app.inject({ method: "POST", url: `/v1/testing-repairs/${repairId}/cancel`, headers: { cookie: owner.cookie } });
    expect(cancelled.statusCode).toBe(202);
    expect(cancelled.json().repair.status).toBe("cancelled");
  });

  it("cancels a queued Security run, and fences a stale worker's late writes", async () => {
    const run = (await startSecurity(owner, snap.id)).json().run as SecurityRunSummary;
    const cancelled = await app.inject({ method: "POST", url: `/v1/security-runs/${run.id}/cancel`, headers: { cookie: owner.cookie } });
    expect(cancelled.statusCode).toBe(202);
    const [row] = await db.select().from(testingRun).where(eq(testingRun.id, run.id));
    expect(row!.cancelRequested).toBe(true);

    // A worker holding generation 1 after another claimed generation 2 writes nothing.
    const stale = (await startSecurity(owner, snap.id)).json().run as SecurityRunSummary;
    await db.update(testingRun).set({ status: "running", generation: 2, heartbeatAt: new Date() }).where(eq(testingRun.id, stale.id));
    await processRun({ id: stale.id, generation: 1 }, { provider: noSandbox, session: null });
    const [after] = await db.select().from(testingRun).where(eq(testingRun.id, stale.id));
    expect(after).toMatchObject({ status: "running", generation: 2, error: null });
    await db.update(testingRun).set({ status: "cancelled", cancelRequested: true, phase: "done" }).where(eq(testingRun.id, stale.id));
  });
});
