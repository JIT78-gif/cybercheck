import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { GithubStatus, SnapshotSummary } from "@cybercheck/contracts";
import { demoProject, makeTarGz } from "./fixtures.ts";

// ---------- A small fake GitHub (API + archive host) ----------

const SHA = "a".repeat(40);
const APP_TOKEN = "app-user-token";
const OLD_OAUTH_TOKEN = "old-oauth-app-token";
let fake: Server;
let base = "";
const seen: Array<{ path: string; headers: IncomingHttpHeaders }> = [];
let tarball: Buffer;

function json(res: import("node:http").ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function repoJson(fullName: string, isPrivate: boolean, pushedAt: string) {
  const [owner, name] = fullName.split("/");
  return { full_name: fullName, name, owner: { login: owner }, private: isPrivate, default_branch: "main", pushed_at: pushedAt, language: "TypeScript", description: null };
}

function startFake() {
  return new Promise<void>((resolve) => {
    fake = createServer((req, res) => {
      const url = new URL(req.url!, base);
      seen.push({ path: url.pathname, headers: req.headers });
      const auth = req.headers.authorization;

      if (url.pathname.startsWith("/codeload/")) {
        // The signed archive URL must never receive our token.
        if (auth) return json(res, 400, { message: "token leaked to archive host" });
        res.writeHead(200, { "content-type": "application/x-gzip", "content-length": String(tarball.length) });
        return res.end(tarball);
      }
      if (auth !== `Bearer ${APP_TOKEN}` && auth !== `Bearer ${OLD_OAUTH_TOKEN}`) return json(res, 401, { message: "Bad credentials" });
      const p = url.pathname;
      if (p === "/user") return json(res, 200, { login: "octo-test", avatar_url: "https://avatars.example/octo.png" });
      if (p === "/user/installations") {
        // GitHub only lists installations for tokens issued by the GitHub App itself.
        if (auth === `Bearer ${OLD_OAUTH_TOKEN}`) return json(res, 403, { message: "must be a GitHub App user token" });
        return json(res, 200, {
          installations: [
            { id: 42, account: { login: "octo-test", type: "User", avatar_url: "x" }, repository_selection: "selected", html_url: "https://github.com/settings/installations/42" },
          ],
        });
      }
      if (p === "/user/installations/42/repositories") {
        return json(res, 200, {
          total_count: 3,
          repositories: [
            repoJson("acme/old-thing", false, "2024-01-01T00:00:00Z"),
            repoJson("acme/storefront", true, "2026-10-09T00:00:00Z"),
            repoJson("acme/evil", false, "2025-01-01T00:00:00Z"),
          ],
        });
      }
      const m = p.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
      if (!m) return json(res, 404, { message: "Not Found" });
      const [, repo, rest = ""] = m;
      if (rest === "") return json(res, 200, { default_branch: "main" });
      if (rest.startsWith("/branches")) return json(res, 200, [{ name: "dev", commit: { sha: "b".repeat(40) } }, { name: "main", commit: { sha: SHA } }]);
      if (rest.startsWith("/commits/")) {
        if (repo === "acme/limited") {
          return json(res, 403, { message: "rate limit" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 600) });
        }
        if (repo === "acme/missing") return json(res, 404, { message: "Not Found" });
        return json(res, 200, { sha: SHA });
      }
      if (rest === `/tarball/${SHA}`) {
        const location = repo === "acme/evil" ? "https://evil.example/steal" : `${base}/codeload/${repo!.replace("/", "-")}.tar.gz?token=signed`;
        res.writeHead(302, { location });
        return res.end();
      }
      return json(res, 404, { message: "Not Found" });
    });
    fake.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
      resolve();
    });
  });
}

// ---------- App under test (imported after env points at the fake GitHub) ----------

let app: FastifyInstance;
let mod: {
  auth: typeof import("../src/auth/auth.ts")["auth"];
  db: typeof import("../src/db/client.ts")["db"];
  pool: typeof import("../src/db/client.ts")["pool"];
  schema: typeof import("../src/db/schema.ts");
  client: typeof import("../src/github/client.ts");
  setTokenUtil: typeof import("better-auth/oauth2")["setTokenUtil"];
  eq: typeof import("drizzle-orm")["eq"];
};

type Account = { cookie: string; userId: string; workspaceId: string };

async function account(name: string, githubToken?: string): Promise<Account> {
  const email = `gh-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@example.test`;
  const password = "github-test-password";
  const created = await mod.auth.api.signUpEmail({ body: { name, email, password } });
  await mod.db.update(mod.schema.user).set({ emailVerified: true }).where(mod.eq(mod.schema.user.id, created.user.id));
  if (githubToken) {
    // Stored exactly like a real GitHub link: encrypted with the auth secret.
    const ctx = await mod.auth.$context;
    await mod.db.insert(mod.schema.account).values({
      id: randomUUID(),
      accountId: String(Math.floor(Math.random() * 1e9)),
      providerId: "github",
      userId: created.user.id,
      accessToken: await mod.setTokenUtil(githubToken, ctx as unknown as Parameters<typeof mod.setTokenUtil>[1]),
    });
  }
  const res = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    headers: { origin: "http://localhost:3000", "content-type": "application/json", "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250) + 1}` },
    payload: { email, password },
  });
  const setCookie = res.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie!]).map((c) => c.split(";")[0]).join("; ");
  const me = await app.inject({ method: "GET", url: "/v1/me", headers: { cookie } });
  return { cookie, userId: created.user.id, workspaceId: me.json().workspaces[0].id };
}

