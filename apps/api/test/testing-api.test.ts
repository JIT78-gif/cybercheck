import { createHash, randomUUID } from "node:crypto";
import { buffer } from "node:stream/consumers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { FindingHumanReview, ReviewedReport, SnapshotSummary, TestingProjectStatus, TestingRepair, TestingRunDetail, TestingRunSummary } from "@cybercheck/contracts";
import { buildApp } from "../src/app.ts";
import { auth } from "../src/auth/auth.ts";
import { db, pool } from "../src/db/client.ts";
import { snapshot, testingRun, user, workspaceMember } from "../src/db/schema.ts";
import { objectStore } from "../src/storage/object-store.ts";
import { providers } from "../src/env.ts";
import type { SandboxProvider, SandboxRunRequest, SandboxRunResult } from "../src/testing/sandbox/provider.ts";
import { processRun, runRepair } from "../src/testing/worker.ts";
import { expressShop, makeZip } from "./fixtures.ts";

let app: FastifyInstance;
type Account = { cookie: string; workspaceId: string };

async function account(name: string): Promise<Account> {
  const email = `tst-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;
  const password = "testing-check-pass";
  const created = await auth.api.signUpEmail({ body: { name, email, password } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.user.id));
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { origin: "http://localhost:3000", "content-type": "application/json", "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250) + 1}` },
    payload: { email, password },
  });
  const sc = res.headers["set-cookie"];
  const cookie = (Array.isArray(sc) ? sc : [sc!]).map((c) => c.split(";")[0]).join("; ");
  const me = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
  return { cookie, workspaceId: me.json().workspaces[0].id };
}

// The shop fixture with a start script, so the rules-based boot plan can start it.
const pkg = JSON.parse(expressShop["package.json"]!);
// A public health route gives the load test a read endpoint it may call without signing in.
const shop = { ...expressShop, "src/server.ts": expressShop["src/server.ts"]!.replace("app.use(cors());", 'app.use(cors());\napp.get("/health", (req, res) => res.json({ ok: true }));'), "package.json": JSON.stringify({ ...pkg, scripts: { ...pkg.scripts, start: "node dist/server.js", typecheck: "tsc --noEmit" } }) };
const zip = makeZip(Object.entries(shop).map(([name, data]) => ({ name: `shop/${name}`, data, deflate: true })));

async function uploadProject(a: Account): Promise<SnapshotSummary & { projectId: string }> {
  const p = await app.inject({ method: "POST", url: `/v1/workspaces/${a.workspaceId}/projects`, headers: { cookie: a.cookie, "content-type": "application/json" }, payload: { name: `shop-${randomUUID().slice(0, 6)}`, sourceType: "archive" } });
  const projectId = p.json().project.id as string;
  const boundary = `----b${randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attest"\r\n\r\ntrue\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="shop.zip"\r\nContent-Type: application/zip\r\n\r\n`),
    zip,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
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

const start = (a: Account, snapshotId: string, key: string | null = randomUUID()) =>
  app.inject({ method: "POST", url: `/v1/snapshots/${snapshotId}/checks/testing`, headers: { cookie: a.cookie, ...(key ? { "idempotency-key": key } : {}) } });

/**
 * A scripted sandbox: no cloud, deterministic answers by command. It plays a project whose
 * typecheck fails, whose suite has one flaky test, and whose app answers 500 to one probe.
 */
class FakeSandbox implements SandboxProvider {
  readonly name = "fake";
  readonly uploads = new Map<string, Buffer>();
  readonly commands: SandboxRunRequest[] = [];
  private suiteRun = 0;
  /** The probe this fake app crashes on (the first one that is not a no-credentials check). */
  crashed: string | null = null;
  private files = new Map<string, Map<string, Buffer>>();

