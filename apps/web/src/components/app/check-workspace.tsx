"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Check, ChevronDown, Info, ListChecks, Lock, Play, Plus } from "lucide-react";
import type { CheckId, ProjectSummary } from "@cybercheck/contracts";
import { UnderstandingSummary } from "@/components/architecture/understanding-summary";
import { AddProjectFlow } from "@/components/intake/add-project";
import { useAddFromQuery } from "@/components/intake/use-add-from-query";
import { SnapshotFacts } from "@/components/intake/snapshot-result";
import { Button } from "@/components/ui/button";
import { Alert, Spinner } from "@/components/ui/form";
import { CHECK_INFO } from "@/lib/checks";
import { cn } from "@/lib/cn";
import { useAppData } from "./app-data";
import { Card, CardTitle, EmptyState, PageHeader, StatusChip } from "./ui";

const lastKey = (wid: string) => `cc_last_project_${wid}`;
const noopSubscribe = () => () => {};

function readLast(wid: string | undefined) {
  if (!wid) return "";
  try {
    return localStorage.getItem(lastKey(wid)) ?? "";
  } catch {
    return "";
  }
}

const statusWord: Record<string, string> = {
  RECEIVED: "processing",
  VALIDATING: "processing",
  REJECTED: "rejected",
  FAILED: "failed",
};

