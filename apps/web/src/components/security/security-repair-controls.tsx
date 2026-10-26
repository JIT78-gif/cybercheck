"use client";

import { useState } from "react";
import { CircleCheck, CircleHelp, CircleX, ShieldAlert, Undo2, UserCheck, Wrench } from "lucide-react";
import type { FindingHumanReview, FindingReviewDecision, SecurityFinding, TestingRepair } from "@cybercheck/contracts";
import { Badge } from "@/components/architecture/parts";
import { RepairBox } from "@/components/testing/repair-box";
import { Button } from "@/components/ui/button";
import { Alert, Spinner } from "@/components/ui/form";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { reviewSecurityFinding } from "./use-security";

const CHOICES: Array<{ id: FindingReviewDecision; label: string; hint: string; icon: typeof CircleCheck; tone: string }> = [
  { id: "confirmed", label: "Confirm", hint: "Approve this as a real issue", icon: CircleCheck, tone: "border-danger/40 text-danger hover:bg-danger/5" },
  { id: "rejected", label: "Reject", hint: "This is not a real issue", icon: CircleX, tone: "border-border text-fg hover:bg-surface-2" },
  { id: "unsure", label: "Unsure", hint: "Gather more evidence first", icon: CircleHelp, tone: "border-border text-fg hover:bg-surface-2" },
  { id: "accepted_risk", label: "Accept risk", hint: "Real, but defer the fix", icon: ShieldAlert, tone: "border-warning/50 text-warning hover:bg-warning/5" },
];

const TEXT: Record<FindingReviewDecision, string> = { confirmed: "Confirmed by reviewer", rejected: "Rejected by reviewer", unsure: "Reviewer is unsure", accepted_risk: "Risk accepted" };
const TONE: Record<FindingReviewDecision, "bad" | "muted" | "info" | "warn"> = { confirmed: "bad", rejected: "muted", unsure: "info", accepted_risk: "warn" };

export function SecurityRepairControls({
  runId,
  projectId,
  finding,
  review,
  repair,
  canReview,
  onChange,
}: {
  runId: string;
  projectId: string;
  finding: SecurityFinding;
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
      await reviewSecurityFinding(runId, finding.id, decision, reason.trim() || null);
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
    <div className="space-y-3 rounded-xl border border-border bg-surface-2/40 p-4" aria-label={`Review and repair ${finding.id}`}>
      <h4 className="flex items-center gap-2 text-sm font-semibold text-fg">
        <UserCheck className="size-4 text-accent" aria-hidden="true" /> Human review and safe repair
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
            <span className="text-fg-muted">Reason (optional and kept in the audit trail)</span>
            <textarea value={reason} onChange={(event) => setReason(event.target.value.slice(0, 2000))} rows={2} className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg focus-visible:outline-2 focus-visible:outline-ring" placeholder="For example: reproduced with the proof shown above" />
          </label>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label="Security finding decision">
            {CHOICES.map((choice) => (
              <button key={choice.id} type="button" disabled={busy != null} onClick={() => void decide(choice.id)} className={cn("flex min-h-11 flex-col items-start rounded-lg border px-3 py-2 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50", choice.tone)}>
                <span className="flex items-center gap-1.5 font-medium">{busy === choice.id ? <Spinner /> : <choice.icon className="size-4" aria-hidden="true" />} {choice.label}</span>
                <span className="text-xs text-fg-muted">{choice.hint}</span>
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
      {!canReview && !review && <p className="text-sm text-fg-muted">A workspace member must review this finding before a repair can be requested.</p>}
      {review?.decision === "confirmed" && finding.status !== "rejected" ? (
        <RepairBox check="security" runId={runId} projectId={projectId} findingId={finding.id} repair={repair} canApprove={canReview} onChange={onChange} />
      ) : (
        <p className="flex items-center gap-1.5 text-xs text-fg-muted">
          <Wrench className="size-3.5" aria-hidden="true" /> Sandbox repair becomes available after a reviewer confirms this finding. The original snapshot is never changed.
        </p>
      )}
      {error && <Alert tone="error">{error}</Alert>}
    </div>
  );
}
