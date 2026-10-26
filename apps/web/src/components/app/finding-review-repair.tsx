"use client";

import { useState } from "react";
import { CircleCheck, CircleHelp, CircleX, ShieldAlert, Undo2, UserCheck, Wrench } from "lucide-react";
import type { FindingHumanReview, FindingReviewDecision, TestingRepair } from "@cybercheck/contracts";
import { Badge } from "@/components/architecture/parts";
import { RepairBox } from "@/components/testing/repair-box";
import { Button } from "@/components/ui/button";
import { Alert, Spinner } from "@/components/ui/form";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { reviewCheckFinding, type RepairPath } from "./use-check-repairs";

// Human review and safe sandbox repair of one finding, for the AI Evaluator and AI Adversarial checks. A repair is
// offered only when the check confirmed the problem with runtime evidence AND a person confirmed it. A verified repair
// is a patch that was actually tested in fresh isolated sandboxes; it is never applied to the project automatically.

const CHOICES: Array<{ id: FindingReviewDecision; label: string; hint: string; icon: typeof CircleCheck; tone: string }> = [
  { id: "confirmed", label: "Confirm", hint: "This is a real problem", icon: CircleCheck, tone: "border-danger/40 text-danger hover:bg-danger/5" },
  { id: "rejected", label: "Reject", hint: "This is not a real problem", icon: CircleX, tone: "border-border text-fg hover:bg-surface-2" },
  { id: "unsure", label: "Unsure", hint: "More evidence is needed", icon: CircleHelp, tone: "border-border text-fg hover:bg-surface-2" },
  { id: "accepted_risk", label: "Accept risk", hint: "Real, but not fixed now", icon: ShieldAlert, tone: "border-warning/50 text-warning hover:bg-warning/5" },
];
const TEXT: Record<FindingReviewDecision, string> = { confirmed: "Confirmed by a reviewer", rejected: "Rejected by a reviewer", unsure: "Reviewer is unsure", accepted_risk: "Risk accepted" };
const TONE: Record<FindingReviewDecision, "bad" | "muted" | "info" | "warn"> = { confirmed: "bad", rejected: "muted", unsure: "info", accepted_risk: "warn" };
const PATH: Record<"ai-evaluator" | "adversarial", RepairPath> = { "ai-evaluator": "ai-evaluation-runs", adversarial: "adversarial-runs" };

export function FindingReviewRepair({ check, runId, projectId, findingId, machineConfirmed, review, repair, canReview, onChange }: {
  check: "ai-evaluator" | "adversarial";
  runId: string;
  projectId: string;
  findingId: string;
  /** The check confirmed this problem with runtime evidence (not suspected, unclear or untested). */
  machineConfirmed: boolean;
  review: FindingHumanReview | null;
  repair: TestingRepair | null;
  canReview: boolean;
  onChange: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<FindingReviewDecision | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: FindingReviewDecision) {
    setBusy(decision);
    setError(null);
    try {
      await reviewCheckFinding(PATH[check], runId, findingId, decision, reason.trim() || null);
      setReason("");
      setEditing(false);
      onChange();
    } catch (cause) {
      setError(cause instanceof ApiError ? `${cause.message} ${cause.fix ?? ""}` : "The decision was not saved. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-3 rounded-xl border border-border bg-surface-2/40 p-4" aria-label={`Review and repair ${findingId}`}>
      <h4 className="flex items-center gap-2 text-sm font-semibold text-fg">
        <UserCheck className="size-4 text-accent" aria-hidden="true" /> Your review and a safe repair
      </h4>
      {review && (
        <p className="text-sm text-fg">
          <Badge tone={TONE[review.decision]}>{TEXT[review.decision]}</Badge>{" "}
          <span className="text-fg-muted">by {review.reviewerName ?? "a reviewer"}, {new Date(review.createdAt).toLocaleString()}</span>
          {review.reason && <span className="mt-1 block">&ldquo;{review.reason}&rdquo;</span>}
        </p>
      )}
      {canReview && (!review || editing) && (
        <>
          <label className="block text-sm">
            <span className="text-fg-muted">Reason (optional, kept in the audit trail)</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value.slice(0, 2000))} rows={2} className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg focus-visible:outline-2 focus-visible:outline-ring" placeholder="For example: reproduced it with the evidence above" />
          </label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="Your decision on this finding">
            {CHOICES.map((c) => (
              <button key={c.id} type="button" disabled={busy != null} onClick={() => void decide(c.id)} className={cn("flex min-h-11 flex-col items-start rounded-lg border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50", c.tone)}>
                <span className="flex items-center gap-1.5 font-medium">{busy === c.id ? <Spinner /> : <c.icon className="size-4" aria-hidden="true" />} {c.label}</span>
                <span className="text-xs text-fg-muted">{c.hint}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {canReview && review && !editing && (
        <Button type="button" variant="outline" size="sm" shape="pill" onClick={() => setEditing(true)}>
          <Undo2 aria-hidden="true" /> Change decision
        </Button>
      )}
      {!canReview && !review && <p className="text-sm text-fg-muted">A workspace member must review this finding before a repair can be tried.</p>}

      {!machineConfirmed ? (
        <p className="flex items-start gap-1.5 text-xs text-fg-muted">
          <Wrench className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /> Not repairable automatically: the check did not confirm this problem with runtime evidence (it is suspected, unclear or could not be tested). Rerun the check, or review it manually.
        </p>
      ) : review?.decision === "confirmed" ? (
        <>
          <p className="text-xs text-fg-muted">The recommended fix above is advice. A repair here is only marked verified after it was tested in fresh isolated sandboxes, and it is never applied to your project for you.</p>
          <RepairBox check={check} runId={runId} projectId={projectId} findingId={findingId} repair={repair} canApprove={canReview} onChange={onChange} />
        </>
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-fg-muted">
          <Wrench className="size-3.5" aria-hidden="true" /> A sandbox repair becomes available after a reviewer confirms this problem. The original snapshot is never changed.
        </p>
      )}
      {error && <Alert tone="error">{error}</Alert>}
    </section>
  );
}
