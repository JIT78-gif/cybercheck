"use client";

// Building blocks of the Testing run page: status styles, findings, the check ledger, executions and expert panels.

import { useMemo } from "react";
import { Ban, ChevronDown, CircleCheck, CircleDashed, CircleX, Clock, FileText, LoaderCircle, ShieldQuestion, TriangleAlert } from "lucide-react";
import type { Obligation, ObligationStatus, TestExecution, TestFinding, TestingRunDetail } from "@cybercheck/contracts";
import { Card, CardTitle } from "@/components/app/ui";
import { EvidenceLink } from "@/components/architecture/code-viewer";
import { Badge, DataTable, Mono } from "@/components/architecture/parts";
import { cn } from "@/lib/cn";
import { ACTIVE_RUN } from "./use-testing";

const PHASES: Array<{ id: TestingRunDetail["phase"]; label: string }> = [
  { id: "admission", label: "Admission" },
  { id: "planning", label: "Plan" },
  { id: "preparing", label: "Install" },
  { id: "authoring", label: "Author" },
  { id: "executing", label: "Run" },
  { id: "triage", label: "Triage" },
  { id: "auditing", label: "Audit" },
];

export const STATUS_STYLE: Record<ObligationStatus, { label: string; tone: "good" | "bad" | "warn" | "info" | "muted"; icon: typeof CircleCheck }> = {
  passed: { label: "Passed", tone: "good", icon: CircleCheck },
  failed: { label: "Failed", tone: "bad", icon: CircleX },
  flaky: { label: "Flaky", tone: "warn", icon: TriangleAlert },
  blocked: { label: "Blocked", tone: "warn", icon: Ban },
  unsupported: { label: "Not supported yet", tone: "muted", icon: CircleDashed },
  skipped: { label: "Skipped", tone: "muted", icon: CircleDashed },
  not_applicable: { label: "Not applicable", tone: "muted", icon: CircleDashed },
  inconclusive: { label: "Inconclusive", tone: "warn", icon: ShieldQuestion },
  planned: { label: "Planned", tone: "muted", icon: Clock },
  running: { label: "Running", tone: "info", icon: LoaderCircle },
};

