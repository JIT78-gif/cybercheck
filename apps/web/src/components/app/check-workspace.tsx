"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, Check, ChevronDown, Info, ListChecks, Lock, Play, Plus } from "lucide-react";
import type { CheckId, ProjectSummary } from "@cybercheck/contracts";
import { AdversarialRunsCard } from "@/components/adversarial/adversarial-runs-card";
import { AdversarialStart } from "@/components/adversarial/adversarial-start";
import { useAdversarialRuns } from "@/components/adversarial/use-adversarial";
import { AiRunsCard } from "@/components/ai-evaluator/ai-runs-card";
import { AiStart } from "@/components/ai-evaluator/ai-start";
import { useAiRuns } from "@/components/ai-evaluator/use-ai-evaluator";
import { UnderstandingSummary } from "@/components/architecture/understanding-summary";
import { SecurityRunsCard } from "@/components/security/security-runs-card";
import { startSecurity, useSecurityRuns } from "@/components/security/use-security";
import { ProjectStatusList } from "@/components/testing/project-status-list";
import { TestingRunsCard } from "@/components/testing/testing-runs-card";
import { TestingStart } from "@/components/testing/testing-start";
import { ACTIVE_RUN, startTesting, useTestingRuns, useTestingStatus } from "@/components/testing/use-testing";
import { AddProjectFlow } from "@/components/intake/add-project";
import { useAddFromQuery } from "@/components/intake/use-add-from-query";
import { SnapshotFacts } from "@/components/intake/snapshot-result";
import { Button, buttonVariants } from "@/components/ui/button";
import { Alert, Spinner } from "@/components/ui/form";
import { ApiError } from "@/lib/api";
import { CHECK_INFO } from "@/lib/checks";
import { cn } from "@/lib/cn";
import { useAppData } from "./app-data";
import { AnalysisChip, AnalysisProgress, Card, CardTitle, EmptyState, PageHeader, RUNNING_STAGES } from "./ui";

const lastKey = (wid: string) => `cc_last_project_${wid}`;
const noopSubscribe = () => () => {};

function readLast(wid: string | undefined) {
  if (!wid) return "";
  try {
    return localStorage.getItem(lastKey(wid)) ?? "";
  } catch {
    return "";
  }
}

