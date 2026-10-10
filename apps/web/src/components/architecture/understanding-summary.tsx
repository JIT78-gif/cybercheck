"use client";

import Link from "next/link";
import { ArrowRight, Network } from "lucide-react";
import { Spinner } from "@/components/ui/form";
import { useUnderstanding } from "./use-understanding";

/** One-line understanding status for a snapshot, with a link to the Architecture area. */
export function UnderstandingSummary({ projectId, snapshotId }: { projectId: string; snapshotId: string }) {
  const { run } = useUnderstanding(snapshotId);
  const d = run?.dossier;
  const href = `/app/projects/${projectId}/architecture`;

  return (
    <div className="rounded-xl border border-border p-4">
      <div className="flex items-start gap-3">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
          <Network className="size-4.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-fg">Architecture and understanding</p>
          {!run || run.status === "queued" || run.status === "analyzing" ? (
            <p className="mt-1 flex items-center gap-2 text-sm text-fg-muted">
              <Spinner /> Reading the code
            </p>
          ) : run.status === "failed" || !d ? (
            <p className="mt-1 text-sm text-fg-muted">The analysis didn&apos;t finish. Open it to try again.</p>
          ) : (
            <p className="mt-1 text-sm text-fg-muted">
              {d.entryPoints.filter((e) => e.kind !== "page").length} endpoints, {d.dataModel.entities.length} data entities,{" "}
              {d.integrations.length} integrations. {d.checklist.filter((c) => c.status === "answered").length} of {d.checklist.length} areas
              answered from code.
            </p>
          )}
          <Link href={href} className="mt-2 inline-flex min-h-9 items-center gap-1.5 text-sm font-medium text-accent hover:underline">
            Open architecture <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
      </div>
    </div>
  );
}