  async preflight() {
    return { ok: true, status: "available" as const, detail: "fake" };
  }
  async image() {
    return "base";
  }
  async upload(b: Buffer) {
    const id = `file-${this.uploads.size + 1}`;
    this.uploads.set(id, b);
    return id;
  }
  async readFile(image: string, path: string) {
    return this.files.get(image)?.get(path) ?? null;
  }
  async run(req: SandboxRunRequest): Promise<SandboxRunResult> {
    this.commands.push(req);
    const img = `img-${this.commands.length}`;
    const out = (exitCode: number, stdout = "", files: Record<string, string> = {}): SandboxRunResult => {
      this.files.set(img, new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])));
      return { operationId: `op-${this.commands.length}`, status: "ok", exitCode, stdout, stderr: "", truncated: false, resultImage: req.keep ? img : null, durationMs: 10, cpuSeconds: 1, maxRssKb: 1000, error: null };
    };
    const c = req.command;
    if (c.includes("load.mjs")) {
      // k6 stages: steady numbers, and a breakpoint that gives way above 180 requests per second.
      const specId = req.files!.find((f) => f.path === "/cc/loadspec.json")!.fileId;
      const spec = JSON.parse(this.uploads.get(specId)!.toString()) as { stages: string[] };
      this.loadStages.push(spec.stages);
      const series = [10, 60, 120, 180, 150].map((rps, t) => ({ t, rps, p50Ms: 5, p95Ms: t < 4 ? 40 : 900, errorRatePct: t < 4 ? 0 : 20, vus: 10 + t * 20 }));
      const stages = spec.stages.map((name) => ({ name, vus: name === "breakpoint" ? 90 : 20, durationSec: 30, requests: 900, rps: 30, errorRatePct: name === "breakpoint" ? 6 : 0, p50Ms: 5, p95Ms: 12, maxMs: 40, status4xx: 0, status429: 0, status5xx: 0, appAlive: true, output: null, series: name === "breakpoint" ? series : [{ t: 0, rps: 30, p50Ms: 5, p95Ms: 12, errorRatePct: 0, vus: 20 }], limitRps: name === "breakpoint" ? 180 : null, brokeBy: name === "breakpoint" ? "errors" : null, reportName: `k6-${name}.html` }));
      const load = { boot: { ok: true, reason: null }, requests: [{ method: "GET", path: "/health", identity: null }], excluded: [], stages, recovery: { ok: true, status: 200, ms: 300, appExited: false }, error: null };
      return out(0, "load: done", { "/out/load.json": JSON.stringify(load), "/out/server.log": "", ...Object.fromEntries(spec.stages.map((n) => [`/out/k6-${n}.html`, `<html><script>dashboard()</script>${n}</html>`])) });
    }
    if (c.includes("tar xzf")) return out(0, "v22.0.0");
    if (c.includes("npm ci") || c.includes("npm install")) return out(0, "added 10 packages");
    if (c.includes("npm run typecheck")) return out(2, "src/server.ts(3,1): error TS2307: Cannot find module './routes/orders'.");
    if (c.includes("npm run build")) return out(0, "");
    if (c.includes("vitest run")) {
      // The second run fails one test: flaky.
      const n = ++this.suiteRun;
      const bad = n === 2 ? `<failure message="expected 2 to be 1">AssertionError: expected 2 to be 1</failure>` : "";
      const xml = `<testsuites><testcase classname="src/a.test.ts" name="adds" time="0.01"></testcase><testcase classname="src/a.test.ts" name="sometimes" time="0.01">${bad}</testcase></testsuites>`;
      return out(bad ? 1 : 0, "", { "/out/suite-root.junit.xml": xml });
    }
    if (c.includes("harness.mjs")) {
      const specId = req.files!.find((f) => f.path === "/cc/spec.json")!.fileId;
      const spec = JSON.parse(this.uploads.get(specId)!.toString());
      const probes = spec.probes.map((p: { id: string; steps: Array<{ method: string; path: string }> }) => {
        if (!this.crashed && !p.id.endsWith(":unauthenticated") && !p.id.includes("/health")) this.crashed = p.id;
        // A repair's patched file, mounted over the project, fixes the crash.
        const patched = (req.files ?? []).some((f) => f.path.startsWith("/work/app/"));
        const crash = p.id === this.crashed && !patched;
        return { id: p.id, ok: !crash, steps: p.steps.map((s) => ({ method: s.method, path: s.path, status: crash ? 500 : 401, ms: 3, ok: !crash, why: crash ? "server error 500" : null, body: crash ? '{"error":"Cannot read properties of undefined (reading \'id\')"}' : "", logFrom: 0, logTo: 0 })) };
      });
      const harness = { prepare: [{ command: "npm run build", exitCode: 0, ms: 5, tail: "" }], boot: { ok: true, ms: 800, reason: null, exitCode: null }, identities: [], probes, latencies: [3, 4, 5, 9] };
      return out(0, "harness: boot=true", { "/out/harness.json": JSON.stringify(harness), "/out/server.log": "TypeError: Cannot read properties of undefined (reading 'id')\n    at src/routes/orders.ts:5:10\n" });
    }
    return out(0, "");
  }
  /** The load stages each load run was asked for. */
  readonly loadStages: string[][] = [];
}

