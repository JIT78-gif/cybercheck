import { randomUUID } from "node:crypto";
import { text } from "node:stream/consumers";
import { createGunzip } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import tar from "tar-stream";
import type { SnapshotSummary, SourceExcerpt, UnderstandingRun } from "@cybercheck/contracts";
import { buildApp } from "../src/app.ts";
import { auth } from "../src/auth/auth.ts";
import { db, pool } from "../src/db/client.ts";
import { snapshot, user } from "../src/db/schema.ts";
import { objectStore } from "../src/storage/object-store.ts";
import { expressShop, makeZip } from "./fixtures.ts";

let app: FastifyInstance;
type Account = { cookie: string; workspaceId: string };

async function account(name: string): Promise<Account> {
  const email = `und-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.test`;
  const password = "understanding-test-pass";
  const created = await auth.api.signUpEmail({ body: { name, email, password } });
  await db.update(user).set({ emailVerified: true }).where(eq(user.id, created.user.id));
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { origin: "http://localhost:3000", "content-type": "application/json", "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 250) + 1}` },
    payload: { email, password },
  });
  const sc = res.headers["set-cookie"];
  const cookie = (Array.isArray(sc) ? sc : [sc!]).map((c) => c.split(";")[0]).join("; ");
  const me = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
  return { cookie, workspaceId: me.json().workspaces[0].id };
}

const zip = makeZip(Object.entries(expressShop).map(([name, data]) => ({ name: `shop/${name}`, data, deflate: true })));

async function uploadProject(a: Account): Promise<SnapshotSummary> {
  const p = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${a.workspaceId}/projects`,
    headers: { cookie: a.cookie, "content-type": "application/json" },
    payload: { name: `shop-${randomUUID().slice(0, 6)}`, sourceType: "archive" },
  });
  const boundary = `----b${randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="attest"\r\n\r\ntrue\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="shop.zip"\r\nContent-Type: application/zip\r\n\r\n`),
    zip,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const up = await app.inject({
    method: "POST",
    url: `/v1/projects/${p.json().project.id}/snapshots/archive`,
    headers: { cookie: a.cookie, "content-type": `multipart/form-data; boundary=${boundary}`, "idempotency-key": randomUUID() },
    payload,
  });
  const id = up.json().snapshot.id as string;
  for (let i = 0; i < 100; i++) {
    const s = (await app.inject({ method: "GET", url: `/v1/snapshots/${id}`, headers: { cookie: a.cookie } })).json().snapshot as SnapshotSummary;
    if (s.status === "BASELINED") return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("not baselined");
}

async function understanding(a: Account, snapshotId: string): Promise<UnderstandingRun> {
  for (let i = 0; i < 150; i++) {
    const res = await app.inject({ method: "GET", url: `/v1/snapshots/${snapshotId}/understanding`, headers: { cookie: a.cookie } });
    const run = res.json().run as UnderstandingRun;
    if (run.status === "ready" || run.status === "failed") return run;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("understanding never finished");
}

let alice: Account;
let bob: Account;
let snap: SnapshotSummary;

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

describe("project understanding API", () => {
  it("never stores secret files, and tells the user which one was left out", async () => {
    expect(snap.exclusions).toContain("secret files (never stored) (1 file)");
    expect(snap.warnings.find((w) => w.code === "secret_file_excluded")?.path).toBe(".env");
    const [row] = await db.select().from(snapshot).where(eq(snapshot.id, snap.id));
    const extract = tar.extract();
    const names: string[] = [];
    let contents = "";
    const done = (async () => {
      for await (const e of extract) {
        names.push(e.header.name);
        contents += await text(e);
      }
    })();
    objectStore.get(row!.archiveObjectKey!).pipe(createGunzip()).pipe(extract);
    await done;
    expect(names).not.toContain(".env");
    expect(contents).not.toContain("sk-real-secret-value");
  });

  it("runs automatically after baseline and returns the dossier", async () => {
    const run = await understanding(alice, snap.id);
    expect(run.status).toBe("ready");
    const d = run.dossier!;
    expect(d.meta.contentDigest).toBe(snap.contentDigest);
    expect(d.entryPoints.find((e) => e.method === "DELETE" && e.path === "/api/orders/:id")?.control.kind).toBe("none_found");
    expect(d.dataModel.entities.map((e) => e.name)).toEqual(expect.arrayContaining(["User", "Order"]));
    expect(d.observations.some((o) => o.title === "A secret file is included in the project")).toBe(true);
    expect(d.checklist).toHaveLength(19);
  });

  it("reuses the dossier instantly for identical content", async () => {
    const twin = await uploadProject(alice);
    const res = await app.inject({ method: "GET", url: `/v1/snapshots/${twin.id}/understanding`, headers: { cookie: alice.cookie } });
    const run = res.json().run as UnderstandingRun;
    expect(run.status).toBe("ready");
    expect(run.dossier?.meta.snapshotId).toBe(twin.id);
  });

  it("shows source lines for evidence, with secrets redacted, and never shows secret files", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/snapshots/${snap.id}/file?path=src/routes/orders.ts&start=9&end=9`, headers: { cookie: alice.cookie } });
    const ex = res.json() as SourceExcerpt;
    expect(ex.lines[0]).toContain('router.delete("/:id"');
    expect(ex.totalLines).toBeGreaterThan(9);
    const secret = await app.inject({ method: "GET", url: `/v1/snapshots/${snap.id}/file?path=.env`, headers: { cookie: alice.cookie } });
    expect(secret.statusCode).toBe(404);
    const missing = await app.inject({ method: "GET", url: `/v1/snapshots/${snap.id}/file?path=../../etc/passwd`, headers: { cookie: alice.cookie } });
    expect(missing.statusCode).toBe(404);
  });

  it("exports Markdown with Mermaid diagrams, and JSON", async () => {
    const md = await app.inject({ method: "GET", url: `/v1/snapshots/${snap.id}/understanding/export?format=md`, headers: { cookie: alice.cookie } });
    expect(md.headers["content-type"]).toContain("text/markdown");
    expect(md.body).toContain("system architecture and design");
    expect(md.body).toContain("```mermaid\nerDiagram");
    expect(md.body).toContain("| DELETE | /api/orders/:id | no protection found |");
    const json = await app.inject({ method: "GET", url: `/v1/snapshots/${snap.id}/understanding/export?format=json`, headers: { cookie: alice.cookie } });
    expect(json.json().meta.contentDigest).toBe(snap.contentDigest);
  });

  it("is private to the project's workspace", async () => {
    for (const url of [`/v1/snapshots/${snap.id}/understanding`, `/v1/snapshots/${snap.id}/file?path=src/server.ts`, `/v1/snapshots/${snap.id}/understanding/export`]) {
      expect((await app.inject({ method: "GET", url, headers: { cookie: bob.cookie } })).statusCode, url).toBe(404);
    }
    expect((await app.inject({ method: "POST", url: `/v1/snapshots/${snap.id}/understanding/rerun`, headers: { cookie: bob.cookie } })).statusCode).toBe(404);
  });
});
