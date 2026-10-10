"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, FileText, Upload } from "lucide-react";
import type { FileTreeEntry, ProjectDetail, SnapshotSummary } from "@cybercheck/contracts";
import { GitHubIcon } from "@/components/auth/provider-icons";
import { AddProjectFlow } from "@/components/intake/add-project";
import { UnderstandingSummary } from "@/components/architecture/understanding-summary";
import { IssueList, SnapshotFacts } from "@/components/intake/snapshot-result";
import { Button } from "@/components/ui/button";
import { Alert, Spinner } from "@/components/ui/form";
import { ApiError, api } from "@/lib/api";
import { CHECK_INFO, CHECK_ORDER } from "@/lib/checks";
import { formatBytes, shortDigest, timeAgo } from "@/lib/format";
import { useAppData } from "./app-data";
import { Card, CardTitle, PageHeader, StatusChip } from "./ui";

const TREE_PREVIEW = 150;

function FileTree({ snapshot }: { snapshot: SnapshotSummary }) {
  const [tree, setTree] = useState<FileTreeEntry[] | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    api<{ tree: FileTreeEntry[] }>(`/v1/snapshots/${snapshot.id}/tree`)
      .then((r) => setTree(r.tree))
      .catch(() => setTree([]));
  }, [snapshot.id]);

  if (!tree) return <Spinner />;
  const shown = all ? tree : tree.slice(0, TREE_PREVIEW);
  return (
    <div>
      <ul className="max-h-96 divide-y divide-border/60 overflow-y-auto rounded-xl border border-border font-mono text-xs">
        {shown.map((f) => (
          <li key={f.path} className="flex items-center justify-between gap-4 px-3 py-2">
            <span className="flex min-w-0 items-center gap-2 text-fg">
              <FileText className="size-3.5 shrink-0 text-fg-muted" aria-hidden="true" />
              <span className="truncate">{f.path}</span>
            </span>
            <span className="shrink-0 text-fg-muted tabular-nums">{formatBytes(f.size)}</span>
          </li>
        ))}
      </ul>
      {tree.length > TREE_PREVIEW && !all && (
        <button type="button" onClick={() => setAll(true)} className="mt-3 cursor-pointer text-sm font-medium text-accent hover:underline">
          Show all {tree.length.toLocaleString("en-US")} files
        </button>
      )}
      <p className="mt-2 text-xs text-fg-muted">File names and sizes only. Contents are never shown here.</p>
    </div>
  );
}

export function ProjectDetailView({ id }: { id: string }) {
  const { upsertProject } = useAppData();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    api<{ project: ProjectDetail }>(`/v1/projects/${id}`)
      .then((r) => setProject(r.project))
      .catch((e) => setError(e instanceof ApiError ? e : null));
  }, [id]);

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader section="Projects" title="Project not found" />
        <Alert>
          {error.message} {error.fix}
        </Alert>
        <Link href="/app/projects" className="text-sm font-medium text-accent hover:underline">
          Back to projects
        </Link>
      </div>
    );
  }
  if (!project) {
    return (
      <div className="flex items-center gap-2 py-10 text-fg-muted">
        <Spinner /> Loading project
      </div>
    );
  }

  const latest = project.latestSnapshot;
  return (
    <div className="space-y-6">
      <PageHeader
        section="Projects"
        title={project.name}
        actions={
          !uploading && (
            <Button shape="pill" variant="outline" onClick={() => setUploading(true)}>
              {project.sourceType === "github" ? (
                <>
                  <GitHubIcon className="size-4" /> Import newer commit
                </>
              ) : (
                <>
                  <Upload aria-hidden="true" /> Upload new snapshot
                </>
              )}
            </Button>
          )
        }
      />
      {project.description && <p className="-mt-2 text-fg-muted">{project.description}</p>}

      {uploading && (
        <Card>
          <CardTitle>New snapshot</CardTitle>
          <p className="mt-1 mb-6 text-sm text-fg-muted">Earlier snapshots stay unchanged; checks use the latest ready one.</p>
          <AddProjectFlow
            existingProject={project}
            onCancel={() => setUploading(false)}
            onDone={async () => {
              setUploading(false);
              const r = await api<{ project: ProjectDetail }>(`/v1/projects/${id}`);
              setProject(r.project);
              upsertProject(r.project);
            }}
          />
        </Card>
      )}

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle>Latest snapshot</CardTitle>
          <StatusChip status={latest?.status} />
        </div>
        {!latest ? (
          <p className="mt-3 text-sm text-fg-muted">No snapshot yet. Upload an archive to create one.</p>
        ) : latest.status === "BASELINED" ? (
          <div className="mt-5 space-y-5">
            <UnderstandingSummary projectId={project.id} snapshotId={latest.id} />
            <SnapshotFacts snapshot={latest} />
          </div>
        ) : latest.status === "REJECTED" ? (
          <div className="mt-5">
            <IssueList items={latest.rejectionReasons} tone="danger" />
          </div>
        ) : latest.status === "FAILED" ? (
          <Alert className="mt-5">{latest.error}</Alert>
        ) : (
          <p className="mt-3 flex items-center gap-2 text-sm text-fg-muted">
            <Spinner /> Processing. This page updates when you reload it.
          </p>
        )}
      </Card>

      <div>
        <h2 className="mb-3 text-lg font-semibold tracking-tight text-fg">Run a check on this project</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {CHECK_ORDER.map((c) => {
            const info = CHECK_INFO[c];
            return (
              <Link
                key={c}
                href={`/app/checks/${c}?project=${project.id}`}
                className="group rounded-2xl border border-border bg-surface p-5 transition duration-200 hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-md"
              >
                <info.icon className="size-5 text-accent" aria-hidden="true" />
                <p className="mt-3 font-semibold text-fg">{info.name}</p>
                <p className="mt-1 text-sm text-fg-muted">{info.tagline}</p>
                <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-fg">
                  Open <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" aria-hidden="true" />
                </span>
              </Link>
            );
          })}
        </div>
      </div>

      {latest?.status === "BASELINED" && (
        <Card>
          <CardTitle>Files in this snapshot</CardTitle>
          <div className="mt-4">
            <FileTree snapshot={latest} />
          </div>
        </Card>
      )}

      <Card>
        <CardTitle>Snapshot history</CardTitle>
        <ul className="mt-4 divide-y divide-border">
          {project.snapshots.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 text-sm">
              <StatusChip status={s.status} />
              <span className="font-mono text-xs text-fg">{shortDigest(s.resolvedRevision ?? s.contentDigest) ?? "n/a"}</span>
              <span className="min-w-0 flex-1 truncate text-fg-muted">{s.sourceRef}</span>
              <span className="text-fg-muted">{timeAgo(s.createdAt)}</span>
            </li>
          ))}
          {project.snapshots.length === 0 && <li className="py-3 text-sm text-fg-muted">No snapshots yet.</li>}
        </ul>
      </Card>
    </div>
  );
}
