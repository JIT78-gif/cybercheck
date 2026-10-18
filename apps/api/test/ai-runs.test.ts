import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AiEvaluationRunDetail, SnapshotSummary } from "@cybercheck/contracts";
import { buildApp } from "../src/app.ts";
import { auth } from "../src/auth/auth.ts";
import { db, pool } from "../src/db/client.ts";
import { testingRun, understandingRun, user } from "../src/db/schema.ts";
import { providers } from "../src/env.ts";
import type { SandboxProvider, SandboxRunRequest, SandboxRunResult } from "../src/testing/sandbox/provider.ts";
import { processRun } from "../src/testing/worker.ts";
import { BENCH, projectFiles } from "./ai-helpers.ts";
import { makeZip } from "./fixtures.ts";

// AI Evaluator end to end on the shared run model: the clean AI control is uploaded and analysed for real, then a run
// goes through admission, applicability, datasets, compilation, a (scripted) sandbox run, grading, findings, the
// decision, storage and the redacted exports. The sandbox here imitates the app's answers to the replay script; the
// real harness and replay server are exercised by ai-replay.test.ts and on Docker.

let app: FastifyInstance;
type Account = { cookie: string; workspaceId: string; userId: string };

async function account(name: string): Promise<Account> {
  const email = `ai-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;
  const password = "ai-evaluator-pass";
  const created = await auth.api.signUpEmail({ body: { name, email, password } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.user.id));
  const res = await app.inject({ method: "POST", url: "/api/auth/sign-in/email", headers: { origin: "http://localhost:3000", "content-type": "application/json", "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250) + 1}` }, payload: { email, password } });
  const sc = res.headers["set-cookie"];
  const cookie = (Array.isArray(sc) ? sc : [sc!]).map((c) => c.split(";")[0]).join("; ");
  const me = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
  return { cookie, workspaceId: me.json().workspaces[0].id, userId: created.user.id };
}

async function upload(a: Account, root: string): Promise<SnapshotSummary & { projectId: string }> {
  // The scripted sandbox cannot reproduce the real app's transforms, so repository-derived cases (built from the
  // project's own tests) are not meaningful here; they are covered by ai-repository.test.ts and the Docker benchmark.
  // Dropping the project's test files keeps this end-to-end simulation deterministic.
  const files = Object.entries(projectFiles(root)).filter(([name]) => !/(^|\/)(tests?|__tests__|spec|e2e)\/|(\.|_)(test|spec)\.[cm]?[jt]sx?$/i.test(name));
  const zip = makeZip(files.map(([name, data]) => ({ name: `app/${name}`, data: Buffer.from(data), deflate: true })));
  const p = await app.inject({ method: "POST", url: `/v1/workspaces/${a.workspaceId}/projects`, headers: { cookie: a.cookie, "content-type": "application/json" }, payload: { name: `ai-${randomUUID().slice(0, 6)}`, sourceType: "archive" } });
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

type Turn = { method?: string; path: string; json?: Record<string, unknown>; replay: Array<Record<string, unknown>> | null };
type Spec = { aiCases?: Array<{ id: string; turns: Turn[] }>; graph: Array<{ id: string; kind: string }> };
const LEAK = "sk-live-abcdefghijklmnopqrstuvwxyz012345";
type ModelCall = { path: string; body: string; served: string };

/** A clean, careful control app answering one turn: the assistant POST, plus caller-scoped history and order reads. */
function answer(t: Turn, leaky: boolean): { status: number | null; body: unknown; model: ModelCall[] } {
  // Caller-scoped reads: another identity never sees the first user's note; orders are never cancelled by the model.
  if ((t.method ?? "POST") === "GET") {
    if (/history/.test(t.path)) return { status: 200, body: [], model: [] };
    if (/orders/.test(t.path)) return { status: 200, body: [{ id: "A-1002", status: "processing" }, { id: "A-1001", status: "shipped" }], model: [] };
    return { status: 200, body: {}, model: [] };
  }
  const msg = String(t.json?.message ?? "");
  if (!msg.trim() || msg.length > 2000) return { status: 400, body: { error: "The message must be 1 to 2000 characters." }, model: [] };
  const script = t.replay ?? [{ content: "Default replay answer." }];
  const model: ModelCall[] = [];
  for (let i = 0; i < 3; i++) {
    const s = script[Math.min(i, script.length - 1)]!;
    model.push({ path: "/v1/chat/completions", body: JSON.stringify({ messages: [{ role: "system", content: "You are the support assistant. Documents: [doc:shipping] Shipping takes 3 to 5 days." }, { role: "user", content: msg }] }), served: s.hang ? "hang" : s.status ? `status ${s.status}` : s.malformed ? "malformed" : Array.isArray(s.toolCalls) && s.toolCalls.length ? "tool_calls" : "content" });
    // A scripted consequential tool call: the control creates an approval and does NOT carry it out, then loops.
    if (Array.isArray(s.toolCalls) && s.toolCalls.length) continue;
    if (typeof s.content === "string") return { status: 200, body: { conversationId: 1, reply: s.content.replace(/\s*\[doc:[^\]]+\]/g, "") + (leaky ? ` Internal key: ${LEAK}` : ""), citations: [], approvals: [] }, model };
    if (s.malformed) break;
  }
  return { status: 502, body: { error: "The assistant is unavailable right now." }, model };
}

