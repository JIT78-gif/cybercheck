"use client";

import { useCallback, useEffect, useState } from "react";
import type { CheckId, TestingRunStatus } from "@cybercheck/contracts";
import { api, ApiError } from "@/lib/api";
import { CHECK_API_SLUG } from "@/lib/checks";

// One generic data layer for "recent runs of a check" and "where every project stands for a check". Every check exposes
// the same shaped endpoints, so the four per-check hooks (use-testing, use-security, ...) can share this instead of each
// reimplementing fetch + poll. Only the fields common to all four *RunSummary are typed here.

export type CheckRunSummary = {
  id: string;
  snapshotId: string;
  projectId: string;
  status: TestingRunStatus;
  step: string | null;
  progress: number | null;
  headline: string | null;
  decision?: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type CheckProjectStatus = { projectId: string; latest: CheckRunSummary | null; active: boolean };

const ACTIVE = new Set<TestingRunStatus>(["queued", "running"]);

/** Recent runs of one check for one project, newest first. Polls while a run is active so a finished run appears. */
export function useProjectCheckRuns(projectId: string | null, check: CheckId) {
  const [runs, setRuns] = useState<CheckRunSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!projectId) return;
      try {
        const out = await api<{ runs: CheckRunSummary[] }>(`/v1/projects/${projectId}/${CHECK_API_SLUG[check]}-runs`);
        if (!alive) return;
        setRuns(out.runs);
        setError(null);
        if (out.runs.some((r) => ACTIVE.has(r.status))) timer = setTimeout(tick, 5000);
      } catch (e) {
        if (alive) setError(e instanceof ApiError ? e : new ApiError(0, "unexpected", "Could not load recent runs.", "Try again."));
      }
    };
    void tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [projectId, check, version]);
  return { runs: projectId ? runs : null, error, reload: useCallback(() => setVersion((v) => v + 1), []) };
}

/** Where every project of the workspace stands for one check, for the cross-project "Open results" grid. */
export function useWorkspaceCheckStatus(workspaceId: string | null, check: CheckId) {
  const [status, setStatus] = useState<CheckProjectStatus[] | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!workspaceId) return;
      try {
        const out = await api<{ projects: CheckProjectStatus[] }>(`/v1/workspaces/${workspaceId}/${CHECK_API_SLUG[check]}-status`);
        if (!alive) return;
        setStatus(out.projects);
        if (out.projects.some((s) => s.active)) timer = setTimeout(tick, 5000);
      } catch {
        if (alive) setStatus([]); // a missing status endpoint must not break the page
      }
    };
    void tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [workspaceId, check, version]);
  return { status: workspaceId ? status : null, reload: useCallback(() => setVersion((v) => v + 1), []) };
}
