"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, CircleCheck, CircleDashed, CircleX, Download, RotateCcw, ShieldQuestion } from "lucide-react";
import type { AiCaseCategory, AiCategoryResult, AiEvaluationCase, AiEvaluationDecision, AiEvaluationFinding, AiEvaluationRunDetail } from "@cybercheck/contracts";
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
import { cancelAiEvaluation, rerunAiEvaluation, useAiRun } from "./use-ai-evaluator";

type Tone = "good" | "bad" | "warn" | "muted" | "info";

const DECISION: Record<AiEvaluationDecision, { label: string; tone: Tone }> = {
  not_applicable: { label: "Not applicable: no AI component", tone: "muted" },
  ready_with_evidence: { label: "Ready, with evidence", tone: "good" },
  not_ready_ai_findings: { label: "Not ready: AI findings", tone: "bad" },
  not_ready_insufficient_evidence: { label: "Not ready: not enough evidence", tone: "warn" },
  not_ready_environment_blocked: { label: "Not ready: the environment could not run it", tone: "warn" },
};

const VERDICT: Record<AiEvaluationCase["verdict"], { label: string; tone: Tone; icon: typeof CircleCheck }> = {
  passed: { label: "Passed", tone: "good", icon: CircleCheck },
  failed: { label: "Failed", tone: "bad", icon: CircleX },
  inconclusive: { label: "Undecided", tone: "warn", icon: ShieldQuestion },
  blocked: { label: "Not run", tone: "muted", icon: CircleDashed },
};

const CATEGORY: Record<AiCaseCategory, string> = {
  functional: "Answers",
  structured_output: "Structured output",
  grounding: "Grounding and citations",
  prompt_injection: "Prompt injection",
  leakage: "Leakage",
  isolation: "User and tenant isolation",
  tools: "Tools",
  output_rendering: "Rendered output",
  robustness: "Robustness",
  multi_turn: "Multi-turn",
  reliability: "Reliability",
  performance: "Performance",
  fairness: "Fairness",
};

const MODE: Record<string, string> = { replay: "Replay model", direct: "Direct (no model)", live: "Live model", none: "Nothing executed" };

const GROUPS: Array<{ id: string; label: string; categories: AiCaseCategory[] }> = [
  { id: "quality", label: "Quality", categories: ["functional", "structured_output", "fairness"] },
  { id: "grounding", label: "Grounding and retrieval", categories: ["grounding"] },
  { id: "safety", label: "Safety and privacy", categories: ["leakage", "prompt_injection", "isolation", "output_rendering"] },
  { id: "tools", label: "Tools and agents", categories: ["tools"] },
  { id: "robustness", label: "Robustness and multi-turn", categories: ["robustness", "multi_turn"] },
  { id: "reliability", label: "Reliability", categories: ["reliability"] },
];

const PHASES = [
  { id: "admission", label: "Admit" },
  { id: "applicability", label: "Find the AI" },
  { id: "datasets", label: "Datasets" },
  { id: "preparing", label: "Runtime" },
  { id: "compiling", label: "Compile" },
  { id: "executing", label: "Run cases" },
  { id: "aggregating", label: "Grade" },
  { id: "reporting", label: "Report" },
];

type Tab = "summary" | "findings" | "cases" | "categories" | "performance" | "components" | "untested";
/** Passive checks run on every reply: they raise findings but never decide the case's own verdict. */
const HYGIENE = new Set(["no_credential", "no_prompt_echo", "no_canary", "no_pii"]);
const pct = (n: number | null) => (n == null ? "n/a" : `${Math.round(n * 100)}%`);

