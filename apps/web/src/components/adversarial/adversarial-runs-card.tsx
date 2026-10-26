"use client";

import type { AdversarialRunSummary } from "@cybercheck/contracts";
import { CheckRunsCard } from "@/components/app/run-chrome";

/** Results card on the AI Adversarial tab: the selected project's runs, live while one is running. */
export function AdversarialRunsCard({ projectId, runs, error }: { projectId: string | null; runs: AdversarialRunSummary[] | null; error: { message: string; fix?: string } | null }) {
  return <CheckRunsCard check="adversarial" projectId={projectId} runs={runs} error={error} rowMeta={(r) => `${r.counts.decisive} of ${r.counts.campaigns} decisive · ${r.counts.confirmed} confirmed`} />;
}
