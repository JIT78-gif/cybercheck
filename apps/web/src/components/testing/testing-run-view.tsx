"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, ArrowRight, Ban, Bug, FlaskConical, ListChecks, ShieldQuestion, Wrench } from "lucide-react";
import type { ObligationStatus, ReviewedReport, TestingRepair, TestingRunDetail } from "@cybercheck/contracts";
import { Card, CardTitle } from "@/components/app/ui";
import { RunHeader } from "@/components/app/run-chrome";
import { CodeViewerProvider } from "@/components/architecture/code-viewer";
import { Badge } from "@/components/architecture/parts";
import { Button } from "@/components/ui/button";
import { Alert, Spinner } from "@/components/ui/form";
import { cn } from "@/lib/cn";
import { BreakpointCard, LayerBars, LoadCharts, LoadTimeline, ProblemBars, ResultsDonut } from "./charts";
import { EvidencePanel, RequirementsList } from "./evidence-panel";
import { LiveView } from "./live/live-view";
import { ProblemsTab, problemGroups } from "./problems-tab";
import { CapabilityMatrix, LAYER_NAME, LayerMatrix, ProvenPanel, ReleaseDecisionCard } from "./release-panels";
import { RepairBox } from "./repair-box";
import { AssessmentCompare } from "./review-panel";
import { EnvironmentAndAudit, ExecutionRow, Fixtures, LegacySummary, Ledger, LoadResults, Phases, STATUS_STYLE, Suites } from "./run-parts";
import { TabPanel, Tabs, useViewParams, type TabItem } from "./run-tabs";
import { ACTIVE_RUN, useRepairs, useReviewedReport, useTestingRun } from "./use-testing";

export { RunStatusBadge, STATUS_STYLE } from "./run-parts";

type TabId = "live" | "overview" | "problems" | "checks" | "load" | "watch" | "repairs" | "details";
type Go = (next: { tab?: TabId; sub?: string | null; f?: string | null }) => void;

const LAYER_ORDER = ["environment", "existing_suite", "api", "unit", "ui", "accessibility", "data", "job", "integration", "performance", "reliability", "deployment"];

