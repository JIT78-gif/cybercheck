"use client";

import { ArrowLeft, Bug, CircleDashed, FlaskConical, Server, ShieldQuestion, TriangleAlert, UserCheck, Wrench } from "lucide-react";
import type { ReviewedReport, TestFinding, TestingRepair, TestingRunDetail } from "@cybercheck/contracts";
import { Card } from "@/components/app/ui";
import { Badge } from "@/components/architecture/parts";
import { cn } from "@/lib/cn";
import { REPAIR_STATUS } from "./repair-box";
import { DECISION_TEXT, DECISION_TONE, ReviewControls } from "./review-panel";
import { Tabs, type TabItem } from "./run-tabs";
import { FindingBody, SEVERITY_TONE, findingMeta } from "./run-parts";

type Group = { id: string; label: string; intro: string; items: TestFinding[]; icon: typeof Bug; tone?: "bad" | "warn" | "muted" };

const QUEUE_SUB: Record<ReviewedReport["findings"][number]["queue"], string> = { awaiting: "review", confirmed: "confirmed", accepted_or_unsure: "accepted", rejected: "rejected" };

/** The problems of a run, grouped the way a person acts on them. Product problems carry the review queues. */
export function problemGroups(run: TestingRunDetail, reviewed: ReviewedReport | null): Group[] {
  const fs = run.findings;
  const open = (f: TestFinding) => f.status !== "rejected";
  const byId = new Map(fs.map((f) => [f.id, f]));
  const queue = (q: ReviewedReport["findings"][number]["queue"]) => (reviewed?.findings ?? []).filter((x) => x.queue === q).map((x) => byId.get(x.findingId)).filter((f): f is TestFinding => Boolean(f));
  const product: Group[] =
    reviewed && reviewed.findings.length
      ? [
          { id: "review", label: "To review", intro: "Problems the machine reported. Confirm the real ones, reject the mistakes of the testing itself.", items: queue("awaiting"), icon: ShieldQuestion, tone: "warn" },
          { id: "confirmed", label: "Confirmed", intro: "A reviewer confirmed these are real. Each one can be tried as a repair in an isolated sandbox.", items: queue("confirmed"), icon: Bug, tone: "bad" },
          { id: "accepted", label: "Accepted or unsure", intro: "Real problems accepted for now, and ones that need more evidence before a decision.", items: queue("accepted_or_unsure"), icon: UserCheck, tone: "muted" },
          { id: "rejected", label: "Rejected", intro: "A reviewer said these are not product problems. Their checks stay without a verdict; they are never counted as passed.", items: queue("rejected"), icon: CircleDashed, tone: "muted" },
        ]
      : [
          { id: "confirmed", label: "Confirmed defects", intro: "Reproduced in clean sandboxes and confirmed by an independent reviewer model, or reported by a deterministic tool.", items: fs.filter((f) => f.kind === "product_defect" && f.status === "confirmed"), icon: Bug, tone: "bad" },
          { id: "review", label: "Needs review", intro: "Failures that look like defects but were not independently confirmed. Check these before acting.", items: fs.filter((f) => f.kind === "product_defect" && f.status === "suspected"), icon: ShieldQuestion, tone: "warn" },
        ];
  const rest: Group[] = [
    { id: "system", label: "Testing system", intro: "Checks cybercheck wrote or ran that did not work. They say nothing about your code; the affected checks count as missing evidence.", items: fs.filter((f) => (f.kind === "tool_failure" || (f.kind === "test_defect" && f.status === "confirmed")) && open(f)), icon: FlaskConical, tone: "muted" },
    { id: "environment", label: "Environment", intro: "Things that stopped a check from giving a verdict: missing configuration, a build that needs internet access, or a service the sandbox does not provide.", items: fs.filter((f) => (f.kind === "environment_failure" || f.kind === "configuration_gap") && open(f)), icon: Server, tone: "muted" },
    { id: "suite", label: "Your tests", intro: "Your own test suites hang, run nothing, or give different results on identical runs.", items: fs.filter((f) => (f.kind === "suite_integrity" || f.kind === "flaky") && open(f)), icon: TriangleAlert, tone: "warn" },
    { id: "dismissed", label: "Dismissed", intro: "Checks whose own expectation turned out to be wrong. Kept for transparency.", items: fs.filter((f) => f.status === "rejected" && !(reviewed?.findings ?? []).some((x) => x.findingId === f.id)), icon: CircleDashed, tone: "muted" },
  ];
  return [...product, ...rest].filter((g) => g.items.length > 0 || ["review", "confirmed"].includes(g.id));
}

