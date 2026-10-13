"use client";

import { useMemo, useState } from "react";
import { Activity, AppWindow, CircleCheck, CircleX, Footprints, Gauge, Info, Send, TriangleAlert } from "lucide-react";
import type { LiveAction, TestingEvent } from "@cybercheck/contracts";
import { cn } from "@/lib/cn";

type Filter = "all" | "req" | "screen" | "step" | "load" | "problems";

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "Everything" },
  { id: "req", label: "Requests" },
  { id: "screen", label: "Screens" },
  { id: "step", label: "Journeys" },
  { id: "load", label: "Load" },
  { id: "problems", label: "Problems only" },
];

/** Whether an action shows something wrong (so "Problems only" can find it, and it is marked in the feed). */
export function isProblem(a: LiveAction | undefined) {
  if (!a) return false;
  if (a.k === "req") return !a.ok;
  if (a.k === "screen") return (a.status ?? 0) >= 400 || (a.axe ?? 0) > 0 || (a.overflow ?? 0) > 2;
  if (a.k === "step") return !a.ok;
  if (a.k === "load") return a.state === "end" && (a.errors ?? 0) > 0;
  return /failed/.test(a.text);
}

const ICON = { req: Send, screen: AppWindow, step: Footprints, load: Gauge, note: Info } as const;

/**
 * Everything cybercheck does, as it happens: each request and its answer, each screen opened, each journey
 * step, the load stages and the run's own phases. Newest first.
 */
export function ActivityFeed({ events, live, onOpenCheck }: { events: TestingEvent[]; live: boolean; onOpenCheck?: (obligationId: string) => void }) {
  const [filter, setFilter] = useState<Filter>("all");
  const shown = useMemo(() => {
    const list = events.filter((e) => {
      if (filter === "all") return true;
      if (filter === "problems") return isProblem(e.data);
      return e.data?.k === filter;
    });
    return list.slice(-300).reverse();
  }, [events, filter]);
  const counts = useMemo(() => {
    const c = { req: 0, screen: 0, step: 0, load: 0, problems: 0 };
    for (const e of events) {
      if (e.data && e.data.k !== "note") c[e.data.k]++;
      if (isProblem(e.data)) c.problems++;
    }
    return c;
  }, [events]);
  const newest = events.at(-1);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter the activity">
        {FILTERS.map((f) => {
          const n = f.id === "all" ? null : counts[f.id as keyof typeof counts];
          return (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              aria-pressed={filter === f.id}
              className={cn(
                "min-h-8 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                filter === f.id ? "border-accent bg-accent/10 text-accent" : "border-border text-fg-muted hover:text-fg",
              )}
            >
              {f.label}
              {n != null && n > 0 && <span className="ml-1 tabular-nums">{n}</span>}
            </button>
          );
        })}
      </div>

      {/* One short announcement of the newest action for screen readers, instead of re-reading the whole list. */}
      <p className="sr-only" aria-live="polite">
        {live && newest ? newest.message : ""}
      </p>

      {shown.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-fg-muted">
          {events.length ? "Nothing matches this filter yet." : live ? "Waiting for the first action..." : "No activity was recorded for this run."}
        </p>
      ) : (
        <ol className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1" aria-label="Activity, newest first">
          {shown.map((e, i) => (
            <Row key={e.seq} e={e} fresh={live && i === 0 && filter === "all"} onOpenCheck={onOpenCheck} />
          ))}
        </ol>
      )}
    </div>
  );
}

function Row({ e, fresh, onOpenCheck }: { e: TestingEvent; fresh: boolean; onOpenCheck?: (id: string) => void }) {
  const a = e.data;
  const bad = isProblem(a);
  const phase = e.type.startsWith("phase:");
  const Icon = a ? ICON[a.k] : phase ? Activity : Info;
  const time = new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const check = a?.k === "req" ? a.check : null;
  const body = (
    <>
      <span className="w-16 shrink-0 font-mono text-[11px] text-fg-muted tabular-nums">{time}</span>
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", bad ? "text-danger" : phase ? "text-accent" : "text-fg-muted")} aria-hidden="true" />
      <span className="min-w-0 flex-1">{a ? <Action a={a} /> : <span className={cn(phase ? "font-medium text-fg" : "text-fg-muted")}>{e.message}</span>}</span>
      {a && a.k !== "note" && a.k !== "load" && (
        <span className="shrink-0" aria-label={bad ? "problem" : "ok"}>
          {bad ? <CircleX className="size-3.5 text-danger" aria-hidden="true" /> : <CircleCheck className="size-3.5 text-success" aria-hidden="true" />}
        </span>
      )}
    </>
  );
  return (
    <li className={cn("rounded-md", fresh && "animate-fade-up bg-accent/5")}>
      {check && onOpenCheck ? (
        <button onClick={() => onOpenCheck(check)} className="flex w-full items-start gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent" title="Show this check">
          {body}
        </button>
      ) : (
        <div className="flex items-start gap-2 px-2 py-1 text-sm">{body}</div>
      )}
    </li>
  );
}

function Action({ a }: { a: LiveAction }) {
  if (a.k === "req")
    return (
      <span className="break-words">
        <span className="font-mono text-xs font-semibold text-fg">{a.method}</span> <span className="font-mono text-xs text-fg">{a.path}</span>{" "}
        <span className={cn("font-mono text-xs", a.ok ? "text-fg-muted" : "text-danger")}>{a.status ?? "no answer"}</span>
        {a.ms != null && <span className="text-xs text-fg-muted"> {a.ms} ms</span>}
        {a.as && <span className="text-xs text-fg-muted"> as {a.as}</span>}
        {!a.ok && <span className="text-xs text-danger"> not as expected</span>}
      </span>
    );
  if (a.k === "screen")
    return (
      <span className="break-words text-fg">
        Opened <span className="font-mono text-xs">{a.path}</span> <span className="text-xs text-fg-muted">at {a.vp} px{a.as ? `, as ${a.as}` : ""}</span>
        {(a.axe ?? 0) > 0 && (
          <span className="text-xs text-danger">
            {" "}
            <TriangleAlert className="inline size-3" aria-hidden="true" /> {a.axe} accessibility problem{a.axe === 1 ? "" : "s"}
          </span>
        )}
        {(a.overflow ?? 0) > 2 && <span className="text-xs text-warning"> {a.overflow} px too wide</span>}
        {(a.status ?? 0) >= 400 && <span className="text-xs text-danger"> answered {a.status}</span>}
      </span>
    );
  if (a.k === "step")
    return (
      <span className="break-words text-fg">
        <span className="font-medium">{a.title}</span>
        <span className="text-xs text-fg-muted">
          {" "}
          step {a.n}/{a.of}:
        </span>{" "}
        {a.action}
        {a.target && <span className="font-mono text-xs"> &quot;{a.target}&quot;</span>}
        {!a.ok && <span className="text-xs text-danger"> failed</span>}
      </span>
    );
  if (a.k === "load")
    return a.state === "start" ? (
      <span className="text-fg">
        Load stage <span className="font-medium">{a.stage}</span> started with {a.vus} simulated users
      </span>
    ) : (
      <span className="text-fg">
        Load stage <span className="font-medium">{a.stage}</span> done: {a.rps ?? 0} requests/s, p95 {a.p95 ?? "?"} ms,{" "}
        <span className={cn((a.errors ?? 0) > 0 && "text-danger")}>{a.errors ?? 0}% errors</span>
      </span>
    );
  return <span className={cn("text-fg-muted", /failed/.test(a.text) && "text-danger")}>{a.text}</span>;
}
