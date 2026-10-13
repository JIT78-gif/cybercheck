"use client";

import Link from "next/link";
import { ArrowRight, FlaskConical } from "lucide-react";
import type { TestingRunSummary } from "@cybercheck/contracts";
import { Card, CardTitle, EmptyState } from "@/components/app/ui";
import { Alert, Spinner } from "@/components/ui/form";
import { timeAgo } from "@/lib/format";
import { RunStatusBadge } from "./run-parts";
import { ACTIVE_RUN } from "./use-testing";

/** Results card on the Testing tab: the selected project's runs, live while one is running. */
export function TestingRunsCard({ projectId, runs, error }: { projectId: string | null; runs: TestingRunSummary[] | null; error: { message: string; fix?: string } | null }) {
  return (
    <Card>
      <CardTitle>Results</CardTitle>
      {error ? (
        <Alert className="mt-4">
          {error.message} {error.fix}
        </Alert>
      ) : !projectId ? (
        <EmptyState icon={FlaskConical} title="No project selected" body="Choose a project to see its Testing runs." />
      ) : runs === null ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-fg-muted">
          <Spinner /> Loading runs
        </p>
      ) : runs.length === 0 ? (
        <EmptyState icon={FlaskConical} title="No Testing runs yet" body="Each run shows what was checked, what failed with evidence, and what could not be checked." />
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {runs.map((r) => {
            const active = ACTIVE_RUN.has(r.status);
            return (
              <li key={r.id} className="py-3">
                <Link href={`/app/projects/${projectId}/testing/${r.id}`} className="group block rounded-lg outline-offset-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <RunStatusBadge status={r.status} />
                    {r.purpose === "repair" && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs font-medium text-accent">Repair check</span>}
                    {r.purpose === "rerun" && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs font-medium text-fg-muted">Rerun</span>}
                    <span className="text-xs text-fg-muted">{timeAgo(r.createdAt)}</span>
                    {r.counts.confirmedDefects > 0 && <span className="text-xs font-medium text-danger">{r.counts.confirmedDefects} confirmed defect{r.counts.confirmedDefects === 1 ? "" : "s"}</span>}
                    <ArrowRight className="ml-auto size-4 text-fg-muted transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                  </div>
                  {active ? (
                    <div className="mt-2 space-y-1.5" role="status" aria-live="polite">
                      <p className="truncate text-sm text-fg">{r.step}</p>
                      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
                        <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(4, (r.progress ?? 0) * 100)}%` }} />
                      </div>
                      <p className="text-xs text-fg-muted tabular-nums">
                        {r.counts.terminal} of {r.counts.obligations} checks done
                      </p>
                    </div>
                  ) : (
                    <p className="mt-1.5 text-sm text-fg">{r.headline ?? r.error ?? "No summary"}</p>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
