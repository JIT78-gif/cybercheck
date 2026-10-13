"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bot, CircleCheck, CircleHelp, CircleX, History, ShieldAlert, Undo2, UserCheck, Wrench } from "lucide-react";
import type { FindingReviewDecision, ReviewedReport, ReviewPrecision, TestingRepair } from "@cybercheck/contracts";
import { Card, CardTitle } from "@/components/app/ui";
import { Badge } from "@/components/architecture/parts";
import { Button } from "@/components/ui/button";
import { Alert, Spinner } from "@/components/ui/form";
import { cn } from "@/lib/cn";
import { ApiError } from "@/lib/api";
import { DECISION } from "./release-panels";
import { RepairBox } from "./repair-box";
import { reviewFinding, targetedRun } from "./use-testing";

const DECISIONS: Array<{ id: FindingReviewDecision; label: string; hint: string; icon: typeof CircleCheck; tone: string }> = [
  { id: "confirmed", label: "Confirm", hint: "This problem is real", icon: CircleCheck, tone: "border-danger/40 text-danger hover:bg-danger/5" },
  { id: "rejected", label: "Reject", hint: "Not a product problem", icon: CircleX, tone: "border-border text-fg hover:bg-surface-2" },
  { id: "unsure", label: "Unsure", hint: "More evidence is needed", icon: CircleHelp, tone: "border-border text-fg hover:bg-surface-2" },
  { id: "accepted_risk", label: "Accept risk", hint: "Real, but not fixed now", icon: ShieldAlert, tone: "border-warning/50 text-warning hover:bg-warning/5" },
];

export const DECISION_TEXT: Record<FindingReviewDecision, string> = { confirmed: "Confirmed", rejected: "Rejected", unsure: "Unsure", accepted_risk: "Risk accepted" };
export const DECISION_TONE: Record<FindingReviewDecision, "bad" | "muted" | "warn" | "info"> = { confirmed: "bad", rejected: "muted", unsure: "info", accepted_risk: "warn" };

function PrecisionLine({ label, p }: { label: string; p: ReviewPrecision }) {
  return (
    <p className="text-sm">
      <span className="text-fg-muted">{label}: </span>
      <span className="text-fg">{p.text}</span>
    </p>
  );
}

