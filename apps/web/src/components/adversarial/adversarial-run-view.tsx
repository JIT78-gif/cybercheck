"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleCheck, CircleDashed, RotateCcw, ShieldAlert, ShieldQuestion, TriangleAlert } from "lucide-react";
import type { AdversarialCampaign, AdversarialFinding, AdversarialRunDetail, AttackChain, FindingHumanReview, TestingRepair } from "@cybercheck/contracts";
import { Card, CardTitle } from "@/components/app/ui";
import { RunHeader, LivePhases } from "@/components/app/run-chrome";
import { FindingReviewRepair } from "@/components/app/finding-review-repair";
import { latestReviewOf, repairOf, useCheckRepairs, useCheckReviews } from "@/components/app/use-check-repairs";
import { Badge, Mono } from "@/components/architecture/parts";
import { CodeViewerProvider, EvidenceLink } from "@/components/architecture/code-viewer";
import { ACTIVE_RUN } from "@/components/testing/use-testing";
import { Button } from "@/components/ui/button";
import { Alert, Spinner } from "@/components/ui/form";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { cancelAdversarial, rerunAdversarial, useAdversarialRun } from "./use-adversarial";
import { attackMeta, blockedGroups, CATEGORY, CATEGORY_ORDER, counters as countersOf, DECISION, nextSteps, PRIORITY_ORDER, redactText, STATUS, type Tone } from "./presentation";

const PHASES = ["admission", "readiness", "surface_mapping", "planning", "compiling", "preparing", "fixtures", "campaigning", "browser_campaigning", "critic", "validating", "reporting"];
const toneClass: Record<Tone, string> = { good: "text-success", bad: "text-danger", warn: "text-warning", muted: "text-fg-muted", info: "text-accent" };
const borderFor = (tone: Tone) => (tone === "good" ? "border-success/40" : tone === "bad" ? "border-danger/50" : tone === "warn" ? "border-warning/40" : "");
const StatusIcon = ({ status, className }: { status: AdversarialCampaign["status"]; className?: string }) => {
  const Icon = status === "failed" ? ShieldAlert : status === "passed" ? CircleCheck : status === "inconclusive" ? ShieldQuestion : status === "blocked" ? TriangleAlert : CircleDashed;
  return <Icon className={cn("size-4 shrink-0", className)} aria-hidden="true" />;
};

export function AdversarialRunView({ projectId, runId }: { projectId: string; runId: string }) {
  const { run, events, error, reload } = useAdversarialRun(runId);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Human review + sandbox repair load once the run has finished with a report (hooks run before any early return).
  const finished = Boolean(run && !ACTIVE_RUN.has(run.status) && run.report);
  const reviewState = useCheckReviews("adversarial-runs", runId, finished);
  const repairState = useCheckRepairs("adversarial-runs", runId, finished);
  const review: ReviewCtx = { runId, projectId, reviews: reviewState.reviews, repairs: repairState.repairs, canReview: reviewState.canReview, onChange: () => { reviewState.refresh(); repairState.refresh(); } };
  if (error && !run) return <Alert>{error.message} {error.fix}</Alert>;
  if (!run) return <p className="flex items-center gap-2 py-10 text-fg-muted"><Spinner /> Loading results</p>;
  const active = ACTIVE_RUN.has(run.status);
  const executed = (run.report?.coverage.applicable ?? 0) > 0 || run.campaigns.some((c) => STATUS[c.status].ran);
  const undecided = run.campaigns.filter((c) => c.status === "blocked" || c.status === "inconclusive");
  const setupBroken = Boolean(run.report?.setup.some((s) => !s.ok));
  const rerunnable = setupBroken ? undecided.filter((c) => c.status === "inconclusive") : undecided;

  const act = async (fn: () => Promise<{ run: { id: string } }>, navigate: boolean) => {
    setBusy(true); setActionError(null);
    try { const out = await fn(); if (navigate) router.push(`/app/projects/${projectId}/adversarial/${out.run.id}`); else reload(); }
    catch (e) { setActionError(e instanceof ApiError ? `${e.message} ${e.fix ?? ""}` : "The action did not complete."); }
    finally { setBusy(false); }
  };

  const actions = <>
    {active && <Button variant="outline" shape="pill" size="sm" disabled={busy} onClick={() => void act(() => cancelAdversarial(run.id), false)}>Cancel</Button>}
    {!active && rerunnable.length > 0 && <Button variant="outline" shape="pill" size="sm" disabled={busy} onClick={() => void act(() => rerunAdversarial(run.id, "campaigns", rerunnable.map((c) => c.id)), true)}><RotateCcw aria-hidden="true" /> Rerun attacks that could not be tested</Button>}
  </>;
  return <CodeViewerProvider snapshotId={run.snapshotId}><div className="space-y-8">
    <RunHeader check="adversarial" projectId={projectId} status={run.status} startedAt={run.startedAt} finishedAt={run.finishedAt} parentRunId={run.parentRunId} showDuration={active || executed} exportBase={run.report ? `/v1/adversarial-runs/${run.id}/export` : null} actions={actions} />
    {actionError && <Alert>{actionError}</Alert>}
    {active ? <LivePhases title="Attacking in progress" phases={PHASES} currentPhase={run.phase} events={events} /> : !run.report ? <Alert>{run.error ?? "This run produced no results."}</Alert> : <Results run={run} projectId={projectId} review={review} />}
  </div></CodeViewerProvider>;
}

