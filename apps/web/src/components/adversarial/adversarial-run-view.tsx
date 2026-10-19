"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, CircleCheck, CircleDashed, CircleX, Download, RotateCcw, ShieldQuestion, Swords } from "lucide-react";
import type { AdversarialCampaign, AdversarialDecision, AdversarialFinding, AdversarialLane, AdversarialRunDetail, AttackChain } from "@cybercheck/contracts";
import { Card, CardTitle, EmptyState } from "@/components/app/ui";
import { Badge, Mono } from "@/components/architecture/parts";
import { CodeViewerProvider, EvidenceLink } from "@/components/architecture/code-viewer";
import { Tabs, TabPanel, useViewParams, type TabItem } from "@/components/testing/run-tabs";
import { duration, RunStatusBadge, SEVERITY_TONE } from "@/components/testing/run-parts";
import { ACTIVE_RUN } from "@/components/testing/use-testing";
import { Button, buttonVariants } from "@/components/ui/button";
import { Alert, Spinner } from "@/components/ui/form";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { cancelAdversarial, rerunAdversarial, useAdversarialRun } from "./use-adversarial";

type Tone = "good" | "bad" | "warn" | "muted" | "info";
type Tab = "summary" | "findings" | "campaigns" | "chains" | "surface" | "audit";

const DECISION: Record<AdversarialDecision, { label: string; tone: Tone }> = {
  not_applicable: { label: "Not applicable", tone: "muted" },
  ready_with_evidence: { label: "Ready, with adversarial evidence", tone: "good" },
  not_ready_adversarial_findings: { label: "Not ready: attack succeeded", tone: "bad" },
  not_ready_insufficient_evidence: { label: "Not ready: insufficient evidence", tone: "warn" },
  not_ready_environment_blocked: { label: "Not ready: runtime blocked", tone: "warn" },
};
const CAMPAIGN: Record<AdversarialCampaign["status"], { label: string; tone: Tone; icon: typeof CircleCheck }> = {
  planned: { label: "Planned", tone: "muted", icon: CircleDashed }, running: { label: "Running", tone: "info", icon: CircleDashed }, passed: { label: "Held", tone: "good", icon: CircleCheck }, failed: { label: "Crossed", tone: "bad", icon: CircleX }, inconclusive: { label: "Inconclusive", tone: "warn", icon: ShieldQuestion }, blocked: { label: "Blocked", tone: "muted", icon: CircleDashed },
};
const LANE: Record<AdversarialLane, string> = { prompt: "Prompt control", leakage: "Leakage", rag_memory: "RAG and memory", tools_approval: "Tools and approval", identity_tenant: "Identity and tenant", mcp_agent: "MCP and agents", output_handling: "Output handling", resource_concurrency: "Resources", multi_stage: "Multi-stage" };
const PHASES = ["admission", "readiness", "surface_mapping", "planning", "compiling", "preparing", "fixtures", "campaigning", "browser_campaigning", "critic", "validating", "reporting"];

