"use client";

import Link from "next/link";
import { ArrowRight, ShieldCheck } from "lucide-react";
import type { SecurityRunSummary } from "@cybercheck/contracts";
import { Card, CardTitle, EmptyState } from "@/components/app/ui";
import { RunStatusBadge } from "@/components/testing/run-parts";
import { ACTIVE_RUN } from "@/components/testing/use-testing";
import { Alert, Spinner } from "@/components/ui/form";
import { timeAgo } from "@/lib/format";

/** Results card on the Security tab: the selected project's runs, live while one is running. */
export function SecurityRunsCard({ projectId, runs, error }: { projectId: string | null; runs: SecurityRunSummary[] | null; error: { message: string; fix?: string } | null }) {
  return (
    <Card>
      <CardTitle>Results</CardTitle>
      {error ? (
        <Alert className="mt-4">
          {error.message} {error.fix}
        </Alert>
      ) : !projectId ? (
        <EmptyState icon={ShieldCheck} title="No project selected" body="Choose a project to see its Security runs." />
      ) : runs === null ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-fg-muted">
          <Spinner /> Loading runs
        </p>
      ) : runs.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="No Security runs yet" body="Each run shows what was confirmed, what is only suspected, and what could not be checked yet." />
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {runs.map((r) => {
            const active = ACTIVE_RUN.has(r.status);
            return (
              <li key={r.id} className="py-3">
                <Link href={`/app/projects/${projectId}/security/${r.id}`} className="group block rounded-lg outline-offset-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <RunStatusBadge status={r.status} />
                    <span className="text-xs text-fg-muted">{timeAgo(r.createdAt)}</span>
                    {r.counts.confirmed > 0 && <span className="text-xs font-medium text-danger">{r.counts.confirmed} confirmed</span>}
                    {r.counts.suspected > 0 && <span className="text-xs font-medium text-warning">{r.counts.suspected} suspected</span>}
                    <ArrowRight className="ml-auto size-4 text-fg-muted transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
                  </div>
                  {active ? (
                    <div className="mt-2 space-y-1.5" role="status" aria-live="polite">
                      <p className="truncate text-sm text-fg">{r.step}</p>
                      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
                        <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(4, (r.progress ?? 0) * 100)}%` }} />
                      </div>
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
