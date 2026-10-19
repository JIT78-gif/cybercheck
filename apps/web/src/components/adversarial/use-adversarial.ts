"use client";

import { useCallback, useEffect, useState } from "react";
import type { AdversarialEvent, AdversarialPolicyInput, AdversarialRunDetail, AdversarialRunSummary, RerunAdversarialInput } from "@cybercheck/contracts";
import { ApiError, api } from "@/lib/api";
import { ACTIVE_RUN } from "@/components/testing/use-testing";

export function useAdversarialRuns(projectId: string | null) {
  const [runs, setRuns] = useState<AdversarialRunSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!projectId) return;
      try {
        const out = await api<{ runs: AdversarialRunSummary[] }>(`/v1/projects/${projectId}/adversarial-runs`);
        if (!alive) return;
        setRuns(out.runs);
        setError(null);
        if (out.runs.some((r) => ACTIVE_RUN.has(r.status))) timer = setTimeout(tick, 3000);
      } catch (e) {
        if (alive) setError(e instanceof ApiError ? e : null);
      }
    };
    void tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [projectId, version]);
  return { runs: projectId ? runs : null, error, reload: useCallback(() => setVersion((v) => v + 1), []) };
}

export function useAdversarialRun(runId: string) {
  const [run, setRun] = useState<AdversarialRunDetail | null>(null);
  const [events, setEvents] = useState<AdversarialEvent[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let after = 0;
    const tick = async () => {
      try {
        const [detail, activity] = await Promise.all([
          api<{ run: AdversarialRunDetail }>(`/v1/adversarial-runs/${runId}`),
          api<{ events: AdversarialEvent[] }>(`/v1/adversarial-runs/${runId}/events?after=${after}`),
        ]);
        if (!alive) return;
        setRun(detail.run);
        if (activity.events.length) {
          after = activity.events.at(-1)!.seq;
          setEvents((old) => [...old, ...activity.events]);
        }
        setError(null);
        if (ACTIVE_RUN.has(detail.run.status)) timer = setTimeout(tick, 2000);
      } catch (e) {
        if (alive) setError(e instanceof ApiError ? e : new ApiError(0, "unexpected", "The run could not be loaded.", "Reload the page."));
      }
    };
    void tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [runId, version]);
  return { run, events, error, reload: useCallback(() => { setEvents([]); setVersion((v) => v + 1); }, []) };
}

export type AdversarialStartOptions = Pick<AdversarialPolicyInput, "profile" | "aiAttacker" | "aiCritic" | "runtime" | "targetComponentId">;

export function startAdversarial(snapshotId: string, options: AdversarialStartOptions) {
  return api<{ run: AdversarialRunSummary }>(`/v1/snapshots/${snapshotId}/checks/adversarial`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, json: options });
}

export function cancelAdversarial(runId: string) {
  return api<{ run: AdversarialRunSummary }>(`/v1/adversarial-runs/${runId}/cancel`, { method: "POST" });
}

export function rerunAdversarial(runId: string, scope: RerunAdversarialInput["scope"], campaignIds: string[] = []) {
  return api<{ run: AdversarialRunSummary }>(`/v1/adversarial-runs/${runId}/rerun`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, json: { scope, campaignIds } });
}