export function AdversarialRunView({ projectId, runId }: { projectId: string; runId: string }) {
  const { run, events, error, reload } = useAdversarialRun(runId);
  const router = useRouter();
  const view = useViewParams();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  if (error && !run) return <Alert>{error.message} {error.fix}</Alert>;
  if (!run) return <p className="flex items-center gap-2 py-10 text-fg-muted"><Spinner /> Loading run</p>;
  const active = ACTIVE_RUN.has(run.status);
  const tab = (view.get("tab") as Tab | null) ?? "summary";
  const undecided = run.campaigns.filter((c) => c.status === "blocked" || c.status === "inconclusive");
  const confirmed = run.findings.filter((f) => f.status === "confirmed");
  const tabs: TabItem<Tab>[] = [
    { id: "summary", label: "Decision summary" }, { id: "findings", label: "Findings", count: run.findings.length, tone: confirmed.length ? "bad" : "muted" }, { id: "campaigns", label: "Campaign explorer", count: run.campaigns.length }, { id: "chains", label: "Attack chains", count: run.chains.length }, { id: "surface", label: "Attack surface" }, { id: "audit", label: "Untested and audit", count: (run.report?.untested.length ?? 0) + undecided.length },
  ];
  const act = async (fn: () => Promise<{ run: { id: string } }>, navigate: boolean) => {
    setBusy(true); setActionError(null);
    try { const out = await fn(); if (navigate) router.push(`/app/projects/${projectId}/adversarial/${out.run.id}`); else reload(); }
    catch (e) { setActionError(e instanceof ApiError ? `${e.message} ${e.fix ?? ""}` : "The action did not complete."); }
    finally { setBusy(false); }
  };
  return <CodeViewerProvider snapshotId={run.snapshotId}><div className="space-y-6">
    <Link href={`/app/checks/adversarial?project=${projectId}`} className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-accent hover:underline"><ArrowLeft className="size-4" aria-hidden="true" /> AI Adversarial</Link>
    <div className="flex flex-wrap items-center gap-3"><h1 className="text-2xl font-semibold text-fg">AI Adversarial check</h1><RunStatusBadge status={run.status} /><span className="text-sm text-fg-muted">{duration(run.startedAt, run.finishedAt) ?? ""}</span>{run.parentRunId && <Link href={`/app/projects/${projectId}/adversarial/${run.parentRunId}`} className="text-sm text-accent hover:underline">Rerun of an earlier run</Link>}<div className="ml-auto flex flex-wrap gap-2">{active && <Button variant="outline" shape="pill" size="sm" disabled={busy} onClick={() => void act(() => cancelAdversarial(run.id), false)}>Cancel</Button>}{!active && undecided.length > 0 && <Button variant="outline" shape="pill" size="sm" disabled={busy} onClick={() => void act(() => rerunAdversarial(run.id, "campaigns", undecided.map((c) => c.id)), true)}><RotateCcw aria-hidden="true" /> Rerun undecided</Button>}{!active && run.report && <><a href={`/v1/adversarial-runs/${run.id}/export?format=md`} download className={buttonVariants({ variant: "outline", shape: "pill", size: "sm" })}><Download aria-hidden="true" /> Markdown</a><a href={`/v1/adversarial-runs/${run.id}/export?format=json`} download className={buttonVariants({ variant: "outline", shape: "pill", size: "sm" })}><Download aria-hidden="true" /> JSON</a></>}</div></div>
    {actionError && <Alert>{actionError}</Alert>}
    {active ? <Live run={run} events={events} /> : !run.report ? <Alert>{run.error ?? "This run has no report."}</Alert> : <><Tabs items={tabs} value={tab} onChange={(id) => view.set({ tab: id === "summary" ? null : id })} label="AI Adversarial results" idPrefix="adv" /><TabPanel idPrefix="adv" value={tab}>{tab === "summary" && <Summary run={run} />}{tab === "findings" && <Findings findings={run.findings} />}{tab === "campaigns" && <Campaigns campaigns={run.campaigns} />}{tab === "chains" && <Chains chains={run.chains} />}{tab === "surface" && <Surface run={run} />}{tab === "audit" && <Audit run={run} />}</TabPanel></>}
  </div></CodeViewerProvider>;
}

function Live({ run, events }: { run: AdversarialRunDetail; events: Array<{ seq: number; type: string; message: string }> }) {
  const at = PHASES.indexOf(run.phase);
  return <Card><CardTitle>In progress</CardTitle><ol className="mt-4 flex flex-wrap gap-2" aria-label="Phases">{PHASES.map((p, i) => <li key={p} aria-current={i === at ? "step" : undefined} className={cn("rounded-full px-3 py-1 text-xs font-medium", i < at ? "bg-success/10 text-success" : i === at ? "bg-accent/10 text-accent" : "bg-surface-2 text-fg-muted")}>{p.replaceAll("_", " ")}</li>)}</ol><ul className="mt-5 space-y-2 text-sm" role="log" aria-live="polite">{events.filter((e) => !e.type.startsWith("phase:")).slice(-12).map((e) => <li key={e.seq}>{e.message}</li>)}{!events.length && <li className="flex items-center gap-2 text-fg-muted"><Spinner /> Starting</li>}</ul></Card>;
}

