"use client";

import Link from "next/link";
import { ArrowRight, CircleDashed, LoaderCircle, RefreshCw } from "lucide-react";
import type { CheckId, ProjectSummary } from "@cybercheck/contracts";
import { Card, CardTitle } from "@/components/app/ui";
import { RunStatusBadge } from "@/components/testing/run-parts";
import { Spinner } from "@/components/ui/form";
import { cn } from "@/lib/cn";
import { CHECK_INFO, runHref } from "@/lib/checks";
import { timeAgo } from "@/lib/format";
import type { CheckProjectStatus } from "./use-check-runs";

// Every project of the workspace and where it stands for ONE check, with a direct link back to the latest result. This
// is the cross-project "Open results" affordance that previously existed only for Testing; it is now shared by all four
// checks so a user can jump back to any project's last result without first re-selecting it in the run form.

type State = "active" | "none" | "outdated" | "done";

function stateOf(p: ProjectSummary, s: CheckProjectStatus | undefined): State {
  if (s?.active) return "active";
  if (!s?.latest) return "none";
  if (p.latestSnapshot && s.latest.snapshotId !== p.latestSnapshot.id) return "outdated";
  return "done";
}

const STATE_TEXT: Record<State, string> = {
  active: "Running now",
  none: "Not run yet",
  outdated: "New code since the last run",
  done: "Last run",
};

export function CheckProjectStatusList({ check, projects, status, selectedId, onSelect }: { check: CheckId; projects: ProjectSummary[] | null; status: CheckProjectStatus[] | null; selectedId: string | null; onSelect: (id: string) => void }) {
  if (!projects?.length) return null;
  const info = CHECK_INFO[check];
  const byId = new Map((status ?? []).map((s) => [s.projectId, s]));
  const states = projects.map((p) => stateOf(p, byId.get(p.id)));
  const done = states.filter((s) => s === "done" || s === "outdated").length;
  const todo = states.filter((s) => s === "none").length;
  return (
    <Card className="space-y-4" role="region" aria-label={`Your projects for ${info.name}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <CardTitle>Your projects</CardTitle>
        {status && <p className="text-sm text-fg-muted">{done} with results · {states.filter((s) => s === "active").length} running now · {todo} not run yet</p>}
      </div>
      {status === null ? (
        <p className="flex items-center gap-2 text-sm text-fg-muted"><Spinner /> Loading status</p>
      ) : (
        <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((p, i) => {
            const s = byId.get(p.id);
            const st = states[i]!;
            const latest = s?.latest;
            const selected = p.id === selectedId;
            return (
              <li key={p.id}>
                <div className={cn("flex h-full flex-col gap-2 rounded-xl border p-3 transition-colors", selected ? "border-accent bg-accent/[0.04]" : "border-border hover:border-fg/20")}>
                  <button type="button" onClick={() => onSelect(p.id)} aria-pressed={selected} className="flex min-h-11 cursor-pointer items-start gap-2 text-left focus-visible:outline-2 focus-visible:outline-ring">
                    <span className="mt-0.5">
                      {st === "active" ? <LoaderCircle className="size-4 animate-spin text-accent" aria-hidden="true" /> : st === "outdated" ? <RefreshCw className="size-4 text-warning" aria-hidden="true" /> : st === "done" ? <info.icon className="size-4 text-fg-muted" aria-hidden="true" /> : <CircleDashed className="size-4 text-fg-muted" aria-hidden="true" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-fg">{p.name}</span>
                      <span className="block text-xs text-fg-muted">{STATE_TEXT[st]}{latest && st !== "active" ? ` · ${timeAgo(latest.createdAt)}` : ""}</span>
                    </span>
                  </button>
                  {st === "active" && latest && (
                    <div className="space-y-1" role="status">
                      <p className="truncate text-xs text-fg">{latest.step ?? "Running"}</p>
                      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true"><div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(4, (latest.progress ?? 0) * 100)}%` }} /></div>
                    </div>
                  )}
                  <div className="mt-auto flex flex-wrap items-center gap-2">
                    {latest && st !== "active" && <RunStatusBadge status={latest.status} />}
                    {latest ? (
                      <Link href={runHref(check, p.id, latest.id)} className="ml-auto inline-flex min-h-9 items-center gap-1 text-sm font-medium text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
                        {st === "active" ? "Watch" : "Open results"} <ArrowRight className="size-3.5" aria-hidden="true" />
                      </Link>
                    ) : (
                      <span className="ml-auto inline-flex items-center gap-1 text-xs text-fg-muted"><info.icon className="size-3.5" aria-hidden="true" /> Select it to start</span>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
