"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Copy, Eye, FolderPlus, Upload } from "lucide-react";
import type { ProjectSummary } from "@cybercheck/contracts";
import { GitHubIcon } from "@/components/auth/provider-icons";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/form";
import { shortDigest, timeAgo } from "@/lib/format";
import { EmptyState, StatusChip } from "./ui";

function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async (e) => {
        e.stopPropagation();
        await navigator.clipboard.writeText(id).catch(() => undefined);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      aria-label={copied ? "Project ID copied" : "Copy project ID"}
      title={copied ? "Copied" : "Copy project ID"}
      className="inline-flex size-10 cursor-pointer items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
    >
      {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
    </button>
  );
}

export function ProjectsTable({
  projects,
  onAdd,
  limit,
}: {
  projects: ProjectSummary[] | null;
  onAdd: () => void;
  limit?: number;
}) {
  const router = useRouter();
  if (projects === null) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-fg-muted">
        <Spinner /> Loading projects
      </div>
    );
  }
  if (projects.length === 0) {
    return (
      <EmptyState
        icon={FolderPlus}
        title="No projects yet"
        body="Add a project once and run Testing, Security, AI Evaluator and Adversarial checks on the same snapshot."
        action={
          <Button shape="pill" onClick={onAdd}>
            <Upload aria-hidden="true" /> Add your first project
          </Button>
        }
      />
    );
  }

  const rows = limit ? projects.slice(0, limit) : projects;
  return (
    <div className="relative -mx-5 overflow-x-auto sm:-mx-7">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-border font-mono text-[11px] uppercase tracking-[0.08em] text-fg-muted">
            <th scope="col" className="px-5 py-3 font-medium sm:pl-7">Name</th>
            <th scope="col" className="px-3 py-3 font-medium">Source</th>
            <th scope="col" className="px-3 py-3 font-medium">Baseline</th>
            <th scope="col" className="px-3 py-3 font-medium">Status</th>
            <th scope="col" className="px-3 py-3 font-medium">Added</th>
            <th scope="col" className="px-5 py-3 text-right font-medium sm:pr-7">
              <span className="sr-only">Options</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const s = p.latestSnapshot;
            return (
              <tr
                key={p.id}
                onClick={() => router.push(`/app/projects/${p.id}`)}
                className="cursor-pointer border-b border-border/70 transition-colors last:border-0 hover:bg-surface-2/50"
              >
                <td className="px-5 py-4 sm:pl-7">
                  <Link href={`/app/projects/${p.id}`} className="font-medium text-fg hover:underline" onClick={(e) => e.stopPropagation()}>
                    {p.name}
                  </Link>
                  {s?.detection?.packageName && s.detection.packageName !== p.name && (
                    <p className="font-mono text-xs text-fg-muted">{s.detection.packageName}</p>
                  )}
                </td>
                <td className="px-3 py-4 text-fg-muted">
                  <span className="inline-flex items-center gap-1.5">
                    {p.sourceType === "github" ? <GitHubIcon className="size-3.5" /> : <Upload className="size-3.5" aria-hidden="true" />}
                    {p.sourceType === "github" ? (p.githubRepo ?? "GitHub") : "Upload"}
                  </span>
                </td>
                <td className="px-3 py-4 font-mono text-xs text-fg">
                  {shortDigest(s?.resolvedRevision ?? s?.contentDigest) ?? <span className="text-fg-muted">none</span>}
                </td>
                <td className="px-3 py-4">
                  <StatusChip status={s?.status} />
                </td>
                <td className="px-3 py-4 whitespace-nowrap text-fg-muted">{timeAgo(p.createdAt)}</td>
                <td className="px-5 py-2 text-right whitespace-nowrap sm:pr-7">
                  <Link
                    href={`/app/projects/${p.id}`}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Open ${p.name}`}
                    title="Open"
                    className="inline-flex size-10 items-center justify-center rounded-full text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
                  >
                    <Eye className="size-4" />
                  </Link>
                  <CopyId id={p.id} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