class FakeAiSandbox implements SandboxProvider {
  readonly name = "fake-ai";
  readonly commands: SandboxRunRequest[] = [];
  readonly uploads = new Map<string, Buffer>();
  private outputs = new Map<string, string>();
  constructor(private readonly leaky = false) {}
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
  async run(req: SandboxRunRequest): Promise<SandboxRunResult> {
    this.commands.push(req);
    const image = `img-${this.commands.length}`;
    if (req.command.includes("harness.mjs")) {
      const spec = JSON.parse(this.uploads.get(req.files!.find((f) => f.path === "/cc/spec.json")!.fileId)!.toString("utf8")) as Spec;
      const aiCases = (spec.aiCases ?? []).map((c) => ({ id: c.id, alive: true, appExited: false, turns: c.turns.map((t) => { const a = answer(t, this.leaky); return { status: a.status, ms: 40, body: JSON.stringify(a.body), contentType: "application/json", error: null, model: a.model }; }) }));
      this.outputs.set(image, JSON.stringify({ prepare: [], boot: { ok: true, ms: 50, reason: null, exitCode: null }, identities: spec.graph.filter((n) => n.kind === "identity").map((n) => ({ name: n.id, kind: "identity", ok: true, note: null })), fixtures: [], probes: [], latencies: [], aiCases }));
    }
    return { operationId: `op-${this.commands.length}`, status: "ok", exitCode: 0, stdout: "", stderr: "", truncated: false, resultImage: req.keep ? image : null, durationMs: 10, cpuSeconds: 1, maxRssKb: null, error: null };
  }
  async readFile(image: string, path: string) {
    if (path.endsWith("harness.json")) return this.outputs.has(image) ? Buffer.from(this.outputs.get(image)!) : null;
    if (path.endsWith("server.log")) return Buffer.from("listening\n");
    return null;
  }
}

let owner: Account;
let control: SnapshotSummary & { projectId: string };
const sandboxWas = providers.sandbox;

/** A claimed run (generation 1), so no dev worker can pick it up. */
async function claimedRun(s: SnapshotSummary & { projectId: string }, policy: Record<string, unknown> = {}) {
  const [ur] = await db.select().from(understandingRun).where(eq(understandingRun.snapshotId, s.id)).orderBy(desc(understandingRun.createdAt));
  const id = randomUUID();
  await db.insert(testingRun).values({ id, check: "ai-evaluator", snapshotId: s.id, projectId: s.projectId, understandingRunId: ur!.id, requestedBy: owner.userId, policy: { engine: "test", profile: "standard", judge: "auto", modelMode: "auto", runtime: "auto", datasetIds: [], ...policy }, status: "running", generation: 1, startedAt: new Date(), heartbeatAt: new Date() });
  return id;
}
const detail = async (id: string) => (await app.inject({ method: "GET", url: `/v1/ai-evaluation-runs/${id}`, headers: { cookie: owner.cookie } })).json().run as AiEvaluationRunDetail;

beforeAll(async () => {
  (providers as { sandbox: boolean }).sandbox = true;
  app = await buildApp();
  owner = await account("owner");
  control = await upload(owner, BENCH.aiControl);
}, 120_000);
afterAll(async () => {
  (providers as { sandbox: boolean }).sandbox = sandboxWas;
  await app.close();
  await pool.end();
});

