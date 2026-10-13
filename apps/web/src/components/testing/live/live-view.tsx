"use client";

import { useEffect, useState } from "react";
import { Box, CircleDollarSign, ListChecks, Timer } from "lucide-react";
import type { TestingEvent, TestingRunDetail } from "@cybercheck/contracts";
import { Card, CardTitle } from "@/components/app/ui";
import { ActivityFeed } from "./activity-feed";
import { BrowserViewer } from "./browser-viewer";
import { CheckMap } from "./check-map";

function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Time, sandboxes at work, AI cost so far and checks done: the numbers that move during a run. */
function LiveHeader({ run, live }: { run: TestingRunDetail; live: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  const start = run.startedAt ? new Date(run.startedAt).getTime() : null;
  const end = run.finishedAt ? new Date(run.finishedAt).getTime() : now;
  const running = run.executions.filter((e) => e.outcome === "running").length;
  const stats = [
    { icon: Timer, label: live ? "Running for" : "Took", value: start ? clock(end - start) : "0:00" },
    { icon: Box, label: live ? "Sandboxes working now" : "Sandbox steps", value: live ? String(running) : String(run.executions.length) },
    { icon: CircleDollarSign, label: live ? "AI cost so far" : "AI cost", value: `$${(run.usage?.costUsd ?? 0).toFixed(3)}` },
    { icon: ListChecks, label: "Checks done", value: `${run.counts.terminal} of ${run.counts.obligations}` },
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {stats.map((s) => (
        <div key={s.label} className="rounded-lg border border-border bg-surface-2/60 px-3 py-2">
          <dt className="flex items-center gap-1.5 text-xs text-fg-muted">
            <s.icon className="size-3.5" aria-hidden="true" />
            {s.label}
          </dt>
          <dd className="mt-0.5 font-mono text-lg font-semibold text-fg tabular-nums">{s.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The run as it happens (or, afterwards, as it happened): what cybercheck is doing, what the browser sees,
 * and every check filling in. `phases` is the run's phase bar, rendered by the run view.
 */
export function LiveView({ run, events, live, phases }: { run: TestingRunDetail; events: TestingEvent[]; live: boolean; phases?: React.ReactNode }) {
  const structured = events.some((e) => e.data);
  // A request in the feed opens its check in the map below.
  const [open, setOpen] = useState<string | null>(null);
  const openCheck = (id: string) => {
    setOpen(id);
    document.getElementById(`check-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  return (
    <div className="min-w-0 space-y-4">
      <Card className="space-y-4">
        {phases}
        <LiveHeader run={run} live={live} />
        {live && <p className="text-sm text-fg">{run.step ?? "Working"}</p>}
      </Card>
      <div className="grid gap-4 lg:grid-cols-5">
        <Card className="flex max-h-[38rem] min-h-[22rem] min-w-0 flex-col gap-3 lg:col-span-2">
          <CardTitle>{live ? "What cybercheck is doing" : "Everything cybercheck did"}</CardTitle>
          {!structured && !live && <p className="text-xs text-fg-muted">Detailed actions are recorded for runs from now on; this run shows its main steps only.</p>}
          <ActivityFeed events={events} live={live} onOpenCheck={openCheck} />
        </Card>
        <Card className="min-w-0 space-y-3 lg:col-span-3">
          <CardTitle>What the browser sees</CardTitle>
          <BrowserViewer runId={run.id} events={events} live={live} />
        </Card>
      </div>
      <Card className="space-y-3">
        <CardTitle>Every check</CardTitle>
        <CheckMap obligations={run.obligations} open={open} onOpen={setOpen} />
      </Card>
      <p className="text-xs text-fg-muted">Your code runs only in an isolated cloud sandbox with no internet access after dependencies are installed. Nothing in your project is changed.</p>
    </div>
  );
}
