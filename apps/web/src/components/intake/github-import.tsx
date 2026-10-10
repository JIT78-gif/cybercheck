"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft, ChevronDown, Download, ExternalLink, Globe, Lock, RefreshCw, Search } from "lucide-react";
import type { GithubBranch, GithubRepo, GithubStatus, ProjectSummary, SnapshotSummary } from "@cybercheck/contracts";
import { useAppData } from "@/components/app/app-data";
import { GitHubIcon } from "@/components/auth/provider-icons";
import { Button } from "@/components/ui/button";
import { Alert, Field, Spinner } from "@/components/ui/form";
import { ApiError, api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";

const RETURN_KEY = "cc_github_return";

/** Where to come back after GitHub (connect or install). Always reopens the import step. */
function returnPath(pathname: string) {
  return `${pathname}?add=github`;
}

export function rememberGithubReturn(pathname: string) {
  try {
    sessionStorage.setItem(RETURN_KEY, returnPath(pathname));
  } catch {
    // storage blocked: the setup page falls back to Projects
  }
}

export function readGithubReturn(): string | null {
  try {
    return sessionStorage.getItem(RETURN_KEY);
  } catch {
    return null;
  }
}

export function clearGithubReturn() {
  try {
    sessionStorage.removeItem(RETURN_KEY);
  } catch {
    // ignore
  }
}

function useGithubStatus() {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<GithubStatus>("/v1/github/status")
      .then((s) => !cancelled && setStatus(s))
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e : null));
    return () => {
      cancelled = true;
    };
  }, []);
  return { status, error };
}

function StateCard({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-surface-2/40 p-6 text-center">
      <span className="mx-auto inline-flex size-12 items-center justify-center rounded-2xl bg-surface text-fg">
        <GitHubIcon className="size-6" />
      </span>
      <p className="mt-4 font-semibold text-fg">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-fg-muted">{body}</p>
      {children && <div className="mt-5 flex flex-wrap justify-center gap-3">{children}</div>}
    </div>
  );
}