/** A Testing run, one section per tab: live progress, the answer, problems, checks, load, replay, repairs, details. */
export function TestingRunView({ projectId, runId }: { projectId: string; runId: string }) {
  const { run, events, error, cancel } = useTestingRun(runId);
  // Human review needs the finished report; it is loaded once the run is done.
  const { reviewed, setReviewed } = useReviewedReport(runId, Boolean(run?.report) && !ACTIVE_RUN.has(run?.status ?? ""));
  const { repairs, refresh: refreshRepairs } = useRepairs(runId, Boolean(reviewed?.findings.length));
  const [cancelling, setCancelling] = useState(false);
  const view = useViewParams();

  const back = (
    <Link href={`/app/checks/testing?project=${projectId}`} className="inline-flex items-center gap-1.5 text-sm text-fg-muted hover:text-fg">
      <ArrowLeft className="size-4" aria-hidden="true" /> Testing
    </Link>
  );
  if (error && !run) {
    return (
      <div className="space-y-4">
        {back}
        <Alert>
          {error.message} {error.fix}
        </Alert>
      </div>
    );
  }
  if (!run) {
    return (
      <div className="flex items-center gap-2 py-10 text-fg-muted">
        <Spinner /> Loading run
      </div>
    );
  }

  const active = ACTIVE_RUN.has(run.status);
  const r = run.report;
  const v2 = Boolean(r?.release);
  const groups = problemGroups(run, reviewed);
  const problemCount = groups.filter((g) => !["rejected", "dismissed"].includes(g.id)).reduce((n, g) => n + g.items.length, 0);
  const noVerdict = run.obligations.filter((o) => ["inconclusive", "blocked", "skipped", "unsupported"].includes(o.status)).length;

  const tabs: TabItem<TabId>[] = [
    ...(active ? [{ id: "live" as const, label: "Live" }] : []),
    ...(r ? [{ id: "overview" as const, label: "Overview" }] : []),
    ...(!active && run.findings.length ? [{ id: "problems" as const, label: "Problems", count: problemCount, tone: problemCount ? ("bad" as const) : ("muted" as const) }] : []),
    ...(run.obligations.length ? [{ id: "checks" as const, label: "Checks", count: run.obligations.length, tone: "muted" as const }] : []),
    ...(r?.load && r.load.stages.length ? [{ id: "load" as const, label: "Load" }] : []),
    ...(!active && run.executions.length ? [{ id: "watch" as const, label: "Watch the run" }] : []),
    ...(repairs.length ? [{ id: "repairs" as const, label: "Repairs", count: repairs.length, tone: "muted" as const }] : []),
    ...(r || run.executions.length ? [{ id: "details" as const, label: "Details" }] : []),
  ];
  const asked = view.get("tab");
  const tab: TabId = tabs.find((t) => t.id === asked)?.id ?? tabs[0]?.id ?? "overview";
  // Switching tabs clears the sub-tab and the selected problem; within a tab only what is given changes.
  const go: Go = (next) =>
    view.set(next.tab ? { tab: next.tab, sub: next.sub ?? null, f: next.f ?? null } : { ...("sub" in next ? { sub: next.sub ?? null } : {}), ...("f" in next ? { f: next.f ?? null } : {}) });

  const header = (
    <RunHeader
      check="testing"
      projectId={projectId}
      status={run.status}
      startedAt={run.startedAt}
      finishedAt={run.finishedAt}
      parentRunId={run.parentRunId}
      exportBase={r ? `/v1/testing-runs/${run.id}/export` : null}
      actions={active ? (
        <Button variant="outline" shape="pill" size="sm" disabled={cancelling} onClick={async () => { setCancelling(true); try { await cancel(); } finally { setCancelling(false); } }}><Ban aria-hidden="true" /> Cancel run</Button>
      ) : null}
    />
  );

  return (
    <CodeViewerProvider snapshotId={run.snapshotId}>
      <div className="space-y-6">
        {header}
        {run.status === "cancelled" && (
          <Card>
            <Phases run={run} />
          </Card>
        )}
        {(run.status === "failed" || run.status === "blocked") && <Alert>{run.error ?? "The run could not finish."}</Alert>}

        {tabs.length > 0 && <Tabs items={tabs} value={tab} onChange={(id) => go({ tab: id })} label="Run sections" idPrefix="run" />}

        {tabs.length > 0 && (
          <TabPanel idPrefix="run" value={tab}>
            {tab === "live" && (
              <LiveView
                run={run}
                events={events}
                live
                phases={
                  <div className="space-y-3">
                    <Phases run={run} />
                    <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-label="Checks done" aria-valuenow={Math.round((run.progress ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100}>
                      <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(4, (run.progress ?? 0) * 100)}%` }} />
                    </div>
                  </div>
                }
              />
            )}

            {tab === "overview" && r && (
              <>
                {v2 ? (
                  <>
                    <ReleaseDecisionCard run={run} report={r} onProblems={problemCount ? () => go({ tab: "problems" }) : undefined} />
                    <NextSteps run={run} reviewed={reviewed} repairs={repairs} noVerdict={noVerdict} go={go} />
                    <Card className="space-y-4" aria-label="At a glance">
                      <CardTitle>At a glance</CardTitle>
                      <div className="grid gap-8 lg:grid-cols-[13rem_minmax(0,1fr)_minmax(0,1fr)]">
                        <ResultsDonut obligations={run.obligations} />
                        <LayerBars obligations={run.obligations} onLayer={(l) => go({ tab: "checks", sub: l })} />
                        <ProblemBars findings={run.findings} reviewed={reviewed} />
                      </div>
                    </Card>
                    {reviewed && reviewed.findings.length > 0 && <AssessmentCompare reviewed={reviewed} />}
                    <ProvenPanel report={r} />
                    <EvidencePanel report={r} />
                  </>
                ) : (
                  <LegacySummary report={r} />
                )}
              </>
            )}

            {tab === "problems" && <ProblemsTab run={run} reviewed={reviewed} setReviewed={setReviewed} repairs={repairs} refreshRepairs={refreshRepairs} sub={view.get("sub")} findingId={view.get("f")} go={go} />}

            {tab === "checks" && <ChecksTab run={run} sub={view.get("sub")} go={go} />}

            {tab === "load" && r?.load && (
              <Card className="space-y-6">
                {r.load.stages.some((s) => s.name === "breakpoint") && <BreakpointCard stage={r.load.stages.find((s) => s.name === "breakpoint")!} />}
                <LoadTimeline load={r.load} />
                <section className="space-y-3" aria-label="Stages compared">
                  <h3 className="font-semibold text-fg">Stages compared</h3>
                  <LoadCharts load={r.load} />
                </section>
                <LoadResults load={r.load} runId={run.id} />
              </Card>
            )}

            {tab === "watch" && <LiveView run={run} events={events} live={false} />}

            {tab === "repairs" && (
              <div className="space-y-4">
                <p className="text-sm text-fg-muted">Every sandbox repair tried for this run. A repair only ever runs in fresh, isolated sandboxes; your project is never changed.</p>
                {repairs.map((x) => {
                  const f = run.findings.find((y) => y.id === x.findingId);
                  return (
                    <Card key={x.id} className="space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium text-fg">
                          {x.findingId} · {f?.title ?? "Problem"}
                        </p>
                        <button type="button" onClick={() => go({ tab: "problems", sub: "confirmed", f: x.findingId })} className="inline-flex min-h-9 cursor-pointer items-center gap-1 text-sm font-medium text-accent hover:underline">
                          Open the problem <ArrowRight className="size-3.5" aria-hidden="true" />
                        </button>
                      </div>
                      <RepairBox runId={run.id} projectId={run.projectId} findingId={x.findingId} repair={x} canApprove={Boolean(reviewed?.canReview)} onChange={refreshRepairs} />
                    </Card>
                  );
                })}
              </div>
            )}

            {tab === "details" && (
              <>
                {r && r.suites.length > 0 && (
                  <Card>
                    <Suites report={r} />
                  </Card>
                )}
                {r?.fixtures && r.fixtures.nodes.length > 0 && (
                  <Card>
                    <Fixtures fixtures={r.fixtures} />
                  </Card>
                )}
                {run.executions.length > 0 && (
                  <Card className="space-y-3">
                    <CardTitle>What ran in the sandbox</CardTitle>
                    <p className="text-sm text-fg-muted">Each command ran in a fresh isolated sandbox. Exit codes and timeouts come from the sandbox platform, not from your project&apos;s output.</p>
                    <div className="space-y-2">
                      {run.executions.map((e) => (
                        <ExecutionRow key={e.id} e={e} runId={run.id} />
                      ))}
                    </div>
                  </Card>
                )}
                {r && (
                  <Card>
                    <EnvironmentAndAudit run={run} report={r} />
                  </Card>
                )}
              </>
            )}
          </TabPanel>
        )}

        {!tabs.length && !active && run.status !== "failed" && run.status !== "blocked" && (
          <Card>
            <p className="flex items-center gap-2 text-sm text-fg-muted">
              <FlaskConical className="size-4" aria-hidden="true" /> No report for this run.
            </p>
          </Card>
        )}
      </div>
    </CodeViewerProvider>
  );
}

/** What a person does next, each one a click away from its tab. */
function NextSteps({ run, reviewed, repairs, noVerdict, go }: { run: TestingRunDetail; reviewed: ReviewedReport | null; repairs: TestingRepair[]; noVerdict: number; go: Go }) {
  const awaiting = reviewed?.findings.filter((x) => x.queue === "awaiting").length ?? 0;
  const confirmed = reviewed?.findings.filter((x) => x.queue === "confirmed") ?? [];
  const unrepaired = confirmed.filter((x) => !repairs.some((y) => y.findingId === x.findingId && y.status !== "cancelled")).length;
  const steps = [
    awaiting > 0 && { icon: ShieldQuestion, tone: "text-warning", title: `Review ${awaiting} problem${awaiting === 1 ? "" : "s"}`, body: "Confirm the real ones and reject mistakes of the testing itself.", onClick: () => go({ tab: "problems", sub: "review" }) },
    unrepaired > 0 && { icon: Wrench, tone: "text-accent", title: `Try a sandbox repair (${unrepaired} confirmed)`, body: "An AI proposes a small fix and reruns the checks in isolated sandboxes. Your code is never changed.", onClick: () => go({ tab: "problems", sub: "confirmed" }) },
    !reviewed?.findings.length && run.findings.some((f) => f.kind === "product_defect" && f.status !== "rejected") && { icon: Bug, tone: "text-danger", title: "See the problems", body: "Each with expected and actual behaviour and how to reproduce it.", onClick: () => go({ tab: "problems" }) },
    noVerdict > 0 && { icon: ListChecks, tone: "text-fg-muted", title: `${noVerdict} check${noVerdict === 1 ? "" : "s"} without a verdict`, body: "Blocked, skipped or inconclusive. See why, layer by layer.", onClick: () => go({ tab: "checks" }) },
    repairs.length > 0 && { icon: Wrench, tone: "text-fg-muted", title: `${repairs.length} repair${repairs.length === 1 ? "" : "s"} tried`, body: "Patches, before and after checks, and costs.", onClick: () => go({ tab: "repairs" }) },
  ].filter(Boolean) as Array<{ icon: typeof Bug; tone: string; title: string; body: string; onClick: () => void }>;
  if (!steps.length) return null;
  return (
    <section aria-label="What to do next" className="space-y-3">
      <h2 className="text-lg font-semibold text-fg">What to do next</h2>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {steps.map((s) => (
          <button key={s.title} type="button" onClick={s.onClick} className="group flex cursor-pointer flex-col items-start gap-2 rounded-2xl border border-border bg-surface p-4 text-left transition-colors hover:border-fg/20 focus-visible:outline-2 focus-visible:outline-ring">
            <s.icon className={cn("size-5", s.tone)} aria-hidden="true" />
            <span className="font-medium text-fg">{s.title}</span>
            <span className="text-sm text-fg-muted">{s.body}</span>
            <span className="mt-auto inline-flex items-center gap-1 text-sm font-medium text-accent">
              Open <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

/** Every planned check: a summary of all layers, then one sub-tab per layer. */
function ChecksTab({ run, sub, go }: { run: TestingRunDetail; sub: string | null; go: Go }) {
  const r = run.report;
  const layers = LAYER_ORDER.filter((l) => run.obligations.some((o) => o.layer === l));
  const failedIn = (l: string) => run.obligations.filter((o) => o.layer === l && o.status === "failed").length;
  const requirements = r?.requirements?.length ?? 0;
  const items: TabItem<string>[] = [
    { id: "all", label: "All layers" },
    ...(requirements ? [{ id: "requirements", label: "Requirements", count: requirements, tone: "muted" as const }] : []),
    ...layers.map((l) => ({ id: l, label: LAYER_NAME[l] ?? l, count: failedIn(l) || run.obligations.filter((o) => o.layer === l).length, tone: failedIn(l) ? ("bad" as const) : ("muted" as const) })),
  ];
  const current = items.find((t) => t.id === sub)?.id ?? "all";
  const obs = current === "all" || current === "requirements" ? run.obligations : run.obligations.filter((o) => o.layer === current);
  const counts = [...new Set(obs.map((o) => o.status))].map((s) => [s, obs.filter((o) => o.status === s).length] as const);
  return (
    <div className="space-y-4">
      <Tabs items={items} value={current} onChange={(id) => go({ sub: id })} label="Layers" level="sub" idPrefix="checks" />
      {current === "all" && (
        <Card className="grid gap-8 lg:grid-cols-[13rem_minmax(0,1fr)]">
          <ResultsDonut obligations={run.obligations} />
          <LayerBars obligations={run.obligations} onLayer={(l) => go({ sub: l })} />
        </Card>
      )}
      {current === "all" && r && (
        <>
          <LayerMatrix report={r} />
          <CapabilityMatrix report={r} />
          {r.untested.length > 0 && (
            <Card className="space-y-3">
              <CardTitle>Missing evidence</CardTitle>
              <p className="text-sm text-fg-muted">These checks were planned but gave no verdict. They are never counted as passed.</p>
              <ul className="divide-y divide-border">
                {r.untested.map((u) => (
                  <li key={u.reason} className="flex items-start justify-between gap-4 py-2.5 text-sm">
                    <span className="min-w-0 text-fg">
                      {u.owner && (
                        <Badge tone={u.owner === "you" ? "warn" : u.owner === "cybercheck" ? "info" : "muted"} className="mr-2 align-middle">
                          {u.owner === "you" ? "Needs you" : u.owner === "cybercheck" ? "cybercheck to fix" : "Not supported yet"}
                        </Badge>
                      )}
                      {u.reason}
                    </span>
                    <span className="shrink-0 text-fg-muted tabular-nums">{u.count}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
      {current === "requirements" && (
        <Card className="space-y-4">
          <div>
            <CardTitle>Documented requirements</CardTitle>
            <p className="mt-1 text-sm text-fg-muted">What the project says it must do, where it says so, and what the checks found. Only documentation, its own tests, protocols or you may define correct behaviour.</p>
          </div>
          <RequirementsList run={run} />
        </Card>
      )}
      {current !== "requirements" && (
      <Card className="space-y-4">
        <div className="flex flex-wrap items-center gap-2" aria-label="Results in this layer">
          {counts.map(([s, n]) => {
            const st = STATUS_STYLE[s as ObligationStatus];
            return (
              <Badge key={s} tone={st.tone}>
                <st.icon className="size-3.5" aria-hidden="true" />
                <span className="tabular-nums">{n}</span> {st.label.toLowerCase()}
              </Badge>
            );
          })}
        </div>
        <Ledger obligations={obs} />
      </Card>
      )}
    </div>
  );
}
