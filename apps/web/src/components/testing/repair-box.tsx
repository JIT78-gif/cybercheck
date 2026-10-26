"use client";

import { useState } from "react";
import Link from "next/link";
import { CircleCheck, CircleX, FileCode2, LoaderCircle, ShieldCheck, TriangleAlert, Wrench } from "lucide-react";
import type { RepairAttempt, TestingRepair } from "@cybercheck/contracts";
import { Badge } from "@/components/architecture/parts";
import { Button } from "@/components/ui/button";
import { Alert, Spinner } from "@/components/ui/form";
import { cn } from "@/lib/cn";
import { ApiError } from "@/lib/api";
import { RepairBeforeAfter } from "./charts";
import { approveRepair, cancelRepair, requestRepair } from "./use-testing";
import { approveSecurityRepair, requestSecurityRepair } from "@/components/security/use-security";
import { approveCheckRepair, requestCheckRepair } from "@/components/app/use-check-repairs";

export type RepairCheck = "testing" | "security" | "ai-evaluator" | "adversarial";
/** What "rerun" means for each check, in plain words. */
const RERUN: Record<RepairCheck, { title: string; reproduction: string; regression: string }> = {
  testing: { title: "Checks rerun", reproduction: "reproduction", regression: "regression (build, your tests, the same endpoint or screen)" },
  security: { title: "Checks rerun", reproduction: "reproduction", regression: "regression (the same endpoint or asset)" },
  "ai-evaluator": { title: "AI cases rerun", reproduction: "that showed the problem (the browser check included, when it applies)", regression: "that passed before and must still pass" },
  adversarial: { title: "Attacks rerun", reproduction: "that succeeded and must now be blocked", regression: "that were blocked before and must stay blocked" },
};
const PATH = { "ai-evaluator": "ai-evaluation-runs", adversarial: "adversarial-runs" } as const;
const request = (check: RepairCheck, runId: string, findingId: string) =>
  check === "security" ? requestSecurityRepair(runId, findingId) : check === "testing" ? requestRepair(runId, findingId) : requestCheckRepair(PATH[check], runId, findingId);
const approve = (check: RepairCheck, runId: string, findingId: string, repairId: string, max: number) =>
  check === "security" ? approveSecurityRepair(runId, findingId, repairId, max) : check === "testing" ? approveRepair(runId, findingId, repairId, max) : approveCheckRepair(PATH[check], runId, findingId, repairId, max);

