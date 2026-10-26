"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { ArrowRight, CircleCheck, FolderKanban, Plus, ScanSearch, Sparkles, X, type LucideIcon } from "lucide-react";
import { useAppData } from "./app-data";
import { AddProjectDialog } from "@/components/intake/add-project";
import { useAddFromQuery } from "@/components/intake/use-add-from-query";
import { Button, ButtonLink } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { ProjectsTable } from "./projects-table";
import { Card, CardTitle, PageHeader } from "./ui";

const DISMISS_KEY = "cc_getting_started_dismissed";
const subscribe = (cb: () => void) => {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
};
const readDismissed = () => {
  try {
    return localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
};

function Stat({
  icon: Icon,
  label,
  value,
  note,
  progress,
}: {
  icon: LucideIcon;
  label: string;
  value: React.ReactNode;
  note: string;
  progress?: number;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.045] p-5 backdrop-blur-sm">
      <div className="flex items-center gap-2 text-sm font-medium text-fg-muted">
        <Icon className="size-4 text-accent" aria-hidden="true" />
        <span>{label}</span>
      </div>
      <p className="mt-3 font-mono text-3xl font-medium leading-none text-fg tabular-nums">{value}</p>
      {progress != null && (
        <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/10" aria-hidden="true">
          <div
            className="h-full origin-left rounded-full bg-accent transition-transform duration-700"
            style={{ transform: `scaleX(${Math.max(0, Math.min(1, progress))})` }}
          />
        </div>
      )}
      <p className={cn("text-xs leading-relaxed text-fg-muted", progress == null ? "mt-4" : "mt-2.5")}>{note}</p>
    </div>
  );
}

