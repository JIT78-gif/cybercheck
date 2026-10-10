import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { and, eq } from "drizzle-orm";
import type { ApiError, GithubBranch, GithubInstallation } from "@cybercheck/contracts";
import { auth } from "../auth/auth.ts";
import { db } from "../db/client.ts";
import { account } from "../db/schema.ts";
import { env } from "../env.ts";

/** A GitHub failure translated into something the user can act on. */
export class GithubError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(body.message);
  }
  /** Temporary problems: worth retrying later rather than changing anything. */
  get transient() {
    return this.body.code === "github_rate_limited" || this.body.code === "github_unavailable";
  }
}

const API = env.GITHUB_API_URL.replace(/\/$/, "");
/** Tarball downloads may only redirect to GitHub's archive host (or the fake GitHub in tests). */
const DOWNLOAD_HOSTS = new Set(["codeload.github.com", new URL(API).host]);

const errors = {
  reconnect: (): ApiError => ({
    code: "github_reconnect_required",
    message: "Your GitHub connection has expired or was revoked.",
    fix: "Reconnect GitHub, then try again.",
  }),
  notConnected: (): ApiError => ({
    code: "github_not_connected",
    message: "No GitHub account is connected.",
    fix: "Connect GitHub first.",
  }),
  notFound: (): ApiError => ({
    code: "github_not_found",
    message: "That repository or branch wasn't found, or cybercheck isn't allowed to read it.",
    fix: "Check the name, or give cybercheck access to the repository in your GitHub App settings.",
  }),
  forbidden: (): ApiError => ({
    code: "github_forbidden",
    message: "GitHub refused access to this repository.",
    fix: "Give cybercheck access to the repository in your GitHub App settings.",
  }),
  rateLimited: (resetEpoch: number | null): ApiError => {
    const mins = resetEpoch ? Math.max(1, Math.ceil((resetEpoch * 1000 - Date.now()) / 60000)) : null;
    return {
      code: "github_rate_limited",
      message: "GitHub's request limit for your account was reached.",
      fix: mins ? `Try again in about ${mins} minute${mins === 1 ? "" : "s"}.` : "Try again in a few minutes.",
    };
  },
  unavailable: (): ApiError => ({
    code: "github_unavailable",
    message: "We couldn't reach GitHub.",
    fix: "Try again in a moment.",
  }),
  tooLarge: (mb: number): ApiError => ({
    code: "download_too_large",
    message: `The repository archive is larger than ${mb} MB.`,
    fix: "Remove large binaries or generated files from the repository, or upload a trimmed .zip instead.",
  }),
};

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "cybercheck",
  };
}

async function toGithubError(res: Response): Promise<GithubError> {
  if (res.status === 401) return new GithubError(409, errors.reconnect());
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (res.status === 429 || (res.status === 403 && remaining === "0")) {
    return new GithubError(429, errors.rateLimited(Number(res.headers.get("x-ratelimit-reset")) || null));
  }
  if (res.status === 403) return new GithubError(403, errors.forbidden());
  if (res.status === 404 || res.status === 422) return new GithubError(404, errors.notFound());
  return new GithubError(502, errors.unavailable());
}

/** JSON request to the GitHub API with a timeout. Never follows redirects to other hosts. */
export async function gh<T>(token: string, path: string, timeoutMs = 15_000): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { headers: headers(token), signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  } catch {
    throw new GithubError(502, errors.unavailable());
  }
  if (!res.ok) throw await toGithubError(res);
  return (await res.json()) as T;
}

// ---------- Tokens ----------

export async function githubAccountFor(userId: string) {
  const [row] = await db
    .select({ id: account.id, accountId: account.accountId })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "github")))
    .limit(1);
  return row ?? null;
}

/** The user's GitHub App token (decrypted and refreshed by Better Auth). Server-side only. */
export async function githubTokenFor(userId: string): Promise<string> {
  const row = await githubAccountFor(userId);
  if (!row) throw new GithubError(409, errors.notConnected());
  try {
    const t = await auth.api.getAccessToken({ body: { accountId: row.id, userId } });
    if (!t?.accessToken) throw new Error("no token");
    return t.accessToken;
  } catch {
    throw new GithubError(409, errors.reconnect());
  }
}

// ---------- Installations, repositories, branches ----------

type RawInstallation = {
  id: number;
  account: { login: string; type: string; avatar_url: string } | null;
  repository_selection: string;
  html_url: string;
};

/**
 * Installations of our GitHub App that this user can access. Only works with a token
 * issued by the GitHub App; any other token gets 403 (reported as "reconnect").
 */