export const REPAIR_STATUS: Record<TestingRepair["status"], { label: string; tone: "good" | "bad" | "warn" | "info" | "muted" }> = {
  awaiting_approval: { label: "Waiting for your approval", tone: "info" },
  running: { label: "Running in a sandbox", tone: "info" },
  verified: { label: "Repair verified", tone: "good" },
  failed_validation: { label: "Repair did not work", tone: "warn" },
  regression_introduced: { label: "Repair broke something else", tone: "bad" },
  budget_exhausted: { label: "Budget used up", tone: "warn" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

const ATTEMPT: Record<RepairAttempt["status"], string> = {
  running: "running",
  verified: "verified: the problem is gone and nothing else broke",
  failed_validation: "the problem is still there",
  regression_introduced: "fixed it but broke a check that passed before",
  rejected_patch: "patch refused before running",
  budget_exhausted: "AI budget used up",
  cancelled: "cancelled",
};

/**
 * Sandbox repair of one confirmed finding: ask, see exactly what may change and what it costs, approve, then follow
 * the attempts. Nothing is ever applied to the project; a verified patch is shown for you to apply yourself.
 */
export function RepairBox({ runId, projectId, findingId, repair, canApprove, onChange, check = "testing" }: { runId: string; projectId: string; findingId: string; repair: TestingRepair | null; canApprove: boolean; onChange: () => void; check?: RepairCheck }) {
  const [busy, setBusy] = useState<"ask" | "approve" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<number | null>(null);
  const act = async (kind: "ask" | "approve" | "cancel", fn: () => Promise<unknown>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setError(e instanceof ApiError ? `${e.message} ${e.fix ?? ""}` : "That did not work. Try again.");
    } finally {
      setBusy(null);
    }
  };

  if (!repair || repair.status === "cancelled") {
    return (
      <div className="space-y-2">
        {repair?.status === "cancelled" && <p className="text-xs text-fg-muted">The last repair request was cancelled.</p>}
        {canApprove ? (
          <Button type="button" variant="outline" size="sm" shape="pill" disabled={busy != null} onClick={() => void act("ask", () => request(check, runId, findingId))}>
            {busy === "ask" ? <Spinner /> : <Wrench aria-hidden="true" />} Try repair in sandbox
          </Button>
        ) : (
          <p className="text-xs text-fg-muted">A workspace member can try a repair of this confirmed problem in an isolated sandbox.</p>
        )}
        {error && <Alert>{error}</Alert>}
      </div>
    );
  }

  const s = REPAIR_STATUS[repair.status];
  const max = attempts ?? repair.scope.maxAttempts;
  return (
    <div className="space-y-3 rounded-lg border border-border bg-surface p-3" aria-label="Sandbox repair">
      <div className="flex flex-wrap items-center gap-2">
        <Wrench className="size-4 text-accent" aria-hidden="true" />
        <span className="text-sm font-semibold text-fg">Sandbox repair</span>
        <Badge tone={s.tone}>
          {repair.status === "running" && <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />}
          {s.label}
        </Badge>
      </div>

      {repair.status === "awaiting_approval" && (
        <div className="space-y-3 text-sm">
          <p className="text-fg">
            An AI will propose a small fix. It is applied <strong>only inside fresh, isolated sandboxes</strong>, then the exact reproduction and the related checks run again. Your project and your code are never changed.
          </p>
          <dl className="grid gap-2 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-fg-muted">Files the fix may change</dt>
              <dd className="font-mono text-xs text-fg">{repair.scope.files.join(", ")}</dd>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">{RERUN[check].title}</dt>
              <dd className="text-fg">
                {repair.scope.reproduction.length} {RERUN[check].reproduction}, {repair.scope.regression.length} {RERUN[check].regression}
              </dd>
              <details className="mt-1 [&_summary::-webkit-details-marker]:hidden">
                <summary className="min-h-11 cursor-pointer list-none text-xs font-medium text-accent">Show exactly what reruns</summary>
                <ul className="mt-1 space-y-0.5 font-mono text-xs text-fg-muted">
                  {repair.scope.reproduction.map((id) => <li key={`r:${id}`}>must now pass: {id}</li>)}
                  {repair.scope.regression.map((id) => <li key={`g:${id}`}>must keep passing: {id}</li>)}
                </ul>
              </details>
            </div>
            <div>
              <dt className="text-xs text-fg-muted">Estimate for {max} attempt{max === 1 ? "" : "s"}</dt>
              <dd className="text-fg">
                up to {Math.round((repair.scope.estimate.minutes[1] / repair.scope.maxAttempts) * max)} min, AI ${repair.scope.estimate.costUsd[0].toFixed(2)} to ${((repair.scope.estimate.costUsd[1] / repair.scope.maxAttempts) * max).toFixed(2)}
              </dd>
            </div>
            <label className="text-sm">
              <span className="block text-xs text-fg-muted">Attempts at most</span>
              <select value={max} onChange={(e) => setAttempts(Number(e.target.value))} className="mt-0.5 min-h-10 rounded-md border border-border bg-surface px-2 text-fg">
                {[1, 2, 3].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          </dl>
          <p className="text-xs text-fg-muted">The fix may not edit tests, configuration or lint settings, or weaken sign-in, role or accessibility checks; such a patch is refused before it runs.</p>
          {canApprove && (
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" shape="pill" disabled={busy != null} onClick={() => void act("approve", () => approve(check, runId, findingId, repair.id, max))}>
                {busy === "approve" ? <Spinner /> : <ShieldCheck aria-hidden="true" />} Approve repair
              </Button>
              <Button type="button" variant="outline" size="sm" shape="pill" disabled={busy != null} onClick={() => void act("cancel", () => cancelRepair(repair.id))}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      )}

      {repair.status === "running" && (
        <div className="flex flex-wrap items-center gap-3 text-sm text-fg">
          <span>
            Attempt {Math.max(1, repair.attempts.length)} of {repair.scope.maxAttempts}: {repair.attempts.at(-1)?.validationRunId ? "rerunning the checks on the patched code" : "proposing a fix"}
          </span>
          {canApprove && (
            <Button type="button" variant="outline" size="sm" shape="pill" disabled={busy != null} onClick={() => void act("cancel", () => cancelRepair(repair.id))}>
              Stop
            </Button>
          )}
        </div>
      )}

      {repair.error && <p className="text-sm text-fg-muted">{repair.error}</p>}
      {repair.attempts.map((a) => (
        <Attempt key={a.n} a={a} projectId={projectId} check={check} />
      ))}
      {!["awaiting_approval", "running"].includes(repair.status) && (
        <p className="text-xs text-fg-muted">Nothing was applied to your project. {repair.status === "verified" ? "To use the verified fix, apply the patch above yourself." : ""}</p>
      )}
      {error && <Alert>{error}</Alert>}
    </div>
  );
}

function Attempt({ a, projectId, check }: { a: RepairAttempt; projectId: string; check: RepairCheck }) {
  const ok = a.status === "verified";
  return (
    <details className="group rounded-md border border-border [&_summary::-webkit-details-marker]:hidden" open={ok}>
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm">
        {ok ? <CircleCheck className="size-4 text-success" aria-hidden="true" /> : a.status === "running" ? <LoaderCircle className="size-4 animate-spin text-accent" aria-hidden="true" /> : <CircleX className="size-4 text-danger" aria-hidden="true" />}
        <span className="font-medium text-fg">Attempt {a.n}</span>
        <span className="text-fg-muted">{ATTEMPT[a.status]}</span>
        {a.costUsd > 0 && <span className="ml-auto font-mono text-xs text-fg-muted">${a.costUsd.toFixed(3)}</span>}
      </summary>
      <div className="space-y-3 border-t border-border px-3 py-3 text-sm">
        {a.summary && <p className="text-fg">{a.summary}</p>}
        {a.rejectedBecause.length > 0 && (
          <ul className="space-y-1">
            {a.rejectedBecause.map((r) => (
              <li key={r} className="flex gap-2 text-fg">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" /> {r}
              </li>
            ))}
          </ul>
        )}
        <RepairBeforeAfter attempt={a} />
        {a.checks.length > 0 && (
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Checks before and after the patch</caption>
            <thead className="text-fg-muted">
              <tr>
                <th className="py-1 pr-2 font-medium">Check</th>
                <th className="py-1 pr-2 font-medium">Role</th>
                <th className="py-1 pr-2 font-medium">Before</th>
                <th className="py-1 font-medium">After the patch</th>
              </tr>
            </thead>
            <tbody>
              {a.checks.slice(0, 30).map((c) => (
                <tr key={c.obligationId} className="border-t border-border">
                  <td className="py-1 pr-2 text-fg">{c.label}</td>
                  <td className="py-1 pr-2 text-fg-muted">{c.role}</td>
                  <td className="py-1 pr-2 font-mono">{c.before}</td>
                  <td className={cn("py-1 font-mono", c.after === "passed" || c.targetResolved ? "text-success" : c.after === "failed" ? "text-danger" : "text-fg-muted")}>
                    {c.targetResolved && c.after !== "passed" ? "target fixed; other findings remain" : c.after}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {a.diff && (
          <div>
            <p className="mb-1 flex items-center gap-1.5 text-xs text-fg-muted">
              <FileCode2 className="size-3.5" aria-hidden="true" /> Patch ({a.filesChanged.join(", ")}) · digest <span className="font-mono">{a.patchDigest?.slice(0, 12)}</span>
            </p>
            <pre className="max-h-80 overflow-auto rounded-md bg-surface-2 p-3 font-mono text-xs leading-relaxed">
              {a.diff.split("\n").map((l, i) => (
                <span key={i} className={cn("block", l.startsWith("+") && !l.startsWith("+++") ? "bg-success/10 text-success" : l.startsWith("-") && !l.startsWith("---") ? "bg-danger/10 text-danger" : "text-fg")}>
                  {l || " "}
                </span>
              ))}
            </pre>
          </div>
        )}
        {a.validationRunId && (
          <Link href={`/app/projects/${projectId}/${check}/${a.validationRunId}`} className="inline-flex text-xs font-medium text-accent hover:underline">
            Open the validation run
          </Link>
        )}
      </div>
    </details>
  );
}
