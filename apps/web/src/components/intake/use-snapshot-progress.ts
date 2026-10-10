"use client";

import { useEffect, useState } from "react";
import type { IntakeEvent, SnapshotSummary } from "@cybercheck/contracts";
import { api } from "@/lib/api";

const TERMINAL = new Set(["baselined", "rejected", "failed"]);

/**
 * Follows a snapshot's intake: live events over SSE, falling back to polling if the
 * stream drops. Resolves the final snapshot once a terminal event arrives.
 */
export function useSnapshotProgress(snapshotId: string | null) {
  const [events, setEvents] = useState<IntakeEvent[]>([]);
  const [snapshot, setSnapshot] = useState<SnapshotSummary | null>(null);

  useEffect(() => {
    if (!snapshotId) return;
    let cancelled = false;
    let source: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;

    const finish = async () => {
      const r = await api<{ snapshot: SnapshotSummary; events: IntakeEvent[] }>(`/v1/snapshots/${snapshotId}`);
      if (!cancelled) {
        setEvents(r.events);
        setSnapshot(r.snapshot);
      }
    };

    const startPolling = () => {
      if (poll) return;
      poll = setInterval(async () => {
        try {
          const r = await api<{ snapshot: SnapshotSummary; events: IntakeEvent[] }>(`/v1/snapshots/${snapshotId}`);
          if (cancelled) return;
          setEvents(r.events);
          if (!["RECEIVED", "VALIDATING"].includes(r.snapshot.status)) {
            setSnapshot(r.snapshot);
            if (poll) clearInterval(poll);
          }
        } catch {
          // keep polling; transient errors are expected while servers restart
        }
      }, 1000);
    };

    source = new EventSource(`/v1/snapshots/${snapshotId}/events`);
    source.addEventListener("intake", (msg) => {
      const e = JSON.parse((msg as MessageEvent<string>).data) as IntakeEvent;
      setEvents((list) => (list.some((x) => x.seq === e.seq) ? list : [...list, e].sort((a, b) => a.seq - b.seq)));
      if (TERMINAL.has(e.type)) {
        source?.close();
        void finish();
      }
    });
    source.onerror = () => {
      source?.close();
      if (!cancelled) startPolling();
    };

    return () => {
      cancelled = true;
      source?.close();
      if (poll) clearInterval(poll);
    };
  }, [snapshotId]);

  return { events, snapshot };
}