let alice: Account;
let bob: Account;
let snap: SnapshotSummary & { projectId: string };
/** A finished Standard run, reused by the review tests. */
let standardRunId = "";

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  alice = await account("alice");
  bob = await account("bob");
  snap = await uploadProject(alice);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("Testing check API", () => {
  it("requires an idempotency key and refuses other users", async () => {
    expect((await start(alice, snap.id, null)).statusCode).toBe(400);
    expect((await start(bob, snap.id)).statusCode).toBe(404);
  });

  it.skipIf(!providers.sandbox)("starts one run per snapshot; repeats and second clicks join it; cancel stops a queued run", async () => {
    const key = randomUUID();
    const first = await start(alice, snap.id, key);
    expect(first.statusCode).toBe(201);
    const run = first.json().run as TestingRunSummary;
    expect(run.status).toBe("queued");
    const replay = await start(alice, snap.id, key);
    expect(replay.json().run.id).toBe(run.id);
    const second = await start(alice, snap.id);
    expect(second.statusCode).toBe(200);
    expect(second.json().run.id).toBe(run.id);

    const list = await app.inject({ method: "GET", url: `/v1/projects/${snap.projectId}/testing-runs`, headers: { cookie: alice.cookie } });
    expect(list.json().runs.map((r: TestingRunSummary) => r.id)).toContain(run.id);
    expect((await app.inject({ method: "GET", url: `/v1/testing-runs/${run.id}`, headers: { cookie: bob.cookie } })).statusCode).toBe(404);

    const cancelled = await app.inject({ method: "POST", url: `/v1/testing-runs/${run.id}/cancel`, headers: { cookie: alice.cookie } });
    expect(cancelled.statusCode).toBe(202);
    expect(cancelled.json().run.status).toBe("cancelled");
  });

  it("runs the whole pipeline on a scripted sandbox: type errors, flaky tests and a 500 are reported with evidence", async () => {
    const [ur] = await db.execute<{ id: string }>(`select id from understanding_run where snapshot_id = '${snap.id}' and status = 'ready' order by created_at desc limit 1` as never).then((r) => (r as unknown as { rows: Array<{ id: string }> }).rows);
    const runId = randomUUID();
    const [me] = await db.select().from(user).limit(1);
    await db.insert(testingRun).values({ id: runId, snapshotId: snap.id, projectId: snap.projectId, understandingRunId: ur!.id, requestedBy: me!.id, policy: { profile: "deep" }, status: "running", generation: 1, startedAt: new Date(), heartbeatAt: new Date() });
    const fake = new FakeSandbox();
    await processRun({ id: runId, generation: 1 }, { provider: fake, session: null });

    const detail = (await app.inject({ method: "GET", url: `/v1/testing-runs/${runId}`, headers: { cookie: alice.cookie } })).json().run as TestingRunDetail;
    expect(detail.status).toBe("completed");
    const ob = (id: string) => detail.obligations.find((o) => o.id === id);
    expect(ob("env:install:.")?.status).toBe("passed");
    expect(ob("env:typecheck:.")?.status).toBe("failed");
    expect(ob("env:boot:.")?.status).toBe("passed");
    expect(ob("suite:runs:.")?.status).toBe("passed");
    expect(ob("suite:passes:.")?.status).toBe("flaky");
    expect(fake.crashed).not.toBeNull();
    expect(ob(fake.crashed!.replace(/^p:/, ""))?.status).toBe("failed");
    // Protected endpoints with no way to sign in are blocked with a reason, never passed.
    expect(detail.obligations.filter((o) => o.status === "blocked" && o.layer === "api").every((o) => Boolean(o.reason))).toBe(true);
    // Live third-party calls are never made, and screens are not opened in this version.
    expect(detail.obligations.filter((o) => o.layer === "integration").every((o) => o.status === "blocked")).toBe(true);

    const kinds = detail.findings.map((f) => `${f.kind}:${f.status}`);
    // The type error is a confirmed product defect found by the compiler (layer environment).
    expect(detail.findings.find((f) => f.kind === "product_defect" && f.layer === "environment")?.status).toBe("confirmed");
    expect(kinds).toContain("flaky:confirmed");
    // Without AI triage and an independent review, a 500 is reported but never "confirmed".
    expect(detail.findings.find((f) => f.kind === "product_defect" && f.layer === "api")?.status).toBe("suspected");
    expect(detail.findings.find((f) => f.kind === "flaky")?.title).toContain("sometimes");

    // Every obligation is terminal, the audit passes, and no command ran with the network on except installs.
    expect(detail.obligations.every((o) => o.status !== "planned" && o.status !== "running")).toBe(true);
    expect(detail.report!.audit.filter((a) => !a.ok)).toEqual([]);
    expect(fake.commands.filter((c) => c.network).every((c) => /npm (ci|install)|k6/.test(c.command))).toBe(true);
    // Deep profile: the suite is sampled four times, which is how the flaky test shows.
    expect(fake.commands.filter((c) => c.command.includes("vitest run"))).toHaveLength(4);
    expect(detail.report!.completeness!.threshold).toBe(90);
    // Three separate answers: the build failure makes the release not ready, whatever else passed.
    expect(detail.report!.release!.decision).toBe("not_ready_product_failures");
    expect(detail.report!.headline.startsWith("Not ready: confirmed product defects.")).toBe(true);
    expect(detail.report!.completeness!.percent).toBeGreaterThan(0);
    expect(detail.report!.completeness!.percent).toBeLessThan(90);
    expect(detail.report!.claims!.some((c) => c.kind === "problem" && /Typecheck failed/.test(c.text))).toBe(true);
    expect(detail.report!.layers!.find((l) => l.layer === "existing_suite")?.flaky).toBe(1);
    expect(detail.report!.headline).not.toMatch(/everything passed/i);
    expect(detail.executions.length).toBeGreaterThanOrEqual(7);
    // The reproduction run only repeats the failed request.
    const probeRuns = fake.commands.filter((c) => c.command.includes("harness.mjs"));
    expect(probeRuns).toHaveLength(2);

    // Deep load: every stage in order, the breakpoint with its limit and second-by-second series, and k6's own report.
    expect(fake.loadStages).toEqual([["smoke", "average", "stress", "spike", "breakpoint"]]);
    const load = detail.report!.load!;
    expect(load.stages.map((s) => s.name)).toEqual(["smoke", "average", "stress", "spike", "breakpoint"]);
    const bp = load.stages.find((s) => s.name === "breakpoint")!;
    expect(bp).toMatchObject({ limitRps: 180, brokeBy: "errors", verdict: "measured", reportName: "k6-breakpoint.html" });
    expect(bp.series).toHaveLength(5);
    expect(ob("perf:breakpoint")?.status).toBe("passed");
    expect(ob("perf:breakpoint")?.reason).toMatch(/Handled up to about 180 requests per second/);
    // The report downloads as a file and is sandboxed: it never runs as a page of this site.
    const html = await app.inject({ method: "GET", url: `/v1/testing-runs/${runId}/executions/${load.executionId}/artifacts/k6-breakpoint.html`, headers: { cookie: alice.cookie } });
    expect(html.statusCode).toBe(200);
    expect(html.headers["content-disposition"]).toBe('attachment; filename="k6-breakpoint.html"');
    expect(html.headers["content-security-policy"]).toBe("sandbox");
    expect((await app.inject({ method: "GET", url: `/v1/testing-runs/${runId}/executions/${load.executionId}/artifacts/k6-breakpoint.html`, headers: { cookie: bob.cookie } })).statusCode).toBe(404);

    // The finished run downloads as a Markdown report and as the full JSON ledger, for its owner only.
    const md = await app.inject({ method: "GET", url: `/v1/testing-runs/${runId}/export?format=md`, headers: { cookie: alice.cookie } });
    expect(md.statusCode).toBe(200);
    expect(md.headers["content-disposition"]).toMatch(/attachment; filename=".+-testing-\d{4}-\d{2}-\d{2}\.md"/);
    expect(md.body).toContain("# Testing report:");
    expect(md.body).toContain(detail.report!.headline);
    expect(md.body).toContain("## Missing evidence");
    expect(md.body).toContain("## Release decision: Not ready: confirmed product defects");
    expect(md.body).toContain("Reproduce:");
    const json = await app.inject({ method: "GET", url: `/v1/testing-runs/${runId}/export?format=json`, headers: { cookie: alice.cookie } });
    expect(json.statusCode).toBe(200);
    expect(json.headers["content-disposition"]).toMatch(/\.json"/);
    const parsed = JSON.parse(json.body) as TestingRunDetail;
    expect(parsed.id).toBe(runId);
    expect(parsed.obligations.length).toBe(detail.obligations.length);
    expect((await app.inject({ method: "GET", url: `/v1/testing-runs/${runId}/export?format=md`, headers: { cookie: bob.cookie } })).statusCode).toBe(404);
  });

  it("Standard runs a healthy suite once and aims at 70% completeness", async () => {
    const [ur] = await db.execute<{ id: string }>(`select id from understanding_run where snapshot_id = '${snap.id}' and status = 'ready' order by created_at desc limit 1` as never).then((r) => (r as unknown as { rows: Array<{ id: string }> }).rows);
    const runId = randomUUID();
    const [me] = await db.select().from(user).limit(1);
    await db.insert(testingRun).values({ id: runId, snapshotId: snap.id, projectId: snap.projectId, understandingRunId: ur!.id, requestedBy: me!.id, policy: {}, status: "running", generation: 1, startedAt: new Date(), heartbeatAt: new Date() });
    const fake = new FakeSandbox();
    await processRun({ id: runId, generation: 1 }, { provider: fake, session: null });
    standardRunId = runId;
    const detail = (await app.inject({ method: "GET", url: `/v1/testing-runs/${runId}`, headers: { cookie: alice.cookie } })).json().run as TestingRunDetail;
    // The first run passes, so the suite is not run again: no repeated sampling on Standard.
    expect(fake.commands.filter((c) => c.command.includes("vitest run"))).toHaveLength(1);
    expect(detail.obligations.find((o) => o.id === "suite:passes:.")?.status).toBe("passed");
    // Load is off by default on Standard: only the one-user smoke test runs (no 20-user stage behind the user's back).
    expect(fake.loadStages).toEqual([["smoke"]]);
    expect(detail.obligations.find((o) => o.id === "perf:average")?.status).toBe("skipped");
    expect(detail.report!.completeness!.threshold).toBe(70);
    expect(detail.report!.release!.gates.find((g) => g.id === "completeness")?.label).toBe("Testing completeness reached the 70% target");
  });

  it("lets every workspace member review findings, keeps every decision, and never turns a rejected check into a pass", async () => {
    const runId = standardRunId;
    const url = (f: string) => `/v1/testing-runs/${runId}/findings/${f}/reviews`;
    const before = (await app.inject({ method: "GET", url: `/v1/testing-runs/${runId}`, headers: { cookie: alice.cookie } })).json().run as TestingRunDetail;
    const products = before.findings.filter((f) => f.kind === "product_defect" && f.status !== "rejected");
    expect(products.length).toBeGreaterThanOrEqual(2);
    const [a, b] = products as [TestingRunDetail["findings"][number], TestingRunDetail["findings"][number]];
    const post = (who: Account, f: string, decision: string, key = randomUUID(), reason: string | null = null) =>
      app.inject({ method: "POST", url: url(f), headers: { cookie: who.cookie, "idempotency-key": key, "content-type": "application/json" }, payload: { decision, reason } });

    // An outsider cannot see the run; any member of the workspace may decide, and the role is recorded.
    const carol = await account("carol");
    const carolEmail = (await app.inject({ method: "GET", url: "/v1/me", headers: { cookie: carol.cookie } })).json().user.email as string;
    const [carolUser] = await db.select().from(user).where(eq(user.email, carolEmail));
    await db.insert(workspaceMember).values({ workspaceId: alice.workspaceId, userId: carolUser!.id, role: "member" });
    expect((await post(bob, a.id, "confirmed")).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/v1/testing-runs/${runId}/reviewed-report`, headers: { cookie: carol.cookie } })).json().reviewed.canReview).toBe(true);
    const byMember = await post(carol, b.id, "unsure");
    expect(byMember.statusCode).toBe(201);
    expect(byMember.json().review.reviewerRole).toBe("member");
    // A review needs a request id; replaying it returns the same review; reusing it for another decision is refused.
    expect((await app.inject({ method: "POST", url: url(a.id), headers: { cookie: alice.cookie, "content-type": "application/json" }, payload: { decision: "confirmed" } })).statusCode).toBe(400);
    const key = randomUUID();
    const first = await post(alice, a.id, "confirmed", key, "Reproduced it locally");
    expect(first.statusCode).toBe(201);
    const again = await post(alice, a.id, "confirmed", key, "Reproduced it locally");
    expect(again.statusCode).toBe(200);
    expect(again.json().review.id).toBe(first.json().review.id);
    expect((await post(alice, a.id, "rejected", key)).statusCode).toBe(422);

    const rejected = await post(alice, b.id, "rejected", randomUUID(), "Intended behaviour");
    expect(rejected.statusCode).toBe(201);
    const reviewed = rejected.json().reviewed as ReviewedReport;
    expect(reviewed.findings.find((f) => f.findingId === a.id)).toMatchObject({ queue: "confirmed", repairEligible: true });
    expect(reviewed.findings.find((f) => f.findingId === b.id)).toMatchObject({ queue: "rejected", repairEligible: false });
    expect(reviewed.reviewed.openDefects).toBeLessThan(reviewed.machine.openDefects);
    expect(reviewed.reviewed.completeness).toBeLessThanOrEqual(reviewed.machine.completeness);
    expect(reviewed.precision.run.percent).toBeNull();
    expect(reviewed.precision.run.text).toMatch(/Not enough reviewed findings to estimate precision/);

    // Changing a decision adds a record that supersedes the previous one; the latest is the effective one.
    const changed = await post(alice, a.id, "unsure", randomUUID(), "Need to check on staging");
    expect(changed.json().review.supersedesReviewId).toBe(first.json().review.id);
    const history = (await app.inject({ method: "GET", url: `/v1/testing-runs/${runId}/reviews`, headers: { cookie: alice.cookie } })).json().reviews as FindingHumanReview[];
    expect(history.filter((r) => r.findingId === a.id).map((r) => r.decision)).toEqual(["confirmed", "unsure"]);
    expect(history.find((r) => r.findingId === a.id)!.reviewerRole).toBe("owner");

    // The machine result is untouched: the stored report, and the checks of the rejected finding, are as before.
    const after = (await app.inject({ method: "GET", url: `/v1/testing-runs/${runId}`, headers: { cookie: alice.cookie } })).json().run as TestingRunDetail;
    expect(JSON.stringify(after.report)).toBe(JSON.stringify(before.report));
    expect(after.findings.find((f) => f.id === b.id)?.status).toBe(b.status);
    for (const id of b.obligationIds) expect(after.obligations.find((o) => o.id === id)?.status).not.toBe("passed");

    // An unsure finding can get a targeted evidence run of just its checks.
    const targeted = await app.inject({ method: "POST", url: `/v1/testing-runs/${runId}/targeted-runs`, headers: { cookie: alice.cookie, "idempotency-key": randomUUID(), "content-type": "application/json" }, payload: { findingIds: [a.id] } });
    expect(targeted.statusCode).toBe(201);
    expect(targeted.json().obligations).toBe(new Set(a.obligationIds).size);
    await db.update(testingRun).set({ status: "cancelled", cancelRequested: true }).where(eq(testingRun.id, targeted.json().run.id));
  });

  it("repairs a confirmed finding only after approval, only inside sandboxes, and never changes the snapshot", async () => {
    const runId = standardRunId;
    const before = (await app.inject({ method: "GET", url: `/v1/testing-runs/${runId}`, headers: { cookie: alice.cookie } })).json().run as TestingRunDetail;
    const crash = before.findings.find((f) => f.kind === "product_defect" && /500/.test(`${f.title} ${f.actual}`))!;
    expect(crash).toBeTruthy();
    const review = (decision: string) => app.inject({ method: "POST", url: `/v1/testing-runs/${runId}/findings/${crash.id}/reviews`, headers: { cookie: alice.cookie, "idempotency-key": randomUUID(), "content-type": "application/json" }, payload: { decision } });
    const ask = (who: Account) => app.inject({ method: "POST", url: `/v1/testing-runs/${runId}/findings/${crash.id}/repairs`, headers: { cookie: who.cookie } });
    const approve = (repairId: string, key: string | null = randomUUID()) => app.inject({ method: "POST", url: `/v1/testing-runs/${runId}/findings/${crash.id}/repair-approvals`, headers: { cookie: alice.cookie, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, payload: { repairId } });

    // No repair without a human confirmation.
    await review("unsure");
    expect((await ask(alice)).json().code).toBe("not_confirmed");
    await review("confirmed");
    // Any workspace member may ask; outsiders cannot even see the run.
    const dave = await account("dave");
    const daveEmail = (await app.inject({ method: "GET", url: "/v1/me", headers: { cookie: dave.cookie } })).json().user.email as string;
    const [daveUser] = await db.select().from(user).where(eq(user.email, daveEmail));
    await db.insert(workspaceMember).values({ workspaceId: alice.workspaceId, userId: daveUser!.id, role: "member" });
    expect((await ask(bob)).statusCode).toBe(404);

    // Asking shows the scope and waits: nothing runs until an explicit approval.
    const asked = await ask(dave);
    expect(asked.statusCode).toBe(201);
    const pending = asked.json().repair as TestingRepair;
    expect(pending.status).toBe("awaiting_approval");
    expect(pending.scope.files.length).toBeGreaterThan(0);
    const target = pending.scope.files[0]!;
    expect(pending.scope.reproduction).toEqual(crash.obligationIds);
    expect(pending.scope.maxAttempts).toBe(2);
    expect((await approve(pending.id, null)).statusCode).toBe(400);
    const approved = await approve(pending.id);
    expect(approved.statusCode).toBe(202);
    expect(approved.json().repair.status).toBe("running");

    const [snapBefore] = await db.select().from(snapshot).where(eq(snapshot.id, snap.id));
    const archiveBefore = createHash("sha256").update(await buffer(objectStore.get(snapBefore!.archiveObjectKey!))).digest("hex");
    const fake = new FakeSandbox();
    const done = await runRepair(pending.id, {
      provider: fake,
      session: null,
      propose: async (input) => {
        const file = input.files.find((f) => f.path === target)!;
        const first = file.text.split("\n")[0]!;
        return { summary: "Validate the input before using it.", edits: [{ path: target, find: first, replace: `${first}\n// validated by cybercheck repair` }] };
      },
    });
    expect(done.status).toBe("verified");
    const attempt = done.attempts[0]!;
    expect(attempt.diff).toContain("+// validated by cybercheck repair");
    expect(attempt.filesChanged).toEqual([target]);
    expect(attempt.checks.filter((c) => c.role === "reproduction").every((c) => c.before !== "passed" && c.after === "passed")).toBe(true);
    expect(attempt.regressions).toEqual([]);
    // The patch was mounted only in the validation sandboxes, never in the cached install images.
    expect(fake.commands.some((c) => c.command.includes("harness.mjs") && (c.files ?? []).some((f) => f.path === `/work/app/${target}`))).toBe(true);
    expect(fake.commands.filter((c) => /tar xzf|npm (ci|install)/.test(c.command)).every((c) => !(c.files ?? []).some((f) => f.path === `/work/app/${target}`))).toBe(true);
    // The snapshot is byte for byte the same.
    const [snapAfter] = await db.select().from(snapshot).where(eq(snapshot.id, snap.id));
    expect(snapAfter!.contentDigest).toBe(snapBefore!.contentDigest);
    expect(createHash("sha256").update(await buffer(objectStore.get(snapAfter!.archiveObjectKey!))).digest("hex")).toBe(archiveBefore);

    // A patch that edits a test to hide the failure is refused before it runs.
    const again = (await ask(alice)).json().repair as TestingRepair;
    await approve(again.id);
    const refused = await runRepair(again.id, { provider: new FakeSandbox(), session: null, propose: async () => ({ summary: "Skip it.", edits: [{ path: "src/a.test.ts", find: "x", replace: "y" }] }) });
    expect(refused.status).toBe("failed_validation");
    expect(refused.attempts.every((a) => a.status === "rejected_patch" && a.validationRunId == null)).toBe(true);
    expect(refused.attempts[0]!.rejectedBecause.join(" ")).toMatch(/tests may not be edited/);

    // Before approval a repair can simply be cancelled.
    const third = (await ask(alice)).json().repair as TestingRepair;
    const cancelled = await app.inject({ method: "POST", url: `/v1/testing-repairs/${third.id}/cancel`, headers: { cookie: alice.cookie } });
    expect(cancelled.json().repair.status).toBe("cancelled");
  });

  it("lists every project of a workspace with where its testing stands", async () => {
    const run = (await app.inject({ method: "GET", url: `/v1/testing-runs/${standardRunId}`, headers: { cookie: alice.cookie } })).json().run as TestingRunDetail;
    const res = await app.inject({ method: "GET", url: `/v1/workspaces/${alice.workspaceId}/testing-status`, headers: { cookie: alice.cookie } });
    expect(res.statusCode).toBe(200);
    const mine = (res.json().projects as TestingProjectStatus[]).find((p) => p.projectId === run.projectId)!;
    // Targeted reruns and repair validations (both made by earlier tests) never count as the latest check.
    expect(mine.latest?.purpose).toBe("check");
    expect(mine.history.length).toBeGreaterThan(0);
    expect(mine.history.at(-1)!.problems).toBeGreaterThanOrEqual(0);
    expect((await app.inject({ method: "GET", url: `/v1/workspaces/${alice.workspaceId}/testing-status`, headers: { cookie: bob.cookie } })).statusCode).toBe(404);
  });

  it("refuses to export a run that is still in progress", async () => {
    const [ur] = await db.execute<{ id: string }>(`select id from understanding_run where snapshot_id = '${snap.id}' and status = 'ready' order by created_at desc limit 1` as never).then((r) => (r as unknown as { rows: Array<{ id: string }> }).rows);
    const [me] = await db.select().from(user).limit(1);
    const runId = randomUUID();
    await db.insert(testingRun).values({ id: runId, snapshotId: snap.id, projectId: snap.projectId, understandingRunId: ur!.id, requestedBy: me!.id, policy: {}, status: "running", generation: 1 });
    const res = await app.inject({ method: "GET", url: `/v1/testing-runs/${runId}/export?format=md`, headers: { cookie: alice.cookie } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("run_not_finished");
    await db.update(testingRun).set({ status: "cancelled" }).where(eq(testingRun.id, runId));
  });
});
