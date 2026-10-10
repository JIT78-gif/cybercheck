"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Download, FolderSearch, RefreshCw } from "lucide-react";
import type { ProjectDetail, ProjectDossier } from "@cybercheck/contracts";
import { Card, EmptyState } from "@/components/app/ui";
import { Button, buttonVariants } from "@/components/ui/button";
import { Alert, Spinner } from "@/components/ui/form";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { shortDigest, timeAgo } from "@/lib/format";
import { CodeViewerProvider } from "./code-viewer";
import { SECTION_GROUPS, SECTIONS, type SectionId } from "./sections";
import { useUnderstanding } from "./use-understanding";

function isSection(x: string): x is SectionId {
  return SECTIONS.some((s) => s.id === x);
}

function SectionIndex({ d, active, go }: { d: ProjectDossier; active: SectionId; go: (id: SectionId) => void }) {
  return (
    <>
      <label className="block lg:hidden">
        <span className="mb-1.5 block text-xs font-medium text-fg-muted">Section</span>
        <select
          value={active}
          onChange={(e) => isSection(e.target.value) && go(e.target.value)}
          className="h-11 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg"
        >
          {SECTION_GROUPS.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.sections.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                  {s.count ? ` (${s.count(d)})` : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <nav aria-label="Architecture sections" className="sticky top-6 hidden max-h-[calc(100dvh-3rem)] overflow-y-auto pr-1 [scrollbar-width:none] lg:block [&::-webkit-scrollbar]:hidden">
        {SECTION_GROUPS.map((g) => (
          <div key={g.label} className="mb-4">
            <p className="mb-1.5 px-3 text-[11px] font-semibold tracking-wide text-fg-muted uppercase">{g.label}</p>
            <ul className="space-y-0.5">
              {g.sections.map((s) => {
                const on = s.id === active;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => go(s.id)}
                      aria-current={on ? "page" : undefined}
                      className={cn(
                        "flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 text-left text-sm transition-colors",
                        on ? "bg-surface font-medium text-fg shadow-[0_1px_2px_rgb(0_0_0/0.06)] ring-1 ring-border" : "text-fg-muted hover:bg-surface/70 hover:text-fg",
                      )}
                    >
                      <s.icon className={cn("size-4 shrink-0", on && "text-accent")} aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{s.label}</span>
                      {s.count && <span className="text-xs text-fg-muted tabular-nums">{s.count(d)}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </>
  );
}

function Dossier({ d }: { d: ProjectDossier }) {
  // Only rendered after the dossier loads in the browser, so reading the hash here is safe.
  const [active, setActive] = useState<SectionId>(() => {
    const h = typeof window === "undefined" ? "" : window.location.hash.slice(1);
    return isSection(h) ? h : "summary";
  });

  // Back/forward and edited links move between sections too.
  useEffect(() => {
    const sync = () => {
      const h = window.location.hash.slice(1);
      setActive(isSection(h) ? h : "summary");
    };
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);

  const go = (id: SectionId) => {
    setActive(id);
    if (window.location.hash !== `#${id}`) window.history.pushState(null, "", `#${id}`);
    const top = document.getElementById("architecture-top");
    if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const section = SECTIONS.find((s) => s.id === active) ?? SECTIONS[0]!;
  return (
    <div id="architecture-top" className="grid scroll-mt-6 gap-6 lg:grid-cols-[232px_minmax(0,1fr)]">
      <SectionIndex d={d} active={active} go={go} />
      <Card key={section.id} className="animate-fade-up min-w-0">
        {section.render(d, go)}
      </Card>
    </div>
  );
}

export function ArchitectureView({ id }: { id: string }) {
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    api<{ project: ProjectDetail }>(`/v1/projects/${id}`)
      .then((r) => setProject(r.project))
      .catch((e) => setError(e instanceof ApiError ? e : null));
  }, [id]);

  const snapshot = project?.snapshots.find((s) => s.status === "BASELINED") ?? null;
  const { run, error: runError, rerun } = useUnderstanding(snapshot?.id ?? null);
  const [rerunning, setRerunning] = useState(false);

  const back = (
    <Link href={`/app/projects/${id}`} className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg">
      <ArrowLeft className="size-4" aria-hidden="true" /> {project?.name ?? "Project"}
    </Link>
  );

  if (error) {
    return (
      <div className="space-y-4">
        {back}
        <Alert>
          {error.message} {error.fix}
        </Alert>
      </div>
    );
  }
  if (!project) {
    return (
      <div className="flex items-center gap-2 py-10 text-fg-muted">
        <Spinner /> Loading project
      </div>
    );
  }

  const exportHref = (format: "md" | "json") => `/v1/snapshots/${snapshot?.id}/understanding/export?format=${format}`;
  const ready = run?.status === "ready" && run.dossier;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {back}
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-fg sm:text-4xl">Architecture</h1>
          {snapshot && (
            <p className="mt-1 text-sm text-fg-muted">
              Snapshot <span className="font-mono text-xs">{shortDigest(snapshot.resolvedRevision ?? snapshot.contentDigest)}</span> · uploaded{" "}
              {timeAgo(snapshot.createdAt)}
            </p>
          )}
        </div>
        {ready && (
          <div className="flex flex-wrap gap-2">
            <a href={exportHref("md")} download className={buttonVariants({ variant: "outline", shape: "pill", size: "sm" })}>
              <Download aria-hidden="true" /> Markdown
            </a>
            <a href={exportHref("json")} download className={buttonVariants({ variant: "outline", shape: "pill", size: "sm" })}>
              <Download aria-hidden="true" /> JSON
            </a>
            <Button
              variant="ghost"
              shape="pill"
              size="sm"
              disabled={rerunning}
              onClick={async () => {
                setRerunning(true);
                try {
                  await rerun();
                } finally {
                  setRerunning(false);
                }
              }}
            >
              <RefreshCw aria-hidden="true" className={cn(rerunning && "animate-spin")} /> Analyze again
            </Button>
          </div>
        )}
      </div>

      {!snapshot ? (
        <Card>
          <EmptyState
            icon={FolderSearch}
            title="No ready snapshot yet"
            body="Upload the project or import it from GitHub. We analyze it as soon as the snapshot is ready."
            action={
              <Link href={`/app/projects/${id}`} className={buttonVariants({ shape: "pill" })}>
                Go to project
              </Link>
            }
          />
        </Card>
      ) : runError ? (
        <Alert>
          {runError.message} {runError.fix}
        </Alert>
      ) : !run || run.status === "queued" || run.status === "analyzing" ? (
        <Card>
          <div className="flex items-start gap-3" role="status" aria-live="polite">
            <Spinner className="mt-1 text-accent" />
            <div>
              <p className="font-medium text-fg">{run?.status === "analyzing" ? "Reading the code" : "Waiting to start"}</p>
              <p className="mt-1 text-sm text-fg-muted">
                We map files, endpoints, data structures, integrations and configuration. This usually takes a few seconds. Your code is
                read, never run.
              </p>
            </div>
          </div>
        </Card>
      ) : run.status === "failed" || !run.dossier ? (
        <Card className="space-y-4">
          <Alert>{run.error ?? "The analysis didn't finish."}</Alert>
          <Button shape="pill" onClick={() => void rerun()}>
            <RefreshCw aria-hidden="true" /> Try again
          </Button>
        </Card>
      ) : (
        <CodeViewerProvider snapshotId={snapshot.id}>
          <Dossier d={run.dossier} />
        </CodeViewerProvider>
      )}
    </div>
  );
}
