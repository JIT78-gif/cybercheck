"use client";

import Link from "next/link";
import { ArrowLeft, CircleCheck, CircleDashed, CircleX, Download, ShieldQuestion } from "lucide-react";
import type { SecurityFinding, SecurityObligation, SecurityReleaseDecision, SecurityRunDetail } from "@cybercheck/contracts";
import { Card, CardTitle, EmptyState } from "@/components/app/ui";
import { Badge, Mono } from "@/components/architecture/parts";
import { CodeViewerProvider, EvidenceLink } from "@/components/architecture/code-viewer";
import { Tabs, TabPanel, useViewParams, type TabItem } from "@/components/testing/run-tabs";
import { duration, RunStatusBadge, SEVERITY_TONE } from "@/components/testing/run-parts";
import { ACTIVE_RUN } from "@/components/testing/use-testing";
import { buttonVariants } from "@/components/ui/button";
import { Alert, Spinner } from "@/components/ui/form";
import { cn } from "@/lib/cn";
import { useSecurityRun } from "./use-security";

const DECISION: Record<SecurityReleaseDecision, { label: string; tone: "good" | "bad" | "warn" }> = {
  ready_with_evidence: { label: "Ready, with evidence", tone: "good" },
  ready_with_accepted_risk: { label: "Ready only with accepted risk", tone: "warn" },
  not_ready_security_findings: { label: "Not ready: confirmed security findings", tone: "bad" },
  not_ready_insufficient_evidence: { label: "Not ready: not enough evidence", tone: "warn" },
  not_ready_environment_blocked: { label: "Not ready: the environment blocked the check", tone: "bad" },
};

const OB_STATUS: Record<SecurityObligation["status"], { label: string; tone: "good" | "bad" | "warn" | "muted" | "info"; icon: typeof CircleCheck }> = {
  passed: { label: "Upheld", tone: "good", icon: CircleCheck },
  failed: { label: "Vulnerability reproduced", tone: "bad", icon: CircleX },
  inconclusive: { label: "Inconclusive", tone: "warn", icon: ShieldQuestion },
  unsupported: { label: "Not tested yet", tone: "muted", icon: CircleDashed },
  blocked: { label: "Blocked", tone: "warn", icon: CircleDashed },
  not_applicable: { label: "Not applicable", tone: "muted", icon: CircleDashed },
  planned: { label: "Planned", tone: "muted", icon: CircleDashed },
  running: { label: "Running", tone: "info", icon: CircleDashed },
};

const LANE: Record<string, string> = { auth: "Authentication", access_control: "Authorization", injection: "Injection and unsafe input", secrets: "Secrets", dependencies: "Dependencies", sast: "Code rules", configuration: "Configuration", infrastructure: "Infrastructure and CI", crypto: "Cryptography and passwords", privacy: "Sensitive data", logging: "Logging and errors" };

const PHASES = [
  { id: "admission", label: "Admit" },
  { id: "readiness", label: "Check the analysis" },
  { id: "planning", label: "Checklist" },
  { id: "preparing", label: "Tools" },
  { id: "scanning", label: "Scan" },
  { id: "app_preparing", label: "Start the app" },
  { id: "fixtures", label: "Sign in" },
  { id: "proving", label: "Prove" },
  { id: "browser_proving", label: "Browser" },
  { id: "critic", label: "Critic" },
  { id: "validating", label: "Validate" },
  { id: "reporting", label: "Report" },
];

type Tab = "summary" | "confirmed" | "suspected" | "coverage" | "untested" | "environment";

