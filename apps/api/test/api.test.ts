import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { ProjectSummary, SnapshotSummary } from "@cybercheck/contracts";
import { buildApp } from "../src/app.ts";
import { auth } from "../src/auth/auth.ts";
import { db, pool } from "../src/db/client.ts";
import { project, snapshot, user } from "../src/db/schema.ts";
import { recoverInterruptedSnapshots } from "../src/intake/pipeline.ts";
import { INTAKE_POLICY_VERSION } from "../src/intake/policy.ts";
import { demoProject, makeZip } from "./fixtures.ts";

let app: FastifyInstance;
const ORIGIN = { origin: "http://localhost:3000" };

type Account = { cookie: string; workspaceId: string; userId: string };

async function account(name: string): Promise<Account> {
  const email = `api-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  const password = "integration-test-password";
  const created = await auth.api.signUpEmail({ body: { name, email, password } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.user.id));
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { ...ORIGIN, "content-type": "application/json" },
    payload: { email, password },
  });
  expect(res.statusCode).toBe(200);
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie!]).map((c) => c.split(";")[0]).join("; ");
  const me = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
  return { cookie, userId: created.user.id, workspaceId: me.json().workspaces[0].id };
}

function multipart(file: Buffer, fields: Record<string, string>, filename = "project.zip") {
  const boundary = `----cc${randomUUID()}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`,
    ),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function createProject(a: Account, name = `proj-${randomUUID().slice(0, 8)}`) {
  const res = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${a.workspaceId}/projects`,
    headers: { cookie: a.cookie, "content-type": "application/json" },
    payload: { name, sourceType: "archive" },
  });
  expect(res.statusCode).toBe(201);
  return res.json().project as ProjectSummary;
}

