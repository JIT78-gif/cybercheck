"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Globe, ImageOff, LoaderCircle, Monitor, Pause, Play, RotateCw, Smartphone, TriangleAlert } from "lucide-react";
import type { LiveAction, TestingEvent } from "@cybercheck/contracts";
import { cn } from "@/lib/cn";

type ScreenShot = Extract<LiveAction, { k: "screen" }> & { exec?: string };
type StepShot = Extract<LiveAction, { k: "step" }> & { exec?: string };

/** Viewport height the browser harness uses for each width (its screenshots are exactly this size). */
const heightOf = (vp: number) => (vp < 500 ? 812 : 900);

const shotUrl = (runId: string, exec: string | undefined, shot: string | null) => (exec && shot ? `/v1/testing-runs/${runId}/executions/${exec}/artifacts/${encodeURIComponent(shot)}` : null);

/**
 * A browser window inside the page: the screens cybercheck opened (desktop and phone width) with the
 * accessibility problems axe found marked on them, and every browser journey played back step by step.
 */
export function BrowserViewer({ runId, events, live }: { runId: string; events: TestingEvent[]; live: boolean }) {
  const screens = useMemo(() => {
    const byKey = new Map<string, ScreenShot>();
    for (const e of events) if (e.data?.k === "screen") byKey.set(`${e.data.url}|${e.data.vp}`, e.data as ScreenShot);
    return [...byKey.values()];
  }, [events]);
  const journeys = useMemo(() => {
    const by = new Map<string, StepShot[]>();
    for (const e of events) if (e.data?.k === "step") by.set(e.data.journey, [...(by.get(e.data.journey) ?? []), e.data as StepShot]);
    return [...by.entries()].map(([id, steps]) => ({ id, title: steps[0]!.title, of: steps[0]!.of, steps: steps.sort((a, b) => a.n - b.n) }));
  }, [events]);

  const [tab, setTab] = useState<"screens" | "journeys">("screens");
  const urls = useMemo(() => [...new Set(screens.map((s) => s.url))], [screens]);
  const widths = useMemo(() => [...new Set(screens.map((s) => s.vp))].sort((a, b) => b - a), [screens]);
  const [pickedUrl, setPickedUrl] = useState<string | null>(null);
  const [vp, setVp] = useState<number | null>(null);
  // While the run is live and nothing was picked, follow the newest screen.
  const url = pickedUrl ?? (live ? (screens.at(-1)?.url ?? null) : (urls[0] ?? null));
  const width = vp ?? widths[0] ?? 1440;
  const current = screens.find((s) => s.url === url && s.vp === width) ?? screens.find((s) => s.url === url) ?? null;

  if (!screens.length && !journeys.length) {
    return (
      <Frame address={live ? "Waiting for the browser checks" : "No browser checks"} toolbar={null}>
        <div className="grid aspect-[16/10] place-items-center bg-surface-2 p-6 text-center text-sm text-fg-muted">
          {live ? (
            <span className="inline-flex items-center gap-2">
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> The browser opens your screens after the API checks start.
            </span>
          ) : (
            "This run did not open any screens, or it ran before screenshots were recorded."
          )}
        </div>
      </Frame>
    );
  }

  return (
    <div className="space-y-3">
      <div role="tablist" aria-label="What the browser shows" className="inline-flex rounded-full border border-border bg-surface p-1 text-sm">
        {(["screens", "journeys"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn("min-h-9 rounded-full px-4 font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent", tab === t ? "bg-accent text-white" : "text-fg-muted hover:text-fg")}
          >
            {t === "screens" ? `Screens (${urls.length})` : `Journeys (${journeys.length})`}
          </button>
        ))}
      </div>

      {tab === "screens" ? (
        <>
          <Frame
            address={current?.path ?? url ?? "/"}
            toolbar={
              widths.length > 1 && (
                <div className="flex items-center gap-1" role="group" aria-label="Screen width">
                  {widths.map((w) => (
                    <button
                      key={w}
                      onClick={() => setVp(w)}
                      aria-pressed={width === w}
                      aria-label={w < 500 ? `Phone width (${w} px)` : `Desktop width (${w} px)`}
                      className={cn("grid size-9 place-items-center rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-accent", width === w ? "bg-accent/10 text-accent" : "text-fg-muted hover:bg-surface-2")}
                    >
                      {w < 500 ? <Smartphone className="size-4" aria-hidden="true" /> : <Monitor className="size-4" aria-hidden="true" />}
                    </button>
                  ))}
                </div>
              )
            }
          >
            <Shot runId={runId} shot={current} live={live} />
          </Frame>
          {current && <ScreenFacts s={current} />}
          <Filmstrip
            items={urls.map((u) => {
              const s = screens.find((x) => x.url === u && x.vp === width) ?? screens.find((x) => x.url === u)!;
              return { key: u, label: s.path, src: shotUrl(runId, s.exec, s.shot), bad: (s.status ?? 0) >= 400 || (s.axe ?? 0) > 0 || (s.overflow ?? 0) > 2 };
            })}
            selected={url}
            onSelect={(k) => setPickedUrl(k)}
          />
        </>
      ) : (
        <JourneyPlayer runId={runId} journeys={journeys} live={live} />
      )}
    </div>
  );
}