export function AiRunView({ projectId, runId }: { projectId: string; runId: string }) {
  const { run, events, error, reload } = useAiRun(runId);
  const view = useViewParams();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const tab = (view.get("tab") as Tab | null) ?? "summary";
  if (error && !run) return <Alert>{error.message} {error.fix}</Alert>;
  if (!run)
    return (
      <p className="flex items-center gap-2 py-10 text-fg-muted">
        <Spinner /> Loading run
      </p>
    );
  const active = ACTIVE_RUN.has(run.status);
  const undecided = run.cases.filter((c) => c.verdict !== "passed" && c.verdict !== "failed");
  const confirmed = run.findings.filter((f) => f.status === "confirmed");
  const items: TabItem<Tab>[] = [
    { id: "summary", label: "Decision summary" },
    { id: "findings", label: "Findings", count: run.findings.length, tone: confirmed.length ? "bad" : "muted" },
    { id: "cases", label: "Cases", count: run.cases.length, tone: "muted" },
    { id: "categories", label: "Categories" },
    { id: "performance", label: "Performance and cost" },
    { id: "components", label: "Components and targets" },
    { id: "untested", label: "Untested and audit", count: (run.report?.untested.length ?? 0) + undecided.length, tone: "muted" },
  ];
  const act = async (fn: () => Promise<{ run: { id: string } }>, go: boolean) => {
    setBusy(true);
    setActionError(null);
    try {
      const r = await fn();
      if (go) router.push(`/app/projects/${projectId}/ai-evaluator/${r.run.id}`);
      else reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? `${e.message} ${e.fix ?? ""}` : "The action did not complete.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <CodeViewerProvider snapshotId={run.snapshotId}>
      <div className="space-y-6">
        <Link href={`/app/checks/ai-evaluator?project=${projectId}`} className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-accent hover:underline">
          <ArrowLeft className="size-4" aria-hidden="true" /> AI Evaluator
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-fg">AI Evaluator check</h1>
          <RunStatusBadge status={run.status} />
          <span className="text-sm text-fg-muted">{duration(run.startedAt, run.finishedAt) ?? ""}</span>
          {run.parentRunId && (
            <Link href={`/app/projects/${projectId}/ai-evaluator/${run.parentRunId}`} className="text-sm text-accent hover:underline">
              Rerun of an earlier run
            </Link>
          )}
          <div className="ml-auto flex flex-wrap gap-2">
            {active && (
              <Button type="button" variant="outline" shape="pill" size="sm" disabled={busy} onClick={() => void act(() => cancelAiEvaluation(run.id), false)}>
                Cancel
              </Button>
            )}
            {!active && run.report && undecided.length > 0 && run.report.decision !== "not_applicable" && (
              <Button type="button" variant="outline" shape="pill" size="sm" disabled={busy} onClick={() => void act(() => rerunAiEvaluation(run.id, "missing"), true)}>
                <RotateCcw aria-hidden="true" /> Rerun {undecided.length} undecided
              </Button>
            )}
            {!active && run.report && (
              <>
                <a href={`/v1/ai-evaluation-runs/${run.id}/export?format=md`} download className={buttonVariants({ variant: "outline", shape: "pill", size: "sm" })}>
                  <Download aria-hidden="true" /> Markdown
                </a>
                <a href={`/v1/ai-evaluation-runs/${run.id}/export?format=json`} download className={buttonVariants({ variant: "outline", shape: "pill", size: "sm" })}>
                  <Download aria-hidden="true" /> JSON
                </a>
              </>
            )}
          </div>
        </div>
        {actionError && <Alert>{actionError}</Alert>}

        {active ? (
          <LiveProgress run={run} events={events} />
        ) : !run.report ? (
          <Alert>{run.error ?? "This run has no report."}</Alert>
        ) : (
          <>
            <Tabs items={items} value={tab} onChange={(id) => view.set({ tab: id === "summary" ? null : id, sub: null })} label="AI Evaluator results" idPrefix="ai" />
            <TabPanel idPrefix="ai" value={tab}>
              {tab === "summary" && <Summary run={run} />}
              {tab === "findings" && <Findings findings={run.findings} />}
              {tab === "cases" && <CaseExplorer cases={run.cases} onRerun={(id) => void act(() => rerunAiEvaluation(run.id, "cases", [id]), true)} busy={busy} />}
              {tab === "categories" && <Categories run={run} />}
              {tab === "performance" && <Performance run={run} />}
              {tab === "components" && <Components run={run} />}
              {tab === "untested" && <UntestedAudit run={run} undecided={undecided} />}
            </TabPanel>
          </>
        )}
      </div>
    </CodeViewerProvider>
  );
}

function LiveProgress({ run, events }: { run: AiEvaluationRunDetail; events: Array<{ seq: number; type: string; message: string }> }) {
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
        {events
          .filter((e) => !e.type.startsWith("phase:"))
          .slice(-12)
          .map((e) => (
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

function CategoryRow({ c }: { c: AiCategoryResult }) {
  const tone: Tone = c.status === "passed" ? "good" : c.status === "failed" ? "bad" : c.status === "insufficient" ? "warn" : "muted";
  const decided = c.passed + c.failed;
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
      <span className="w-48 shrink-0 text-sm font-medium text-fg">{CATEGORY[c.category]}</span>
      <span className="flex min-w-0 flex-1 items-center gap-3">
        <span className="h-2 min-w-16 flex-1 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
          <span className={cn("block h-full rounded-full", tone === "good" ? "bg-success" : tone === "bad" ? "bg-danger" : "bg-warning")} style={{ width: `${decided ? (c.passed / decided) * 100 : 0}%` }} />
        </span>
        <span className="shrink-0 text-sm text-fg tabular-nums">
          {c.passed} of {decided} passed
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <Badge tone={tone}>{c.status === "insufficient" ? "not enough evidence" : c.status.replace("_", " ")}</Badge>
        <span className="text-xs text-fg-muted">
          {c.threshold != null ? `needs ${pct(c.threshold)}` : "no threshold"}
          {c.undecided ? `, ${c.undecided} undecided` : ""}
        </span>
      </span>
    </li>
  );
}

function Summary({ run }: { run: AiEvaluationRunDetail }) {
  const r = run.report!;
  const d = DECISION[r.decision];
  return (
    <>
      <Card className={cn(d.tone === "good" ? "border-success/40" : d.tone === "bad" ? "border-danger/40" : d.tone === "warn" ? "border-warning/40" : "")}>
        <Badge tone={d.tone}>{d.label}</Badge>
        <p className="mt-3 text-base text-fg">{r.headline}</p>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-fg-muted">
          {r.claims.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </Card>
      {r.decision !== "not_applicable" && (
        <>
          <div className="grid gap-6 md:grid-cols-3">
            <Card>
              <CardTitle>Decided cases</CardTitle>
              <p className="mt-3 text-3xl font-semibold text-fg tabular-nums">
                {r.coverage.decisive} <span className="text-base font-normal text-fg-muted">of {r.coverage.applicable}</span>
              </p>
              <p className="mt-1 text-sm text-fg-muted">
                needs {pct(r.thresholds.coverage)}; critical {r.coverage.criticalDecisive} of {r.coverage.criticalApplicable}
              </p>
            </Card>
            <Card>
              <CardTitle>Findings</CardTitle>
              <p className="mt-3 text-3xl font-semibold text-fg tabular-nums">
                {r.findings.confirmed} <span className="text-base font-normal text-fg-muted">confirmed</span>
              </p>
              <p className="mt-1 text-sm text-fg-muted">{r.findings.confirmedCriticalHigh} critical or high; every one reproduced by a deterministic check</p>
            </Card>
            <Card>
              <CardTitle>How the AI was exercised</CardTitle>
              <p className="mt-3 text-lg font-semibold text-fg">{MODE[r.mode.used] ?? r.mode.used}</p>
              <p className="mt-1 text-sm text-fg-muted">{r.mode.reason}</p>
            </Card>
          </div>
          <Card>
            <CardTitle>Results by category</CardTitle>
            {r.categories.length ? (
              <ul className="mt-2 divide-y divide-border">
                {r.categories.map((c) => (
                  <CategoryRow key={c.category} c={c} />
                ))}
              </ul>
            ) : (
              <p className="mt-3 text-sm text-fg-muted">No category was measured.</p>
            )}
          </Card>
        </>
      )}
    </>
  );
}

function Findings({ findings }: { findings: AiEvaluationFinding[] }) {
  if (!findings.length) return <EmptyState icon={CircleCheck} title="No AI findings" body="No case failed a hard check and no reply failed a hygiene check. Undecided and untested cases are listed in their own tab." />;
  return (
    <ul className="space-y-4">
      {findings.map((f) => (
        <li key={f.id}>
          <Card>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={SEVERITY_TONE[f.severity]}>{f.severity}</Badge>
              <Badge tone={f.status === "confirmed" ? "bad" : "warn"}>{f.status}</Badge>
              <span className="text-xs text-fg-muted">
                {f.id} · {CATEGORY[f.category]} · {MODE[f.mode] ?? f.mode}
              </span>
            </div>
            <h3 className="mt-2 font-medium text-fg">{f.title}</h3>
            <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm md:grid-cols-[10rem_minmax(0,1fr)]">
              <dt className="text-fg-muted">What should hold</dt>
              <dd className="text-fg">{f.expected}</dd>
              <dt className="text-fg-muted">What was observed</dt>
              <dd className="text-fg">{f.observed}</dd>
              <dt className="text-fg-muted">Why it matters</dt>
              <dd className="text-fg">{f.impact}</dd>
              <dt className="text-fg-muted">Confirmation</dt>
              <dd className="text-fg">{f.confirmation}</dd>
              <dt className="text-fg-muted">Fix</dt>
              <dd className="text-fg">{f.remediation}</dd>
              <dt className="text-fg-muted">Route</dt>
              <dd>
                <Mono>{f.endpoint ?? "none"}</Mono>
              </dd>
              <dt className="text-fg-muted">Cases</dt>
              <dd className="text-fg-muted">{f.caseIds.join(", ")}</dd>
              {f.sourceEvidence.length > 0 && (
                <>
                  <dt className="text-fg-muted">Where in the code</dt>
                  <dd className="flex flex-wrap gap-2">
                    {f.sourceEvidence.map((e, i) => (
                      <EvidenceLink key={`${e.path}:${e.line}:${i}`} evidence={e} />
                    ))}
                  </dd>
                </>
              )}
              {f.owasp.length > 0 && (
                <>
                  <dt className="text-fg-muted">Standards</dt>
                  <dd className="text-fg-muted">{f.owasp.join(", ")}</dd>
                </>
              )}
              {f.limitations.length > 0 && (
                <>
                  <dt className="text-fg-muted">Limits</dt>
                  <dd className="text-fg-muted">{f.limitations.join(" ")}</dd>
                </>
              )}
            </dl>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function VerdictBadge({ v }: { v: AiEvaluationCase["verdict"] }) {
  const s = VERDICT[v];
  return (
    <Badge tone={s.tone}>
      <s.icon className="size-3.5" aria-hidden="true" /> {s.label}
    </Badge>
  );
}

function CaseDetail({ c, onRerun, busy }: { c: AiEvaluationCase; onRerun?: (id: string) => void; busy?: boolean }) {
  const s = c.samples[0];
  return (
    <div className="space-y-4 px-4 pb-4 text-sm">
      <dl className="grid gap-x-6 gap-y-2 md:grid-cols-[10rem_minmax(0,1fr)]">
        <dt className="text-fg-muted">Input</dt>
        <dd className="text-fg">{c.inputClass}</dd>
        <dt className="text-fg-muted">Conversation</dt>
        <dd className="text-fg">{c.conversationSetup}</dd>
        <dt className="text-fg-muted">Expected</dt>
        <dd className="text-fg">{c.oracle.expected}</dd>
        <dt className="text-fg-muted">Result</dt>
        <dd className="text-fg">{c.reason || "No reason recorded."}</dd>
        <dt className="text-fg-muted">Source</dt>
        <dd className="text-fg-muted">
          {c.source.kind === "builtin" ? "Built-in catalogue" : "Uploaded dataset"} version <Mono>{c.source.version}</Mono>, digest <Mono>{c.source.digest.slice(0, 12)}</Mono>
        </dd>
        <dt className="text-fg-muted">Route</dt>
        <dd>
          <Mono>{c.target.endpoint}</Mono> <span className="text-fg-muted">({MODE[c.mode] ?? c.mode})</span>
        </dd>
        {c.preconditions.length > 0 && (
          <>
            <dt className="text-fg-muted">Preconditions</dt>
            <dd className="text-fg">{c.preconditions.map((p) => `${p.what}: ${p.met === null ? "unknown" : p.met ? "met" : "not met"}`).join("; ")}</dd>
          </>
        )}
      </dl>
      {c.graders.length > 0 && (
        <div>
          <p className="text-xs font-medium tracking-wide text-fg-muted uppercase">Deterministic checks</p>
          <ul className="mt-2 divide-y divide-border">
            {c.graders.map((g) => (
              <li key={g.grader} className="flex flex-col gap-1 py-2 sm:flex-row sm:items-start sm:gap-4">
                <span className="flex shrink-0 items-center gap-2 sm:w-64">
                  <Badge tone={g.pass === null ? "muted" : g.pass ? "good" : "bad"}>{g.pass === null ? "undecided" : g.pass ? "pass" : "fail"}</Badge>
                  <Mono>{g.grader}</Mono>
                </span>
                <span className="min-w-0 text-fg">
                  {g.detail} <span className="text-xs text-fg-muted">({HYGIENE.has(g.grader) ? "reply check: a failure is a finding" : g.hard ? "decides the case" : "reported only"})</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {s && (
        <div className="space-y-2">
          <p className="text-xs font-medium tracking-wide text-fg-muted uppercase">What the app answered (redacted)</p>
          {s.turns.map((t, i) => (
            <div key={i} className="rounded-lg bg-surface-2/60 p-3">
              <p className="text-xs text-fg-muted">
                {t.request} {t.as ? `as ${t.as}` : ""}: <span className="tabular-nums">{t.status ?? "no response"}</span>, <span className="tabular-nums">{t.ms}</span> ms
              </p>
              <p className="mt-1 wrap-break-word whitespace-pre-wrap text-fg">{t.reply ?? t.error ?? "No reply field."}</p>
            </div>
          ))}
          <p className="text-xs text-fg-muted tabular-nums">
            {s.modelRequests} model call(s), about {s.tokens.input} input and {s.tokens.output} output tokens{s.costUsd === 0 ? ", no model cost (replay)" : ""}
            {s.citations.length ? `; citations: ${s.citations.join(", ")}` : ""}
            {s.toolCalls.length ? `; tools: ${s.toolCalls.map((x) => x.name).join(", ")}` : ""}
          </p>
        </div>
      )}
      {c.limitations.length > 0 && <p className="text-xs text-fg-muted">{c.limitations.join(" ")}</p>}
      {c.sourceEvidence.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {c.sourceEvidence.map((e, i) => (
            <EvidenceLink key={`${e.path}:${e.line}:${i}`} evidence={e} />
          ))}
        </div>
      )}
      {onRerun && (
        <Button type="button" variant="outline" shape="pill" size="sm" disabled={busy} onClick={() => onRerun(c.id)}>
          <RotateCcw aria-hidden="true" /> Rerun this case
        </Button>
      )}
    </div>
  );
}

function CaseList({ cases, onRerun, busy }: { cases: AiEvaluationCase[]; onRerun?: (id: string) => void; busy?: boolean }) {
  return (
    <ul className="divide-y divide-border rounded-xl border border-border">
      {cases.map((c) => (
        <li key={c.id}>
          <details className="group [&_summary::-webkit-details-marker]:hidden">
            <summary className="flex min-h-12 cursor-pointer list-none flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
              <span className="w-28 shrink-0">
                <VerdictBadge v={c.verdict} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-fg">{c.title}</span>
                <span className="block truncate text-xs text-fg-muted">
                  {CATEGORY[c.category]} · {c.priority} · <Mono>{c.id}</Mono>
                </span>
              </span>
              {c.findingIds.length > 0 && <span className="shrink-0 text-xs font-medium text-danger">{c.findingIds.join(", ")}</span>}
            </summary>
            <CaseDetail c={c} onRerun={onRerun} busy={busy} />
          </details>
        </li>
      ))}
    </ul>
  );
}

function CaseExplorer({ cases, onRerun, busy }: { cases: AiEvaluationCase[]; onRerun: (id: string) => void; busy: boolean }) {
  const view = useViewParams();
  const f = (view.get("f") as AiEvaluationCase["verdict"] | "all" | null) ?? "all";
  const filters: Array<{ id: AiEvaluationCase["verdict"] | "all"; label: string }> = [{ id: "all", label: "All" }, ...(["failed", "inconclusive", "blocked", "passed"] as const).map((v) => ({ id: v, label: VERDICT[v].label }))];
  const shown = f === "all" ? cases : cases.filter((c) => c.verdict === f);
  if (!cases.length) return <EmptyState icon={CircleDashed} title="No cases" body="Nothing was compiled for this run." />;
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter cases by result">
        {filters.map((x) => {
          const n = x.id === "all" ? cases.length : cases.filter((c) => c.verdict === x.id).length;
          return (
            <button
              key={x.id}
              type="button"
              aria-pressed={f === x.id}
              onClick={() => view.set({ f: x.id === "all" ? null : x.id })}
              className={cn("inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-sm transition-colors", f === x.id ? "border-accent bg-accent/10 text-accent" : "border-border text-fg-muted hover:text-fg")}
            >
              {x.label} <span className="tabular-nums">{n}</span>
            </button>
          );
        })}
      </div>
      <div className="mt-4">{shown.length ? <CaseList cases={shown} onRerun={onRerun} busy={busy} /> : <p className="text-sm text-fg-muted">No case with this result.</p>}</div>
    </Card>
  );
}

function Categories({ run }: { run: AiEvaluationRunDetail }) {
  const view = useViewParams();
  const sub = view.get("sub") ?? "quality";
  const r = run.report!;
  const group = GROUPS.find((g) => g.id === sub) ?? GROUPS[0]!;
  const results = r.categories.filter((c) => group.categories.includes(c.category));
  const cases = run.cases.filter((c) => group.categories.includes(c.category));
  const passive = group.id === "safety" ? run.cases.filter((c) => c.graders.some((g) => ["no_credential", "no_prompt_echo", "no_canary", "no_pii"].includes(g.grader) && g.pass === false)) : [];
  const items: TabItem<string>[] = GROUPS.map((g) => ({ id: g.id, label: g.label, count: run.cases.filter((c) => g.categories.includes(c.category)).length, tone: r.categories.some((c) => g.categories.includes(c.category) && c.status === "failed") ? "bad" : "muted" }));
  return (
    <div className="space-y-6">
      <Tabs items={items} value={group.id} onChange={(id) => view.set({ sub: id === "quality" ? null : id })} label="Category groups" level="sub" idPrefix="ai-cat" />
      <TabPanel idPrefix="ai-cat" value={group.id}>
        {results.length ? (
          <Card>
            <ul className="divide-y divide-border">
              {results.map((c) => (
                <CategoryRow key={c.category} c={c} />
              ))}
            </ul>
            {results.flatMap((c) => c.limitations).length > 0 && <p className="mt-3 text-xs text-fg-muted">{[...new Set(results.flatMap((c) => c.limitations))].join(" ")}</p>}
          </Card>
        ) : (
          <EmptyState icon={CircleDashed} title={`${group.label}: not measured`} body={group.id === "tools" || group.id === "safety" ? "This engine version runs only defensive cases. Upload a dataset with cases in these categories, or wait for the adversarial catalogue." : "No case in this run belongs to this group."} />
        )}
        {(cases.length > 0 || passive.length > 0) && (
          <div className="mt-6">
            <CaseList cases={cases.length ? cases : passive} />
          </div>
        )}
      </TabPanel>
    </div>
  );
}

function Performance({ run }: { run: AiEvaluationRunDetail }) {
  const p = run.report!.performance;
  const r = run.report!;
  const stat = (label: string, value: string, note: string) => (
    <Card>
      <CardTitle>{label}</CardTitle>
      <p className="mt-3 text-3xl font-semibold text-fg tabular-nums">{value}</p>
      <p className="mt-1 text-sm text-fg-muted">{note}</p>
    </Card>
  );
  return (
    <>
      <div className="grid gap-6 md:grid-cols-3">
        {stat("Median turn", p.p50Ms == null ? "n/a" : `${p.p50Ms} ms`, `over ${p.turns} turn(s); failure-injection cases left out`)}
        {stat("p95 turn", p.p95Ms == null ? "n/a" : `${p.p95Ms} ms`, `threshold ${r.thresholds.p95LatencyMs} ms${r.mode.used === "replay" ? "; not judged in replay" : ""}`)}
        {stat("Model calls", String(p.modelRequests), `about ${p.tokensIn} input and ${p.tokensOut} output tokens`)}
      </div>
      <Card>
        <CardTitle>Cost</CardTitle>
        <p className="mt-2 text-sm text-fg">
          {p.costUsd == null ? "Not measured." : `$${p.costUsd.toFixed(4)}`} {p.costBasis === "not_measured" ? "Replay answers cost nothing, and the real model's cost was not measured." : ""}
        </p>
        <p className="mt-2 text-sm text-fg-muted tabular-nums">
          This run used {run.usage.sandboxOperations} sandbox operation(s) and {run.usage.sandboxCpuSeconds} CPU second(s); cybercheck AI cost ${run.usage.costUsd.toFixed(3)}.
        </p>
      </Card>
      {r.metrics.length > 0 && (
        <Card>
          <CardTitle>Metrics</CardTitle>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Metrics with their denominators</caption>
              <thead className="text-xs text-fg-muted">
                <tr>
                  <th className="py-2 pr-4 font-medium">Metric</th>
                  <th className="py-2 pr-4 font-medium">Value</th>
                  <th className="py-2 pr-4 font-medium">Of</th>
                  <th className="py-2 pr-4 font-medium">Threshold</th>
                  <th className="py-2 pr-4 font-medium">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {r.metrics.map((m) => (
                  <tr key={m.name}>
                    <td className="py-2 pr-4 text-fg">{m.name}</td>
                    <td className="py-2 pr-4 tabular-nums">{m.score == null ? "n/a" : m.score <= 1 ? pct(m.score) : m.score}</td>
                    <td className="py-2 pr-4 tabular-nums text-fg-muted">{m.denominator}</td>
                    <td className="py-2 pr-4 tabular-nums text-fg-muted">{m.threshold == null ? "none" : m.threshold <= 1 ? pct(m.threshold) : m.threshold}</td>
                    <td className="py-2 pr-4">
                      <Badge tone={m.pass === null ? "muted" : m.pass ? "good" : "bad"}>{m.pass === null ? "not judged" : m.pass ? "met" : "missed"}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

const RUNTIME_LABEL: Record<string, string> = { nebius: "Nebius sandbox", local: "Local Docker", static: "Nothing executed", none: "Nothing executed" };

function Components({ run }: { run: AiEvaluationRunDetail }) {
  const a = run.report!.applicability;
  const env = run.report!.environment;
  return (
    <>
      {a.components.map((c) => {
        const t = a.targets.find((x) => x.target.componentId === c.id);
        return (
          <Card key={c.id}>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{c.name}</CardTitle>
              <Badge tone="info">{c.kind === "local_logic" ? "no model provider" : (c.provider.name ?? c.provider.family)}</Badge>
            </div>
            <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm md:grid-cols-[12rem_minmax(0,1fr)]">
              <dt className="text-fg-muted">Routes</dt>
              <dd className="flex flex-wrap gap-2">{c.endpoints.length ? c.endpoints.map((e) => <Mono key={e}>{e}</Mono>) : <span className="text-fg-muted">none found</span>}</dd>
              <dt className="text-fg-muted">Evaluated through</dt>
              <dd className="text-fg">{t ? <><Mono>{`${t.target.method ?? "POST"} ${t.target.path}`}</Mono>, reply at <Mono>{t.target.responseSelector}</Mono> ({t.boundBy === "user" ? "chosen by you" : "the only matching route"})</> : "not bound"}</dd>
              <dt className="text-fg-muted">Provider settings</dt>
              <dd className="text-fg">{c.provider.baseUrlEnv.length ? c.provider.baseUrlEnv.join(", ") : "none"}{c.provider.reason ? <span className="text-fg-muted"> ({c.provider.reason})</span> : null}</dd>
              <dt className="text-fg-muted">Tools</dt>
              <dd className="text-fg">{c.tools.length ? c.tools.map((x) => `${x.name ?? "unnamed"}${x.consequential ? " (consequential)" : ""}`).join(", ") : "none"}</dd>
              {c.systemPrompts.length > 0 && (
                <>
                  <dt className="text-fg-muted">System prompt</dt>
                  <dd className="flex flex-wrap gap-2">
                    {c.systemPrompts.map((e, i) => (
                      <EvidenceLink key={`${e.path}:${e.line}:${i}`} evidence={e} />
                    ))}
                  </dd>
                </>
              )}
            </dl>
          </Card>
        );
      })}
      {a.unbound.length > 0 && (
        <Alert tone="info">
          {a.unbound.map((u) => `${u.componentId}: ${u.reason}${u.candidates.length ? ` Candidates: ${u.candidates.join(", ")}.` : ""}`).join(" ")}
        </Alert>
      )}
      <Card>
        <CardTitle>Execution environment</CardTitle>
        <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm md:grid-cols-[12rem_minmax(0,1fr)]">
          <dt className="text-fg-muted">Where it ran</dt>
          <dd className="text-fg">{RUNTIME_LABEL[env.selected] ?? env.selected}</dd>
          {env.fallbackReason && (
            <>
              <dt className="text-fg-muted">Why not the preferred runtime</dt>
              <dd className="text-fg">{env.fallbackReason}</dd>
            </>
          )}
          <dt className="text-fg-muted">Isolation</dt>
          <dd className="text-fg">{env.isolation}</dd>
        </dl>
      </Card>
    </>
  );
}

function UntestedAudit({ run, undecided }: { run: AiEvaluationRunDetail; undecided: AiEvaluationCase[] }) {
  const r = run.report!;
  return (
    <>
      {undecided.length > 0 && (
        <Card>
          <CardTitle>Undecided or not run</CardTitle>
          <p className="mt-1 text-sm text-fg-muted">Each says why. They count against coverage until a rerun decides them; none counts as a pass.</p>
          <div className="mt-3">
            <CaseList cases={undecided} />
          </div>
        </Card>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle>Not tested in this run</CardTitle>
          <ul className="mt-3 space-y-2 text-sm">
            {r.untested.map((u) => (
              <li key={u.what}>
                <span className="text-fg">{u.what}</span> <span className="text-fg-muted">{u.reason}</span>
              </li>
            ))}
            {!r.untested.length && <li className="text-fg-muted">Nothing.</li>}
          </ul>
        </Card>
        <Card>
          <CardTitle>Judge, datasets and versions</CardTitle>
          <ul className="mt-3 space-y-2 text-sm">
            <li>
              <span className="text-fg">AI judge: {r.judge.status}.</span> <span className="text-fg-muted">{r.judge.reason}</span>
            </li>
            {r.datasets.map((d) => (
              <li key={d.id} className="text-fg">
                {d.name} <span className="text-fg-muted">({d.source}, version {d.version}, {d.cases} case(s), digest <Mono>{d.digest.slice(0, 12)}</Mono>)</span>
              </li>
            ))}
            <li className="text-fg-muted">
              Engine <Mono>{r.versions.engine}</Mono>, checks <Mono>{r.versions.grader}</Mono>, snapshot <Mono>{r.versions.snapshotDigest.slice(0, 12)}</Mono>
              {r.versions.runtimeImage ? <>, image <Mono>{r.versions.runtimeImage}</Mono></> : null}
            </li>
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
      {r.limitations.length > 0 && (
        <Card>
          <CardTitle>Limitations</CardTitle>
          <ul className="mt-3 list-disc space-y-1.5 pl-5 text-sm text-fg">
            {r.limitations.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