async function upload(a: Account, projectId: string, file: Buffer, key = randomUUID(), attest = "true") {
  const body = multipart(file, { attest });
  return app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/snapshots/archive`,
    headers: { cookie: a.cookie, "content-type": body.contentType, "idempotency-key": key },
    payload: body.payload,
  });
}

async function waitForFinal(a: Account, snapshotId: string): Promise<SnapshotSummary> {
  for (let i = 0; i < 100; i++) {
    const res = await app.inject({ method: "GET", url: `/v1/snapshots/${snapshotId}`, headers: { cookie: a.cookie } });
    const s = res.json().snapshot as SnapshotSummary;
    if (!["RECEIVED", "VALIDATING"].includes(s.status)) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("snapshot never finished");
}

const demoZip = makeZip(Object.entries(demoProject).map(([name, data]) => ({ name, data, deflate: true })));

let alice: Account;
let bob: Account;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  alice = await account("alice");
  bob = await account("bob");
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe("project intake API", () => {
  it("creates a project, accepts an upload, and baselines it with events", async () => {
    const p = await createProject(alice);
    const res = await upload(alice, p.id, demoZip);
    expect(res.statusCode).toBe(202);
    const created = res.json().snapshot as SnapshotSummary;
    expect(created.status).toBe("RECEIVED");

    const final = await waitForFinal(alice, created.id);
    expect(final.status).toBe("BASELINED");
    expect(final.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(final.fileCount).toBe(Object.keys(demoProject).length);
    expect(final.detection?.typescript).toBe(true);

    const detail = await app.inject({ method: "GET", url: `/v1/snapshots/${created.id}`, headers: { cookie: alice.cookie } });
    const types = (detail.json().events as Array<{ type: string }>).map((e) => e.type);
    expect(types).toEqual(["received", "validating", "extracting", "normalizing", "detecting", "baselined"]);

    // SSE replays history and closes after the terminal event.
    const sse = await app.inject({ method: "GET", url: `/v1/snapshots/${created.id}/events?after=2`, headers: { cookie: alice.cookie } });
    expect(sse.headers["content-type"]).toContain("text/event-stream");
    expect(sse.body).toContain("event: intake");
    expect(sse.body).not.toContain('"type":"received"');
    expect(sse.body).toContain('"type":"baselined"');

    const tree = await app.inject({ method: "GET", url: `/v1/snapshots/${created.id}/tree`, headers: { cookie: alice.cookie } });
    expect(tree.json().tree.map((f: { path: string }) => f.path)).toContain("package.json");

    const list = await app.inject({ method: "GET", url: `/v1/workspaces/${alice.workspaceId}/projects`, headers: { cookie: alice.cookie } });
    const listed = (list.json().projects as ProjectSummary[]).find((x) => x.id === p.id)!;
    expect(listed.latestSnapshot?.status).toBe("BASELINED");
  });

  it("records rejection reasons for a hostile archive", async () => {
    const p = await createProject(alice);
    const res = await upload(alice, p.id, makeZip([{ name: "../../evil.js", data: "x" }]));
    const final = await waitForFinal(alice, res.json().snapshot.id);
    expect(final.status).toBe("REJECTED");
    expect(final.rejectionReasons[0]?.code).toBe("path_traversal");
  });

  it("requires ownership confirmation", async () => {
    const p = await createProject(alice);
    const res = await upload(alice, p.id, demoZip, randomUUID(), "false");
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("attestation_required");
  });

  it("is idempotent: same key + same file returns the same snapshot; different file is refused", async () => {
    const p = await createProject(alice);
    const key = randomUUID();
    const first = await upload(alice, p.id, demoZip, key);
    const again = await upload(alice, p.id, demoZip, key);
    expect(again.statusCode).toBe(202);
    expect(again.json().snapshot.id).toBe(first.json().snapshot.id);

    const other = await upload(alice, p.id, makeZip([{ name: "x.js", data: "different" }]), key);
    expect(other.statusCode).toBe(422);
    expect(other.json().code).toBe("idempotency_key_reused");
    await waitForFinal(alice, first.json().snapshot.id);
  });

  it("rejects duplicate project names in a workspace", async () => {
    const name = `dup-${randomUUID().slice(0, 6)}`;
    await createProject(alice, name);
    const res = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${alice.workspaceId}/projects`,
      headers: { cookie: alice.cookie, "content-type": "application/json" },
      payload: { name, sourceType: "archive" },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("tenant isolation", () => {
  it("hides one user's projects and snapshots from another (404, not 403)", async () => {
    const p = await createProject(alice);
    const up = await upload(alice, p.id, demoZip);
    const sid = up.json().snapshot.id as string;
    await waitForFinal(alice, sid);

    const asBob = { cookie: bob.cookie };
    for (const url of [
      `/v1/projects/${p.id}`,
      `/v1/snapshots/${sid}`,
      `/v1/snapshots/${sid}/tree`,
      `/v1/snapshots/${sid}/events`,
      `/v1/workspaces/${alice.workspaceId}/projects`,
    ]) {
      const res = await app.inject({ method: "GET", url, headers: asBob });
      expect(res.statusCode, url).toBe(404);
    }
    const bobUpload = await upload(bob, p.id, demoZip);
    expect(bobUpload.statusCode).toBe(404);
    const bobCreate = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${alice.workspaceId}/projects`,
      headers: { cookie: bob.cookie, "content-type": "application/json" },
      payload: { name: "intruder", sourceType: "archive" },
    });
    expect(bobCreate.statusCode).toBe(404);
  });

  it("requires a session", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/workspaces/${alice.workspaceId}/projects` });
    expect(res.statusCode).toBe(401);
  });
});

describe("restart recovery", () => {
  it("marks snapshots interrupted mid-processing as FAILED", async () => {
    const p = await createProject(alice);
    const id = randomUUID();
    await db.insert(snapshot).values({
      id,
      projectId: p.id,
      status: "VALIDATING",
      sourceType: "archive",
      intakePolicyVersion: INTAKE_POLICY_VERSION,
      ownershipAttestedAt: new Date(),
      attestedBy: alice.userId,
    });
    await recoverInterruptedSnapshots();
    const [row] = await db.select().from(snapshot).where(eq(snapshot.id, id));
    expect(row!.status).toBe("FAILED");
    expect(row!.error).toContain("interrupted");
    await db.delete(project).where(eq(project.id, p.id));
  });
});
