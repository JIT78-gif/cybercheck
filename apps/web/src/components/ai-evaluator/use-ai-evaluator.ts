"use client";

import { useCallback, useEffect, useState } from "react";
import type { AiDatasetSummary, AiDatasetValidationIssue, AiEvaluationEvent, AiEvaluationPolicyInput, AiEvaluationRunDetail, AiEvaluationRunSummary } from "@cybercheck/contracts";
import { ApiError, api } from "@/lib/api";
import { ACTIVE_RUN } from "@/components/testing/use-testing";

/** AI Evaluator runs of one project, refreshed every 3s while one is active. */
export function useAiRuns(projectId: string | null) {
  const [runs, setRuns] = useState<AiEvaluationRunSummary[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!projectId) return;
      try {
        const r = await api<{ runs: AiEvaluationRunSummary[] }>(`/v1/projects/${projectId}/ai-evaluation-runs`);
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

/** One AI Evaluator run with its cases and events; polls every 2s while it runs. */
export function useAiRun(runId: string) {
  const [run, setRun] = useState<AiEvaluationRunDetail | null>(null);
  const [events, setEvents] = useState<AiEvaluationEvent[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let after = 0;
    const tick = async () => {
      try {
        const [r, e] = await Promise.all([api<{ run: AiEvaluationRunDetail }>(`/v1/ai-evaluation-runs/${runId}`), api<{ events: AiEvaluationEvent[] }>(`/v1/ai-evaluation-runs/${runId}/events?after=${after}`)]);
        if (!alive) return;
        setRun(r.run);
        if (e.events.length) {
          after = e.events.at(-1)!.seq;
          setEvents((prev) => [...prev, ...e.events]);
        }
        setError(null);
        if (ACTIVE_RUN.has(r.run.status)) timer = setTimeout(tick, 2000);
      } catch (err) {
        if (alive) setError(err instanceof ApiError ? err : new ApiError(0, "unexpected", "The run could not be loaded.", "Reload the page."));
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

/** Uploaded datasets of one project. */
export function useAiDatasets(projectId: string | null) {
  const [datasets, setDatasets] = useState<AiDatasetSummary[] | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    if (!projectId) return;
    api<{ datasets: AiDatasetSummary[] }>(`/v1/projects/${projectId}/ai-evaluation-datasets`)
      .then((r) => alive && setDatasets(r.datasets))
      .catch(() => alive && setDatasets([]));
    return () => {
      alive = false;
    };
  }, [projectId, version]);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { datasets: projectId ? datasets : null, reload };
}

export type StartOptions = Pick<AiEvaluationPolicyInput, "profile" | "datasetIds" | "target" | "judge" | "modelMode" | "runtime" | "baselineRunId">;

export async function startAiEvaluation(snapshotId: string, options: StartOptions) {
  return api<{ run: AiEvaluationRunSummary }>(`/v1/snapshots/${snapshotId}/checks/ai-evaluator`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, json: { profile: options.profile, datasetIds: options.datasetIds, judge: options.judge ?? "auto", modelMode: options.modelMode ?? "auto", runtime: options.runtime ?? "auto", ...(options.baselineRunId ? { baselineRunId: options.baselineRunId } : {}), ...(options.target ? { target: options.target } : {}) } });
}

export async function cancelAiEvaluation(runId: string) {
  return api<{ run: AiEvaluationRunSummary }>(`/v1/ai-evaluation-runs/${runId}/cancel`, { method: "POST" });
}

export async function rerunAiEvaluation(runId: string, scope: "missing" | "cases", caseIds?: string[]) {
  return api<{ run: AiEvaluationRunSummary }>(`/v1/ai-evaluation-runs/${runId}/rerun`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, json: { scope, ...(caseIds ? { caseIds } : {}) } });
}

/** Upload a JSONL dataset. A rejected file throws an ApiError whose `issues` list each line's problem. */
export async function uploadAiDataset(projectId: string, name: string, content: string): Promise<{ dataset: AiDatasetSummary } | { issues: AiDatasetValidationIssue[]; message: string }> {
  const res = await fetch(`/v1/projects/${projectId}/ai-evaluation-datasets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, content }), cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (res.ok) return body as { dataset: AiDatasetSummary };
  return { issues: (body?.issues ?? []) as AiDatasetValidationIssue[], message: body?.message ?? body?.error?.message ?? "The dataset was not accepted." };
}
