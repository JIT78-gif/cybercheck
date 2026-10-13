"use client";

import { useCallback, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/cn";

export type TabItem<T extends string> = { id: T; label: string; count?: number; tone?: "bad" | "warn" | "muted" };

/** URL-backed view state (?tab=…&sub=…&f=…), so a link opens the exact tab and problem. */
export function useViewParams() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const set = useCallback(
    (next: Record<string, string | null>) => {
      const q = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(next)) {
        if (v == null) q.delete(k);
        else q.set(k, v);
      }
      router.replace(`${pathname}?${q.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );
  return { get: (k: string) => params.get(k), set };
}

/**
 * Accessible tab bar: arrow keys move between tabs, Home and End jump to the ends. `level` "main" is the page's
 * top tabs; "sub" is the smaller row inside a tab.
 */
export function Tabs<T extends string>({ items, value, onChange, label, level = "main", idPrefix }: { items: TabItem<T>[]; value: T; onChange: (id: T) => void; label: string; level?: "main" | "sub"; idPrefix: string }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const move = (i: number) => {
    const n = (i + items.length) % items.length;
    refs.current[n]?.focus();
    onChange(items[n]!.id);
  };
  return (
    <div role="tablist" aria-label={label} className={cn("flex gap-1 overflow-x-auto", level === "main" ? "border-b border-border" : "flex-wrap")}>
      {items.map((t, i) => {
        const on = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            id={`${idPrefix}-tab-${t.id}`}
            role="tab"
            type="button"
            aria-selected={on}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") move(i + 1);
              else if (e.key === "ArrowLeft") move(i - 1);
              else if (e.key === "Home") move(0);
              else if (e.key === "End") move(items.length - 1);
              else return;
              e.preventDefault();
            }}
            className={cn(
              "inline-flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-ring",
              level === "main"
                ? cn("-mb-px min-h-11 border-b-2 px-3 text-sm font-medium", on ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg")
                : cn("min-h-9 rounded-full px-3 text-sm", on ? "bg-fg text-bg" : "bg-surface-2 text-fg-muted hover:text-fg"),
            )}
          >
            {t.label}
            {t.count != null && (
              <span
                className={cn(
                  "rounded-full px-1.5 text-xs tabular-nums",
                  on && level === "sub" ? "bg-bg/20" : t.tone === "bad" ? "bg-danger/10 text-danger" : t.tone === "warn" ? "bg-warning/10 text-warning" : "bg-surface-2 text-fg-muted",
                )}
              >
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** The panel a tab bar controls. */
export function TabPanel({ idPrefix, value, children }: { idPrefix: string; value: string; children: React.ReactNode }) {
  return (
    <div role="tabpanel" id={`${idPrefix}-panel`} aria-labelledby={`${idPrefix}-tab-${value}`} className="space-y-6 focus-visible:outline-none">
      {children}
    </div>
  );
}
