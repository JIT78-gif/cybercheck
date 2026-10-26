"use client";

import type { AiEvaluationRunSummary } from "@cybercheck/contracts";
import { CheckRunsCard } from "@/components/app/run-chrome";

/** Results card on the AI Evaluator tab: the selected project's runs, live while one is running. */
export function AiRunsCard({ projectId, runs, error }: { projectId: string | null; runs: AiEvaluationRunSummary[] | null; error: { message: string; fix?: string } | null }) {
  return <CheckRunsCard check="ai-evaluator" projectId={projectId} runs={runs} error={error} rowMeta={(r) => `${r.counts.passed} of ${r.counts.cases} cases passed · ${r.counts.confirmed} confirmed`} />;
}