export function ProblemsTab({
  run,
  reviewed,
  setReviewed,
  repairs,
  refreshRepairs,
  sub,
  findingId,
  go,
}: {
  run: TestingRunDetail;
  reviewed: ReviewedReport | null;
  setReviewed: (r: ReviewedReport) => void;
  repairs: TestingRepair[];
  refreshRepairs: () => void;
  sub: string | null;
  findingId: string | null;
  go: (next: { sub?: string | null; f?: string | null }) => void;
}) {
  const groups = problemGroups(run, reviewed);
  const current = groups.find((g) => g.id === sub) ?? groups.find((g) => g.items.length) ?? groups[0]!;
  const explicit = Boolean(findingId && current.items.some((f) => f.id === findingId));
  const selected = current.items.find((f) => f.id === findingId) ?? current.items[0] ?? null;
  const itemOf = (id: string) => reviewed?.findings.find((x) => x.findingId === id) ?? null;
  const repairOf = (id: string) => repairs.find((x) => x.findingId === id) ?? null;
  const tabs: TabItem<string>[] = groups.map((g) => ({ id: g.id, label: g.label, count: g.items.length, tone: g.items.length ? g.tone : "muted" }));

  // After a decision the problem moves to its new queue; follow it there so the next step (repair) is in view.
  const onReviewed = (r: ReviewedReport, id: string) => {
    setReviewed(r);
    const q = r.findings.find((x) => x.findingId === id)?.queue;
    if (q) go({ sub: QUEUE_SUB[q], f: id });
  };

  return (
    <div className="space-y-4">
      <Tabs items={tabs} value={current.id} onChange={(id) => go({ sub: id, f: null })} label="Problem groups" level="sub" idPrefix="problems" />
      <p className="text-sm text-fg-muted">{current.intro}</p>
      {current.items.length === 0 ? (
        <Card>
          <p className="text-sm text-fg-muted">Nothing here.</p>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          <ul className={cn("space-y-2 lg:block", explicit ? "hidden" : "block")} aria-label={current.label}>
            {current.items.map((f) => {
              const it = itemOf(f.id);
              const rep = repairOf(f.id);
              const on = selected?.id === f.id;
              return (
                <li key={f.id}>
                  <button
                    type="button"
                    onClick={() => go({ f: f.id })}
                    aria-current={on ? "true" : undefined}
                    className={cn("flex w-full cursor-pointer flex-col items-start gap-1.5 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring", on ? "border-accent bg-accent/[0.04]" : "border-border hover:border-fg/20")}
                  >
                    <span className="flex w-full items-start gap-2">
                      <Badge tone={SEVERITY_TONE[f.severity]} className="shrink-0 capitalize">{f.severity}</Badge>
                      <span className="min-w-0 text-sm font-medium text-fg">{f.title}</span>
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
                      {f.id}
                      {it?.review && <Badge tone={DECISION_TONE[it.review.decision]}>{DECISION_TEXT[it.review.decision]}</Badge>}
                      {rep && (
                        <Badge tone={REPAIR_STATUS[rep.status].tone}>
                          <Wrench className="size-3" aria-hidden="true" /> {REPAIR_STATUS[rep.status].label}
                        </Badge>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {selected && (
            <Card className={cn("min-w-0 space-y-4 lg:block", explicit ? "block" : "hidden")} aria-label={`Problem ${selected.id}`}>
              <button type="button" onClick={() => go({ f: null })} className="inline-flex min-h-10 items-center gap-1.5 text-sm text-fg-muted hover:text-fg lg:hidden">
                <ArrowLeft className="size-4" aria-hidden="true" /> All {current.label.toLowerCase()}
              </button>
              <div className="flex items-start gap-3">
                <Badge tone={SEVERITY_TONE[selected.severity]} className="mt-1 shrink-0 capitalize">{selected.severity}</Badge>
                <div className="min-w-0">
                  <h3 className="text-lg font-semibold text-fg">{selected.title}</h3>
                  <p className="mt-0.5 text-xs text-fg-muted">{findingMeta(selected)}</p>
                </div>
              </div>
              {(() => {
                const it = itemOf(selected.id);
                // Actions first: the decision and the sandbox repair are what a reader came here to do.
                return it && reviewed ? (
                  <ReviewControls
                    key={selected.id}
                    runId={run.id}
                    projectId={run.projectId}
                    item={it}
                    onReviewed={(r) => onReviewed(r, selected.id)}
                    canReview={reviewed.canReview}
                    allowAcceptedRisk={reviewed.allowAcceptedRisk}
                    repair={repairOf(selected.id)}
                    onRepairChange={refreshRepairs}
                  />
                ) : null;
              })()}
              <FindingBody f={selected} run={run} className="border-t border-border pt-4" />
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
