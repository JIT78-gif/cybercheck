"use client";

import type { TestingRunSummary } from "@cybercheck/contracts";
import { CheckRunsCard } from "@/components/app/run-chrome";

/** Results card on the Testing tab: the selected project's runs, live while one is running. */
export function TestingRunsCard({ projectId, runs, error }: { projectId: string | null; runs: TestingRunSummary[] | null; error: { message: string; fix?: string } | null }) {
  return <CheckRunsCard check="testing" projectId={projectId} runs={runs} error={error} rowMeta={(r) => (r.counts.confirmedDefects > 0 ? `${r.counts.confirmedDefects} problem${r.counts.confirmedDefects === 1 ? "" : "s"}` : "No problems found")} />;
}