export function GithubImport({
  existingProject,
  onStarted,
  onBack,
}: {
  /** Import a new commit into this GitHub project instead of choosing a repository. */
  existingProject?: ProjectSummary;
  onStarted: (project: ProjectSummary, snapshotId: string) => void;
  onBack?: () => void;
}) {
  const pathname = usePathname();
  const { workspace, upsertProject } = useAppData();
  const { status, error } = useGithubStatus();
  const [installationId, setInstallationId] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [repos, setRepos] = useState<{ key: string; list: GithubRepo[]; total: number } | null>(null);
  const [listError, setListError] = useState<ApiError | null>(null);
  const [picked, setPicked] = useState<GithubRepo | null>(null);
  const [connecting, setConnecting] = useState(false);

  const activeInstallation = status?.installations.find((i) => i.id === installationId) ?? status?.installations[0] ?? null;
  const listKey = activeInstallation && workspace ? `${activeInstallation.id}:${debounced}:${refreshKey}` : null;

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (!listKey || !activeInstallation || !workspace || existingProject) return;
    let cancelled = false;
    const params = new URLSearchParams({ workspace: workspace.id, q: debounced });
    if (refreshKey > 0) params.set("refresh", "1");
    api<{ repos: GithubRepo[]; total: number }>(`/v1/github/installations/${activeInstallation.id}/repos?${params}`)
      .then((r) => {
        if (cancelled) return;
        setListError(null);
        setRepos({ key: listKey, list: r.repos, total: r.total });
      })
      .catch((e) => !cancelled && setListError(e instanceof ApiError ? e : null));
    return () => {
      cancelled = true;
    };
  }, [listKey, activeInstallation, workspace, debounced, refreshKey, existingProject]);

  async function connect() {
    setConnecting(true);
    const origin = window.location.origin;
    const { error } = await authClient.linkSocial({
      provider: "github",
      callbackURL: origin + returnPath(pathname),
      errorCallbackURL: origin + returnPath(pathname),
    });
    if (error) setConnecting(false);
  }

  function install() {
    if (!status?.installUrl) return;
    rememberGithubReturn(pathname);
    window.location.href = status.installUrl;
  }

  // Re-import into an existing GitHub project: skip straight to branch selection.
  if (existingProject?.githubRepo) {
    const [owner, name] = existingProject.githubRepo.split("/");
    const repo: GithubRepo = {
      fullName: existingProject.githubRepo,
      name: name!,
      owner: owner!,
      private: false,
      defaultBranch: "",
      pushedAt: null,
      language: null,
      description: null,
      importedProjectId: existingProject.id,
    };
    return <Configure repo={repo} existingProject={existingProject} onStarted={onStarted} />;
  }

  if (picked) {
    return (
      <Configure
        repo={picked}
        onBack={() => setPicked(null)}
        onStarted={(p, id) => {
          upsertProject(p);
          onStarted(p, id);
        }}
      />
    );
  }

  const back = onBack && (
    <Button type="button" variant="ghost" size="sm" onClick={onBack}>
      <ArrowLeft aria-hidden="true" /> Back
    </Button>
  );

  if (error) return <Alert>{error.message} {error.fix}</Alert>;
  if (!status) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-fg-muted">
        <Spinner /> Checking your GitHub connection
      </div>
    );
  }
  if (!status.configured) {
    return (
      <div className="space-y-4">
        <StateCard title="GitHub import isn't set up yet" body="The server needs its GitHub App keys before repositories can be imported. Upload a folder or archive in the meantime." />
        {back}
      </div>
    );
  }
  if (!status.connected || !status.authorized) {
    return (
      <div className="space-y-4">
        <StateCard
          title={status.connected ? "Reconnect GitHub" : "Connect GitHub"}
          body={
            status.connected
              ? "Your GitHub connection needs to be renewed so we can list your repositories. It takes one click."
              : "Connect your GitHub account to see your repositories. You'll choose exactly which ones cybercheck can read."
          }
        >
          <Button shape="pill" onClick={connect} disabled={connecting}>
            {connecting ? <Spinner /> : <GitHubIcon className="size-4" />}
            {status.connected ? "Reconnect GitHub" : "Connect GitHub"}
          </Button>
        </StateCard>
        {back}
      </div>
    );
  }
  if (status.installations.length === 0) {
    return (
      <div className="space-y-4">
        <StateCard
          title="Choose which repositories cybercheck can read"
          body="Install the cybercheck GitHub App on your account or an organization. You pick all repositories or only selected ones, and access is read-only."
        >
          <Button shape="pill" onClick={install}>
            <GitHubIcon className="size-4" /> Install on GitHub
          </Button>
        </StateCard>
        {back}
      </div>
    );
  }

  const showing = repos?.key === listKey ? repos : null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {status.installations.length > 1 ? (
          <div className="relative">
            <select
              aria-label="GitHub account"
              value={activeInstallation?.id ?? ""}
              onChange={(e) => setInstallationId(Number(e.target.value))}
              className="h-11 cursor-pointer appearance-none rounded-full border border-border bg-surface pr-9 pl-4 text-sm font-medium text-fg"
            >
              {status.installations.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.account.login}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-fg-muted" aria-hidden="true" />
          </div>
        ) : (
          <span className="inline-flex h-11 items-center gap-2 rounded-full border border-border px-4 text-sm font-medium text-fg">
            <GitHubIcon className="size-4" /> {activeInstallation?.account.login}
          </span>
        )}
        <label className="relative min-w-48 flex-1">
          <span className="sr-only">Search repositories</span>
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-fg-muted" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search repositories"
            className="h-11 w-full rounded-full border border-border bg-surface pr-4 pl-10 text-sm text-fg placeholder:text-fg-muted focus-visible:outline-2 focus-visible:outline-ring"
          />
        </label>
        <button
          type="button"
          onClick={() => setRefreshKey((k) => k + 1)}
          aria-label="Refresh repository list"
          title="Refresh"
          className="inline-flex size-11 cursor-pointer items-center justify-center rounded-full border border-border text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
        >
          <RefreshCw className="size-4" />
        </button>
      </div>

      {listError && (
        <Alert>
          {listError.message} {listError.fix}
        </Alert>
      )}

      <div className="max-h-[22rem] overflow-y-auto rounded-2xl border border-border">
        {!showing ? (
          <div className="flex items-center gap-2 p-5 text-sm text-fg-muted">
            <Spinner /> Loading repositories
          </div>
        ) : showing.list.length === 0 ? (
          <p className="p-5 text-sm text-fg-muted">
            {debounced ? `No repositories match "${debounced}".` : "No repositories are shared with cybercheck on this account yet."}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {showing.list.map((r) => (
              <li key={r.fullName} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2/40">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium text-fg">{r.name}</span>
                    <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-fg-muted">
                      {r.private ? <Lock className="size-3" aria-hidden="true" /> : <Globe className="size-3" aria-hidden="true" />}
                      {r.private ? "Private" : "Public"}
                    </span>
                  </p>
                  <p className="mt-0.5 truncate text-xs text-fg-muted">
                    {[r.owner, r.language, r.pushedAt ? `updated ${timeAgo(r.pushedAt)}` : null].filter(Boolean).join(" · ")}
                  </p>
                </div>
                {r.importedProjectId ? (
                  <Link
                    href={`/app/projects/${r.importedProjectId}`}
                    className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-success/30 bg-success/5 px-3 text-xs font-medium text-success"
                  >
                    Imported · Open
                  </Link>
                ) : (
                  <Button size="sm" shape="pill" onClick={() => setPicked(r)} aria-label={`Import ${r.fullName}`}>
                    <Download aria-hidden="true" /> Import
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        {back ?? <span />}
        <div className="flex flex-wrap gap-4">
          {activeInstallation && (
            <a href={activeInstallation.settingsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-fg-muted hover:text-fg">
              Missing a repository? Adjust GitHub access <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          )}
          <button type="button" onClick={install} className="inline-flex cursor-pointer items-center gap-1 text-fg-muted hover:text-fg">
            Add an organization <ExternalLink className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
      {showing && showing.total > showing.list.length && (
        <p className="text-xs text-fg-muted">
          Showing {showing.list.length} of {showing.total}. Search to find others.
        </p>
      )}
    </div>
  );
}

function Configure({
  repo,
  existingProject,
  onBack,
  onStarted,
}: {
  repo: GithubRepo;
  existingProject?: ProjectSummary;
  onBack?: () => void;
  onStarted: (project: ProjectSummary, snapshotId: string) => void;
}) {
  const { workspace } = useAppData();
  const [branches, setBranches] = useState<GithubBranch[] | null>(null);
  const [branchError, setBranchError] = useState<ApiError | null>(null);
  const [branch, setBranch] = useState("");
  const [name, setName] = useState(repo.name.slice(0, 80));
  const [attest, setAttest] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectSummary | null>(existingProject ?? null);
  const key = useMemo(() => crypto.randomUUID(), []);

  useEffect(() => {
    let cancelled = false;
    api<{ branches: GithubBranch[] }>(`/v1/github/repos/${repo.fullName}/branches`)
      .then((r) => {
        if (cancelled) return;
        setBranches(r.branches);
        setBranch((b) => b || r.branches.find((x) => x.isDefault)?.name || r.branches[0]?.name || "");
      })
      .catch((e) => !cancelled && setBranchError(e instanceof ApiError ? e : null));
    return () => {
      cancelled = true;
    };
  }, [repo.fullName]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!workspace || !branch || !attest) return;
    setError(null);
    setNameError(null);
    setSubmitting(true);
    try {
      let target = project;
      if (!target) {
        const r = await api<{ project: ProjectSummary }>(`/v1/workspaces/${workspace.id}/projects`, {
          method: "POST",
          json: { name: name.trim(), sourceType: "github", githubRepo: repo.fullName },
        });
        target = r.project;
        setProject(target);
      }
      const r = await api<{ snapshot: SnapshotSummary }>(`/v1/projects/${target.id}/snapshots/github`, {
        method: "POST",
        headers: { "Idempotency-Key": key },
        json: { repo: repo.fullName, ref: branch, attest: true },
      });
      onStarted(target, r.snapshot.id);
    } catch (err) {
      const e2 = err instanceof ApiError ? err : new ApiError(0, "unexpected", "Import failed.", "Try again.");
      if (e2.code === "project_name_taken" || e2.code === "invalid_request") setNameError(`${e2.message} ${e2.fix ?? ""}`);
      else setError(e2);
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-2/50 p-3">
        <GitHubIcon className="size-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-fg">{repo.fullName}</p>
          <p className="text-xs text-fg-muted">{existingProject ? `Import a newer commit into ${existingProject.name}` : "Read-only import"}</p>
        </div>
        {onBack && (
          <Button type="button" variant="ghost" size="sm" onClick={onBack} disabled={submitting}>
            Change
          </Button>
        )}
      </div>

      <div>
        <label htmlFor="branch-select" className="mb-1.5 block text-sm font-medium text-fg">
          Branch
        </label>
        {branchError ? (
          <Alert>
            {branchError.message} {branchError.fix}
          </Alert>
        ) : !branches ? (
          <div className="flex h-11 items-center gap-2 text-sm text-fg-muted">
            <Spinner /> Loading branches
          </div>
        ) : (
          <div className="relative">
            <select
              id="branch-select"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              disabled={submitting}
              className="h-11 w-full cursor-pointer appearance-none rounded-md border border-border bg-surface pr-10 pl-3 text-base text-fg sm:text-sm"
            >
              {branches.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                  {b.isDefault ? " (default)" : ""}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-fg-muted" aria-hidden="true" />
          </div>
        )}
        <p className="mt-1.5 text-xs text-fg-muted">We pin the branch to its exact latest commit, so results always match one version.</p>
      </div>

      {!existingProject && (
        <Field
          label="Project name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={nameError ?? undefined}
          maxLength={80}
          disabled={submitting}
        />
      )}

      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-4">
        <input
          type="checkbox"
          checked={attest}
          onChange={(e) => setAttest(e.target.checked)}
          className="mt-0.5 size-5 shrink-0 cursor-pointer accent-primary"
          disabled={submitting}
          required
        />
        <span className="text-sm">
          <span className="font-medium text-fg">I own this code or am authorized to assess it.</span>
          <span className="mt-0.5 block text-fg-muted">We record this with the snapshot. Checks only ever run on isolated copies.</span>
        </span>
      </label>

      {error && (
        <Alert>
          {error.message} {error.fix}
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" shape="pill" disabled={submitting || !attest || !branch}>
          {submitting ? <Spinner /> : <Download aria-hidden="true" />}
          {submitting ? "Starting import" : existingProject ? "Import commit" : "Import repository"}
        </Button>
        {!attest && <span className={cn("text-xs text-fg-muted")}>Tick the confirmation to continue.</span>}
      </div>
    </form>
  );
}