function Summary({ run }: { run: AdversarialRunDetail }) {
  const r = run.report!; const d = DECISION[r.decision];
  return <div className="space-y-6"><Card className={cn(d.tone === "good" ? "border-success/40" : d.tone === "bad" ? "border-danger/40" : d.tone === "warn" ? "border-warning/40" : "")}><Badge tone={d.tone}>{d.label}</Badge><p className="mt-3 text-base text-fg">{r.headline}</p><ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-fg-muted">{r.claims.map((x) => <li key={x}>{x}</li>)}</ul></Card><div className="grid gap-6 md:grid-cols-3"><Metric label="Decisive campaigns" value={`${r.coverage.decisive} of ${r.coverage.applicable}`} note="Blocked and inconclusive attempts remain in the denominator." /><Metric label="Confirmed findings" value={String(r.findings.confirmed)} note={`${r.findings.confirmedCriticalHigh} critical or high`} /><Metric label="Critical obligations" value={`${r.obligationCoverage.criticalDecisive} of ${r.obligationCoverage.criticalRequired}`} note="Every required critical lane must be decisive." /></div><Card><CardTitle>Coverage by lane</CardTitle><ul className="mt-3 divide-y divide-border">{r.obligations.map((o) => <li key={o.lane} className="flex flex-wrap items-center gap-3 py-3"><span className="min-w-48 font-medium text-fg">{LANE[o.lane]}</span><Badge tone={o.status === "passed" ? "good" : o.status === "failed" ? "bad" : o.status === "inconclusive" || o.status === "blocked" ? "warn" : "muted"}>{o.status.replaceAll("_", " ")}</Badge><span className="text-sm text-fg-muted">{o.decided}/{o.campaigns} decisive — {o.reason}</span></li>)}</ul></Card><Card><CardTitle>Execution policy</CardTitle><p className="mt-3 text-sm text-fg">{r.environment.isolation}</p><p className="mt-2 text-sm text-fg-muted">Runtime: {r.environment.selected}; attacker: {r.attacker.status}; critic: {r.critic.status}. {r.critic.reason}</p></Card></div>;
}
function Metric({ label, value, note }: { label: string; value: string; note: string }) { return <Card><CardTitle>{label}</CardTitle><p className="mt-3 text-3xl font-semibold text-fg tabular-nums">{value}</p><p className="mt-1 text-sm text-fg-muted">{note}</p></Card>; }

