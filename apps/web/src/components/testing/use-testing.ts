"use client";

import { useCallback, useEffect, useState } from "react";
import type { FindingHumanReview, FindingReviewDecision, ReviewedReport, StartTestingInput, TestingProjectStatus, TestingRepair, TestingEvent, TestingPreview, TestingRunDetail, TestingRunSummary } from "@cybercheck/contracts";
import { ApiError, api } from "@/lib/api";

export const ACTIVE_RUN = new Set(["queued", "running"]);

/** Testing runs of one project, refreshed every 3s while one is active. */
export function useTestingRuns(projectId: string | null) {
  const [runs, setRuns] = useState<TestingRunSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!projectId) return;
      try {
        const r = await api<{ runs: TestingRunSummary[] }>(`/v1/projects/${projectId}/testing-runs`);
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

/** Testing state of every project in a workspace; refreshed every 4s while any run is active. */
export function useTestingStatus(workspaceId: string | null) {
  const [status, setStatus] = useState<TestingProjectStatus[] | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!workspaceId) return;
      try {
        const r = await api<{ projects: TestingProjectStatus[] }>(`/v1/workspaces/${workspaceId}/testing-status`);
        if (!alive) return;
        setStatus(r.projects);
        if (r.projects.some((p) => p.active)) timer = setTimeout(tick, 4000);
      } catch {
        // the list is a convenience; the run card still works without it
      }
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [workspaceId, version]);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { status: workspaceId ? status : null, reload };
}

/** One run with its ledger and live events; polls while it runs. */
export function useTestingRun(runId: string) {
  const [run, setRun] = useState<TestingRunDetail | null>(null);
  const [events, setEvents] = useState<TestingEvent[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let after = 0;
    // Every event since the last one seen (the API returns at most 500 per call, so a finished run is read in pages).
    const newEvents = async () => {
      const all: TestingEvent[] = [];
      for (let page = 0; page < 20; page++) {
        const e = await api<{ events: TestingEvent[] }>(`/v1/testing-runs/${runId}/events?after=${after}`);
        all.push(...e.events);
        if (e.events.length) after = e.events.at(-1)!.seq;
        if (e.events.length < 500) break;
      }
      return all;
    };
    const tick = async () => {
      try {
        const [r, e] = await Promise.all([api<{ run: TestingRunDetail }>(`/v1/testing-runs/${runId}`), newEvents()]);
        if (!alive) return;
        setRun(r.run);
        if (e.length) setEvents((prev) => [...prev, ...e]);
        setError(null);
        // Faster while checks are executing, so the live view keeps up with the sandbox (which reports every 2 s).
        if (ACTIVE_RUN.has(r.run.status)) timer = setTimeout(tick, r.run.phase === "executing" ? 1500 : 3000);
      } catch (err) {
        if (alive) setError(err instanceof ApiError ? err : null);
      }
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [runId, version]);

  const cancel = useCallback(async () => {
    await api(`/v1/testing-runs/${runId}/cancel`, { method: "POST" });
    setEvents([]);
    setVersion((v) => v + 1);
  }, [runId]);

  return { run, events, error, cancel };
}

export async function startTesting(snapshotId: string, options: StartTestingInput = {}) {
  return api<{ run: TestingRunSummary }>(`/v1/snapshots/${snapshotId}/checks/testing`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify(options),
  });
}

/** What a run would do and roughly cost (rules only, nothing runs). */
export async function previewTesting(snapshotId: string, options: StartTestingInput = {}) {
  return api<{ preview: TestingPreview }>(`/v1/snapshots/${snapshotId}/checks/testing/preview`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(options),
  });
}

/** Runs only the checks of a finished run that have no decisive verdict; the rest is carried over. */
export async function rerunMissing(runId: string) {
  return api<{ run: TestingRunSummary; obligations: number }>(`/v1/testing-runs/${runId}/rerun`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify({ scope: "missing" }),
  });
}

/** The run after human review (decisions, queues, precision), refreshed after each decision. */
export function useReviewedReport(runId: string, enabled: boolean) {
  const [reviewed, setReviewed] = useState<ReviewedReport | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    api<{ reviewed: ReviewedReport }>(`/v1/testing-runs/${runId}/reviewed-report`)
      .then((r) => alive && setReviewed(r.reviewed))
      .catch((e) => alive && setError(e instanceof ApiError ? e : null));
    return () => {
      alive = false;
    };
  }, [runId, enabled]);
  return { reviewed, setReviewed, error };
}

/** Record a decision on one finding; returns the new review and the updated reviewed report. */
export async function reviewFinding(runId: string, findingId: string, decision: FindingReviewDecision, reason: string | null) {
  return api<{ review: FindingHumanReview; reviewed: ReviewedReport }>(`/v1/testing-runs/${runId}/findings/${findingId}/reviews`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify({ decision, reason }),
  });
}

/** Rerun only the checks behind these findings (for example to gather more evidence on an unsure one). */
export async function targetedRun(runId: string, findingIds: string[]) {
  return api<{ run: TestingRunSummary; obligations: number }>(`/v1/testing-runs/${runId}/targeted-runs`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify({ findingIds }),
  });
}

/** The repairs of a run; refreshed every 4 s while one is running. */
export function useRepairs(runId: string, enabled: boolean) {
  const [repairs, setRepairs] = useState<TestingRepair[]>([]);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const r = await api<{ repairs: TestingRepair[] }>(`/v1/testing-runs/${runId}/repairs`);
        if (!alive) return;
        setRepairs(r.repairs);
        if (r.repairs.some((x) => x.status === "running")) timer = setTimeout(tick, 4000);
      } catch {
        // The report stays usable without repairs.
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

/** Ask for a repair of a confirmed finding: returns its scope and estimate; nothing runs yet. */
export async function requestRepair(runId: string, findingId: string) {
  return api<{ repair: TestingRepair }>(`/v1/testing-runs/${runId}/findings/${findingId}/repairs`, { method: "POST" });
}

/** Explicit approval: the repair runs in fresh sandboxes only. */
export async function approveRepair(runId: string, findingId: string, repairId: string, maxAttempts: number) {
  return api<{ repair: TestingRepair }>(`/v1/testing-runs/${runId}/findings/${findingId}/repair-approvals`, {
    method: "POST",
    headers: { "idempotency-key": crypto.randomUUID(), "content-type": "application/json" },
    body: JSON.stringify({ repairId, maxAttempts }),
  });
}

export async function cancelRepair(repairId: string) {
  return api<{ repair: TestingRepair }>(`/v1/testing-repairs/${repairId}/cancel`, { method: "POST" });
}
