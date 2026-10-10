"use client";

import { useCallback, useEffect, useState } from "react";
import type { UnderstandingRun } from "@cybercheck/contracts";
import { ApiError, api } from "@/lib/api";

/** Loads a snapshot's understanding and polls while the analysis is still running. */
export function useUnderstanding(snapshotId: string | null) {
  const [run, setRun] = useState<UnderstandingRun | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!snapshotId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      api<{ run: UnderstandingRun }>(`/v1/snapshots/${snapshotId}/understanding`)
        .then(({ run }) => {
          if (cancelled) return;
          setRun(run);
          setError(null);
          if (run.status === "queued" || run.status === "analyzing") timer = setTimeout(load, 1500);
          else if (run.dossier?.ai?.status === "running") timer = setTimeout(load, 5000); // AI step still working
        })
        .catch((e) => !cancelled && setError(e instanceof ApiError ? e : null));
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [snapshotId, tick]);

  const rerun = useCallback(async () => {
    if (!snapshotId) return;
    const r = await api<{ run: UnderstandingRun }>(`/v1/snapshots/${snapshotId}/understanding/rerun`, { method: "POST" });
    setRun(r.run);
    setTick((t) => t + 1);
  }, [snapshotId]);

  return { run, error, rerun };
}
