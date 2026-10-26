"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, ChevronDown, Play } from "lucide-react";
import type { CheckId } from "@cybercheck/contracts";
import { RunStatusBadge } from "@/components/testing/run-parts";
import { ACTIVE_RUN } from "@/components/testing/use-testing";
import { Spinner } from "@/components/ui/form";
import { cn } from "@/lib/cn";
import { CHECK_INFO, CHECK_ORDER, runHref } from "@/lib/checks";
import { timeAgo } from "@/lib/format";
import { useProjectCheckRuns } from "./use-check-runs";

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

function CheckCard({ check, projectId, ready }: { check: CheckId; projectId: string; ready: boolean }) {
  const info = CHECK_INFO[check];
  const { runs } = useProjectCheckRuns(ready ? projectId : null, check);
  const [showHistory, setShowHistory] = useState(false);
  const sorted = runs ? [...runs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)) : null;
  const active = sorted?.find((r) => ACTIVE_RUN.has(r.status)) ?? null;
  const latest = active ?? sorted?.[0] ?? null;
  const older = sorted ? sorted.filter((r) => r.id !== latest?.id) : [];
  const startHref = `/app/checks/${check}?project=${projectId}`;

  return (
    <div className="flex h-full flex-col rounded-2xl border border-border bg-surface p-5">
      <div className="flex items-center gap-2">
        <info.icon className={cn("size-5", ready ? "text-accent" : "text-fg-muted")} aria-hidden="true" />
        <p className="font-semibold text-fg">{info.name}</p>
      </div>
      <p className="mt-1 text-sm text-fg-muted">{info.tagline}</p>

      <div className="mt-4 flex-1">
        {!ready ? (
          <p className="text-sm text-fg-muted">Unlocks when the analysis has finished.</p>
        ) : runs === null ? (
          <p className="flex items-center gap-2 text-sm text-fg-muted"><Spinner className="size-3.5" /> Loading</p>
        ) : !latest ? (
          <p className="text-sm text-fg-muted">Not run yet.</p>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <RunStatusBadge status={latest.status} />
              <span className="text-xs text-fg-muted">{timeAgo(latest.createdAt)}</span>
            </div>
            {latest.headline && !active && <p className="line-clamp-2 text-sm text-fg-muted">{latest.headline}</p>}
            {active && <p className="truncate text-sm text-fg-muted">{latest.step ?? "Running"}</p>}
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        {ready && latest ? (
          <Link href={runHref(check, projectId, latest.id)} className={cn("inline-flex min-h-11 items-center gap-1 text-sm font-medium text-accent hover:underline", focusRing)}>
            {active ? "Watch" : "Open results"} <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        ) : ready ? (
          <Link href={startHref} className={cn("inline-flex min-h-11 items-center gap-1 text-sm font-medium text-fg hover:text-accent", focusRing)}>
            <Play className="size-4" aria-hidden="true" /> Run {info.name}
          </Link>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-sm text-fg-muted">Not available</span>
        )}
        {ready && latest && !active && (
          <Link href={startHref} className={cn("inline-flex min-h-11 items-center gap-1 text-sm text-fg-muted hover:text-accent", focusRing)}>
            <Play className="size-3.5" aria-hidden="true" /> Run again
          </Link>
        )}
        {older.length > 0 && (
          <button type="button" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory} className={cn("ml-auto inline-flex min-h-11 cursor-pointer items-center gap-1 text-xs font-medium text-fg-muted hover:text-fg", focusRing)}>
            History ({older.length}) <ChevronDown className={cn("size-3.5 transition-transform", showHistory && "rotate-180")} aria-hidden="true" />
          </button>
        )}
      </div>

      {showHistory && older.length > 0 && (
        <ul className="mt-3 divide-y divide-border border-t border-border">
          {older.map((r) => (
            <li key={r.id}>
              <Link href={runHref(check, projectId, r.id)} className={cn("group flex items-center gap-x-3 py-2.5 text-sm", focusRing)}>
                <RunStatusBadge status={r.status} />
                <span className="text-xs text-fg-muted">{timeAgo(r.createdAt)}</span>
                <ArrowRight className="ml-auto size-3.5 text-fg-muted transition-transform group-hover:translate-x-1" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The project page's "Checks" section: for each check, its latest result on this project (with a way to open it and
 *  its history) and a way to run it. Replaces a grid that only ever linked to the check landing page. */
export function ProjectCheckResults({ projectId, ready }: { projectId: string; ready: boolean }) {
  return (
    <section aria-labelledby="project-checks-h">
      <h2 id="project-checks-h" className="mb-1 text-lg font-semibold tracking-tight text-fg">Checks</h2>
      {!ready && <p className="mb-3 text-sm text-fg-muted">Checks unlock when the analysis has finished, so every check works from the complete understanding of the project.</p>}
      <div className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {CHECK_ORDER.map((c) => <CheckCard key={c} check={c} projectId={projectId} ready={ready} />)}
      </div>
    </section>
  );
}