export function Overview() {
  const { workspace, projects, me } = useAppData();
  const [adding, setAdding] = useState(false);
  const { fromGithub, clear } = useAddFromQuery();
  const dismissedStored = useSyncExternalStore(subscribe, readDismissed, () => false);
  const [dismissedNow, setDismissedNow] = useState(false);
  const dismissed = dismissedStored || dismissedNow;

  const total = projects?.length ?? null;
  const ready = projects?.filter((p) => p.analysis.stage === "ready").length ?? null;
  const hasProject = (total ?? 0) > 0;

  const steps = [
    { done: Boolean(me), title: "Create your account", body: "Signed in and verified." },
    {
      done: hasProject,
      title: "Add your first project",
      body: "Upload a .zip or .tar.gz. It becomes an immutable snapshot every check shares.",
      action: !hasProject && (
        <Button size="sm" shape="pill" variant="outline" onClick={() => setAdding(true)}>
          Add project <ArrowRight aria-hidden="true" />
        </Button>
      ),
    },
    {
      done: false,
      title: "Run your first check",
      body: "Pick Testing, Security, AI Evaluator or Adversarial and choose your project.",
      action: hasProject ? (
        <ButtonLink href="/app/checks/testing" size="sm" shape="pill" variant="outline">
          Open Testing <ArrowRight aria-hidden="true" />
        </ButtonLink>
      ) : (
        <span className="rounded-full bg-surface-2 px-3 py-1 text-xs text-fg-muted">After step 2</span>
      ),
    },
    {
      done: false,
      title: "Review evidence and approve a fix",
      body: "Fixes are tested in a sandbox. Applying them to your code is always your decision.",
      action: <span className="rounded-full bg-surface-2 px-3 py-1 text-xs text-fg-muted">Coming next</span>,
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader section="Overview" title="Overview" />

      {/* Hero card */}
      <section className="theme-dark relative overflow-hidden rounded-3xl border border-border bg-bg p-6 text-fg shadow-xl sm:p-10">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(var(--border)_1px,transparent_1px)] bg-size-[24px_24px] mask-[radial-gradient(70%_80%_at_80%_20%,black,transparent)]" />
        <div className="animate-breathe pointer-events-none absolute inset-0 bg-[radial-gradient(45%_70%_at_85%_10%,color-mix(in_srgb,var(--accent)_22%,transparent),transparent)]" />
        <div className="relative">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <span className="rounded-lg bg-white/10 px-3 py-1 font-mono text-xs uppercase tracking-[0.08em] text-fg-muted">
              Workspace
            </span>
            <Button shape="pill" onClick={() => setAdding(true)}>
              <Plus aria-hidden="true" /> Add project
            </Button>
          </div>
          <h2 className="mt-5 text-4xl font-semibold tracking-tight sm:text-5xl">{workspace?.name ?? " "}</h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-fg-muted sm:text-base">
            Add a project once, then run Testing, Security, AI Evaluator and Adversarial checks on the same frozen snapshot.
          </p>
          <div className="mt-8 grid gap-3 sm:grid-cols-3">
            <Stat
              icon={FolderKanban}
              label="Projects"
              value={total ?? <span aria-label="Loading">...</span>}
              note={total === 1 ? "One project saved in this workspace" : `${total ?? 0} projects saved in this workspace`}
            />
            <Stat
              icon={Sparkles}
              label="Ready to check"
              value={
                <>
                  {ready ?? "..."}
                  {total != null && <span className="text-base text-fg-muted"> of {total}</span>}
                </>
              }
              progress={total ? (ready ?? 0) / total : 0}
              note="Analysis is complete and checks can start"
            />
            <Stat
              icon={ScanSearch}
              label="Check types"
              value={4}
              note="Testing, Security, AI Evaluator and Adversarial"
            />
          </div>
        </div>
      </section>

      {!dismissed && (
        <Card>
          <div className="flex items-start justify-between gap-4">
            <CardTitle>Getting started</CardTitle>
            <button
              type="button"
              onClick={() => {
                try {
                  localStorage.setItem(DISMISS_KEY, "1");
                } catch {
                  // storage blocked: hide for this visit only
                }
                setDismissedNow(true);
              }}
              aria-label="Dismiss getting started"
              className="inline-flex size-10 cursor-pointer items-center justify-center rounded-full border border-border text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg"
            >
              <X className="size-4" />
            </button>
          </div>
          <ol className="mt-4 divide-y divide-border">
            {steps.map((s, i) => (
              <li key={s.title} className="flex flex-wrap items-center gap-4 py-4 sm:flex-nowrap">
                <span
                  className={cn(
                    "inline-flex size-8 shrink-0 items-center justify-center rounded-full border text-sm",
                    s.done ? "border-success/30 bg-success/10 text-success" : "border-border text-fg-muted",
                  )}
                >
                  {s.done ? <CircleCheck className="size-4" aria-label="done" /> : i + 1}
                </span>
                <div className="min-w-0 flex-1 basis-[calc(100%-3rem)] sm:basis-auto">
                  <p className={cn("font-medium", s.done ? "text-fg-muted line-through decoration-fg-muted/40" : "text-fg")}>{s.title}</p>
                  <p className="text-sm text-fg-muted">{s.body}</p>
                </div>
                {s.action && <div className="pl-12 sm:pl-0">{s.action}</div>}
              </li>
            ))}
          </ol>
        </Card>
      )}

      <Card>
        <div className="mb-4 flex items-center gap-3">
          <CardTitle>Projects</CardTitle>
          <button
            type="button"
            onClick={() => setAdding(true)}
            aria-label="Add project"
            title="Add project"
            className="inline-flex size-10 cursor-pointer items-center justify-center rounded-full border border-border text-fg transition-colors hover:bg-surface-2"
          >
            <Plus className="size-4" />
          </button>
          {(total ?? 0) > 5 && (
            <Link href="/app/projects" className="ml-auto text-sm font-medium text-accent hover:underline">
              View all {total}
            </Link>
          )}
        </div>
        <ProjectsTable projects={projects} onAdd={() => setAdding(true)} limit={5} />
      </Card>

      <AddProjectDialog
        open={adding || fromGithub}
        initialSource={fromGithub ? "github" : undefined}
        onClose={() => {
          setAdding(false);
          clear();
        }}
      />
    </div>
  );
}
