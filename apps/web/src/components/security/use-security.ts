"use client";

import { useCallback, useEffect, useState } from "react";
import type { FindingHumanReview, FindingReviewDecision, SecurityEvent, SecurityRunDetail, SecurityRunSummary, TestingRepair } from "@cybercheck/contracts";
import { ApiError, api } from "@/lib/api";
import { ACTIVE_RUN } from "@/components/testing/use-testing";

/** Security runs of one project, refreshed every 3s while one is active. */
export function useSecurityRuns(projectId: string | null) {
  const [runs, setRuns] = useState<SecurityRunSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!projectId) return;
      try {
        const r = await api<{ runs: SecurityRunSummary[] }>(`/v1/projects/${projectId}/security-runs`);
        if (!alive) return;
        setRuns(r.runs);
        setError(null);
        if (r.runs.some((x) => ACTIVE_RUN.has(x.status))) timer = setTimeout(tick, 3000);
      } catch (e) {
        if (alive) setError(e instanceof ApiError ? e : null);
      }
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [projectId, version]);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { runs: projectId ? runs : null, error, reload };
}

/** One Security run with its ledger and its events; polls every 2s while it runs. */
export function useSecurityRun(runId: string) {
  const [run, setRun] = useState<SecurityRunDetail | null>(null);
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let after = 0;
    const tick = async () => {
      try {
        const [r, e] = await Promise.all([
          api<{ run: SecurityRunDetail }>(`/v1/security-runs/${runId}`, { signal: AbortSignal.timeout(20_000) }),
          api<{ events: SecurityEvent[] }>(`/v1/security-runs/${runId}/events?after=${after}`, { signal: AbortSignal.timeout(20_000) }),
        ]);
        if (!alive) return;
        setRun(r.run);
        if (e.events.length) {
          after = e.events.at(-1)!.seq;
          setEvents((prev) => [...prev, ...e.events]);
        }
        setError(null);
        if (ACTIVE_RUN.has(r.run.status)) timer = setTimeout(tick, 2000);
      } catch (err) {
        if (alive) {
          setError(err instanceof ApiError ? err : new ApiError(0, "unexpected", "The run could not be loaded.", "Reload the page."));
          timer = setTimeout(tick, 4000);
        }
      }
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [runId, version]);
  const reload = useCallback(() => {
    setEvents([]);
    setVersion((v) => v + 1);
  }, []);
  return { run, events, error, reload };
}

export async function startSecurity(snapshotId: string) {
  return api<{ run: SecurityRunSummary }>(`/v1/snapshots/${snapshotId}/checks/security`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID() },
    signal: AbortSignal.timeout(20_000),
  });
}

export async function cancelSecurity(runId: string) {
  return api<{ run: SecurityRunSummary }>(`/v1/security-runs/${runId}/cancel`, { method: "POST" });
}

export async function rerunMissingSecurity(runId: string) {
  return api<{ run: SecurityRunSummary; obligations: number }>(`/v1/security-runs/${runId}/rerun`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify({ scope: "missing" }),
    signal: AbortSignal.timeout(20_000),
  });
}

export function useSecurityReviews(runId: string, enabled: boolean) {
  const [reviews, setReviews] = useState<FindingHumanReview[]>([]);
  const [canReview, setCanReview] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    api<{ reviews: FindingHumanReview[]; canReview: boolean }>(`/v1/security-runs/${runId}/reviews`)
      .then((r) => {
        if (!alive) return;
        setReviews(r.reviews);
        setCanReview(r.canReview);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [runId, enabled, version]);
  return { reviews, canReview, refresh: useCallback(() => setVersion((v) => v + 1), []) };
}

export async function reviewSecurityFinding(runId: string, findingId: string, decision: FindingReviewDecision, reason: string | null) {
  return api<{ review: FindingHumanReview }>(`/v1/security-runs/${runId}/findings/${findingId}/reviews`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify({ decision, reason }),
  });
}

export function useSecurityRepairs(runId: string, enabled: boolean) {
  const [repairs, setRepairs] = useState<TestingRepair[]>([]);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const r = await api<{ repairs: TestingRepair[] }>(`/v1/security-runs/${runId}/repairs`);
        if (!alive) return;
        setRepairs(r.repairs);
        if (r.repairs.some((x) => x.status === "running")) timer = setTimeout(tick, 4000);
      } catch {
        // The immutable Security report stays usable if repair metadata cannot load.
      }
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [runId, enabled, version]);
  return { repairs, refresh: useCallback(() => setVersion((v) => v + 1), []) };
}

export async function requestSecurityRepair(runId: string, findingId: string) {
  return api<{ repair: TestingRepair }>(`/v1/security-runs/${runId}/findings/${findingId}/repairs`, { method: "POST" });
}

export async function approveSecurityRepair(runId: string, findingId: string, repairId: string, maxAttempts: number) {
  return api<{ repair: TestingRepair }>(`/v1/security-runs/${runId}/findings/${findingId}/repair-approvals`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify({ repairId, maxAttempts }),
  });
}