export function CheckWorkspace({ check }: { check: CheckId }) {
  const info = CHECK_INFO[check];
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { workspace, projects, refreshProjects } = useAppData();
  const [addingClicked, setAdding] = useState(false);
  const { fromGithub, clear } = useAddFromQuery();
  const adding = addingClicked || fromGithub;
  const [picked, setPicked] = useState<string | null>(null);
  const last = useSyncExternalStore(noopSubscribe, () => readLast(workspace?.id), () => "");

  const ready = (projects ?? []).filter((p) => p.latestSnapshot?.status === "BASELINED");
  // Priority: explicit choice, ?project=, last used in this workspace, newest ready project.
  const candidates = [picked, params.get("project"), last, ready[0]?.id];
  const selected: ProjectSummary | undefined = candidates
    .map((id) => (id ? projects?.find((p) => p.id === id) : undefined))
    .find(Boolean);

  function select(id: string) {
    setPicked(id);
    if (workspace) {
      try {
        localStorage.setItem(lastKey(workspace.id), id);
      } catch {
        // storage blocked: the URL still carries the choice
      }
    }
    const q = new URLSearchParams(params.toString());
    q.set("project", id);
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  }

  const snap = selected?.latestSnapshot;
  const isReady = snap?.status === "BASELINED";
  const notApplicable = check === "ai-evaluator" && isReady && (snap?.detection?.aiSdks.length ?? 0) === 0;

  return (
    <div className="space-y-6">
      <PageHeader section={info.name} title={info.name} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {/* Left: run card */}
        <Card className="h-fit">
          <CardTitle>Run a {info.name} check</CardTitle>
          <p className="mt-1 text-sm text-fg-muted">{info.tagline}</p>

          {adding ? (
            <div className="mt-6">
              <AddProjectFlow
                initialSource={fromGithub ? "github" : undefined}
                onCancel={() => {
                  setAdding(false);
                  clear();
                }}
                onDone={async (p) => {
                  setAdding(false);
                  clear();
                  await refreshProjects();
                  select(p.id);
                }}
              />
            </div>
          ) : (
            <div className="mt-6 space-y-5">
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label htmlFor="project-select" className="text-sm font-medium text-fg">
                    Project
                  </label>
                  <span className="rounded-md bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">required</span>
                </div>
                {projects === null ? (
                  <div className="flex h-12 items-center gap-2 text-sm text-fg-muted">
                    <Spinner /> Loading projects
                  </div>
                ) : projects.length === 0 ? (
                  <p className="rounded-xl bg-surface-2/60 p-4 text-sm text-fg-muted">
                    No projects yet. Add one below; it will be available in every check tab.
                  </p>
                ) : (
                  <div className="relative">
                    <select
                      id="project-select"
                      value={selected?.id ?? ""}
                      onChange={(e) => select(e.target.value)}
                      className="h-12 w-full cursor-pointer appearance-none rounded-xl border border-border bg-surface pr-10 pl-4 text-base text-fg transition-colors hover:border-fg/20 focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {!selected && <option value="">Choose a project</option>}
                      {projects.map((p) => {
                        const st = p.latestSnapshot?.status;
                        const disabled = st !== "BASELINED";
                        return (
                          <option key={p.id} value={p.id} disabled={disabled}>
                            {p.name}
                            {disabled ? ` (${st ? statusWord[st] : "no snapshot"})` : ""}
                          </option>
                        );
                      })}
                    </select>
                    <ChevronDown className="pointer-events-none absolute top-1/2 right-4 size-4 -translate-y-1/2 text-fg-muted" aria-hidden="true" />
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setAdding(true)}
                  className="mt-3 inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium text-accent underline-offset-4 hover:underline"
                >
                  <Plus className="size-4" aria-hidden="true" /> Add new project
                </button>
              </div>

              <details className="group rounded-xl border border-border [&_summary::-webkit-details-marker]:hidden">
                <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 text-sm font-medium text-fg">
                  <span className="inline-flex items-center gap-2">
                    <ListChecks className="size-4 text-fg-muted" aria-hidden="true" /> Options
                  </span>
                  <ChevronDown className="size-4 text-fg-muted transition-transform group-open:rotate-180" aria-hidden="true" />
                </summary>
                <p className="faq-answer px-4 pb-4 text-sm text-fg-muted">
                  Scope controls (which suites, targets and rules apply) arrive together with the {info.name} engine.
                </p>
              </details>

              {notApplicable && (
                <Alert tone="info">
                  Not applicable to {selected?.name}: no AI model, chatbot, agent or document search was detected in its
                  dependencies.
                </Alert>
              )}

              <div>
                <Button type="button" shape="pill" size="lg" className="w-full" disabled>
                  <Play aria-hidden="true" /> Start {info.name} check
                </Button>
                <p className="mt-2 flex items-start gap-2 text-xs text-fg-muted">
                  <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  {isReady
                    ? `Your project is ready. The ${info.name} engine is the next build step, so nothing runs yet.`
                    : `Choose a ready project first. The ${info.name} engine is the next build step.`}
                </p>
              </div>
            </div>
          )}
        </Card>

        {/* Right: context cards */}
        <div className="space-y-6">
          <Card>
            <div className="flex items-center gap-3">
              <span className="inline-flex size-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <info.icon className="size-5" aria-hidden="true" />
              </span>
              <CardTitle>What this check does</CardTitle>
            </div>
            <ul className="mt-5 space-y-2.5">
              {info.does.map((d) => (
                <li key={d} className="flex gap-2.5 text-sm text-fg">
                  <Check className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
                  {d}
                </li>
              ))}
            </ul>
            <p className="mt-4 text-sm text-fg-muted">
              <span className="font-medium text-fg">You get: </span>
              {info.youGet}
            </p>
            {info.note && (
              <p className="mt-3 flex items-start gap-2 text-xs text-fg-muted">
                <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                {info.note}
              </p>
            )}
          </Card>

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>Selected project</CardTitle>
              {selected && <StatusChip status={snap?.status} />}
            </div>
            {selected && snap ? (
              <div className="mt-5 space-y-5">
                <p className="font-medium text-fg">{selected.name}</p>
                {isReady ? (
                  <>
                    <UnderstandingSummary projectId={selected.id} snapshotId={snap.id} />
                    <SnapshotFacts snapshot={snap} />
                  </>
                ) : (
                  <p className="text-sm text-fg-muted">This project&apos;s latest snapshot isn&apos;t ready. Open it to see why.</p>
                )}
                <Link
                  href={`/app/projects/${selected.id}`}
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
                >
                  View project details <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              </div>
            ) : (
              <p className="mt-3 text-sm text-fg-muted">Choose or add a project to see its frozen snapshot here.</p>
            )}
          </Card>

          <Card>
            <CardTitle>Results</CardTitle>
            <EmptyState
              icon={info.icon}
              title={`No ${info.name} runs yet`}
              body="Each run will show what was checked, what failed with evidence, and what could not be checked."
            />
          </Card>
        </div>
      </div>
    </div>
  );
}

export function CheckWorkspaceFallback() {
  return (
    <div className={cn("flex items-center gap-2 py-10 text-fg-muted")}>
      <Spinner /> Loading
    </div>
  );
}
