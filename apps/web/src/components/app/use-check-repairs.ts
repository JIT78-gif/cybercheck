"use client";

import { useCallback, useEffect, useState } from "react";
import type { FindingHumanReview, FindingReviewDecision, TestingRepair } from "@cybercheck/contracts";
import { api } from "@/lib/api";

// Human review + sandbox repair for the AI Evaluator and AI Adversarial checks. Both expose the same endpoints under
// their own run path, so one set of hooks serves both. Reviews and repairs sit beside the immutable machine report.

export type RepairPath = "ai-evaluation-runs" | "adversarial-runs";

export function useCheckReviews(path: RepairPath, runId: string, enabled: boolean) {
  const [reviews, setReviews] = useState<FindingHumanReview[]>([]);
  const [canReview, setCanReview] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    api<{ reviews: FindingHumanReview[]; canReview: boolean }>(`/v1/${path}/${runId}/reviews`)
      .then((r) => {
        if (!alive) return;
        setReviews(r.reviews);
        setCanReview(r.canReview);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [path, runId, enabled, version]);
  return { reviews, canReview, refresh: useCallback(() => setVersion((v) => v + 1), []) };
}

export async function reviewCheckFinding(path: RepairPath, runId: string, findingId: string, decision: FindingReviewDecision, reason: string | null) {
  return api<{ review: FindingHumanReview }>(`/v1/${path}/${runId}/findings/${findingId}/reviews`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify({ decision, reason }),
  });
}

export function useCheckRepairs(path: RepairPath, runId: string, enabled: boolean) {
  const [repairs, setRepairs] = useState<TestingRepair[]>([]);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const r = await api<{ repairs: TestingRepair[] }>(`/v1/${path}/${runId}/repairs`);
        if (!alive) return;
        setRepairs(r.repairs);
        if (r.repairs.some((x) => x.status === "running")) timer = setTimeout(tick, 4000);
      } catch {
        // The report stays usable if repair metadata cannot load.
      }
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [path, runId, enabled, version]);
  return { repairs, refresh: useCallback(() => setVersion((v) => v + 1), []) };
}

export async function requestCheckRepair(path: RepairPath, runId: string, findingId: string) {
  return api<{ repair: TestingRepair }>(`/v1/${path}/${runId}/findings/${findingId}/repairs`, { method: "POST" });
}

export async function approveCheckRepair(path: RepairPath, runId: string, findingId: string, repairId: string, maxAttempts: number) {
  return api<{ repair: TestingRepair }>(`/v1/${path}/${runId}/findings/${findingId}/repair-approvals`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify({ repairId, maxAttempts }),
  });
}

/** The newest review per finding (reviews are append-only; a later one supersedes, never overwrites). */
export const latestReviewOf = (reviews: FindingHumanReview[], findingId: string) => [...reviews].reverse().find((r) => r.findingId === findingId) ?? null;
/** The newest repair per finding. */
export const repairOf = (repairs: TestingRepair[], findingId: string) => repairs.find((r) => r.findingId === findingId) ?? null;
