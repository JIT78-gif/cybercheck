"use client";

import { useMemo } from "react";
import { X } from "lucide-react";
import type { Obligation, ObligationStatus } from "@cybercheck/contracts";
import { cn } from "@/lib/cn";

const LAYER_LABEL: Record<string, string> = {
  environment: "Install and build",
  existing_suite: "Your own tests",
  unit: "Generated unit tests",
  api: "API",
  ui: "Screens and journeys",
  accessibility: "Accessibility",
  data: "Database",
  performance: "Load",
  reliability: "Reliability",
  integration: "Integrations",
  job: "Background jobs",
  deployment: "Deployment",
};

/** Colour and a glyph, so status never depends on colour alone. */
const TILE: Record<ObligationStatus, { cls: string; glyph: string; label: string }> = {
  passed: { cls: "bg-success/80 text-white", glyph: "✓", label: "passed" },
  failed: { cls: "bg-danger text-white", glyph: "×", label: "failed" },
  flaky: { cls: "bg-warning text-white", glyph: "~", label: "flaky" },
  inconclusive: { cls: "bg-warning/30 text-fg", glyph: "?", label: "no verdict" },
  blocked: { cls: "bg-warning/20 text-fg", glyph: "!", label: "blocked" },
  running: { cls: "bg-accent/70 text-white animate-pulse motion-reduce:animate-none", glyph: "•", label: "running" },
  planned: { cls: "bg-surface-2 text-fg-muted", glyph: "", label: "waiting" },
  unsupported: { cls: "bg-surface-2 text-fg-muted/70", glyph: "-", label: "not supported" },
  skipped: { cls: "bg-surface-2 text-fg-muted/70", glyph: "-", label: "skipped" },
  not_applicable: { cls: "bg-surface-2 text-fg-muted/70", glyph: "-", label: "not applicable" },
};

const LEGEND: ObligationStatus[] = ["passed", "failed", "inconclusive", "blocked", "running", "planned", "unsupported"];

/** Every planned check as a tile, grouped by what it tests, filling in as results arrive. */
export function CheckMap({ obligations, open, onOpen }: { obligations: Obligation[]; open: string | null; onOpen: (id: string | null) => void }) {
  const setOpen = onOpen;
  const groups = useMemo(() => {
    const by = new Map<string, Obligation[]>();
    for (const o of obligations) by.set(o.layer, [...(by.get(o.layer) ?? []), o]);
    return [...by.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [obligations]);
  const picked = obligations.find((o) => o.id === open) ?? null;

  if (!obligations.length) return <p className="text-sm text-fg-muted">The checks appear here once the plan is ready.</p>;
  return (
    <div className="space-y-4">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted" aria-label="Legend">
        {LEGEND.map((s) => (
          <li key={s} className="flex items-center gap-1.5">
            <span className={cn("grid size-4 place-items-center rounded-[3px] text-[10px] font-bold", TILE[s].cls)} aria-hidden="true">
              {TILE[s].glyph}
            </span>
            {TILE[s].label}
          </li>
        ))}
      </ul>
      <div className="space-y-3">
        {groups.map(([layer, list]) => {
          const done = list.filter((o) => !["planned", "running"].includes(o.status)).length;
          const failed = list.filter((o) => o.status === "failed").length;
          return (
            <section key={layer} aria-label={LAYER_LABEL[layer] ?? layer}>
              <h4 className="mb-1.5 flex items-baseline justify-between gap-2 text-xs font-medium text-fg">
                <span>{LAYER_LABEL[layer] ?? layer}</span>
                <span className="font-normal text-fg-muted tabular-nums">
                  {done} of {list.length} done{failed ? `, ${failed} failed` : ""}
                </span>
              </h4>
              <ul className="flex flex-wrap gap-1">
                {list.map((o) => (
                  <li key={o.id} id={`check-${o.id}`}>
                    <button
                      onClick={() => setOpen(open === o.id ? null : o.id)}
                      aria-label={`${o.asset.label}: ${o.objective}. ${TILE[o.status].label}`}
                      aria-expanded={open === o.id}
                      title={`${o.asset.label}: ${o.objective} (${TILE[o.status].label})`}
                      className={cn(
                        "grid size-6 place-items-center rounded-[4px] text-[11px] font-bold transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent motion-reduce:transition-none motion-reduce:hover:scale-100",
                        TILE[o.status].cls,
                        open === o.id && "ring-2 ring-accent ring-offset-1",
                      )}
                    >
                      {TILE[o.status].glyph}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      {picked && (
        <div className="relative rounded-lg border border-border bg-surface-2 p-3 pr-10 text-sm" role="region" aria-label="Check details">
          <button onClick={() => setOpen(null)} aria-label="Close" className="absolute top-2 right-2 grid size-8 place-items-center rounded-md text-fg-muted hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent">
            <X className="size-4" aria-hidden="true" />
          </button>
          <p className="font-medium text-fg">{picked.objective}</p>
          <p className="mt-0.5 font-mono text-xs text-fg-muted">{picked.asset.label}</p>
          <p className="mt-2 text-fg">
            <span className="font-medium">{TILE[picked.status].label[0]!.toUpperCase() + TILE[picked.status].label.slice(1)}</span>
            {picked.reason ? `: ${picked.reason}` : ""}
          </p>
        </div>
      )}
    </div>
  );
}
