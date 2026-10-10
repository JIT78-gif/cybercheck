"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/cn";

export function SectionHeader({ title, intro, actions }: { title: string; intro?: string; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold tracking-tight text-fg">{title}</h2>
        {intro && <p className="mt-1 max-w-2xl text-sm text-fg-muted">{intro}</p>}
      </div>
      {actions}
    </div>
  );
}

export function SubTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-sm font-semibold text-fg">{children}</h3>;
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-fg-muted">{children}</p>;
}

/** Label/value pairs, e.g. "Password hashing: bcrypt". */
export function Facts({ items }: { items: Array<[string, React.ReactNode]> }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0 rounded-xl border border-border px-4 py-3">
          <dt className="text-xs text-fg-muted">{k}</dt>
          <dd className="mt-1 text-sm break-words text-fg">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function List({ values, none = "None found" }: { values: string[]; none?: string }) {
  if (!values.length) return <span className="text-fg-muted">{none}</span>;
  return <>{values.join(", ")}</>;
}

export type Column<T> = { label: string; cell: (row: T) => React.ReactNode; className?: string };

const PAGE = 50;

/** A table with optional text search and filter chips. Rows past 50 load on demand. */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  searchText,
  searchLabel = "Search",
  filters,
  empty,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T, i: number) => string;
  searchText?: (row: T) => string;
  searchLabel?: string;
  filters?: Array<{ id: string; label: string; test: (row: T) => boolean }>;
  empty: string;
}) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const f = filters?.find((x) => x.id === filter);
    return rows.filter((r) => (!f || f.test(r)) && (!needle || !searchText || searchText(r).toLowerCase().includes(needle)));
  }, [rows, q, filter, filters, searchText]);

  if (!rows.length) return <Empty>{empty}</Empty>;

  return (
    <div className="space-y-3">
      {(searchText || filters) && (
        <div className="flex flex-wrap items-center gap-2">
          {searchText && (
            <label className="relative min-w-0 flex-1 basis-56">
              <span className="sr-only">{searchLabel}</span>
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-muted" aria-hidden="true" />
              <input
                type="search"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setLimit(PAGE);
                }}
                placeholder={searchLabel}
                className="h-10 w-full rounded-lg border border-border bg-surface pr-3 pl-9 text-sm text-fg outline-none placeholder:text-fg-muted focus:border-accent focus:ring-2 focus:ring-accent/20"
              />
            </label>
          )}
          {filters && (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filters">
              {[{ id: null, label: "All" }, ...filters].map((f) => (
                <button
                  key={f.id ?? "all"}
                  type="button"
                  aria-pressed={filter === f.id}
                  onClick={() => {
                    setFilter(f.id);
                    setLimit(PAGE);
                  }}
                  className={cn(
                    "h-9 cursor-pointer rounded-full border px-3 text-xs font-medium transition-colors",
                    filter === f.id ? "border-fg bg-fg text-bg" : "border-border text-fg-muted hover:text-fg",
                  )}
                >
                  {f.label}
                  {"test" in f && <span className="ml-1.5 tabular-nums opacity-70">{rows.filter(f.test).length}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="relative overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[560px] border-collapse text-left text-sm">
          <thead className="bg-surface-2/60 text-xs text-fg-muted">
            <tr>
              {columns.map((c) => (
                <th key={c.label} scope="col" className={cn("px-3 py-2.5 font-medium", c.className)}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/70">
            {shown.slice(0, limit).map((r, i) => (
              <tr key={rowKey(r, i)} className="align-top hover:bg-surface-2/40">
                {columns.map((c) => (
                  <td key={c.label} className={cn("px-3 py-2.5 text-fg", c.className)}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-3 py-6 text-center text-fg-muted">
                  Nothing matches.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {(shown.length > limit || shown.length !== rows.length) && (
        <p className="text-xs text-fg-muted tabular-nums">
          Showing {Math.min(limit, shown.length)} of {rows.length}
          {shown.length > limit && (
            <button type="button" onClick={() => setLimit((l) => l + PAGE * 4)} className="ml-3 cursor-pointer font-medium text-accent hover:underline">
              Show more
            </button>
          )}
        </p>
      )}
    </div>
  );
}

const TONES = {
  good: "border-success/30 bg-success/8 text-success",
  warn: "border-warning/30 bg-warning/8 text-warning",
  bad: "border-danger/30 bg-danger/8 text-danger",
  info: "border-accent/30 bg-accent/8 text-accent",
  muted: "border-border bg-surface-2 text-fg-muted",
} as const;

export function Badge({ tone, children, className }: { tone: keyof typeof TONES; children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium", TONES[tone], className)}>
      {children}
    </span>
  );
}

export function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("font-mono text-xs break-all", className)}>{children}</span>;
}