export function CheckWorkspace({ check }: { check: CheckId }) {
  const info = CHECK_INFO[check];
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { workspace, projects, refreshProjects } = useAppData();
  const [addingClicked, setAdding] = useState(false);
  const { fromGithub, clear } = useAddFromQuery();
  const adding = addingClicked || fromGithub;
  const [picked, setPicked] = useState<string | null>(null);
  const last = useSyncExternalStore(noopSubscribe, () => readLast(workspace?.id), () => "");

  const ready = (projects ?? []).filter((p) => p.analysis.stage === "ready");
  // Priority: explicit choice, ?project=, last used in this workspace, newest ready project.
  const candidates = [picked, params.get("project"), last, ready[0]?.id];
  const selected: ProjectSummary | undefined = candidates
    .map((id) => (id ? projects?.find((p) => p.id === id) : undefined))
    .find(Boolean);

  function select(id: string) {
    setPicked(id);
    if (workspace) {
      try {
        localStorage.setItem(lastKey(workspace.id), id);
      } catch {
        // storage blocked: the URL still carries the choice
      }
    }
    const q = new URLSearchParams(params.toString());
    q.set("project", id);
    router.replace(`${pathname}?${q.toString()}`, { scroll: false });
  }

  const snap = selected?.latestSnapshot;
  const isReady = selected?.analysis.stage === "ready";
  // Every check tab now has a runnable engine.
  const testingEngine = check === "testing";
  const securityEngine = check === "security";
  const aiEngine = check === "ai-evaluator";
  const adversarialEngine = check === "adversarial";
  const engine = testingEngine || securityEngine || aiEngine || adversarialEngine;
  const testingRuns = useTestingRuns(testingEngine ? (selected?.id ?? null) : null);
  const securityRuns = useSecurityRuns(securityEngine ? (selected?.id ?? null) : null);
  const aiRuns = useAiRuns(aiEngine ? (selected?.id ?? null) : null);
  const adversarialRuns = useAdversarialRuns(adversarialEngine ? (selected?.id ?? null) : null);
  const selectedRuns = securityEngine ? securityRuns : aiEngine ? aiRuns : adversarialEngine ? adversarialRuns : testingRuns;
  const { error: runsError, reload } = selectedRuns;
  const activeRun = selectedRuns.runs?.find((r) => ACTIVE_RUN.has(r.status));
  const runPath = (id: string) => `/app/projects/${selected?.id}/${securityEngine ? "security" : aiEngine ? "ai-evaluator" : adversarialEngine ? "adversarial" : "testing"}/${id}`;
  const { status: testingStatus } = useTestingStatus(testingEngine ? (workspace?.id ?? null) : null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<ApiError | null>(null);

  async function start() {
    if (!snap || !selected) return;
    setStarting(true);
    setStartError(null);
    try {
      const { run } = securityEngine ? await startSecurity(snap.id) : await startTesting(snap.id);
      reload();
      router.push(runPath(run.id));
    } catch (e) {
      setStartError(e instanceof ApiError ? e : new ApiError(0, "unexpected", "The check could not start.", "Try again."));
      setStarting(false);
    }
  }
  const notApplicable = check === "ai-evaluator" && isReady && (snap?.detection?.aiSdks.length ?? 0) === 0;

  return (
    <div className="space-y-6">
      <PageHeader section={info.name} title={info.name} />

      {testingEngine && <ProjectStatusList projects={projects} status={testingStatus} selectedId={selected?.id ?? null} onSelect={select} />}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        {/* Left: run card */}
        <Card className="h-fit">
          <CardTitle>Run a {info.name} check</CardTitle>
          <p className="mt-1 text-sm text-fg-muted">{info.tagline}</p>

          {adding ? (
            <div className="mt-6">
              <AddProjectFlow
                initialSource={fromGithub ? "github" : undefined}
                onCancel={() => {
                  setAdding(false);
                  clear();
                }}
                onDone={async (p) => {
                  setAdding(false);
                  clear();
                  await refreshProjects();
                  select(p.id);
                }}
              />
            </div>
          ) : (
            <div className="mt-6 space-y-5">
              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label htmlFor="project-select" className="text-sm font-medium text-fg">
                    Project
                  </label>
                  <span className="rounded-md bg-danger/10 px-2 py-0.5 text-xs font-medium text-danger">required</span>
                </div>
                {projects === null ? (
                  <div className="flex h-12 items-center gap-2 text-sm text-fg-muted">
                    <Spinner /> Loading projects
                  </div>
                ) : projects.length === 0 ? (
                  <p className="rounded-xl bg-surface-2/60 p-4 text-sm text-fg-muted">
                    No projects yet. Add one below; it will be available in every check tab.
                  </p>
                ) : (
                  <div className="relative">
                    <select
                      id="project-select"
                      value={selected?.id ?? ""}
                      onChange={(e) => select(e.target.value)}
                      className="h-12 w-full cursor-pointer appearance-none rounded-xl border border-border bg-surface pr-10 pl-4 text-base text-fg transition-colors hover:border-fg/20 focus-visible:outline-2 focus-visible:outline-ring"
                    >
                      {!selected && <option value="">Choose a project</option>}
                      {projects.map((p) => {
                        // Projects still being analysed can be picked to watch progress; failed ones cannot.
                        const stage = p.analysis.stage;
                        const disabled = stage === "failed" || stage === "rejected" || stage === "none";
                        const note = stage === "ready" ? "" : RUNNING_STAGES.has(stage) ? ` (analysing${p.analysis.progress != null ? ` ${Math.round(p.analysis.progress * 100)}%` : ""})` : ` (${stage === "none" ? "no snapshot" : stage})`;
                        return (
                          <option key={p.id} value={p.id} disabled={disabled}>
                            {p.name}
                            {note}
                          </option>
                        );
                      })}
                    </select>
                    <ChevronDown className="pointer-events-none absolute top-1/2 right-4 size-4 -translate-y-1/2 text-fg-muted" aria-hidden="true" />
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setAdding(true)}
                  className="mt-3 inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium text-accent underline-offset-4 hover:underline"
                >
                  <Plus className="size-4" aria-hidden="true" /> Add new project
                </button>
              </div>

              {!engine && (
                <details className="group rounded-xl border border-border [&_summary::-webkit-details-marker]:hidden">
                  <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 text-sm font-medium text-fg">
                    <span className="inline-flex items-center gap-2">
                      <ListChecks className="size-4 text-fg-muted" aria-hidden="true" /> Options
                    </span>
                    <ChevronDown className="size-4 text-fg-muted transition-transform group-open:rotate-180" aria-hidden="true" />
                  </summary>
                  <p className="faq-answer px-4 pb-4 text-sm text-fg-muted">
                    Scope controls (which suites, targets and rules apply) arrive together with the {info.name} engine.
                  </p>
                </details>
              )}

              {notApplicable && (
                <Alert tone="info">
                  No AI library was detected in the dependencies of {selected?.name}. The check still looks for assistants built
                  in the code itself, and finishes as not applicable at no cost if there are none.
                </Alert>
              )}

              {aiEngine && selected && !activeRun && isReady && <AiStart projectId={selected.id} snapshotId={snap?.id ?? null} onStarted={reload} />}

              {adversarialEngine && selected && !activeRun && isReady && <AdversarialStart projectId={selected.id} snapshotId={snap?.id ?? null} onStarted={reload} />}

              {testingEngine && selected && !activeRun && isReady && (
                <TestingStart projectId={selected.id} snapshotId={snap?.id ?? null} ready={isReady} />
              )}

              <div className={cn((testingEngine || aiEngine || adversarialEngine) && selected && !activeRun && isReady && "hidden")}>
                {engine && activeRun && selected ? (
                  <Link href={runPath(activeRun.id)} className={buttonVariants({ shape: "pill", size: "lg", className: "w-full" })}>
                    <Spinner /> View the running check
                  </Link>
                ) : (
                  <Button type="button" shape="pill" size="lg" className="w-full" disabled={!engine || !isReady || !snap || starting} onClick={() => void start()}>
                    {starting ? <Spinner /> : <Play aria-hidden="true" />} Start {info.name} check
                  </Button>
                )}
                {startError && (
                  <Alert className="mt-3">
                    {startError.message} {startError.fix}
                  </Alert>
                )}
                <p className="mt-2 flex items-start gap-2 text-xs text-fg-muted">
                  <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  {isReady
                    ? securityEngine
                      ? "Your project is ready. Re-checks the project analysis, then scans for leaked secrets, vulnerable dependencies, risky code and configuration in an isolated sandbox with the network off. Your code is only read: it is never run or changed."
                      : aiEngine
                      ? "Your project is ready. Starts your app in an isolated sandbox with the network off, points its model calls at a scripted replay model, and checks every answer. No real model is called and your code is never changed."
                      : adversarialEngine
                      ? "Your project is ready. Runs typed, bounded attack campaigns against a disposable sandbox with external network disabled. Deterministic checks do not need AI credits; optional attacker and critic models are best-effort."
                      : engine
                      ? "Your project is ready. Builds it, runs its own tests, sets up sign-in and data, then checks the API, the screens, the database and load in an isolated sandbox. Your code is never changed."
                      : `Your project is ready. The ${info.name} engine is the next build step, so nothing runs yet.`
                    : selected && RUNNING_STAGES.has(selected.analysis.stage)
                      ? `${selected.name} is still being analysed. Checks can start once it is ready.`
                      : `Choose a ready project first. The ${info.name} engine is the next build step.`}
                </p>
              </div>
            </div>
          )}
        </Card>

        {/* Right: context cards */}
        <div className="space-y-6">
          <Card>
            <div className="flex items-center gap-3">
              <span className="inline-flex size-10 items-center justify-center rounded-xl bg-accent/10 text-accent">
                <info.icon className="size-5" aria-hidden="true" />
              </span>
              <CardTitle>What this check does</CardTitle>
            </div>
            <ul className="mt-5 space-y-2.5">
              {info.does.map((d) => (
                <li key={d} className="flex gap-2.5 text-sm text-fg">
                  <Check className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
                  {d}
                </li>
              ))}
            </ul>
            <p className="mt-4 text-sm text-fg-muted">
              <span className="font-medium text-fg">You get: </span>
              {info.youGet}
            </p>
            {info.note && (
              <p className="mt-3 flex items-start gap-2 text-xs text-fg-muted">
                <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                {info.note}
              </p>
            )}
          </Card>

          <Card>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CardTitle>Selected project</CardTitle>
              {selected && <AnalysisChip analysis={selected.analysis} />}
            </div>
            {selected && snap ? (
              <div className="mt-5 space-y-5">
                <p className="font-medium text-fg">{selected.name}</p>
                {isReady ? (
                  <>
                    <UnderstandingSummary projectId={selected.id} snapshotId={snap.id} />
                    <SnapshotFacts snapshot={snap} />
                  </>
                ) : RUNNING_STAGES.has(selected.analysis.stage) ? (
                  <AnalysisProgress analysis={selected.analysis} />
                ) : (
                  <p className="text-sm text-fg-muted">{selected.analysis.error ?? "This project's latest snapshot isn't ready."} Open it to see why or run the analysis again.</p>
                )}
                <Link
                  href={`/app/projects/${selected.id}`}
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:underline"
                >
                  View project details <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              </div>
            ) : (
              <p className="mt-3 text-sm text-fg-muted">Choose or add a project to see its frozen snapshot here.</p>
            )}
          </Card>

          {securityEngine ? (
            <SecurityRunsCard projectId={selected?.id ?? null} runs={securityRuns.runs} error={runsError} />
          ) : aiEngine ? (
            <AiRunsCard projectId={selected?.id ?? null} runs={aiRuns.runs} error={runsError} />
          ) : adversarialEngine ? (
            <AdversarialRunsCard projectId={selected?.id ?? null} runs={adversarialRuns.runs} error={runsError} />
          ) : testingEngine ? (
            <TestingRunsCard projectId={selected?.id ?? null} runs={testingRuns.runs} error={runsError} />
          ) : (
            <Card>
              <CardTitle>Results</CardTitle>
              <EmptyState
                icon={info.icon}
                title={`No ${info.name} runs yet`}
                body="Each run will show what was checked, what failed with evidence, and what could not be checked."
              />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

export function CheckWorkspaceFallback() {
  return (
    <div className={cn("flex items-center gap-2 py-10 text-fg-muted")}>
      <Spinner /> Loading
    </div>
  );
}