type ReviewCtx = { runId: string; projectId: string; reviews: FindingHumanReview[]; repairs: TestingRepair[]; canReview: boolean; onChange: () => void };

function Results({ run, projectId, review }: { run: AdversarialRunDetail; projectId: string; review: ReviewCtx }) {
  const r = run.report!;
  const c = countersOf(run.campaigns, r.accounting);
  const d = DECISION[r.decision];
  const steps = nextSteps(run.findings, run.campaigns, r.setup);
  const groups = blockedGroups(run.campaigns, r.setup);
  const topVuln = run.findings.find((f) => f.status === "confirmed" && (f.severity === "critical" || f.severity === "high")) ?? run.findings.find((f) => f.status === "confirmed");
  const why = r.decision === "not_ready_adversarial_findings" && topVuln ? ` This project is not ready for release because ${attackMeta({ techniqueId: topVuln.rootCause, lane: topVuln.lane, title: topVuln.title }).explanation.toLowerCase()}`
    : r.decision === "ready_with_evidence" ? " Every attack that ran was resisted, so no weakness was confirmed in this test."
    : r.decision === "not_ready_insufficient_evidence" ? " Too few attacks could be completed to judge this project, so more setup or a rerun is needed."
    : r.decision === "not_ready_environment_blocked" ? " The test environment was not available, so no attack was sent."
    : r.decision === "not_applicable" ? " There was nothing in this project for the attacker to test." : "";
  const summary = c.executed > 0
    ? `Cybercheck planned ${c.planned} attack${c.planned === 1 ? "" : "s"} and successfully ran ${c.executed}. ${c.vulnerabilities} found a vulnerability, ${c.protected} ${c.protected === 1 ? "was" : "were"} resisted, ${c.unclear} ${c.unclear === 1 ? "was" : "were"} unclear and ${c.couldNotTest} could not run.${why}`
    : `Cybercheck planned ${c.planned} attack${c.planned === 1 ? "" : "s"} but could not run any of them.${why}`;

  return <div className="space-y-8">
    {run.parentRunId && <Alert><strong>Targeted rerun.</strong> This page shows only the attacks selected from the earlier run. It does not replace the full-project result.</Alert>}
    {/* 1. Plain-language decision */}
    <Card className={cn("border-2", borderFor(d.tone))}>
      <div className="flex items-center gap-2"><StatusIcon status={r.decision === "not_ready_adversarial_findings" ? "failed" : r.decision === "ready_with_evidence" ? "passed" : "blocked"} className={toneClass[d.tone]} /><Badge tone={d.tone}>{d.label}</Badge></div>
      <p className="mt-3 text-lg text-fg">{summary}</p>
    </Card>

    {/* 2. Large result counters */}
    <section aria-labelledby="counters-h">
      <h2 id="counters-h" className="sr-only">Result counts</h2>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Counter label="Planned attacks" value={c.planned} />
        <Counter label="Actually ran" value={`${c.executed} / ${c.planned}`} />
        <Counter label="Vulnerabilities found" value={c.vulnerabilities} tone={c.vulnerabilities ? "bad" : "good"} />
        <Counter label="Protected" value={c.protected} tone="good" />
        <Counter label="Could not test" value={c.couldNotTest} tone={c.couldNotTest ? "warn" : "muted"} />
        <Counter label="Unclear" value={c.unclear} tone={c.unclear ? "warn" : "muted"} />
      </div>
      <div className="mt-3">
        <div className="flex items-center justify-between text-sm text-fg-muted"><span>Coverage: attacks completed out of attacks planned</span><span className="font-medium text-fg tabular-nums">{c.coveragePct}%</span></div>
        <div className="mt-1 h-2.5 w-full overflow-hidden rounded-full bg-surface-2" role="img" aria-label={`Coverage ${c.coveragePct} percent: ${c.executed} of ${c.planned} planned attacks were completed`}><div className="h-full rounded-full bg-accent" style={{ width: `${c.coveragePct}%` }} /></div>
      </div>
    </section>

    {/* 3. What you should do next */}
    {steps.length > 0 && <section aria-labelledby="next-h"><Card>
      <CardTitle id="next-h">What you should do next</CardTitle>
      <ol className="mt-4 space-y-3">{[...steps].sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority)).map((s, i) => <li key={`${s.title}:${i}`} className="flex flex-col gap-1 rounded-lg bg-surface-2 p-3 sm:flex-row sm:items-start sm:gap-3">
        <Badge tone={s.tone}>{s.priority}</Badge>
        <div className="min-w-0"><p className="font-medium text-fg">{s.title}</p><p className="text-sm text-fg-muted">{s.detail}</p>{s.campaignId && <a href={`#attack-${s.campaignId}`} className="mt-1 inline-flex min-h-11 items-center text-sm font-medium text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">See this attack and its evidence</a>}</div>
      </li>)}</ol>
    </Card></section>}

    {/* 6. Attack categories */}
    <section aria-labelledby="cat-h"><Card>
      <CardTitle id="cat-h">Attacks by category</CardTitle>
      <div className="mt-4 space-y-3">{CATEGORY_ORDER.map((key) => {
        const cat = run.campaigns.filter((x) => attackMeta(x).category === key);
        if (!cat.length) return null;
        const n = (s: AdversarialCampaign["status"]) => cat.filter((x) => x.status === s).length;
        return <div key={key} className="rounded-lg border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="font-medium text-fg">{CATEGORY[key].title}</p><p className="text-sm text-fg-muted">{CATEGORY[key].blurb}</p></div></div>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
            <Stat label="Planned" value={cat.length} />
            <Stat label="Ran" value={n("failed") + n("passed") + n("inconclusive")} />
            <Stat label="Vulnerable" value={n("failed")} tone={n("failed") ? "bad" : "muted"} />
            <Stat label="Protected" value={n("passed")} tone={n("passed") ? "good" : "muted"} />
            <Stat label="Could not test" value={n("blocked")} tone={n("blocked") ? "warn" : "muted"} />
          </dl>
        </div>;
      })}</div>
    </Card></section>

    {/* 5. Blocked attacks grouped by root cause */}
    {groups.length > 0 && <section aria-labelledby="blocked-h"><Card className="border-warning/40">
      <CardTitle id="blocked-h">Attacks that could not be tested</CardTitle>
      {groups.map((g, i) => <div key={i} className="mt-3">
        <p className="text-sm text-fg">{g.reason}</p>
        <p className="mt-1 text-sm font-medium text-warning">“Could not test” does not mean the application is safe. These attacks were never sent.</p>
        {g.setupFailures.length > 0 && <ul className="mt-3 space-y-1 text-sm">{g.setupFailures.map((s) => <li key={s.name} className="flex items-center gap-2"><TriangleAlert className="size-4 text-warning" aria-hidden="true" /><span className="text-fg">{s.kind === "identity" ? `Test account "${s.name}"` : `Test data "${s.name}"`}:</span> <span className="text-fg-muted">could not be set up</span></li>)}</ul>}
        <details className="mt-3 rounded-lg bg-surface-2 p-3"><summary className="min-h-11 cursor-pointer text-sm font-medium text-fg">Technical details</summary><ul className="mt-2 space-y-1 text-xs text-fg-muted">{g.setupFailures.map((s) => <li key={s.name}><Mono>{s.name}</Mono>: {redactText(s.detail)}</li>)}{!g.setupFailures.length && <li>The attacker could not establish the preconditions these attacks need in the sandbox.</li>}</ul></details>
      </div>)}
    </Card></section>}

    <section aria-labelledby="setup-h"><Card>
      <CardTitle id="setup-h">Test setup</CardTitle>
      <p className="mt-2 text-sm text-fg-muted">These are the synthetic seed, activation, account, session and data steps checked before attacks were sent.</p>
      {!r.setup.length ? <p className="mt-3 text-sm text-fg-muted">No setup steps were recorded.</p> : <ul className="mt-3 space-y-2 text-sm">{r.setup.map((s) => <li key={`${s.kind}:${s.name}`} className="flex items-start gap-2"><Badge tone={s.ok ? "good" : "warn"}>{s.ok ? "Ready" : "Failed"}</Badge><span><span className="font-medium text-fg">{s.name}</span><span className="block text-fg-muted">{redactText(s.detail)}</span></span></li>)}</ul>}
    </Card></section>

    {r.untested.length > 0 && <section aria-labelledby="untested-h"><Card className="border-warning/30">
      <CardTitle id="untested-h">Untested</CardTitle>
      <p className="mt-2 text-sm text-fg-muted">These selected checks were excluded by safety, budget, compatibility, or a missing frozen definition. They are not passes.</p>
      <ul className="mt-3 space-y-2 text-sm">{r.untested.map((x, i) => <li key={`${x.what}:${i}`} className="rounded-lg bg-surface-2 p-3"><Mono>{x.what}</Mono><span className="mt-1 block text-fg-muted">{redactText(x.reason)}</span></li>)}</ul>
    </Card></section>}

    {/* 4. Attack explorer */}
    <section aria-labelledby="attacks-h"><h2 id="attacks-h" className="text-lg font-semibold text-fg">Every attack we tried</h2>
      <div className="mt-4 space-y-3">{run.campaigns.map((x) => <AttackCard key={x.id} campaign={x} finding={run.findings.find((f) => f.campaignIds.includes(x.id))} review={review} />)}</div>
    </section>

    {/* 7. Attack chains */}
    {run.chains.length > 0 && <section aria-labelledby="chains-h"><Card>
      <CardTitle id="chains-h">Multi-step attack chains</CardTitle>
      <p className="mt-2 text-sm text-fg-muted">A chain combines smaller steps into a full break-in. A chain is only counted as succeeding when every step was proven at runtime.</p>
      <div className="mt-4 space-y-4">{run.chains.map((ch) => <ChainStory key={ch.id} chain={ch} />)}</div>
    </Card></section>}

    {/* 9. AI participation */}
    <section aria-labelledby="ai-h"><Card>
      <CardTitle id="ai-h">How AI was used</CardTitle>
      <p className="mt-3 text-sm text-fg-muted">{aiParticipation(r)}</p>
    </Card></section>

    {/* 10. Cost and environment */}
    <section aria-labelledby="env-h"><Card>
      <CardTitle id="env-h">Where and how this ran</CardTitle>
      <ul className="mt-3 space-y-1.5 text-sm text-fg-muted">
        <li>Ran in an isolated {r.environment.selected === "nebius" ? "Nebius" : r.environment.selected === "local" ? "local Docker" : "sandbox"} sandbox.</li>
        <li>External internet access was disabled during the attacks.</li>
        <li>Only synthetic test accounts and records were used. No real customer data was touched.</li>
        <li>Estimated AI cost: {typeof r.usage.costUsd === "number" ? `$${r.usage.costUsd.toFixed(2)}` : "$0.00"}.</li>
        {typeof r.usage.durationMs === "number" && <li>Duration: {Math.max(1, Math.round(r.usage.durationMs / 60000))} minute(s).</li>}
        {r.reusedSecurity?.note && <li>{r.reusedSecurity.note}</li>}
      </ul>
      {!r.reusedSecurity?.securityRunId && <Link href={`/app/checks/security?project=${projectId}`} className="mt-3 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">Run the Security check first for stronger starting evidence</Link>}
    </Card></section>

    {/* 8. Technical details, collapsed */}
    <section aria-labelledby="tech-h"><Card>
      <CardTitle id="tech-h">Technical details</CardTitle>
      <details className="mt-3"><summary className="min-h-11 cursor-pointer text-sm font-medium text-accent">Evidence and safety checks</summary>
        <ul className="mt-2 space-y-2 text-sm">{r.audit.map((a) => <li key={a.check} className="flex items-start gap-2"><Badge tone={a.ok ? "good" : "bad"}>{a.ok ? "Pass" : "Fail"}</Badge><span><span className="font-medium text-fg">{a.check}</span><span className="block text-fg-muted">{a.detail}</span></span></li>)}</ul>
      </details>
      <details className="mt-2"><summary className="min-h-11 cursor-pointer text-sm font-medium text-accent">Engine, versions and identifiers</summary>
        <dl className="mt-2 grid gap-2 text-xs text-fg-muted sm:grid-cols-2"><div><dt className="font-medium text-fg">Engine</dt><dd><Mono>{r.engine}</Mono></dd></div><div><dt className="font-medium text-fg">Catalogue / compiler</dt><dd><Mono>{r.catalogueVersion} / {r.compilerVersion}</Mono></dd></div><div><dt className="font-medium text-fg">Snapshot</dt><dd><Mono>{r.versions.snapshotDigest.slice(0, 16)}</Mono></dd></div>{r.versions.campaignPlanDigest && <div><dt className="font-medium text-fg">Frozen campaign plan</dt><dd><Mono>{r.versions.campaignPlanDigest.slice(0, 16)}</Mono></dd></div>}<div><dt className="font-medium text-fg">AI tokens</dt><dd className="tabular-nums">{r.usage.tokensIn + r.usage.tokensOut}</dd></div></dl>
      </details>
      <details className="mt-2"><summary className="min-h-11 cursor-pointer text-sm font-medium text-accent">Rules of engagement</summary>
        <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2"><Tech label="Endpoints in scope" value={r.rulesOfEngagement.allowedEndpoints.join(", ") || "None"} /><Tech label="Synthetic identities" value={r.rulesOfEngagement.allowedIdentities.join(", ") || "None"} /><Tech label="External network" value={r.rulesOfEngagement.externalNetwork ? "enabled" : "disabled"} /><Tech label="Attack surface" value={`${r.surface.nodes.length} nodes, ${r.surface.edges.length} evidence links`} /></dl>
      </details>
    </Card></section>
  </div>;
}

