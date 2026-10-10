"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { FileCode2, ShieldCheck, X } from "lucide-react";
import type { Evidence, SourceExcerpt } from "@cybercheck/contracts";
import { Alert, Spinner } from "@/components/ui/form";
import { ApiError, api } from "@/lib/api";
import { cn } from "@/lib/cn";

const CONTEXT = 12;

type Open = (e: Evidence) => void;
const Ctx = createContext<Open | null>(null);

export function useCodeViewer() {
  const open = useContext(Ctx);
  if (!open) throw new Error("useCodeViewer must be inside <CodeViewerProvider>");
  return open;
}

/** "src/x.ts:42" button that opens the code viewer at that line. */
export function EvidenceLink({ evidence, className }: { evidence: Evidence; className?: string }) {
  const open = useCodeViewer();
  return (
    <button
      type="button"
      onClick={() => open(evidence)}
      className={cn("inline-flex max-w-full cursor-pointer items-center gap-1 truncate rounded font-mono text-xs text-accent underline-offset-2 hover:underline", className)}
      title={`Open ${evidence.path} at line ${evidence.line}`}
    >
      <FileCode2 className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">
        {evidence.path}:{evidence.line}
      </span>
    </button>
  );
}

export function CodeViewerProvider({ snapshotId, children }: { snapshotId: string; children: React.ReactNode }) {
  const [target, setTarget] = useState<Evidence | null>(null);
  const [excerpt, setExcerpt] = useState<SourceExcerpt | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const highlight = useRef<HTMLTableRowElement>(null);

  const open = useCallback((e: Evidence) => {
    setTarget(e);
    setExcerpt(null);
    setError(null);
    dialog.current?.showModal();
  }, []);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    const start = Math.max(1, target.line - CONTEXT);
    const end = (target.endLine ?? target.line) + CONTEXT;
    const q = new URLSearchParams({ path: target.path, start: String(start), end: String(end) });
    api<SourceExcerpt>(`/v1/snapshots/${snapshotId}/file?${q}`)
      .then((x) => !cancelled && setExcerpt(x))
      .catch((e) => !cancelled && setError(e instanceof ApiError ? e : null));
    return () => {
      cancelled = true;
    };
  }, [target, snapshotId]);

  useEffect(() => {
    highlight.current?.scrollIntoView({ block: "center" });
  }, [excerpt]);

  const hiStart = target?.line ?? 0;
  const hiEnd = Math.min(target?.endLine ?? hiStart, hiStart + 30);

  return (
    <Ctx.Provider value={open}>
      {children}
      <dialog
        ref={dialog}
        onClose={() => setTarget(null)}
        aria-labelledby="code-viewer-title"
        className="m-auto w-[min(960px,calc(100%-2rem))] rounded-2xl border border-border bg-surface p-0 text-fg shadow-2xl backdrop:bg-black/40"
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
          <div className="min-w-0">
            <h2 id="code-viewer-title" className="truncate font-mono text-sm font-medium">
              {target?.path}
            </h2>
            {excerpt && (
              <p className="text-xs text-fg-muted">
                Lines {excerpt.start} to {excerpt.end} of {excerpt.totalLines} · read-only snapshot
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => dialog.current?.close()}
            aria-label="Close code viewer"
            className="inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full text-fg-muted hover:bg-surface-2 hover:text-fg"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-auto">
          {error ? (
            <Alert className="m-5">
              {error.message} {error.fix}
            </Alert>
          ) : !excerpt ? (
            <div className="flex items-center gap-2 p-5 text-sm text-fg-muted">
              <Spinner /> Loading code
            </div>
          ) : (
            <table className="w-full border-collapse font-mono text-[12.5px] leading-6">
              <tbody>
                {excerpt.lines.map((l, i) => {
                  const n = excerpt.start + i;
                  const hit = n >= hiStart && n <= hiEnd;
                  return (
                    <tr key={n} ref={n === hiStart ? highlight : undefined} className={hit ? "bg-accent/10" : undefined}>
                      <td className={cn("w-14 select-none border-r border-border px-3 text-right align-top text-fg-muted", hit && "font-semibold text-accent")}>{n}</td>
                      <td className="px-4 align-top whitespace-pre text-fg">{l || " "}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        {excerpt && excerpt.redactions > 0 && (
          <p className="flex items-center gap-2 border-t border-border px-5 py-2 text-xs text-fg-muted">
            <ShieldCheck className="size-3.5 text-success" aria-hidden="true" />
            {excerpt.redactions} secret-looking value{excerpt.redactions === 1 ? " was" : "s were"} hidden.
          </p>
        )}
      </dialog>
    </Ctx.Provider>
  );
}