export function SecurityRunView({ projectId, runId }: { projectId: string; runId: string }) {
  const { run, events, error } = useSecurityRun(runId);
  const view = useViewParams();
  const tab = (view.get("tab") as Tab | null) ?? "summary";
  if (error && !run) return <Alert>{error.message} {error.fix}</Alert>;
  if (!run)
    return (
      <p className="flex items-center gap-2 py-10 text-fg-muted">
        <Spinner /> Loading run
      </p>
    );
  const active = ACTIVE_RUN.has(run.status);
  const confirmed = run.findings.filter((f) => f.status === "confirmed");
  const suspected = run.findings.filter((f) => f.status === "suspected" || f.status === "inconclusive");
  const untested = run.obligations.filter((o) => ["unsupported", "inconclusive", "blocked"].includes(o.status));
  const items: TabItem<Tab>[] = [
    { id: "summary", label: "Decision summary" },
    { id: "confirmed", label: "Confirmed findings", count: confirmed.length, tone: confirmed.length ? "bad" : "muted" },
    { id: "suspected", label: "Suspected risks", count: suspected.length, tone: suspected.length ? "warn" : "muted" },
    { id: "coverage", label: "Security coverage" },
    { id: "untested", label: "Untested and blocked", count: untested.length, tone: "muted" },
    { id: "environment", label: "Cost and environment" },
  ];

  return (
    <CodeViewerProvider snapshotId={run.snapshotId}>
      <div className="space-y-6">
        <Link href={`/app/checks/security?project=${projectId}`} className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-accent hover:underline">
          <ArrowLeft className="size-4" aria-hidden="true" /> Security
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-fg">Security check</h1>
          <RunStatusBadge status={run.status} />
          <span className="text-sm text-fg-muted">{duration(run.startedAt, run.finishedAt) ?? ""}</span>
          {!active && run.report && (
            <div className="ml-auto flex flex-wrap gap-2">
              <a href={`/v1/security-runs/${run.id}/export?format=md`} download className={buttonVariants({ variant: "outline", shape: "pill", size: "sm" })}>
                <Download aria-hidden="true" /> Markdown
              </a>
              <a href={`/v1/security-runs/${run.id}/export?format=json`} download className={buttonVariants({ variant: "outline", shape: "pill", size: "sm" })}>
                <Download aria-hidden="true" /> JSON
              </a>
            </div>
          )}
        </div>

        {active ? (
          <LiveProgress run={run} events={events} />
        ) : !run.report ? (
          <Alert>{run.error ?? "This run has no report."}</Alert>
        ) : (
          <>
            <Tabs items={items} value={tab} onChange={(id) => view.set({ tab: id === "summary" ? null : id })} label="Security results" idPrefix="sec" />
            <TabPanel idPrefix="sec" value={tab}>
              {tab === "summary" && <Summary run={run} />}
              {tab === "confirmed" && <FindingList findings={confirmed} empty="No finding was confirmed. Suspected risks and untested checks are listed in their own tabs." />}
              {tab === "suspected" && <FindingList findings={suspected} empty="No suspected risk." />}
              {tab === "coverage" && <Coverage obligations={run.obligations} />}
              {tab === "untested" && <Untested obligations={untested} />}
              {tab === "environment" && <Environment run={run} />}
            </TabPanel>
          </>
        )}
      </div>
    </CodeViewerProvider>
  );
}

function LiveProgress({ run, events }: { run: SecurityRunDetail; events: Array<{ seq: number; type: string; message: string }> }) {
  const at = PHASES.findIndex((p) => p.id === run.phase);
  return (
    <Card>
      <CardTitle>In progress</CardTitle>
      <ol className="mt-4 flex flex-wrap gap-2" aria-label="Phases">
        {PHASES.map((p, i) => (
          <li key={p.id} aria-current={i === at ? "step" : undefined} className={cn("rounded-full px-3 py-1 text-xs font-medium", i < at ? "bg-success/10 text-success" : i === at ? "bg-accent/10 text-accent" : "bg-surface-2 text-fg-muted")}>
            {p.label}
          </li>
        ))}
      </ol>
      <ul className="mt-5 space-y-2 text-sm" role="log" aria-live="polite">
        {events.filter((e) => !e.type.startsWith("phase:")).slice(-12).map((e) => (
          <li key={e.seq} className="text-fg">
            {e.message}
          </li>
        ))}
        {!events.length && (
          <li className="flex items-center gap-2 text-fg-muted">
            <Spinner /> {run.status === "queued" ? "Waiting for a worker" : "Starting"}
          </li>
        )}
      </ul>
    </Card>
  );
}