function Counter({ label, value, tone = "muted" }: { label: string; value: string | number; tone?: Tone }) {
  return <div className="rounded-xl border border-border bg-surface p-4"><p className={cn("text-3xl font-semibold tabular-nums", tone === "bad" ? "text-danger" : tone === "good" ? "text-success" : tone === "warn" ? "text-warning" : "text-fg")}>{value}</p><p className="mt-1 text-sm text-fg-muted">{label}</p></div>;
}
function Stat({ label, value, tone = "muted" }: { label: string; value: number; tone?: Tone }) {
  return <div><dt className="text-fg-muted">{label}</dt><dd className={cn("font-semibold tabular-nums", tone === "bad" ? "text-danger" : tone === "good" ? "text-success" : tone === "warn" ? "text-warning" : "text-fg")}>{value}</dd></div>;
}
function Tech({ label, value }: { label: string; value: string }) { return <div><dt className="font-medium text-fg">{label}</dt><dd className="break-words text-fg-muted">{value}</dd></div>; }

function AttackCard({ campaign, finding, review }: { campaign: AdversarialCampaign; finding?: AdversarialFinding; review: ReviewCtx }) {
  const s = STATUS[campaign.status];
  const meta = attackMeta(campaign);
  const identity = campaign.steps[0]?.asIdentity ?? "anonymous";
  const observed = redactText(finding?.observed ?? campaign.steps.find((st) => st.observed)?.observed ?? (s.ran ? "See technical details." : "The attack was not sent."));
  return <Card id={`attack-${campaign.id}`} className={borderFor(s.tone)}>
    <div className="flex flex-wrap items-center gap-2">
      <StatusIcon status={campaign.status} className={toneClass[s.tone]} />
      <h3 className="min-w-0 font-semibold text-fg">{meta.name}</h3>
      <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", s.tone === "bad" ? "bg-danger/10 text-danger" : s.tone === "good" ? "bg-success/10 text-success" : s.tone === "warn" ? "bg-warning/10 text-warning" : "bg-surface-2 text-fg-muted")}>{s.label}</span>
      {finding && finding.status === "confirmed" && <Badge tone="bad">{finding.severity}</Badge>}
      <span className="ml-auto text-xs text-fg-muted">{CATEGORY[meta.category].title}</span>
    </div>
    <p className="mt-2 text-sm text-fg">{meta.explanation}</p>
    <p className="mt-1 text-sm font-medium" aria-live="off"><span className={toneClass[s.tone]}>{s.meaning}</span></p>
    <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
      <Field label="Target feature" value={<Mono>{campaign.target.endpoint}</Mono>} />
      <Field label="Signed in as" value={identity === "anonymous" ? "a visitor who is not signed in" : `test account "${identity.replace(/#forged$/, " (with a forged token)")}"`} />
      <Field label="Did the attack actually run?" value={s.ran ? "Yes, it ran in full." : "No, it could not be sent."} />
      <Field label="What Cybercheck attempted" value={meta.attempted} />
      <Field label="What should have happened" value={meta.expected} />
      <Field label="What actually happened" value={observed} />
    </dl>
    {finding && finding.status === "confirmed" && <p className="mt-3 rounded-lg bg-danger/5 p-3 text-sm"><span className="font-medium text-danger">Business impact:</span> <span className="text-fg">{finding.impact}</span></p>}
    <p className="mt-3 text-sm"><span className="font-medium">Recommended fix:</span> {finding?.remediation ?? "No change needed for this result."}</p>
    {campaign.status === "blocked" && <p className="mt-2 text-sm font-medium text-warning">This is not a safety result. The attack was never sent, so it does not mean the feature is secure.</p>}
    {finding && finding.sourceEvidence.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{finding.sourceEvidence.map((e, i) => <EvidenceLink key={`${e.path}:${e.line}:${i}`} evidence={e} />)}</div>}
    {campaign.limitations.length > 0 && campaign.status !== "blocked" && <p className="mt-2 text-xs text-fg-muted">Limitations: {campaign.limitations.join("; ")}</p>}
    {/* One review + repair per finding, shown on the first attack that confirmed it. */}
    {finding && finding.campaignIds[0] === campaign.id && <div className="mt-4"><FindingReviewRepair check="adversarial" runId={review.runId} projectId={review.projectId} findingId={finding.id} machineConfirmed={finding.status === "confirmed"} review={latestReviewOf(review.reviews, finding.id)} repair={repairOf(review.repairs, finding.id)} canReview={review.canReview} onChange={review.onChange} /></div>}
    <details className="mt-3"><summary className="min-h-11 cursor-pointer text-xs font-medium text-fg-muted">Technical details</summary><ul className="mt-2 space-y-1 text-xs text-fg-muted"><li>Attack id: <Mono>{campaign.id}</Mono></li><li>Technique: <Mono>{campaign.techniqueId}</Mono> (lane {campaign.lane})</li><li>Executions: {campaign.executionIds.length}</li>{campaign.steps.map((st) => <li key={st.seq}><Mono>{st.seq}. {st.operation}</Mono> as {st.asIdentity ?? "anonymous"} → <Mono>{st.target}</Mono></li>)}</ul></details>
  </Card>;
}