/** The two assessments side by side: what the machine concluded, and where human review leaves it. */
export function AssessmentCompare({ reviewed }: { reviewed: ReviewedReport }) {
  const m = DECISION[reviewed.machine.decision];
  const h = DECISION[reviewed.reviewed.decision];
  const stat = (label: string, value: string) => (
    <div>
      <dt className="text-xs text-fg-muted">{label}</dt>
      <dd className="font-mono text-base font-semibold text-fg tabular-nums">{value}</dd>
    </div>
  );
  return (
    <Card className="space-y-4">
      <CardTitle>Machine and human-reviewed assessment</CardTitle>
      <div className="grid gap-4 md:grid-cols-2">
        <section className="space-y-3 rounded-xl border border-border p-4" aria-label="Machine assessment">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
            <Bot className="size-4 text-fg-muted" aria-hidden="true" /> Machine assessment
          </h3>
          <Badge tone={m.tone}>
            <m.icon className="size-3.5" aria-hidden="true" /> {m.label}
          </Badge>
          <dl className="grid grid-cols-3 gap-3">
            {stat("Completeness", `${reviewed.machine.completeness}%`)}
            {stat("Product health", reviewed.machine.productHealth == null ? "n/a" : `${reviewed.machine.productHealth}%`)}
            {stat("Open problems", String(reviewed.machine.openDefects))}
          </dl>
          <p className="text-xs text-fg-muted">The result at the end of the run. It never changes.</p>
        </section>
        <section className="space-y-3 rounded-xl border border-accent/30 bg-accent/[0.03] p-4" aria-label="Human-reviewed assessment">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-fg">
            <UserCheck className="size-4 text-accent" aria-hidden="true" /> Human-reviewed assessment
          </h3>
          <Badge tone={h.tone}>
            <h.icon className="size-3.5" aria-hidden="true" /> {h.label}
          </Badge>
          <dl className="grid grid-cols-3 gap-3">
            {stat("Completeness", `${reviewed.reviewed.completeness}%`)}
            {stat("Product health", reviewed.reviewed.productHealth == null ? "n/a" : `${reviewed.reviewed.productHealth}%`)}
            {stat("Open problems", String(reviewed.reviewed.openDefects))}
          </dl>
          <p className="text-xs text-fg-muted">
            {reviewed.reviewed.awaitingReview} awaiting review · {reviewed.reviewed.unsure} unsure · {reviewed.reviewed.acceptedRisks} accepted risk{reviewed.reviewed.acceptedRisks === 1 ? "" : "s"}. Review changes which problems count, never how much was tested.
          </p>
        </section>
      </div>
      {reviewed.reviewed.reasons.length > 0 && reviewed.reviewed.decision !== "ready" && (
        <div>
          <p className="text-sm font-medium text-fg">Release conditions not met</p>
          <ul className="mt-2 space-y-1.5 text-sm">
            {reviewed.reviewed.reasons.slice(0, 6).map((r) => {
              const at = r.indexOf(": ");
              return (
                <li key={r} className="flex items-start gap-2">
                  <CircleX className="mt-0.5 size-4 shrink-0 text-danger" aria-label="not met" />
                  <span className="min-w-0">{at > 0 ? <><span className="text-fg">Needed: {r.slice(0, at).replace(/^./, (c) => c.toLowerCase())}.</span> <span className="text-fg-muted">Now: {r.slice(at + 2)}</span></> : <span className="text-fg-muted">{r}</span>}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="space-y-1 rounded-lg bg-surface-2/60 p-3">
        <PrecisionLine label="Review precision, this run" p={reviewed.precision.run} />
        <PrecisionLine label="Review precision, this project" p={reviewed.precision.project} />
        <p className="text-xs text-fg-muted">Counts only findings a reviewer confirmed or rejected. It measures how often the machine was right about the problems it reported, not how much was tested.</p>
      </div>
    </Card>
  );
}

/** Decide on one finding: four choices and an optional reason. Roles outside REVIEW_ROLES see the decision only. */
export function ReviewControls({ runId, projectId, item, onReviewed, canReview, allowAcceptedRisk, repair, onRepairChange }: { runId: string; projectId: string; item: ReviewedReport["findings"][number]; onReviewed: (r: ReviewedReport) => void; canReview: boolean; allowAcceptedRisk: boolean; repair: TestingRepair | null; onRepairChange: () => void }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<FindingReviewDecision | "rerun" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const r = item.review;

  async function decide(d: FindingReviewDecision) {
    setBusy(d);
    setError(null);
    try {
      const res = await reviewFinding(runId, item.findingId, d, reason.trim() || null);
      onReviewed(res.reviewed);
      setReason("");
      setEditing(false);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.message} ${e.fix ?? ""}` : "The decision was not saved. Try again.");
    } finally {
      setBusy(null);
    }
  }
  async function moreEvidence() {
    setBusy("rerun");
    setError(null);
    try {
      const res = await targetedRun(runId, [item.findingId]);
      router.push(`/app/projects/${res.run.projectId}/testing/${res.run.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.message} ${e.fix ?? ""}` : "The rerun could not start.");
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-border bg-surface-2/40 p-4">
      <h4 className="flex items-center gap-2 text-sm font-semibold text-fg">
        <UserCheck className="size-4 text-accent" aria-hidden="true" /> Your review
      </h4>
      {r && (
        <p className="text-sm text-fg">
          <Badge tone={DECISION_TONE[r.decision]}>{DECISION_TEXT[r.decision]}</Badge>{" "}
          <span className="text-fg-muted">
            by {r.reviewerName ?? "a reviewer"} ({r.reviewerRole}), {new Date(r.createdAt).toLocaleString()}
          </span>
          {r.reason && <span className="mt-1 block text-fg">&ldquo;{r.reason}&rdquo;</span>}
          {item.history > 1 && (
            <span className="mt-1 flex items-center gap-1 text-xs text-fg-muted">
              <History className="size-3.5" aria-hidden="true" /> {item.history} decisions so far; earlier ones are kept
            </span>
          )}
        </p>
      )}
      {canReview && (!r || editing) && (
        <>
          <label className="block text-sm">
            <span className="text-fg-muted">Reason (optional, saved with your decision)</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value.slice(0, 2000))} rows={2} className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg focus-visible:outline-2 focus-visible:outline-ring" placeholder="For example: reproduced it on staging" />
          </label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="Decision">
            {DECISIONS.filter((d) => d.id !== "accepted_risk" || allowAcceptedRisk).map((d) => (
              <button
                key={d.id}
                type="button"
                disabled={busy != null}
                onClick={() => void decide(d.id)}
                className={cn("flex min-h-11 flex-col items-start rounded-lg border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50", d.tone)}
              >
                <span className="flex items-center gap-1.5 font-medium">
                  {busy === d.id ? <Spinner /> : <d.icon className="size-4" aria-hidden="true" />} {d.label}
                </span>
                <span className="text-xs text-fg-muted">{d.hint}</span>
              </button>
            ))}
          </div>
          {!allowAcceptedRisk && <p className="text-xs text-fg-muted">Accepting a risk is switched off for this run.</p>}
        </>
      )}
      {canReview && r && !editing && (
        <Button type="button" variant="outline" size="sm" shape="pill" onClick={() => setEditing(true)}>
          <Undo2 aria-hidden="true" /> Change decision
        </Button>
      )}
      {!canReview && !r && <p className="text-sm text-fg-muted">Not reviewed yet. Members of this workspace can decide.</p>}
      {r?.decision === "unsure" && canReview && (
        <Button type="button" variant="outline" size="sm" shape="pill" disabled={busy != null} onClick={() => void moreEvidence()}>
          {busy === "rerun" ? <Spinner /> : null} Rerun just these checks for more evidence
        </Button>
      )}
      {item.repairEligible ? (
        <RepairBox runId={runId} projectId={projectId} findingId={item.findingId} repair={repair} canApprove={canReview} onChange={onRepairChange} />
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-fg-muted">
          <Wrench className="size-3.5" aria-hidden="true" /> Sandbox repair: available after a reviewer confirms this problem.
        </p>
      )}
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
