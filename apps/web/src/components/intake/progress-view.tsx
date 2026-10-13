"use client";

import { useEffect, useRef } from "react";
import { CircleCheck, CircleDashed, CircleX, LoaderCircle } from "lucide-react";
import type { ProjectDetail, ProjectSummary } from "@cybercheck/contracts";
import { useAppData } from "@/components/app/app-data";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/form";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { IssueList, SnapshotFacts } from "./snapshot-result";
import { useSnapshotProgress } from "./use-snapshot-progress";

const ARCHIVE_STAGES: Array<{ type: string; label: string }> = [
  { type: "received", label: "Upload received" },
  { type: "validating", label: "Checking for unsafe paths, archive bombs and size limits" },
  { type: "extracting", label: "Reading project files (nothing is executed)" },
  { type: "normalizing", label: "Freezing an immutable, content-addressed snapshot" },
  { type: "detecting", label: "Detecting languages, frameworks and AI components" },
];

const GITHUB_STAGES: Array<{ type: string; label: string }> = [
  { type: "received", label: "Import requested" },
  { type: "resolving", label: "Pinning the branch to an exact commit" },
  { type: "downloading", label: "Downloading that commit from GitHub (read-only)" },
  ...ARCHIVE_STAGES.slice(1),
];

function Timeline({
  stages,
  seen,
  outcome,
  detail,
}: {
  stages: Array<{ type: string; label: string }>;
  seen: Set<string>;
  outcome: "baselined" | "rejected" | "failed" | null;
  detail: Record<string, string>;
}) {
  const lastSeen = [...stages].reverse().find((s) => seen.has(s.type))?.type;
  return (
    <ol className="space-y-3" aria-live="polite">
      {stages.map((s) => {
        const done = seen.has(s.type) && (s.type !== lastSeen || outcome === "baselined");
        const active = s.type === lastSeen && !outcome;
        const stopped = s.type === lastSeen && (outcome === "rejected" || outcome === "failed");
        return (
          <li key={s.type} className="flex items-center gap-3 text-sm">
            {stopped ? (
              <CircleX className="size-4 shrink-0 text-danger" aria-label="stopped" />
            ) : done ? (
              <CircleCheck className="size-4 shrink-0 text-success" aria-label="done" />
            ) : active ? (
              <LoaderCircle className="size-4 shrink-0 animate-spin text-accent" aria-label="in progress" />
            ) : (
              <CircleDashed className="size-4 shrink-0 text-fg-muted/60" aria-label="waiting" />
            )}
            <span className={cn(done || active || stopped ? "text-fg" : "text-fg-muted")}>
              {s.label}
              {detail[s.type] && <span className="ml-2 font-mono text-xs text-fg-muted">{detail[s.type]}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function ProgressView({
  snapshotId,
  project,
  source,
  onDone,
  onRetry,
  retryLabel = "Try another file",
}: {
  snapshotId: string;
  project: ProjectSummary;
  source: "archive" | "github";
  onDone: (p: ProjectSummary) => void;
  onRetry: () => void;
  retryLabel?: string;
}) {
  const { upsertProject } = useAppData();
  const { events, snapshot } = useSnapshotProgress(snapshotId);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const seen = new Set(events.map((e) => e.type));
  const outcome = (["baselined", "rejected", "failed"] as const).find((t) => seen.has(t)) ?? null;
  const sha = events.find((e) => e.type === "downloading")?.payload.sha;
  const detail: Record<string, string> = typeof sha === "string" ? { downloading: sha.slice(0, 7) } : {};

  useEffect(() => {
    headingRef.current?.focus();
  }, [outcome]);

  // Once final, refresh the project so every tab sees its new status.
  useEffect(() => {
    if (!snapshot) return;
    api<{ project: ProjectDetail }>(`/v1/projects/${project.id}`)
      .then(({ project: p }) => upsertProject(p))
      .catch(() => undefined);
  }, [snapshot, project.id, upsertProject]);

  return (
    <div className="space-y-5">
      <h3 ref={headingRef} tabIndex={-1} className="text-lg font-semibold text-fg outline-none">
        {outcome === "baselined"
          ? "Upload saved, analysis started"
          : outcome === "rejected"
            ? source === "github"
              ? "We couldn't import this repository"
              : "We couldn't accept this archive"
            : outcome === "failed"
              ? "Processing stopped"
              : "Creating your snapshot"}
      </h3>
      <Timeline stages={source === "github" ? GITHUB_STAGES : ARCHIVE_STAGES} seen={seen} outcome={outcome} detail={detail} />

      {snapshot?.status === "BASELINED" && (
        <div className="animate-fade-up space-y-5 rounded-2xl border border-success/30 bg-success/5 p-5">
          <p className="flex items-center gap-2 text-sm font-medium text-success">
            <CircleCheck className="size-4" aria-hidden="true" />
            {project.name} is saved as a frozen snapshot. We are now reading and explaining the code; checks unlock when that finishes (usually 2 to 5 minutes). You can follow it live on the project page.
          </p>
          <SnapshotFacts snapshot={snapshot} />
        </div>
      )}
      {snapshot?.status === "REJECTED" && (
        <div className="animate-fade-up rounded-2xl border border-danger/30 bg-danger/5 p-5">
          <IssueList items={snapshot.rejectionReasons} tone="danger" />
        </div>
      )}
      {snapshot?.status === "FAILED" && <Alert>{snapshot.error}</Alert>}

      <div className="flex flex-wrap gap-3">
        {snapshot?.status === "BASELINED" && (
          <Button type="button" shape="pill" onClick={() => onDone(project)}>
            Done
          </Button>
        )}
        {(snapshot?.status === "REJECTED" || snapshot?.status === "FAILED") && (
          <Button type="button" shape="pill" onClick={onRetry}>
            {retryLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
