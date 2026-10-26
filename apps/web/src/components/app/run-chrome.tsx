"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Download } from "lucide-react";
import type { CheckId, TestingRunStatus } from "@cybercheck/contracts";
import { Card, CardTitle, EmptyState } from "@/components/app/ui";
import { duration, RunStatusBadge } from "@/components/testing/run-parts";
import { ACTIVE_RUN } from "@/components/testing/use-testing";
import { buttonVariants } from "@/components/ui/button";
import { Alert, Spinner } from "@/components/ui/form";
import { cn } from "@/lib/cn";
import { CHECK_INFO, runHref } from "@/lib/checks";
import { timeAgo } from "@/lib/format";
import type { CheckRunSummary } from "./use-check-runs";

// The shared frame every check's result page wears: one back-to-project + check breadcrumb, one title, the run status,
// duration, export row and (while running) a progress strip. The body below it is still each check's own (tabs for the
// technical checks, the plain-language scroll for Adversarial), so this only unifies the chrome, not the content.

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export function RunHeader({ check, projectId, status, startedAt, finishedAt, parentRunId, showDuration = true, exportBase, actions }: {
  check: CheckId;
  projectId: string;
  status: TestingRunStatus;
  startedAt: string | null;
  finishedAt: string | null;
  parentRunId?: string | null;
  showDuration?: boolean;
  exportBase?: string | null;
  actions?: ReactNode;
}) {
  const name = CHECK_INFO[check].name;
  const active = ACTIVE_RUN.has(status);
  return (
    <div className="space-y-3">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm">
        <Link href={`/app/projects/${projectId}`} className={cn("inline-flex min-h-11 items-center gap-1.5 font-medium text-accent hover:underline", focusRing)}>
          <ArrowLeft className="size-4" aria-hidden="true" /> Back to project
        </Link>
        <span className="text-fg-muted" aria-hidden="true">/</span>
        <Link href={`/app/checks/${check}?project=${projectId}`} className={cn("inline-flex min-h-11 items-center text-fg-muted hover:text-fg hover:underline", focusRing)}>
          {name}
        </Link>
      </nav>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold text-fg">{name} results</h1>
        <RunStatusBadge status={status} />
        {showDuration && (active || finishedAt) && <span className="text-sm text-fg-muted">{duration(startedAt, finishedAt) ?? ""}</span>}
        {parentRunId && <Link href={runHref(check, projectId, parentRunId)} className={cn("text-sm text-accent hover:underline", focusRing)}>Rerun of an earlier run</Link>}
        <div className="ml-auto flex flex-wrap gap-2">
          {actions}
          {!active && exportBase && (
            <>
              <a href={`${exportBase}?format=md`} download className={buttonVariants({ variant: "outline", shape: "pill", size: "sm" })}><Download aria-hidden="true" /> Report</a>
              <a href={`${exportBase}?format=json`} download className={buttonVariants({ variant: "outline", shape: "pill", size: "sm" })}><Download aria-hidden="true" /> Data (JSON)</a>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function LivePhases({ title = "In progress", phases, currentPhase, events }: { title?: string; phases: Array<string | { id: string; label: string }>; currentPhase: string; events: Array<{ seq: number; type?: string; message: string }> }) {
  const norm = phases.map((p) => (typeof p === "string" ? { id: p, label: p.replaceAll("_", " ") } : p));
  const at = norm.findIndex((p) => p.id === currentPhase);
  return (
    <Card>
      <CardTitle>{title}</CardTitle>
      <ol className="mt-4 flex flex-wrap gap-2" aria-label="Phases">
        {norm.map((p, i) => (
          <li key={p.id} aria-current={i === at ? "step" : undefined} className={cn("rounded-full px-3 py-1 text-xs font-medium", i < at ? "bg-success/10 text-success" : i === at ? "bg-accent/10 text-accent" : "bg-surface-2 text-fg-muted")}>
            {p.label}
          </li>
        ))}
      </ol>
      <ul className="mt-5 space-y-2 text-sm" role="log" aria-live="polite">
        {events.filter((e) => !e.type?.startsWith("phase:")).slice(-12).map((e) => <li key={e.seq}>{e.message}</li>)}
        {!events.length && <li className="flex items-center gap-2 text-fg-muted"><Spinner /> Starting</li>}
      </ul>
    </Card>
  );
}

/** The right-column "Results" list shared by every check's landing page: recent runs, each a link back to its result.
 *  Generic over the check's own run-summary type so each check can render its own count line via `rowMeta`. */
export function CheckRunsCard<T extends CheckRunSummary>({ check, projectId, runs, error, rowMeta }: { check: CheckId; projectId: string | null; runs: T[] | null; error?: { message: string } | null; rowMeta?: (run: T) => ReactNode }) {
  const info = CHECK_INFO[check];
  return (
    <Card>
      <CardTitle>Results</CardTitle>
      {error ? (
        <Alert className="mt-4">{error.message}</Alert>
      ) : !projectId ? (
        <p className="mt-4 text-sm text-fg-muted">Choose a project to see its {info.name} runs.</p>
      ) : runs === null ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-fg-muted"><Spinner /> Loading runs</p>
      ) : runs.length === 0 ? (
        <EmptyState icon={info.icon} title={`No ${info.name} runs yet`} body="Each run will show what was checked, what found a weakness with evidence, and what could not be tested." />
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {runs.map((r) => {
            const active = ACTIVE_RUN.has(r.status);
            return (
              <li key={r.id}>
                <Link href={runHref(check, projectId, r.id)} className={cn("group block py-3", focusRing)}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <RunStatusBadge status={r.status} />
                    <span className="text-xs text-fg-muted">{timeAgo(r.createdAt)}</span>
                    {!active && rowMeta && <span className="text-xs text-fg-muted">{rowMeta(r)}</span>}
                    <ArrowRight className="ml-auto size-4 text-fg-muted transition-transform group-hover:translate-x-1" aria-hidden="true" />
                  </div>
                  {active ? (
                    <div className="mt-2 space-y-1" role="status">
                      <p className="truncate text-xs text-fg">{r.step ?? "Running"}</p>
                      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
                        <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(4, (r.progress ?? 0) * 100)}%` }} />
                      </div>
                    </div>
                  ) : r.headline ? (
                    <p className="mt-1 line-clamp-2 text-sm text-fg-muted">{r.headline}</p>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