async function createGithubProject(a: Account, repo: string) {
  return app.inject({
    method: "POST",
    url: `/v1/workspaces/${a.workspaceId}/projects`,
    headers: { cookie: a.cookie, "content-type": "application/json" },
    payload: { name: `${repo.split("/")[1]}-${randomUUID().slice(0, 6)}`, sourceType: "github", githubRepo: repo },
  });
}

async function importRepo(a: Account, projectId: string, repo: string, ref = "main") {
  return app.inject({
    method: "POST",
    url: `/v1/projects/${projectId}/snapshots/github`,
    headers: { cookie: a.cookie, "content-type": "application/json", "idempotency-key": randomUUID() },
    payload: { repo, ref, attest: true },
  });
}

async function waitForFinal(a: Account, id: string): Promise<SnapshotSummary & { events: string[] }> {
  for (let i = 0; i < 100; i++) {
    const res = await app.inject({ method: "GET", url: `/v1/snapshots/${id}`, headers: { cookie: a.cookie } });
    const body = res.json();
    if (!["RECEIVED", "VALIDATING"].includes(body.snapshot.status)) return { ...body.snapshot, events: body.events.map((e: { type: string }) => e.type) };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("snapshot never finished");
}

let alice: Account;
let bob: Account;

beforeAll(async () => {
  await startFake();
  tarball = await makeTarGz(Object.entries(demoProject).map(([name, data]) => ({ name: `acme-storefront-aaaaaaa/${name}`, data })));
  process.env.GITHUB_API_URL = base;
  process.env.GITHUB_APP_SLUG = "cybercheck-test";
  process.env.GITHUB_CLIENT_ID ||= "test-client-id";
  process.env.GITHUB_CLIENT_SECRET ||= "test-client-secret";

  const { buildApp } = await import("../src/app.ts");
  mod = {
    auth: (await import("../src/auth/auth.ts")).auth,
    ...(await import("../src/db/client.ts")),
    schema: await import("../src/db/schema.ts"),
    client: await import("../src/github/client.ts"),
    setTokenUtil: (await import("better-auth/oauth2")).setTokenUtil,
    eq: (await import("drizzle-orm")).eq,
  };
  app = await buildApp();
  await app.ready();
  alice = await account("alice", APP_TOKEN);
  bob = await account("bob");
});

afterAll(async () => {
  await app?.close();
  await mod?.pool.end();
  fake?.close();
});

describe("GitHub status and repository list", () => {
  it("reports a connected, authorized user with their installations", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/github/status", headers: { cookie: alice.cookie } });
    const s = res.json() as GithubStatus;
    expect(s).toMatchObject({ configured: true, connected: true, authorized: true, login: "octo-test" });
    expect(s.installUrl).toBe("https://github.com/apps/cybercheck-test/installations/new");
    expect(s.installations.map((i) => i.id)).toEqual([42]);
  });

  it("asks users connected through an old OAuth app to reconnect", async () => {
    const old = await account("old", OLD_OAUTH_TOKEN);
    const s = (await app.inject({ method: "GET", url: "/v1/github/status", headers: { cookie: old.cookie } })).json() as GithubStatus;
    expect(s).toMatchObject({ connected: true, authorized: false, installations: [] });
  });

  it("reports not connected for users without GitHub", async () => {
    const s = (await app.inject({ method: "GET", url: "/v1/github/status", headers: { cookie: bob.cookie } })).json() as GithubStatus;
    expect(s).toMatchObject({ configured: true, connected: false, authorized: false });
  });

  it("lists repositories, newest push first, and searches them", async () => {
    mod.client.clearGithubCache();
    const res = await app.inject({ method: "GET", url: `/v1/github/installations/42/repos?workspace=${alice.workspaceId}`, headers: { cookie: alice.cookie } });
    expect(res.statusCode).toBe(200);
    const names = res.json().repos.map((r: { fullName: string }) => r.fullName);
    expect(names).toEqual(["acme/storefront", "acme/evil", "acme/old-thing"]);
    const q = await app.inject({ method: "GET", url: `/v1/github/installations/42/repos?workspace=${alice.workspaceId}&q=STORE`, headers: { cookie: alice.cookie } });
    expect(q.json().repos.map((r: { fullName: string }) => r.fullName)).toEqual(["acme/storefront"]);
  });

  it("refuses installation IDs the user can't access (a forged setup redirect)", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/github/installations/999/repos?workspace=${alice.workspaceId}`, headers: { cookie: alice.cookie } });
    expect(res.statusCode).toBe(404);
  });

  it("lists branches with the default first", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/github/repos/acme/storefront/branches", headers: { cookie: alice.cookie } });
    expect(res.json().branches.map((b: { name: string; isDefault: boolean }) => [b.name, b.isDefault])).toEqual([["main", true], ["dev", false]]);
  });
});

describe("importing a repository", () => {
  it("pins the exact commit, downloads without leaking the token, and baselines it", async () => {
    const created = await createGithubProject(alice, "acme/storefront");
    expect(created.statusCode).toBe(201);
    const p = created.json().project;
    const res = await importRepo(alice, p.id, "acme/storefront");
    expect(res.statusCode).toBe(202);
    const final = await waitForFinal(alice, res.json().snapshot.id);
    expect(final.status).toBe("BASELINED");
    expect(final.resolvedRevision).toBe(SHA);
    expect(final.sourceRef).toBe("main");
    expect(final.events).toEqual(["received", "resolving", "downloading", "validating", "extracting", "normalizing", "detecting", "baselined"]);
    expect(final.detection?.packageName).toBe("acme-storefront"); // top folder stripped
    expect(seen.filter((r) => r.path.startsWith("/codeload/")).every((r) => !r.headers.authorization)).toBe(true);

    // The repo list now marks it imported.
    mod.client.clearGithubCache();
    const list = await app.inject({ method: "GET", url: `/v1/github/installations/42/repos?workspace=${alice.workspaceId}`, headers: { cookie: alice.cookie } });
    expect(list.json().repos.find((r: { fullName: string }) => r.fullName === "acme/storefront").importedProjectId).toBe(p.id);
  });

  it("refuses a second project for the same repository", async () => {
    const res = await createGithubProject(alice, "acme/storefront");
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("project_repo_exists");
  });

  it("refuses to follow a tarball redirect to a non-GitHub host", async () => {
    const p = (await createGithubProject(alice, "acme/evil")).json().project;
    const final = await waitForFinal(alice, (await importRepo(alice, p.id, "acme/evil")).json().snapshot.id);
    expect(final.status).toBe("FAILED");
    expect(seen.some((r) => r.path === "/steal")).toBe(false);
  });

  it("explains GitHub rate limits and missing repositories", async () => {
    const limited = (await createGithubProject(alice, "acme/limited")).json().project;
    const l = await waitForFinal(alice, (await importRepo(alice, limited.id, "acme/limited")).json().snapshot.id);
    expect(l.status).toBe("FAILED");
    expect(l.error).toMatch(/request limit.*Try again in about \d+ minutes?/);

    const missing = (await createGithubProject(alice, "acme/missing")).json().project;
    const m = await waitForFinal(alice, (await importRepo(alice, missing.id, "acme/missing")).json().snapshot.id);
    expect(m.status).toBe("REJECTED");
    expect(m.rejectionReasons[0]?.code).toBe("github_not_found");
  });

  it("only imports the repository the project is linked to", async () => {
    const p = (await createGithubProject(alice, `acme/other-${randomUUID().slice(0, 4)}`)).json().project;
    const res = await importRepo(alice, p.id, "acme/storefront");
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("repo_mismatch");
  });

  it("requires ownership confirmation and a valid branch name", async () => {
    const p = (await createGithubProject(alice, `acme/attest-${randomUUID().slice(0, 4)}`)).json().project;
    const noAttest = await app.inject({
      method: "POST",
      url: `/v1/projects/${p.id}/snapshots/github`,
      headers: { cookie: alice.cookie, "content-type": "application/json", "idempotency-key": randomUUID() },
      payload: { repo: p.githubRepo, ref: "main", attest: false },
    });
    expect(noAttest.json().code).toBe("attestation_required");
    const badRef = await importRepo(alice, p.id, p.githubRepo, "../../etc");
    expect(badRef.statusCode).toBe(400);
  });

  it("isolates users: others can't import into your project, and need their own GitHub", async () => {
    const p = (await createGithubProject(alice, `acme/private-${randomUUID().slice(0, 4)}`)).json().project;
    expect((await importRepo(bob, p.id, p.githubRepo)).statusCode).toBe(404);
    const own = (await createGithubProject(bob, "acme/storefront")).json().project;
    const res = await importRepo(bob, own.id, "acme/storefront");
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("github_not_connected");
  });
});

describe("tarball download limits", () => {
  it("stops a download that exceeds the size cap and leaves no file behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gh-dl-"));
    const dest = join(dir, "x.tar.gz");
    await expect(mod.client.downloadTarball(APP_TOKEN, "acme/storefront", SHA, dest, 100)).rejects.toMatchObject({
      body: { code: "download_too_large" },
    });
    await expect(stat(dest)).rejects.toThrow();
    await rm(dir, { recursive: true, force: true });
  });
});