function Findings({ findings }: { findings: AdversarialFinding[] }) {
  if (!findings.length) return <EmptyState icon={CircleCheck} title="No active findings" body="Executed campaigns either held or no hypothesis was promoted into a finding." />;
  return <div className="space-y-4">{findings.map((f) => <Card key={f.id}><div className="flex flex-wrap items-center gap-2"><Badge tone={SEVERITY_TONE[f.severity]}>{f.severity}</Badge><Badge tone={f.status === "confirmed" ? "bad" : f.status === "suspected" ? "warn" : "muted"}>{f.status}</Badge><Mono>{f.id}</Mono><span className="ml-auto text-xs text-fg-muted">{LANE[f.lane]}</span></div><h2 className="mt-3 text-lg font-semibold text-fg">{f.title}</h2><p className="mt-2 text-sm text-fg">{f.impact}</p><dl className="mt-4 grid gap-3 sm:grid-cols-2"><Fact label="Expected" value={f.expected} /><Fact label="Observed" value={f.observed} /><Fact label="Boundary" value={f.boundaryCrossed} /><Fact label="Asset" value={f.assetReached} /></dl><p className="mt-4 text-sm"><span className="font-medium">Fix:</span> {f.remediation}</p>{f.sourceEvidence.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{f.sourceEvidence.map((e, i) => <EvidenceLink key={`${e.path}:${e.line}:${i}`} evidence={e} />)}</div>}</Card>)}</div>;
}
function Campaigns({ campaigns }: { campaigns: AdversarialCampaign[] }) {
  if (!campaigns.length) return <EmptyState icon={Swords} title="No campaigns ran" body="Open Untested and audit to see why the catalogue could not execute." />;
  return <div className="space-y-3">{campaigns.map((c) => { const s = CAMPAIGN[c.status]; const Icon = s.icon; return <details key={c.id} className="rounded-xl border border-border bg-surface px-4 py-3"><summary className="flex cursor-pointer list-none flex-wrap items-center gap-2"><Icon className="size-4" aria-hidden="true" /><span className="font-medium text-fg">{c.title}</span><Badge tone={s.tone}>{s.label}</Badge><span className="ml-auto text-xs text-fg-muted">{LANE[c.lane]} · {c.attacker}</span></summary><p className="mt-3 text-sm text-fg-muted">{c.reason}</p><p className="mt-2 text-xs text-fg-muted"><Mono>{c.target.endpoint}</Mono> · reset: {c.resetStrategy} · {c.executionIds.length} execution(s)</p><ol className="mt-3 space-y-2">{c.steps.map((x) => <li key={x.seq} className="rounded-lg bg-surface-2 p-3 text-sm"><span className="font-medium">{x.seq}. {x.operation}</span> as {x.asIdentity ?? "anonymous"} → <Mono>{x.target}</Mono><p className="mt-1 text-fg-muted">{x.observed}</p></li>)}</ol></details>; })}</div>;
}
function Chains({ chains }: { chains: AttackChain[] }) {
  if (!chains.length) return <EmptyState icon={Swords} title="No multi-stage chain was applicable" body="The target needs compatible boundaries and evidence before a chain can be assembled." />;
  return <div className="space-y-4">{chains.map((c) => <Card key={c.id}><div className="flex items-center gap-2"><Badge tone={c.verdict === "confirmed" ? "bad" : c.verdict === "rejected" ? "good" : "warn"}>{c.verdict}</Badge><h2 className="font-semibold text-fg">{c.title}</h2></div><p className="mt-2 text-sm text-fg-muted">{c.reason}</p><ol className="mt-4 space-y-2">{c.links.map((l, i) => <li key={`${l.label}:${i}`} className="flex items-start gap-2 text-sm"><span className={l.crossed ? "text-danger" : "text-fg-muted"}>{l.crossed ? "Crossed" : "Not proven"}</span><span>{l.label}</span>{l.evidence[0] && <EvidenceLink evidence={l.evidence[0]} />}</li>)}</ol></Card>)}</div>;
}
function Surface({ run }: { run: AdversarialRunDetail }) { const r = run.report!; return <div className="space-y-6"><Card><CardTitle>Rules of engagement</CardTitle><dl className="mt-4 grid gap-3 sm:grid-cols-2"><Fact label="Endpoints" value={r.rulesOfEngagement.allowedEndpoints.join(", ") || "None"} /><Fact label="Synthetic identities" value={r.rulesOfEngagement.allowedIdentities.join(", ") || "None"} /><Fact label="Tools" value={r.rulesOfEngagement.allowedTools.join(", ") || "None"} /><Fact label="Network" value={r.rulesOfEngagement.externalNetwork ? "External network enabled" : "External network disabled"} /></dl></Card><Card><CardTitle>Evidence-backed attack surface</CardTitle><p className="mt-2 text-sm text-fg-muted">{r.surface.nodes.length} nodes and {r.surface.edges.length} edges.</p><ul className="mt-3 space-y-2">{r.surface.edges.map((e, i) => <li key={`${e.from}:${e.to}:${i}`} className="rounded-lg bg-surface-2 p-3 text-sm"><span className="font-medium">{e.from} → {e.to}</span><span className="ml-2 text-fg-muted">{e.label}</span>{e.evidence[0] && <div className="mt-1"><EvidenceLink evidence={e.evidence[0]} /></div>}</li>)}</ul></Card></div>; }
function Audit({ run }: { run: AdversarialRunDetail }) { const r = run.report!; return <div className="space-y-6"><Card><CardTitle>Evidence and redaction audit</CardTitle><ul className="mt-3 space-y-2">{r.audit.map((a) => <li key={a.check} className="flex items-start gap-2 text-sm"><Badge tone={a.ok ? "good" : "bad"}>{a.ok ? "Pass" : "Fail"}</Badge><span><span className="font-medium text-fg">{a.check}</span><span className="block text-fg-muted">{a.detail}</span></span></li>)}</ul></Card><Card><CardTitle>Untested and blocked checks</CardTitle>{r.untested.length ? <ul className="mt-3 space-y-2">{r.untested.map((u, i) => <li key={`${u.what}:${i}`} className="rounded-lg bg-surface-2 p-3 text-sm"><span className="font-medium text-fg">{u.what}</span><span className="mt-1 block text-fg-muted">{u.reason}</span></li>)}</ul> : <p className="mt-3 text-sm text-fg-muted">No compiler rejection or blocked lane was recorded.</p>}</Card>{r.limitations.length > 0 && <Card><CardTitle>Limitations</CardTitle><ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-fg-muted">{r.limitations.map((x, i) => <li key={`${x}:${i}`}>{x}</li>)}</ul></Card>}</div>; }
function Fact({ label, value }: { label: string; value: string }) { return <div className="rounded-lg bg-surface-2 p-3"><dt className="text-xs text-fg-muted">{label}</dt><dd className="mt-1 text-sm text-fg">{value}</dd></div>; }