export async function listInstallations(token: string): Promise<GithubInstallation[]> {
  let data: { installations: RawInstallation[] };
  try {
    data = await gh(token, "/user/installations?per_page=100");
  } catch (err) {
    if (err instanceof GithubError && err.body.code === "github_forbidden") throw new GithubError(409, errors.reconnect());
    throw err;
  }
  return data.installations
    .filter((i) => i.account)
    .map((i) => ({
      id: i.id,
      account: { login: i.account!.login, type: i.account!.type, avatarUrl: i.account!.avatar_url },
      selection: i.repository_selection,
      settingsUrl: i.html_url,
    }));
}

export type RepoSummary = {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: string | null;
  language: string | null;
  description: string | null;
};

type RawRepo = {
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  default_branch: string;
  pushed_at: string | null;
  language: string | null;
  description: string | null;
};

const MAX_REPO_PAGES = 10; // 1,000 repositories per installation
const repoCache = new Map<string, { at: number; repos: RepoSummary[] }>();
const REPO_CACHE_MS = 60_000;

/** Repositories this user can read through one installation (cached briefly for fast search). */
export async function listInstallationRepos(token: string, userId: string, installationId: number, refresh = false) {
  const key = `${userId}:${installationId}`;
  const cached = repoCache.get(key);
  if (!refresh && cached && Date.now() - cached.at < REPO_CACHE_MS) return cached.repos;

  const repos: RepoSummary[] = [];
  for (let page = 1; page <= MAX_REPO_PAGES; page++) {
    const data = await gh<{ total_count: number; repositories: RawRepo[] }>(
      token,
      `/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
    );
    for (const r of data.repositories) {
      repos.push({
        fullName: r.full_name,
        name: r.name,
        owner: r.owner.login,
        private: r.private,
        defaultBranch: r.default_branch,
        pushedAt: r.pushed_at,
        language: r.language,
        description: r.description ? r.description.slice(0, 200) : null,
      });
    }
    if (data.repositories.length < 100 || repos.length >= data.total_count) break;
  }
  repos.sort((a, b) => Date.parse(b.pushedAt ?? "0") - Date.parse(a.pushedAt ?? "0"));
  repoCache.set(key, { at: Date.now(), repos });
  return repos;
}

export async function listBranches(token: string, repo: string): Promise<GithubBranch[]> {
  const info = await gh<{ default_branch: string }>(token, `/repos/${repo}`);
  const branches: GithubBranch[] = [];
  for (let page = 1; page <= 3; page++) {
    const data = await gh<Array<{ name: string; commit: { sha: string } }>>(token, `/repos/${repo}/branches?per_page=100&page=${page}`);
    for (const b of data) branches.push({ name: b.name, sha: b.commit.sha, isDefault: b.name === info.default_branch });
    if (data.length < 100) break;
  }
  branches.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name));
  return branches;
}

/** Pin a branch/tag/SHA to the exact commit we will snapshot. */
export async function resolveCommit(token: string, repo: string, ref: string): Promise<string> {
  const data = await gh<{ sha: string }>(token, `/repos/${repo}/commits/${encodeURIComponent(ref)}`);
  if (!/^[a-f0-9]{40}$/.test(data.sha)) throw new GithubError(502, errors.unavailable());
  return data.sha;
}

/**
 * Stream the repository tarball at an exact commit into `dest`, with a hard size cap.
 * GitHub answers with a redirect to a short-lived signed URL; we follow it only to
 * GitHub's archive host and never send our token anywhere else.
 */
export async function downloadTarball(token: string, repo: string, sha: string, dest: string, maxBytes: number) {
  let res: Response;
  try {
    res = await fetch(`${API}/repos/${repo}/tarball/${sha}`, {
      headers: headers(token),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      const target = location ? new URL(location, API) : null;
      const allowed =
        target && DOWNLOAD_HOSTS.has(target.host) && (target.protocol === "https:" || new URL(API).protocol === "http:");
      if (!target || !allowed) throw new GithubError(502, errors.unavailable());
      res = await fetch(target, {
        headers: { "User-Agent": "cybercheck" },
        redirect: "error",
        signal: AbortSignal.timeout(180_000),
      });
    }
  } catch (err) {
    if (err instanceof GithubError) throw err;
    throw new GithubError(502, errors.unavailable());
  }
  if (!res.ok || !res.body) throw await toGithubError(res);

  const declared = Number(res.headers.get("content-length"));
  if (declared && declared > maxBytes) throw new GithubError(413, errors.tooLarge(Math.round(maxBytes / 1024 / 1024)));

  let seen = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _e, cb) {
      seen += chunk.length;
      if (seen > maxBytes) return cb(new GithubError(413, errors.tooLarge(Math.round(maxBytes / 1024 / 1024))));
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), cap, createWriteStream(dest));
  } catch (err) {
    await rm(dest, { force: true });
    if (err instanceof GithubError) throw err;
    throw new GithubError(502, errors.unavailable());
  }
  return seen;
}

/** For tests: forget cached repository lists. */
export function clearGithubCache() {
  repoCache.clear();
}