describe("AI Evaluator runs end to end", () => {
  it("evaluates the clean AI control with the replay model and finds it ready, with evidence for every case", async () => {
    const sandbox = new FakeAiSandbox();
    const id = await claimedRun(control);
    await processRun({ id, generation: 1 }, { provider: sandbox, session: null });
    const run = await detail(id);
    expect(run.status).toBe("completed");
    const r = run.report!;
    expect(r.mode.used).toBe("replay");
    expect(run.cases.length).toBeGreaterThanOrEqual(7);
    expect(run.cases.filter((c) => c.verdict !== "passed").map((c) => `${c.id}: ${c.reason}`)).toEqual([]);
    expect(run.findings).toEqual([]);
    expect(r.audit.filter((a) => !a.ok)).toEqual([]);
    // Every case passed, including the safety cases, so every critical safety lane is decisive. The control renders
    // replies with textContent (no HTML sink), so output rendering does not apply and the component is ready.
    for (const lane of ["prompt_injection", "isolation", "tools", "leakage"]) expect(r.obligations.find((o) => o.lane === lane)!.status, lane).toBe("passed");
    expect(r.obligations.find((o) => o.lane === "output_rendering")!.status).toBe("not_applicable");
    expect(run.findings).toEqual([]);
    expect(r.decision).toBe("ready_with_evidence");
    // The app's provider base URL pointed at the loopback replay model, with a dummy key; the harness ran network off.
    const harness = sandbox.commands.find((c) => c.command.includes("harness.mjs"))!;
    expect(harness.network).toBe(false);
    expect(harness.env!.AI_BASE_URL).toBe("http://127.0.0.1:8098/v1");
    const spec = JSON.parse(sandbox.uploads.get(harness.files!.find((f) => f.path === "/cc/spec.json")!.fileId)!.toString("utf8"));
    expect(spec.replay).toEqual({ port: 8098 });
    // No request sends the answer key (it only appears in the replay script, which plays the model).
    expect(JSON.stringify(spec.aiCases.flatMap((c: { turns: Array<{ json: unknown }> }) => c.turns.map((t) => t.json)))).not.toContain("9:00 to 17:00");
  }, 60_000);

  it("confirms a credential leak in replies as a critical finding and keeps it out of every export", async () => {
    const id = await claimedRun(control, { profile: "quick" });
    await processRun({ id, generation: 1 }, { provider: new FakeAiSandbox(true), session: null });
    const run = await detail(id);
    expect(run.report!.decision).toBe("not_ready_ai_findings");
    expect(run.findings[0]).toMatchObject({ status: "confirmed", severity: "critical", rootCause: "no_credential", basis: "deterministic" });
    expect(run.findings[0]!.caseIds.length).toBeGreaterThan(1);
    expect(run.cases.some((c) => c.id === "builtin.reliability.provider-timeout")).toBe(false);
    const json = await app.inject({ method: "GET", url: `/v1/ai-evaluation-runs/${id}/export?format=json`, headers: { cookie: owner.cookie } });
    const md = await app.inject({ method: "GET", url: `/v1/ai-evaluation-runs/${id}/export?format=md`, headers: { cookie: owner.cookie } });
    expect(json.statusCode).toBe(200);
    expect(md.statusCode).toBe(200);
    for (const body of [json.body, md.body, JSON.stringify(run)]) expect(body).not.toContain(LEAK);
    expect(md.body).toContain("AI replies expose credential-like values");
  }, 60_000);

  it("runs an uploaded dataset's frozen cases next to the built-in ones, and a rerun runs only the chosen case", async () => {
    const jsonl = [
      JSON.stringify({ id: "hours", category: "functional", priority: "critical", input: { message: "When are you open?" }, expected: { contains: ["weekdays"] }, replay: [{ content: "We are open on weekdays." }] }),
      JSON.stringify({ id: "unscripted", category: "functional", input: { message: "Tell me about refunds." }, expected: { contains: ["30 days"] } }),
    ].join("\n");
    const up = await app.inject({ method: "POST", url: `/v1/projects/${control.projectId}/ai-evaluation-datasets`, headers: { cookie: owner.cookie, "content-type": "application/json" }, payload: { name: "support", content: jsonl } });
    expect(up.statusCode).toBe(201);
    const datasetId = up.json().dataset.id as string;
    const id = await claimedRun(control, { datasetIds: [datasetId], profile: "quick" });
    await processRun({ id, generation: 1 }, { provider: new FakeAiSandbox(), session: null });
    const run = await detail(id);
    expect(run.cases.find((c) => c.id === "hours")).toMatchObject({ verdict: "passed", priority: "critical", source: { kind: "uploaded", datasetId } });
    // No frozen answer: its answer check cannot be decided in replay mode.
    expect(run.cases.find((c) => c.id === "unscripted")).toMatchObject({ verdict: "inconclusive" });
    expect(run.report!.datasets.map((d) => d.source)).toEqual(["builtin", "uploaded"]);

    // Rerun through the route, then process the queued child as a claimed run.
    const rr = await app.inject({ method: "POST", url: `/v1/ai-evaluation-runs/${id}/rerun`, headers: { cookie: owner.cookie, "content-type": "application/json", "idempotency-key": randomUUID() }, payload: { scope: "cases", caseIds: ["hours"] } });
    expect(rr.statusCode).toBe(201);
    const childId = rr.json().run.id as string;
    await db.update(testingRun).set({ status: "running", generation: 1, startedAt: new Date(), heartbeatAt: new Date() }).where(and(eq(testingRun.id, childId), eq(testingRun.status, "queued")));
    await processRun({ id: childId, generation: 1 }, { provider: new FakeAiSandbox(), session: null });
    const child = await detail(childId);
    expect(child.parentRunId).toBe(id);
    expect(child.cases.map((c) => c.id)).toEqual(["hours"]);
    expect(child.report!.limitations.join(" ")).toMatch(/no verdict was copied/);
  }, 90_000);

  it("is environment-blocked, not failed, when no sandbox runtime is available", async () => {
    const down: SandboxProvider = { name: "nebius", preflight: async () => ({ ok: false, status: "billing_unavailable" as const, detail: "HTTP 402" }), image: async () => "", upload: async () => "", run: async () => { throw new Error("unused"); }, readFile: async () => null };
    const id = await claimedRun(control, { runtime: "nebius" });
    await processRun({ id, generation: 1 }, { provider: down, session: null });
    const run = await detail(id);
    expect(run.status).toBe("completed");
    expect(run.report!.decision).toBe("not_ready_environment_blocked");
    expect(run.findings).toEqual([]);
  }, 60_000);
});
