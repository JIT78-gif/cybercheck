"use client";

import Link from "next/link";
import { ArrowRight, Swords } from "lucide-react";
import type { AdversarialRunSummary } from "@cybercheck/contracts";
import { Card, CardTitle, EmptyState } from "@/components/app/ui";
import { RunStatusBadge } from "@/components/testing/run-parts";
import { ACTIVE_RUN } from "@/components/testing/use-testing";
import { Alert, Spinner } from "@/components/ui/form";
import { timeAgo } from "@/lib/format";

export function AdversarialRunsCard({ projectId, runs, error }: { projectId: string | null; runs: AdversarialRunSummary[] | null; error: { message: string; fix?: string } | null }) {
  return <Card><CardTitle>Results</CardTitle>
    {error ? <Alert className="mt-4">{error.message} {error.fix}</Alert> : !projectId ? <EmptyState icon={Swords} title="No project selected" body="Choose a project to see its AI Adversarial runs." /> : runs === null ? <p className="mt-4 flex items-center gap-2 text-sm text-fg-muted"><Spinner /> Loading runs</p> : !runs.length ? <EmptyState icon={Swords} title="No AI Adversarial runs yet" body="Each run records attack campaigns, evidence-backed chains, findings, and blocked checks." /> :
      <ul className="mt-4 divide-y divide-border">{runs.map((r) => <li key={r.id} className="py-3"><Link href={`/app/projects/${projectId}/adversarial/${r.id}`} className="group block rounded-lg outline-offset-4"><div className="flex flex-wrap items-center gap-2"><RunStatusBadge status={r.status} /><span className="text-xs text-fg-muted">{timeAgo(r.createdAt)}</span>{r.counts.campaigns > 0 && <span className="text-xs text-fg-muted">{r.counts.decisive} of {r.counts.campaigns} decisive</span>}{r.counts.confirmed > 0 && <span className="text-xs font-medium text-danger">{r.counts.confirmed} confirmed</span>}<ArrowRight className="ml-auto size-4 text-fg-muted transition-transform group-hover:translate-x-0.5" aria-hidden="true" /></div>{ACTIVE_RUN.has(r.status) ? <p className="mt-2 text-sm text-fg">{r.step ?? "Running"}</p> : <p className="mt-1.5 text-sm text-fg">{r.headline ?? r.error ?? "No summary"}</p>}</Link></li>)}</ul>}
  </Card>;
}
