"use client";

import { useEffect, useId, useRef, useState } from "react";
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
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

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

  const zoom = (f: number) => setScale((s) => Math.min(4, Math.max(0.25, s * f)));
  const reset = () => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  };

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
        <figcaption className="text-xs font-medium text-fg-muted">{label}</figcaption>
        <div className="flex items-center gap-1">
          {[
            { icon: Minus, label: "Zoom out", on: () => zoom(1 / 1.25) },
            { icon: Plus, label: "Zoom in", on: () => zoom(1.25) },
            { icon: RotateCcw, label: "Reset view", on: reset },
          ].map((b) => (
            <button
              key={b.label}
              type="button"
              onClick={b.on}
              aria-label={b.label}
              title={b.label}
              className="inline-flex size-9 cursor-pointer items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <b.icon className="size-4" />
            </button>
          ))}
          <span className="w-12 text-right font-mono text-xs text-fg-muted tabular-nums">{Math.round(scale * 100)}%</span>
        </div>
      </div>
      <div
        className="relative h-[min(70vh,560px)] cursor-grab touch-none overflow-hidden bg-bg active:cursor-grabbing"
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setOffset({ x: drag.current.ox + e.clientX - drag.current.x, y: drag.current.oy + e.clientY - drag.current.y });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        role="img"
        aria-label={label}
      >
        {!svg ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-fg-muted">
            <Spinner /> Drawing diagram
          </div>
        ) : (
          <div
            className="flex h-full w-full items-start justify-center p-6 [&_svg]:h-auto [&_svg]:max-w-none"
            style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`, transformOrigin: "top center" }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        )}
      </div>
    </figure>
  );
}