export const RUN_STATUS: Record<TestingRunDetail["status"], { label: string; tone: "good" | "bad" | "warn" | "info" | "muted" }> = {
  queued: { label: "Queued", tone: "info" },
  running: { label: "Running", tone: "info" },
  // Workflow status only: whether the product passed is the release decision, never this badge.
  completed: { label: "Workflow finished", tone: "muted" },
  partial: { label: "Finished: could not test", tone: "warn" },
  blocked: { label: "Blocked", tone: "warn" },
  failed: { label: "Stopped with an error", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

export const SEVERITY_TONE = { critical: "bad", high: "bad", medium: "warn", low: "info", info: "muted" } as const;

export function duration(a: string | null, b: string | null) {
  if (!a) return null;
  const ms = (b ? new Date(b).getTime() : Date.now()) - new Date(a).getTime();
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function RunStatusBadge({ status }: { status: TestingRunDetail["status"] }) {
  const s = RUN_STATUS[status];
  return (
    <Badge tone={s.tone}>
      {ACTIVE_RUN.has(status) && <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />}
      {s.label}
    </Badge>
  );
}

export function Phases({ run }: { run: TestingRunDetail }) {
  const at = PHASES.findIndex((p) => p.id === run.phase);
  return (
    <ol className="flex flex-wrap gap-x-1 gap-y-2" aria-label="Phases">
      {PHASES.map((p, i) => {
        const done = run.phase === "done" || i < at;
        const now = i === at && ACTIVE_RUN.has(run.status);
        return (
          <li key={p.id} className="flex items-center gap-1">
            <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium", done ? "bg-success/10 text-success" : now ? "bg-accent/10 text-accent" : "bg-surface-2 text-fg-muted")} aria-current={now ? "step" : undefined}>
              {done ? <CircleCheck className="size-3.5" aria-hidden="true" /> : now ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : <CircleDashed className="size-3.5" aria-hidden="true" />}
              {p.label}
            </span>
            {i < PHASES.length - 1 && <span className="h-px w-2 bg-border" aria-hidden="true" />}
          </li>
        );
      })}
    </ol>
  );
}

export function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium tracking-wide text-fg-muted uppercase">{label}</p>
      <div className="mt-1 text-sm text-fg">{children}</div>
    </div>
  );
}

export function Pre({ children }: { children: React.ReactNode }) {
  return <pre className="max-h-72 overflow-auto rounded-lg bg-surface-2 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg">{children}</pre>;
}

export const findingMeta = (f: TestFinding) =>
  `${f.id} · machine verdict: ${f.status === "confirmed" ? "confirmed" : f.status === "suspected" ? "suspected" : "dismissed"} · ${f.confidence} confidence evidence${f.groupedFrom && f.groupedFrom.length > 1 ? ` · one root cause, ${f.groupedFrom.length} evidence sources` : ""}`;

export function FindingItem({ f, run, footer, badge }: { f: TestFinding; run: TestingRunDetail; footer?: React.ReactNode; badge?: React.ReactNode }) {
  return (
    <details className="group rounded-xl border border-border [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex min-h-12 cursor-pointer list-none items-start gap-3 px-4 py-3">
        <Badge tone={SEVERITY_TONE[f.severity]} className="mt-0.5 capitalize">{f.severity}</Badge>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-fg">{f.title}</span>
          <span className="mt-0.5 block text-xs text-fg-muted">{findingMeta(f)}</span>
          {badge}
        </span>
        <ChevronDown className="mt-1 size-4 shrink-0 text-fg-muted transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <FindingBody f={f} run={run} footer={footer} className="border-t border-border px-4 py-4" />
    </details>
  );
}

/** Everything about one finding: expectation, reproduction, cause, location, evidence; `footer` holds the actions. */
export function FindingBody({ f, run, footer, className }: { f: TestFinding; run: TestingRunDetail; footer?: React.ReactNode; className?: string }) {
  const execs = run.executions.filter((e) => f.executionIds.includes(e.id));
  return (
      <div className={cn("grid gap-4 sm:grid-cols-2", className)}>
        <Labelled label="Expected">{f.expected}</Labelled>
        <Labelled label="Actual">
          <span className="whitespace-pre-wrap">{f.actual}</span>
        </Labelled>
        <div className="sm:col-span-2">
          <Labelled label="Reproduce">
            <Pre>{f.reproduction}</Pre>
          </Labelled>
        </div>
        {f.rootCause && <Labelled label="Likely cause">{f.rootCause}</Labelled>}
        {f.location && (
          <Labelled label="Where">
            <EvidenceLink evidence={f.location} />
          </Labelled>
        )}
        <div className="sm:col-span-2">
          <Labelled label="How this was verified">{f.validation}</Labelled>
        </div>
        {f.limitation && (
          <div className="sm:col-span-2">
            <Labelled label="Limitation">{f.limitation}</Labelled>
          </div>
        )}
        {f.nextAction && (
          <div className="sm:col-span-2">
            <Labelled label="Next action">{f.nextAction}</Labelled>
          </div>
        )}
        {f.groupedFrom && f.groupedFrom.length > 1 && (
          <div className="sm:col-span-2">
            <Labelled label="Seen by">
              <ul className="list-disc space-y-0.5 pl-5">
                {f.groupedFrom.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </Labelled>
          </div>
        )}
        {f.carriedFrom && <p className="text-xs text-fg-muted sm:col-span-2">Carried over from an earlier run of the same code; its evidence is in that run.</p>}
        {execs.length > 0 && (
          <div className="sm:col-span-2">
            <Labelled label="Evidence">
              <ul className="space-y-1">
                {execs.map((e) => (
                  <li key={e.id}>
                    <a href={`/v1/testing-runs/${run.id}/executions/${e.id}/artifacts/output.txt`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-accent hover:underline">
                      <FileText className="size-3.5" aria-hidden="true" /> {e.label}
                    </a>{" "}
                    <span className="text-xs text-fg-muted">
                      exit {e.exitCode ?? "none"}
                      {e.timedOut ? ", timed out" : ""} · {e.durationMs != null ? `${(e.durationMs / 1000).toFixed(1)}s` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </Labelled>
          </div>
        )}
        {footer && <div className="sm:col-span-2">{footer}</div>}
      </div>
  );
}

export function ExecutionRow({ e, runId }: { e: TestExecution; runId: string }) {
  const tone = e.outcome === "ok" ? "good" : e.outcome === "running" ? "info" : e.outcome === "failed" ? "bad" : "warn";
  return (
    <details className="group rounded-xl border border-border [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
        <Badge tone={tone}>{e.outcome === "ok" ? "exit 0" : e.outcome === "failed" ? `exit ${e.exitCode}` : e.outcome.replace("_", " ")}</Badge>
        <span className="min-w-0 flex-1 text-sm text-fg">{e.label}</span>
        <span className="text-xs text-fg-muted tabular-nums">{e.durationMs != null ? `${(e.durationMs / 1000).toFixed(1)}s` : "running"}</span>
        <span className="text-xs text-fg-muted">{e.network ? "network on" : "network off"}</span>
      </summary>
      <div className="space-y-3 border-t border-border px-4 py-3">
        <Labelled label="Command">
          <Mono>{e.command}</Mono>
        </Labelled>
        {e.envNames.length > 0 && <Labelled label="Variables set (names only)">{e.envNames.join(", ")}</Labelled>}
        <Labelled label="Output (end)">
          <Pre>{e.outputTail || "(no output)"}</Pre>
        </Labelled>
        <div className="flex flex-wrap gap-3 text-sm">
          {e.artifacts.map((a) => (
            <a key={a.key} href={`/v1/testing-runs/${runId}/executions/${e.id}/artifacts/${a.name}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-accent hover:underline">
              <FileText className="size-3.5" aria-hidden="true" /> {a.name}
            </a>
          ))}
        </div>
        <p className="text-xs text-fg-muted">
          Sandbox {e.sandbox.provider} · operation <Mono>{e.sandbox.operationId ?? "none"}</Mono>
          {e.retryOf ? " · repeat of an earlier execution" : ""}
        </p>
      </div>
    </details>
  );
}

export function Ledger({ obligations }: { obligations: Obligation[] }) {
  const present = useMemo(() => [...new Set(obligations.map((o) => o.status))], [obligations]);
  return (
    <DataTable
      rows={obligations}
      rowKey={(o) => o.id}
      empty="No obligations."
      searchText={(o) => `${o.asset.label} ${o.objective} ${o.reason ?? ""}`}
      searchLabel="Search checks"
      filters={present.map((s) => ({ id: s, label: STATUS_STYLE[s].label, test: (o: Obligation) => o.status === s }))}
      columns={[
        { label: "Check", cell: (o) => <span><span className="block text-fg">{o.objective}</span><span className="block text-xs text-fg-muted">{o.asset.label}{o.origin === "authored" ? " · AI-authored scenario" : ""}</span></span> },
        { label: "Layer", cell: (o) => <span className="text-xs text-fg-muted">{o.layer.replace("_", " ")}</span>, className: "hidden md:table-cell" },
        { label: "Expected (oracle)", cell: (o) => <span className="text-xs text-fg-muted">{o.oracle.expected}</span>, className: "hidden lg:table-cell" },
        {
          label: "Result",
          cell: (o) => {
            const s = STATUS_STYLE[o.status];
            return (
              <span>
                <Badge tone={s.tone}>
                  <s.icon className={cn("size-3.5", o.status === "running" && "animate-spin")} aria-hidden="true" />
                  {s.label}
                </Badge>
                {o.reason && <span className="mt-1 block max-w-md text-xs text-fg-muted">{o.reason}</span>}
              </span>
            );
          },
        },
      ]}
    />
  );
}

/** Reports from before the release decision existed: the headline, totals and measures. */
export function LegacySummary({ report: r }: { report: NonNullable<TestingRunDetail["report"]> }) {
  return (
    <Card className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <CardTitle className="max-w-3xl">{r.headline}</CardTitle>
        <Badge tone={r.verdict === "defects_found" ? "bad" : r.verdict === "no_defects_found" ? "good" : "warn"}>
          {r.verdict === "defects_found" ? "Defects found" : r.verdict === "problems_found" ? "Build or test problems" : r.verdict === "no_defects_found" ? "No defects found" : r.verdict === "partial" ? "Partly tested" : "Could not test"}
        </Badge>
      </div>
      <ul className="flex flex-wrap gap-2" aria-label="Results by status">
        {(Object.entries(r.totals) as Array<[ObligationStatus, number]>)
          .filter(([, n]) => n > 0)
          .map(([s, n]) => {
            const st = STATUS_STYLE[s];
            return (
              <li key={s}>
                <Badge tone={st.tone}>
                  <st.icon className="size-3.5" aria-hidden="true" />
                  <span className="tabular-nums">{n}</span> {st.label.toLowerCase()}
                </Badge>
              </li>
            );
          })}
      </ul>
      <div className="grid gap-4 sm:grid-cols-2">
        {r.measures.map((m) => (
          <div key={m.label}>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-fg">{m.label}</span>
              <span className="shrink-0 text-fg-muted tabular-nums">
                {m.numerator} of {m.denominator}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
              <div className="h-full rounded-full bg-accent" style={{ width: `${m.denominator ? (m.numerator / m.denominator) * 100 : 0}%` }} />
            </div>
            {m.note && <p className="mt-1 text-xs text-fg-muted">{m.note}</p>}
          </div>
        ))}
      </div>
    </Card>
  );
}

export function Suites({ report: r }: { report: NonNullable<TestingRunDetail["report"]> }) {
  return (
    <section className="space-y-3">
      <h3 className="font-semibold text-fg">Your test suites</h3>
      {r.suites.map((s) => (
        <details key={s.workspace} className="group rounded-xl border border-border [&_summary::-webkit-details-marker]:hidden">
          <summary className="flex min-h-12 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
            <Badge tone={s.verdict === "passed" ? "good" : s.verdict === "failed" ? "bad" : "warn"}>{s.verdict.replace("_", " ")}</Badge>
            <span className="text-sm font-medium text-fg">
              {s.framework} · {s.workspace === "." ? "project root" : s.workspace}
            </span>
            <span className="text-sm text-fg-muted tabular-nums">
              {s.tests.total} tests: {s.tests.passed} passed, {s.tests.failed} failed, {s.tests.skipped} skipped
            </span>
          </summary>
          <div className="border-t border-border px-4 py-3">
            <p className="mb-3 text-xs text-fg-muted">
              <Mono>{s.command}</Mono> · ran {s.executionIds.length} time{s.executionIds.length === 1 ? "" : "s"} in separate clean sandboxes
            </p>
            <ul className="max-h-80 space-y-1 overflow-auto text-sm">
              {[...s.cases].sort((a, b) => Number(b.status !== "passed") - Number(a.status !== "passed")).map((c, i) => (
                <li key={`${c.name}-${i}`} className="flex items-start gap-2">
                  {c.status === "passed" ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-label="passed" /> : c.status === "skipped" ? <CircleDashed className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-label="skipped" /> : <CircleX className="mt-0.5 size-4 shrink-0 text-danger" aria-label="failed" />}
                  <span className="min-w-0">
                    <span className="text-fg">{c.name}</span>
                    {c.message && <span className="block truncate text-xs text-fg-muted">{c.message}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </details>
      ))}
    </section>
  );
}

export function LoadResults({ load, runId }: { load: NonNullable<NonNullable<TestingRunDetail["report"]>["load"]>; runId: string }) {
  const reports = load.executionId ? load.stages.filter((s) => s.reportName) : [];
  return (
    <section className="space-y-3">
      <h3 className="font-semibold text-fg">Load and capacity</h3>
      <p className="text-sm text-fg-muted">{load.note}</p>
      <DataTable
        rows={load.stages}
        rowKey={(s) => s.name}
        empty="No load stage ran."
        columns={[
          { label: "Stage", cell: (s) => <span className="font-medium text-fg capitalize">{s.name}</span> },
          { label: "Users", cell: (s) => <span className="tabular-nums">{s.vus}</span> },
          { label: "Requests", cell: (s) => <span className="tabular-nums">{s.requests}{s.verdict === "invalid" ? "" : ` (${s.rps}/s)`}</span> },
          { label: "p95", cell: (s) => <span className="tabular-nums">{s.p95Ms == null ? "not measured" : `${s.p95Ms} ms`}</span> },
          { label: "Errors", cell: (s) => <span className="tabular-nums">{s.errorRatePct}%</span> },
          {
            label: "Result",
            cell: (s) =>
              s.name === "breakpoint" ? (
                <Badge tone={s.brokeBy && s.brokeBy !== "generator" ? "warn" : "good"}>{s.limitRps != null ? `limit about ${Math.round(s.limitRps)}/s` : s.brokeBy ? "unhealthy from the start" : "no limit reached"}</Badge>
              ) : (
                <Badge tone={s.verdict === "passed" ? "good" : s.verdict === "failed" ? "bad" : "muted"}>{s.verdict === "measured" ? "measured, no threshold" : s.verdict === "invalid" ? "not valid: the app stopped" : s.verdict}</Badge>
              ),
          },
        ]}
      />
      {reports.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-sm text-fg-muted">k6&apos;s own report of each stage (an HTML file to save and open; it shows every metric k6 collected).</p>
          <div className="flex flex-wrap gap-2">
            {reports.map((s) => (
              <a key={s.name} href={`/v1/testing-runs/${runId}/executions/${load.executionId}/artifacts/${s.reportName}`} download className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-border px-3 text-sm text-fg hover:border-fg/20">
                <FileText className="size-3.5" aria-hidden="true" /> <span className="capitalize">{s.name}</span> k6 report
              </a>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

export function Fixtures({ fixtures }: { fixtures: NonNullable<NonNullable<TestingRunDetail["report"]>["fixtures"]> }) {
  return (
    <section className="space-y-3">
      <h3 className="font-semibold text-fg">Test data and sign-in setup</h3>
      <p className="text-sm text-fg-muted">Run once before the checks, in dependency order. A check whose setup failed was not sent; it is listed as blocked.</p>
      <ul className="space-y-2 text-sm">
        {fixtures.nodes.map((n) => (
          <li key={n.id} className="flex items-start gap-2">
            {n.ok === true ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-label="worked" /> : n.ok === false ? <CircleX className="mt-0.5 size-4 shrink-0 text-danger" aria-label="failed" /> : <CircleDashed className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-label="not run" />}
            <span className="min-w-0">
              <span className="text-fg">{n.label}</span>
              <span className="block text-xs break-words text-fg-muted">{n.detail}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function EnvironmentAndAudit({ run, report: r }: { run: TestingRunDetail; report: NonNullable<TestingRunDetail["report"]> }) {
  const stages = Object.entries(run.usage.byStage ?? {});
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="space-y-4">
        <h3 className="font-semibold text-fg">Environment and cost</h3>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <Labelled label="Sandbox">{r.environment.provider}</Labelled>
          <Labelled label="Image">
            <Mono>{r.environment.image}</Mono>
          </Labelled>
          <Labelled label="Runtime">{r.environment.runtime ?? "unknown"}</Labelled>
          <Labelled label="Network">{r.environment.network}</Labelled>
          <Labelled label="AI this run">
            {run.usage.aiCalls} calls · {(run.usage.inputTokens + run.usage.outputTokens).toLocaleString()} tokens · ${run.usage.costUsd.toFixed(3)}
            {run.usage.planSource === "cache" && <span className="block text-xs text-fg-muted">Plan reused from an earlier run of this code (saved about ${(run.usage.savedByCacheUsd ?? 0).toFixed(3)}).</span>}
          </Labelled>
          {run.projectSpendUsd != null && <Labelled label="All Testing AI for this project">${run.projectSpendUsd.toFixed(3)}</Labelled>}
          {(() => {
            const decisive = run.obligations.filter((o) => ["passed", "failed", "flaky"].includes(o.status)).length;
            const confirmed = run.findings.filter((f) => f.kind === "product_defect" && f.status === "confirmed").length;
            return decisive > 0 ? (
              <Labelled label="Cost per result">
                ${(run.usage.costUsd / decisive).toFixed(4)} per decisive check{confirmed ? ` · $${(run.usage.costUsd / confirmed).toFixed(3)} per confirmed defect` : ""}
              </Labelled>
            ) : null;
          })()}
          <Labelled label="Sandbox work">
            {run.usage.sandboxOperations} operations · {run.usage.sandboxCpuSeconds} CPU seconds
          </Labelled>
          {r.performance && (
            <Labelled label="Single-user probe latency (diagnostic)">
              p50 {r.performance.p50Ms} ms · p95 {r.performance.p95Ms} ms over {r.performance.requests} requests; not a load test
            </Labelled>
          )}
          {r.environment.syntheticEnv.length > 0 && <Labelled label="Synthetic settings (names)">{r.environment.syntheticEnv.join(", ")}</Labelled>}
        </dl>
        {stages.length > 0 && (
          <div>
            <p className="text-xs font-medium tracking-wide text-fg-muted uppercase">AI cost by stage</p>
            <ul className="mt-2 space-y-1 text-sm">
              {stages.map(([name, s]) => (
                <li key={name} className="flex justify-between gap-3">
                  <span className="text-fg capitalize">{name}</span>
                  <span className="text-fg-muted tabular-nums">
                    {s.calls} call{s.calls === 1 ? "" : "s"} · ${s.costUsd.toFixed(3)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      <section className="space-y-4">
        <h3 className="font-semibold text-fg">Report checks</h3>
        {r.release && (
          <ul className="space-y-2 text-sm" aria-label="Release gates">
            {r.release.gates.map((g) => (
              <li key={g.id} className="flex items-start gap-2">
                {g.ok === true ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-label="met" /> : g.ok === false ? <CircleX className="mt-0.5 size-4 shrink-0 text-danger" aria-label="not met" /> : <CircleDashed className="mt-0.5 size-4 shrink-0 text-fg-muted" aria-label="does not apply" />}
                <span>
                  <span className="text-fg">{g.label}</span>
                  <span className="block text-xs text-fg-muted">{g.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <ul className="space-y-2 text-sm" aria-label="Report audit">
          {r.audit.map((a) => (
            <li key={a.check} className="flex items-start gap-2">
              {a.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-label="ok" /> : <CircleX className="mt-0.5 size-4 shrink-0 text-danger" aria-label="failed" />}
              <span>
                <span className="text-fg">{a.check}</span>
                <span className="block text-xs text-fg-muted">{a.detail}</span>
              </span>
            </li>
          ))}
        </ul>
        <div>
          <p className="text-xs font-medium tracking-wide text-fg-muted uppercase">Limitations</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-fg-muted">
            {r.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
