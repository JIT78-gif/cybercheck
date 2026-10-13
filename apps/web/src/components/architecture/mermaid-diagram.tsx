"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Minus, Plus, RotateCcw } from "lucide-react";
import { Spinner } from "@/components/ui/form";

type MermaidApi = (typeof import("mermaid"))["default"];
let loader: Promise<MermaidApi> | null = null;

/** Load mermaid once, in strict mode (labels are sanitized; no scripts or click handlers). */
function getMermaid() {
  loader ??= import("mermaid").then(({ default: m }) => {
    m.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      // On a syntax error, throw instead of drawing Mermaid's error image into the page.
      suppressErrorRendering: true,
      theme: "base",
      fontFamily: "IBM Plex Sans, ui-sans-serif, system-ui, sans-serif",
      themeVariables: {
        primaryColor: "#eef4ff",
        primaryBorderColor: "#1d4ed8",
        primaryTextColor: "#0f172a",
        lineColor: "#94a3b8",
        secondaryColor: "#f3f2ee",
        tertiaryColor: "#ffffff",
        clusterBkg: "#fafaf7",
        clusterBorder: "#e6e4de",
        fontSize: "14px",
      },
      flowchart: { htmlLabels: true, curve: "basis", padding: 12 },
      er: { layoutDirection: "TB" },
    });
    return m;
  });
  return loader;
}

/** A Mermaid diagram with zoom and pan. Falls back to its source text if it can't render. */
export function MermaidDiagram({ code, label }: { code: string; label: string }) {
  const rawId = useId();
  const id = `mmd-${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  // One view state so zoom and pan always update together. The content is transformed from its top-left corner.
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const viewport = useRef<HTMLDivElement>(null);

  /** Zoom by `factor`, keeping the content under point (px, py) of the viewport in place. */
  const zoomAt = useCallback((factor: number, px: number, py: number) => {
    setView((v) => {
      const scale = Math.min(6, Math.max(0.2, v.scale * factor));
      const k = scale / v.scale;
      return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  }, []);

  // Ctrl (or Cmd) + mouse wheel, and trackpad pinch, zoom around the pointer. A native listener is
  // needed because React's wheel handler is passive and can't stop the browser from zooming the page.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return; // plain scrolling still scrolls the page
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018)), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt, svg]);

  useEffect(() => {
    let cancelled = false;
    getMermaid()
      .then((m) => m.render(id, code))
      .then((r) => !cancelled && setSvg(r.svg))
      .catch(() => {
        // Mermaid renders in a temporary element; make sure nothing is left behind on failure.
        for (const stray of [id, `d${id}`, `i${id}`]) document.getElementById(stray)?.remove();
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [id, code]);

  // Buttons zoom around the centre of the visible area (factor 0 = reset).
  const onButton = useCallback(
    (factor: number) => {
      if (!factor) return setView({ scale: 1, x: 0, y: 0 });
      const r = viewport.current?.getBoundingClientRect();
      zoomAt(factor, (r?.width ?? 0) / 2, (r?.height ?? 0) / 2);
    },
    [zoomAt],
  );
  const reset = () => setView({ scale: 1, x: 0, y: 0 });

  if (failed) {
    return (
      <div className="rounded-xl border border-warning/30 bg-warning/5 p-4 text-sm">
        <p className="font-medium text-fg">This diagram couldn&apos;t be drawn.</p>
        <p className="mt-1 text-fg-muted">The facts it shows are still listed below. Its source:</p>
        <pre className="mt-3 max-h-64 overflow-auto rounded-lg bg-surface p-3 font-mono text-xs text-fg-muted">{code}</pre>
      </div>
    );
  }

  return (
    <figure className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <figcaption className="min-w-0 text-xs text-fg-muted">
          <span className="font-medium">{label}</span>
          <span className="hidden sm:inline"> · Ctrl + scroll to zoom, drag to move, double-click to reset</span>
        </figcaption>
        <div className="flex items-center gap-1">
          {[
            { icon: Minus, label: "Zoom out", factor: 1 / 1.25 },
            { icon: Plus, label: "Zoom in", factor: 1.25 },
            { icon: RotateCcw, label: "Reset view", factor: 0 },
          ].map((b) => (
            <button
              key={b.label}
              type="button"
              onClick={() => onButton(b.factor)}
              aria-label={b.label}
              title={b.label}
              className="inline-flex size-9 cursor-pointer items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <b.icon className="size-4" />
            </button>
          ))}
          <span className="w-12 text-right font-mono text-xs text-fg-muted tabular-nums">{Math.round(view.scale * 100)}%</span>
        </div>
      </div>
      <div
        ref={viewport}
        className="relative h-[min(70vh,560px)] cursor-grab touch-none overflow-hidden bg-bg active:cursor-grabbing"
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          setView((v) => ({ ...v, x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onDoubleClick={reset}
        role="img"
        aria-label={`${label}. Hold Ctrl and scroll to zoom.`}
      >
        {!svg ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-fg-muted">
            <Spinner /> Drawing diagram
          </div>
        ) : (
          <div
            className="flex h-full w-full items-start justify-center p-6 [&_svg]:h-auto [&_svg]:max-w-none"
            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transformOrigin: "0 0" }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        )}
      </div>
    </figure>
  );
}
