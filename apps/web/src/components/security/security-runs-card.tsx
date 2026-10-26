"use client";

import type { SecurityRunSummary } from "@cybercheck/contracts";
import { CheckRunsCard } from "@/components/app/run-chrome";

/** Results card on the Security tab: the selected project's runs, live while one is running. */
export function SecurityRunsCard({ projectId, runs, error }: { projectId: string | null; runs: SecurityRunSummary[] | null; error: { message: string; fix?: string } | null }) {
  return <CheckRunsCard check="security" projectId={projectId} runs={runs} error={error} rowMeta={(r) => `${r.counts.confirmed} confirmed · ${r.counts.suspected} suspected`} />;
}