function Field({ label, value }: { label: string; value: React.ReactNode }) { return <div className="rounded-lg bg-surface-2 p-3"><dt className="text-xs text-fg-muted">{label}</dt><dd className="mt-1 text-fg">{value}</dd></div>; }

const LINK_STATE: Record<string, { label: string; tone: Tone }> = { crossed: { label: "Proven", tone: "bad" } };
function ChainStory({ chain }: { chain: AttackChain }) {
  const verdict = chain.verdict === "confirmed" ? { label: "Full break-in proven", tone: "bad" as Tone } : chain.verdict === "rejected" ? { label: "Blocked (a step was resisted)", tone: "good" as Tone } : { label: "Not fully proven", tone: "warn" as Tone };
  return <div className={cn("rounded-lg border p-3", borderFor(verdict.tone))}>
    <div className="flex items-center gap-2"><Badge tone={verdict.tone}>{verdict.label}</Badge><h4 className="font-semibold text-fg">{chain.title}</h4></div>
    <ol className="mt-3 space-y-2">{chain.links.map((l, i) => { const st = l.crossed ? LINK_STATE.crossed! : { label: "Not proven", tone: "muted" as Tone }; return <li key={`${l.label}:${i}`} className="flex items-start gap-2 text-sm"><span className="mt-0.5 font-medium tabular-nums text-fg-muted">Step {i + 1}</span><span className="min-w-0 text-fg">{l.label}</span><span className={cn("ml-auto shrink-0 text-xs font-medium", st.tone === "bad" ? "text-danger" : st.tone === "good" ? "text-success" : "text-fg-muted")}>{st.label}</span>{l.evidence[0] && <EvidenceLink evidence={l.evidence[0]} />}</li>; })}</ol>
    <p className="mt-2 text-sm text-fg-muted">{chain.reason}</p>
  </div>;
}

function aiParticipation(r: AdversarialRunDetail["report"]): string {
  if (!r) return "";
  const model = r.attacker.status === "ran";
  const first = model
    ? `An AI model (${r.attacker.model ?? "the configured model"}) helped select and prioritize attacks, proposing ${r.attacker.hypotheses} attack idea(s). Deterministic runtime checks, not the AI, decided whether each attack actually succeeded. AI was never allowed to confirm a vulnerability.`
    : "Attacks were chosen by Cybercheck's built-in deterministic catalogue. Deterministic runtime checks decided whether each attack succeeded. No AI was needed to confirm any result.";
  const critic = r.critic.status === "ran" ? " An optional second AI review double-checked the findings; it can only challenge a result, never confirm one."
    : r.critic.status === "off" ? " The optional second AI review was turned off. Runtime evidence remains valid."
    : " The optional second AI review was unavailable. Runtime evidence remains valid.";
  return first + critic;
}
