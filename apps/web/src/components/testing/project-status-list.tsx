"use client";

import Link from "next/link";
import { ArrowRight, CircleDashed, FlaskConical, LoaderCircle, RefreshCw } from "lucide-react";
import type { ProjectSummary, TestingProjectStatus } from "@cybercheck/contracts";
import { Card, CardTitle } from "@/components/app/ui";
import { Badge } from "@/components/architecture/parts";
import { Spinner } from "@/components/ui/form";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";
import { ProblemSparkline } from "./charts";
import { DECISION } from "./release-panels";
import { ACTIVE_RUN } from "./use-testing";

type State = "testing" | "untested" | "outdated" | "tested";

function stateOf(p: ProjectSummary, s: TestingProjectStatus | undefined): State {
  if (s?.active) return "testing";
  if (!s?.latest) return "untested";
  if (p.latestSnapshot && s.latest.snapshotId !== p.latestSnapshot.id) return "outdated";
  return "tested";
}

const STATE_TEXT: Record<State, string> = {
  testing: "Testing now",
  untested: "Not tested yet",
  outdated: "New code since the last test",
  tested: "Tested",
};

/** Every project of the workspace and where its testing stands: tested, testing now, or still to do. */
export function ProjectStatusList({ projects, status, selectedId, onSelect }: { projects: ProjectSummary[] | null; status: TestingProjectStatus[] | null; selectedId: string | null; onSelect: (id: string) => void }) {
  if (!projects?.length) return null;
  const byId = new Map((status ?? []).map((s) => [s.projectId, s]));
  const states = projects.map((p) => stateOf(p, byId.get(p.id)));
  const todo = states.filter((s) => s === "untested" || s === "outdated").length;
  return (
    <Card className="space-y-4" role="region" aria-label="Your projects">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <CardTitle>Your projects</CardTitle>
        {status && (
          <p className="text-sm text-fg-muted">
            {states.filter((s) => s === "tested").length} tested · {states.filter((s) => s === "testing").length} testing now · {todo} to test
          </p>
        )}
      </div>
      {status === null ? (
        <p className="flex items-center gap-2 text-sm text-fg-muted">
          <Spinner /> Loading testing status
        </p>
      ) : (
        <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((p, i) => {
            const s = byId.get(p.id);
            const st = states[i]!;
            const d = s?.decision ? DECISION[s.decision] : null;
            const latest = s?.latest;
            const problems = latest?.counts.confirmedDefects ?? 0;
            const selected = p.id === selectedId;
            return (
              <li key={p.id}>
                <div className={cn("flex h-full flex-col gap-2 rounded-xl border p-3 transition-colors", selected ? "border-accent bg-accent/[0.04]" : "border-border hover:border-fg/20")}>
                  <button type="button" onClick={() => onSelect(p.id)} aria-pressed={selected} className="flex min-h-11 cursor-pointer items-start gap-2 text-left focus-visible:outline-2 focus-visible:outline-ring">
                    <span className="mt-0.5">
                      {st === "testing" ? (
                        <LoaderCircle className="size-4 animate-spin text-accent" aria-hidden="true" />
                      ) : st === "tested" && d ? (
                        <d.icon className={cn("size-4", d.tone === "good" ? "text-success" : d.tone === "bad" ? "text-danger" : "text-warning")} aria-hidden="true" />
                      ) : st === "outdated" ? (
                        <RefreshCw className="size-4 text-warning" aria-hidden="true" />
                      ) : (
                        <CircleDashed className="size-4 text-fg-muted" aria-hidden="true" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-fg">{p.name}</span>
                      <span className="block text-xs text-fg-muted">
                        {STATE_TEXT[st]}
                        {latest && st !== "testing" ? ` · last test ${timeAgo(latest.createdAt)}` : ""}
                      </span>
                    </span>
                  </button>
                  {st === "testing" && latest && ACTIVE_RUN.has(latest.status) && (
                    <div className="space-y-1" role="status">
                      <p className="truncate text-xs text-fg">{latest.step}</p>
                      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
                        <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(4, (latest.progress ?? 0) * 100)}%` }} />
                      </div>
                    </div>
                  )}
                  <div className="mt-auto flex flex-wrap items-center gap-2">
                    {d && st !== "testing" && <Badge tone={d.tone}>{d.label}</Badge>}
                    {latest && !d && st !== "testing" && <Badge tone="muted">No release decision</Badge>}
                    {problems > 0 && st !== "testing" && <span className="text-xs font-medium text-danger">{problems} problem{problems === 1 ? "" : "s"}</span>}
                    {s && <ProblemSparkline history={s.history} />}
                    {latest && (
                      <Link href={`/app/projects/${p.id}/testing/${latest.id}`} className="ml-auto inline-flex min-h-9 items-center gap-1 text-sm font-medium text-accent hover:underline">
                        {st === "testing" ? "Watch" : "Open results"} <ArrowRight className="size-3.5" aria-hidden="true" />
                      </Link>
                    )}
                    {!latest && (
                      <span className="ml-auto inline-flex items-center gap-1 text-xs text-fg-muted">
                        <FlaskConical className="size-3.5" aria-hidden="true" /> Select it to start a test
                      </span>
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