function Summary({ run }: { run: SecurityRunDetail }) {
  const r = run.report!;
  const d = DECISION[r.decision];
  const c = r.coverage;
  const counts = (["passed", "failed", "inconclusive", "unsupported", "blocked"] as const).map((s) => ({ s, n: run.obligations.filter((o) => o.status === s).length }));
  const tone = { passed: "bg-success", failed: "bg-danger", inconclusive: "bg-warning", unsupported: "bg-fg/15", blocked: "bg-warning/60" } as const;
  return (
    <>
      <Card className={cn(d.tone === "good" ? "border-success/40" : d.tone === "bad" ? "border-danger/40" : "border-warning/40")}>
        <Badge tone={d.tone}>{d.label}</Badge>
        <p className="mt-3 text-base text-fg">{r.headline}</p>
        <p className="mt-2 text-sm text-fg-muted">This is evidence about the checks that ran, not a promise that the app cannot be attacked.</p>
      </Card>
      <div className="grid gap-6 md:grid-cols-3">
        <Card>
          <CardTitle>Decisive evidence</CardTitle>
          <p className="mt-3 text-3xl font-semibold text-fg tabular-nums">
            {c.decisive} <span className="text-base font-normal text-fg-muted">of {c.applicable}</span>
          </p>
          <p className="mt-1 text-sm text-fg-muted">applicable obligations; {c.criticalDecisive} of {c.criticalApplicable} critical</p>
        </Card>
        <Card>
          <CardTitle>Findings</CardTitle>
          <p className="mt-3 text-3xl font-semibold text-fg tabular-nums">
            {r.findings.confirmed} <span className="text-base font-normal text-fg-muted">confirmed</span>
          </p>
          <p className="mt-1 text-sm text-fg-muted">{r.findings.suspected} suspected risk(s) to review; {r.findings.confirmedCriticalHigh} confirmed critical or high</p>
        </Card>
        <Card>
          <CardTitle>Project analysis</CardTitle>
          <p className="mt-3 text-lg font-semibold text-fg">{r.readiness.level.replace(/_/g, " ").toLowerCase()}</p>
          <p className="mt-1 text-sm text-fg-muted">{r.readiness.issues.filter((i) => i.severity === "error").length} contradiction(s) found when the analysis was checked again</p>
        </Card>
      </div>
      <Card>
        <CardTitle>Obligations by result</CardTitle>
        <div className="mt-4 flex h-3 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
          {counts.filter((x) => x.n).map((x) => (
            <div key={x.s} className={tone[x.s]} style={{ width: `${(x.n / Math.max(1, c.applicable)) * 100}%` }} />
          ))}
        </div>
        <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-fg-muted">
          {counts.map((x) => (
            <li key={x.s} className="inline-flex items-center gap-1.5">
              <span className={cn("size-2.5 rounded-full", tone[x.s])} aria-hidden="true" /> {OB_STATUS[x.s].label}: <span className="text-fg tabular-nums">{x.n}</span>
            </li>
          ))}
        </ul>
      </Card>
      {r.readiness.issues.length > 0 && (
        <Card>
          <CardTitle>What the check did not trust in the analysis</CardTitle>
          <ul className="mt-3 space-y-2 text-sm">
            {r.readiness.issues.map((i) => (
              <li key={`${i.rule}-${i.message}`} className="text-fg">
                <Badge tone={i.severity === "error" ? "warn" : "muted"}>{i.severity === "error" ? "Contradiction" : "Gap"}</Badge> {i.message}
                {i.blocks.length > 0 && <span className="text-fg-muted"> Checks in {i.blocks.map((b) => LANE[b] ?? b).join(", ")} are inconclusive until this is settled.</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function FindingList({ findings, empty }: { findings: SecurityFinding[]; empty: string }) {
  if (!findings.length) return <EmptyState icon={CircleCheck} title="Nothing here" body={empty} />;
  const rank = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  return (
    <ul className="space-y-4">
      {[...findings].sort((a, b) => rank[a.severity] - rank[b.severity]).map((f) => (
        <li key={f.id}>
          <Card>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={SEVERITY_TONE[f.severity]}>{f.severity}</Badge>
              <Badge tone={f.status === "confirmed" ? "bad" : "warn"}>{f.status}</Badge>
              <span className="text-xs text-fg-muted">
                {f.id} · {f.detector.tool} {f.detector.version}
              </span>
            </div>
            <h3 className="mt-2 font-medium text-fg">{f.title}</h3>
            <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm md:grid-cols-[10rem_minmax(0,1fr)]">
              <dt className="text-fg-muted">What should hold</dt>
              <dd className="text-fg">{f.expected}</dd>
              <dt className="text-fg-muted">What was found</dt>
              <dd className="text-fg">{f.observed}</dd>
              <dt className="text-fg-muted">Why it matters</dt>
              <dd className="text-fg">{f.impact}</dd>
              <dt className="text-fg-muted">Confirmation</dt>
              <dd className="text-fg">{f.confirmation}</dd>
              <dt className="text-fg-muted">Fix</dt>
              <dd className="text-fg">{f.remediation}</dd>
              {f.secret && (
                <>
                  <dt className="text-fg-muted">Secret</dt>
                  <dd className="text-fg">
                    {f.secret.type}: <Mono>{f.secret.preview}</Mono> (fingerprint <Mono>{f.secret.fingerprint}</Mono>)
                  </dd>
                </>
              )}
              {f.evidence.length > 0 && (
                <>
                  <dt className="text-fg-muted">Where</dt>
                  <dd className="flex flex-wrap gap-2">
                    {f.evidence.map((e) => (
                      <EvidenceLink key={`${e.path}:${e.line}`} evidence={e} />
                    ))}
                  </dd>
                </>
              )}
              {(f.cwe.length > 0 || f.owasp.length > 0) && (
                <>
                  <dt className="text-fg-muted">Standards</dt>
                  <dd className="text-fg-muted">{[...f.cwe, ...f.owasp].join(", ")}</dd>
                </>
              )}
            </dl>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function ObligationRows({ obligations }: { obligations: SecurityObligation[] }) {
  return (
    <ul className="divide-y divide-border">
      {obligations.map((o) => {
        const s = OB_STATUS[o.status];
        return (
          <li key={o.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:gap-4">
            <span className="w-36 shrink-0">
              <Badge tone={s.tone}>
                <s.icon className="size-3.5" aria-hidden="true" /> {s.label}
              </Badge>
            </span>
            <span className="min-w-0">
              <span className="block text-sm text-fg">{o.requirement}</span>
              {o.reason && <span className="block text-xs text-fg-muted">{o.reason}</span>}
              <span className="block text-xs text-fg-muted">
                {o.priority} · {o.standards.join(", ")}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Coverage({ obligations }: { obligations: SecurityObligation[] }) {
  const lanes = [...new Set(obligations.map((o) => o.lane))];
  return (
    <>
      {lanes.map((lane) => {
        const list = obligations.filter((o) => o.lane === lane);
        const applicable = list.filter((o) => o.status !== "not_applicable");
        const decisive = applicable.filter((o) => o.status === "passed" || o.status === "failed");
        return (
          <Card key={lane}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>{LANE[lane] ?? lane}</CardTitle>
              <span className="text-sm text-fg-muted tabular-nums">
                {decisive.length} of {applicable.length} decided
              </span>
            </div>
            <div className="mt-3">
              <ObligationRows obligations={list} />
            </div>
          </Card>
        );
      })}
    </>
  );
}

function Untested({ obligations }: { obligations: SecurityObligation[] }) {
  if (!obligations.length) return <EmptyState icon={CircleCheck} title="Nothing left untested" body="Every applicable obligation has a decisive result." />;
  return (
    <Card>
      <CardTitle>Not tested or not decided</CardTitle>
      <p className="mt-1 text-sm text-fg-muted">Each one says why. They count against coverage until a later round or a rerun decides them.</p>
      <div className="mt-3">
        <ObligationRows obligations={obligations} />
      </div>
    </Card>
  );
}

const RUNTIME_LABEL: Record<string, string> = { nebius: "Nebius sandbox", local: "Local Docker", static: "Analysis only (nothing executed)" };

function Environment({ run }: { run: SecurityRunDetail }) {
  const r = run.report!;
  const env = r.environment;
  const billing = env ? env.health.status === "billing_unavailable" || /402|billing/i.test(env.fallbackReason ?? "") : false;
  return (
    <>
      {env && (
        <Card>
          <CardTitle>Execution environment</CardTitle>
          <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm md:grid-cols-[12rem_minmax(0,1fr)]">
            <dt className="text-fg-muted">Where it ran</dt>
            <dd className="text-fg">{RUNTIME_LABEL[env.selected] ?? env.selected}{env.provider ? <> (<Mono>{env.provider}</Mono>)</> : null}</dd>
            <dt className="text-fg-muted">Requested</dt>
            <dd className="text-fg">{env.requested}</dd>
            {env.fallbackReason && (
              <>
                <dt className="text-fg-muted">Why not the preferred runtime</dt>
                <dd className="text-fg">{env.fallbackReason}</dd>
              </>
            )}
            <dt className="text-fg-muted">Preferred runtime health</dt>
            <dd className="text-fg">{env.health.ok ? "available" : env.health.status}{env.health.detail ? <span className="text-fg-muted"> ({env.health.detail})</span> : null}</dd>
            <dt className="text-fg-muted">Isolation</dt>
            <dd className="text-fg">{env.isolation}</dd>
            {r.critic && (
              <>
                <dt className="text-fg-muted">AI critic</dt>
                <dd className="text-fg">{r.critic.ran ? `ran: ${r.critic.accepted} of ${r.critic.proposals} hypotheses passed the compiler` : r.critic.reason}</dd>
              </>
            )}
            {r.proofs && (
              <>
                <dt className="text-fg-muted">Runtime proofs</dt>
                <dd className="text-fg tabular-nums">{r.proofs.total} proof(s), {r.proofs.requests} request(s): {r.proofs.byVerdict.failed ?? 0} reproduced, {r.proofs.byVerdict.passed ?? 0} held, {(r.proofs.byVerdict.blocked ?? 0) + (r.proofs.byVerdict.inconclusive ?? 0)} unsettled</dd>
              </>
            )}
          </dl>
          {billing && (
            <Alert tone={env!.selected === "static" ? "error" : "info"} className="mt-4">
              {env!.selected === "static"
                ? "Nebius was unavailable for billing (HTTP 402) and no local Docker runtime was available, so this run is analysis only. Settle the Nebius balance or start Docker, then run the check again."
                : "Nebius was unavailable for billing (HTTP 402). The check ran on the local Docker fallback. To use the Nebius sandbox, settle the account balance, then run the check again."}
            </Alert>
          )}
        </Card>
      )}
      <Card>
        <CardTitle>Tools and data</CardTitle>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-fg-muted">
              <tr>
                <th className="py-2 pr-4 font-medium">Tool</th>
                <th className="py-2 pr-4 font-medium">Version</th>
                <th className="py-2 pr-4 font-medium">Rules or data</th>
                <th className="py-2 pr-4 font-medium">Exit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {r.tools.map((t) => (
                <tr key={t.name}>
                  <td className="py-2 pr-4 text-fg">{t.name}</td>
                  <td className="py-2 pr-4">
                    <Mono>{t.version}</Mono>
                  </td>
                  <td className="py-2 pr-4 text-fg-muted">{t.rulePack ? `rule pack ${t.rulePack}` : t.databaseAt ? `data from ${t.databaseAt}` : ""}</td>
                  <td className="py-2 pr-4 tabular-nums">{t.exitCode ?? "did not run"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-sm text-fg-muted">
          {run.usage.sandboxOperations} sandbox operation(s), {run.usage.sandboxCpuSeconds} CPU seconds, AI cost ${run.usage.costUsd.toFixed(3)} (Round 1 uses no AI).
        </p>
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>Not run in this round</CardTitle>
          <ul className="mt-3 space-y-2 text-sm">
            {r.skipped.map((s) => (
              <li key={s.capability}>
                <span className="text-fg">{s.capability}</span> <span className="text-fg-muted">{s.reason}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardTitle>Limitations</CardTitle>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-fg">
            {r.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </Card>
      </div>
      <Card>
        <CardTitle>Report checks</CardTitle>
        <ul className="mt-3 space-y-2 text-sm">
          {r.audit.map((a) => (
            <li key={a.check} className="flex items-start gap-2">
              {a.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-label="passed" /> : <CircleX className="mt-0.5 size-4 shrink-0 text-danger" aria-label="failed" />}
              <span>
                <span className="text-fg">{a.check}</span> <span className="text-fg-muted">{a.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