/** Browser chrome: back, forward and reload (decorative), the address, and tools on the right. */
function Frame({ address, toolbar, children }: { address: string; toolbar: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface shadow-sm">
      <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-3 py-2">
        <div className="hidden gap-1.5 sm:flex" aria-hidden="true">
          <span className="size-2.5 rounded-full bg-danger/60" />
          <span className="size-2.5 rounded-full bg-warning/60" />
          <span className="size-2.5 rounded-full bg-success/60" />
        </div>
        <div className="flex items-center gap-1 text-fg-muted" aria-hidden="true">
          <ChevronLeft className="size-4" />
          <ChevronRight className="size-4" />
          <RotateCw className="size-3.5" />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1 font-mono text-xs text-fg">
          <Globe className="size-3.5 shrink-0 text-fg-muted" aria-hidden="true" />
          <span className="truncate" title={address}>
            {address}
          </span>
        </div>
        {toolbar}
      </div>
      {children}
    </div>
  );
}

/** One screenshot with the accessibility problems marked where axe found them. */
function Shot({ runId, shot, live }: { runId: string; shot: ScreenShot | null; live: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  const src = shot ? shotUrl(runId, shot.exec, shot.shot) : null;
  const h = shot ? heightOf(shot.vp) : 900;
  const marks = (shot?.marks ?? []).filter((m) => m.box.y < h);
  const phone = (shot?.vp ?? 1440) < 500;
  return (
    <div className={cn("relative bg-surface-2", phone && "flex justify-center py-4")}>
      <div className={cn("relative", phone ? "w-[min(100%,260px)] overflow-hidden rounded-[1.5rem] border-4 border-fg/80 shadow-md" : "w-full")} style={{ aspectRatio: shot ? `${shot.vp} / ${h}` : "16 / 10" }}>
        {src && failed !== src ? (
          // eslint-disable-next-line @next/next/no-img-element -- authenticated artifact URL, not an optimisable static image
          <img src={src} alt={`Screenshot of ${shot!.path} at ${shot!.vp} px${shot!.as ? `, signed in as ${shot!.as}` : ""}`} className="absolute inset-0 size-full object-cover object-top" onError={() => setFailed(src)} />
        ) : (
          <div className="absolute inset-0 grid place-items-center p-4 text-center text-sm text-fg-muted">
            {live && shot && !shot.shot ? (
              <span className="inline-flex items-center gap-2">
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> Opening {shot.path}
              </span>
            ) : live && shot ? (
              <span className="inline-flex items-center gap-2">
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> The screenshot arrives when this browser step finishes
              </span>
            ) : (
              <span className="inline-flex items-center gap-2">
                <ImageOff className="size-4" aria-hidden="true" /> No screenshot for this screen
              </span>
            )}
          </div>
        )}
        {src &&
          failed !== src &&
          marks.map((m, i) => (
            <span
              key={i}
              className="absolute rounded-sm border-2 border-danger bg-danger/10"
              style={{ left: `${(m.box.x / shot!.vp) * 100}%`, top: `${(m.box.y / h) * 100}%`, width: `${Math.max(1.5, (m.box.w / shot!.vp) * 100)}%`, height: `${Math.max(1.5, (m.box.h / h) * 100)}%` }}
              title={`${i + 1}. ${m.help} (${m.rule})`}
            >
              <span className="absolute -top-2.5 -left-2.5 grid size-5 place-items-center rounded-full bg-danger text-[10px] font-semibold text-white shadow" aria-hidden="true">
                {i + 1}
              </span>
            </span>
          ))}
      </div>
    </div>
  );
}

/** What was found on the shown screen, in words (markers are never the only signal). */
function ScreenFacts({ s }: { s: ScreenShot }) {
  const marks = s.marks ?? [];
  const ok = (s.status ?? 0) < 400 && !(s.axe ?? 0) && (s.overflow ?? 0) <= 2;
  return (
    <div className="space-y-2 text-sm">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-fg-muted">
        <span>
          Answered <span className="font-mono text-fg">{s.status ?? "nothing"}</span>
        </span>
        <span>{s.as ? `Signed in as ${s.as}` : "Not signed in"}</span>
        {(s.overflow ?? 0) > 2 && <span className="text-warning">{s.overflow} px wider than the screen</span>}
        {ok && <span className="text-success">No problem found on this screen</span>}
      </p>
      {marks.length > 0 && (
        <ol className="space-y-1">
          {marks.map((m, i) => (
            <li key={i} className="flex gap-2 text-fg">
              <span className="grid size-5 shrink-0 place-items-center rounded-full bg-danger text-[10px] font-semibold text-white" aria-hidden="true">
                {i + 1}
              </span>
              <span>
                <TriangleAlert className="mr-1 inline size-3.5 text-danger" aria-hidden="true" />
                {m.help} <span className="font-mono text-xs text-fg-muted">({m.rule}{m.impact ? `, ${m.impact}` : ""})</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Filmstrip({ items, selected, onSelect }: { items: Array<{ key: string; label: string; src: string | null; bad: boolean }>; selected: string | null; onSelect: (key: string) => void }) {
  return (
    <ul className="flex gap-2 overflow-x-auto pb-1" aria-label="Screens opened">
      {items.map((it) => (
        <li key={it.key} className="shrink-0">
          <button
            onClick={() => onSelect(it.key)}
            aria-current={selected === it.key ? "true" : undefined}
            className={cn("block w-32 overflow-hidden rounded-lg border text-left transition-shadow focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent", selected === it.key ? "border-accent ring-2 ring-accent/30" : "border-border hover:border-fg-muted")}
          >
            <span className="block aspect-[16/10] bg-surface-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- authenticated artifact URL */}
              {it.src && <img src={it.src} alt="" className="size-full object-cover object-top" loading="lazy" />}
            </span>
            <span className="flex items-center gap-1 px-2 py-1 font-mono text-[11px] text-fg">
              {it.bad && <TriangleAlert className="size-3 shrink-0 text-danger" aria-label="has problems" />}
              <span className="truncate">{it.label}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Each journey step by step: the screenshot after the step, what was done, and whether it worked. */
function JourneyPlayer({ runId, journeys, live }: { runId: string; journeys: Array<{ id: string; title: string; of: number; steps: StepShot[] }>; live: boolean }) {
  const [jid, setJid] = useState<string | null>(null);
  const [n, setN] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const j = journeys.find((x) => x.id === jid) ?? (live ? journeys.at(-1) : journeys[0]) ?? null;
  const steps = j?.steps ?? [];
  const at = n != null ? Math.min(n, steps.length - 1) : live ? steps.length - 1 : 0;
  const step = steps[at] ?? null;

  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => {
      if (at >= steps.length - 1) setPlaying(false);
      else setN(at + 1);
    }, 1600);
    return () => clearTimeout(t);
  }, [playing, at, steps.length]);

  if (!j) return <p className="text-sm text-fg-muted">{live ? "Journeys start after the screens are checked." : "No browser journey ran."}</p>;
  const src = step ? shotUrl(runId, step.exec, step.shot) : null;
  return (
    <div className="space-y-3">
      <label className="flex flex-col gap-1 text-sm sm:flex-row sm:items-center sm:gap-2">
        <span className="text-fg-muted">Journey</span>
        <select
          value={j.id}
          onChange={(e) => {
            setJid(e.target.value);
            setN(0);
            setPlaying(false);
          }}
          className="min-h-10 rounded-md border border-border bg-surface px-2 text-fg"
        >
          {journeys.map((x) => (
            <option key={x.id} value={x.id}>
              {x.title}
            </option>
          ))}
        </select>
      </label>
      <Frame address={step ? `${step.action}${step.target ? `: ${step.target}` : ""}` : j.title} toolbar={null}>
        <div className="relative aspect-[16/10] bg-surface-2">
          {src ? (
            // eslint-disable-next-line @next/next/no-img-element -- authenticated artifact URL
            <img src={src} alt={`After step ${step!.n}: ${step!.action}${step!.target ? ` ${step!.target}` : ""}`} className="absolute inset-0 size-full object-cover object-top" />
          ) : (
            <div className="absolute inset-0 grid place-items-center text-sm text-fg-muted">
              {live ? (
                <span className="inline-flex items-center gap-2">
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> The screenshots arrive when the journeys finish
                </span>
              ) : (
                "No screenshot for this step"
              )}
            </div>
          )}
        </div>
      </Frame>
      {step && (
        <p className={cn("text-sm", step.ok ? "text-fg" : "text-danger")}>
          Step {step.n} of {step.of}: {step.action}
          {step.target ? <span className="font-mono"> &quot;{step.target}&quot;</span> : null} {step.ok ? "worked" : "failed here"}
        </p>
      )}
      <div className="flex items-center gap-2">
        <button onClick={() => setN(Math.max(0, at - 1))} disabled={at <= 0} aria-label="Previous step" className="grid size-10 place-items-center rounded-full border border-border disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent">
          <ChevronLeft className="size-4" aria-hidden="true" />
        </button>
        <button onClick={() => setPlaying((p) => !p)} aria-label={playing ? "Pause" : "Play the journey"} className="grid size-10 place-items-center rounded-full bg-accent text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          {playing ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
        </button>
        <button onClick={() => setN(Math.min(steps.length - 1, at + 1))} disabled={at >= steps.length - 1} aria-label="Next step" className="grid size-10 place-items-center rounded-full border border-border disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent">
          <ChevronRight className="size-4" aria-hidden="true" />
        </button>
        <ol className="ml-2 flex min-w-0 flex-1 gap-1 overflow-x-auto" aria-label="Steps">
          {steps.map((s, i) => (
            <li key={s.n}>
              <button
                onClick={() => {
                  setN(i);
                  setPlaying(false);
                }}
                aria-label={`Step ${s.n}${s.ok ? "" : ", failed"}`}
                aria-current={i === at ? "step" : undefined}
                className={cn("h-2.5 w-6 rounded-full", i === at ? "bg-accent" : s.ok ? "bg-success/50" : "bg-danger")}
              />
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
