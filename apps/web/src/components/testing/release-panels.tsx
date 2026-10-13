"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CircleAlert, CircleCheck, CircleHelp, CircleX, Download, ListChecks, RotateCcw, ShieldAlert, ShieldCheck, ShieldX } from "lucide-react";
import type { TestingReport, TestingRunDetail } from "@cybercheck/contracts";
import { Card, CardTitle } from "@/components/app/ui";
import { Badge, DataTable } from "@/components/architecture/parts";
import { Button, buttonVariants } from "@/components/ui/button";
import { Alert, Spinner } from "@/components/ui/form";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { rerunMissing } from "./use-testing";

type Release = NonNullable<TestingReport["release"]>;

export const DECISION: Record<Release["decision"], { label: string; tone: "good" | "bad" | "warn"; icon: typeof ShieldCheck }> = {
  ready: { label: "Ready to release", tone: "good", icon: ShieldCheck },
  ready_with_accepted_risk: { label: "Ready with accepted risk", tone: "warn", icon: ShieldAlert },
  not_ready_product_failures: { label: "Not ready: confirmed product defects", tone: "bad", icon: ShieldX },
  not_ready_insufficient_evidence: { label: "Not ready: insufficient evidence", tone: "warn", icon: ShieldAlert },
  not_ready_environment_blocked: { label: "Not ready: the environment blocked testing", tone: "warn", icon: ShieldAlert },
};

const ASSESSMENT: Record<NonNullable<TestingReport["assessment"]>, string> = {
  ready_with_evidence: "ready, with evidence",
  defects_found: "defects found",
  testing_system_problem: "testing-system problem",
  insufficient_evidence: "insufficient evidence",
  could_not_test: "could not test",
};

const TONE_TEXT = { good: "text-success", bad: "text-danger", warn: "text-warning" } as const;
const TONE_BG = { good: "bg-success/10", bad: "bg-danger/10", warn: "bg-warning/10" } as const;

export const LAYER_NAME: Record<string, string> = {
  environment: "Install, build and start",
  existing_suite: "Your own tests",
  unit: "Generated unit tests",
  api: "API",
  data: "Database",
  ui: "Screens and journeys",
  accessibility: "Accessibility",
  job: "Background jobs",
  integration: "External integrations",
  performance: "Load and capacity",
  reliability: "Reliability",
  deployment: "Deployment",
};

const PROOF_NAME: Record<string, string> = {
  static: "build",
  guard: "guard",
  validation: "validation",
  availability: "no crash",
  business_behavior: "behaviour",
  state_change: "state change",
  journey: "journey",
  accessibility: "accessibility",
  data_integrity: "data integrity",
  reliability: "reliability",
  capacity: "capacity",
};

function Meter({ value, threshold, tone, label }: { value: number | null; threshold?: number; tone: "good" | "bad" | "warn"; label: string }) {
  return (
    <div className="relative mt-2 h-2 overflow-hidden rounded-full bg-surface-2" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? 0}>
      <div className={cn("h-full rounded-full", tone === "good" ? "bg-success" : tone === "bad" ? "bg-danger" : "bg-warning")} style={{ width: `${Math.max(value ? 2 : 0, value ?? 0)}%` }} />
      {threshold != null && <div className="absolute top-0 h-full w-0.5 bg-fg/60" style={{ left: `${threshold}%` }} aria-hidden="true" />}
    </div>
  );
}

/** Level 1: the answer. Release decision, completeness, product health and the next action, before any detail. */
export function ReleaseDecisionCard({ run, report, onProblems }: { run: TestingRunDetail; report: TestingReport; onProblems?: () => void }) {
  const router = useRouter();
  const release = report.release!;
  const d = DECISION[release.decision];
  const c = report.completeness!;
  const h = report.productHealth!;
  const missing = run.obligations.filter((o) => ["inconclusive", "blocked", "skipped"].includes(o.status)).length;
  const problems = run.findings.filter((f) => f.status !== "rejected" && f.kind !== "product_defect").length + run.findings.filter((f) => f.kind === "product_defect" && f.status !== "rejected").length;
  const [rerunning, setRerunning] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const failedGates = release.gates.filter((g) => g.ok === false);

  async function rerun() {
    setRerunning(true);
    setError(null);
    try {
      const { run: next } = await rerunMissing(run.id);
      router.push(`/app/projects/${run.projectId}/testing/${next.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "unexpected", "The rerun could not start.", "Try again."));
      setRerunning(false);
    }
  }

  return (
    <Card className="space-y-6" aria-labelledby="release-decision">
      <div className="flex flex-wrap items-start gap-4">
        <span className={cn("inline-flex size-12 shrink-0 items-center justify-center rounded-2xl", TONE_BG[d.tone], TONE_TEXT[d.tone])}>
          <d.icon className="size-6" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium tracking-wide text-fg-muted uppercase">Release decision</p>
          <h2 id="release-decision" className={cn("mt-0.5 text-2xl font-semibold tracking-tight", TONE_TEXT[d.tone])}>
            {d.label}
          </h2>
          <p className="mt-1 text-sm text-fg-muted">
            Workflow finished · assessment: {report.assessment ? ASSESSMENT[report.assessment] : "n/a"} · {report.profile ?? "standard"} profile
            {run.parentRunId ? " · targeted rerun" : ""}
          </p>
        </div>
      </div>

      <div className="grid gap-5 sm:grid-cols-3">
        <div>
          <p className="text-sm text-fg">Testing completeness</p>
          <p className="text-3xl font-semibold text-fg tabular-nums">{c.percent}%</p>
          <Meter value={c.percent} threshold={c.threshold} tone={c.percent >= c.threshold ? "good" : "warn"} label="Testing completeness" />
          <p className="mt-1.5 text-xs text-fg-muted">Risk-weighted share of applicable checks with decisive, strong evidence. The line marks the {c.threshold}% release bar.</p>
        </div>
        <div>
          <p className="text-sm text-fg">Product health</p>
          <p className="text-3xl font-semibold text-fg tabular-nums">{h.percent == null ? "n/a" : `${h.percent}%`}</p>
          <Meter value={h.percent} tone={h.percent == null ? "warn" : h.percent >= 95 ? "good" : h.percent >= 80 ? "warn" : "bad"} label="Product health" />
          <p className="mt-1.5 text-xs text-fg-muted">Of the decisive checks only (risk-weighted). {h.excluded.inconclusive + h.excluded.blocked + h.excluded.unsupported + h.excluded.skipped} checks without a verdict are not counted here.</p>
        </div>
        <div>
          <p className="text-sm text-fg">Critical checks decisive</p>
          <p className="text-3xl font-semibold text-fg tabular-nums">
            {c.criticalDecisive} <span className="text-lg font-normal text-fg-muted">of {c.criticalTotal}</span>
          </p>
          <Meter value={c.criticalTotal ? (c.criticalDecisive / c.criticalTotal) * 100 : 100} tone={c.criticalDecisive === c.criticalTotal ? "good" : "warn"} label="Critical checks decisive" />
          <p className="mt-1.5 text-xs text-fg-muted">Every critical check must give a pass or fail verdict before a release.</p>
        </div>
      </div>

      {failedGates.length > 0 && (
        <div>
          <p className="text-sm font-medium text-fg">Why</p>
          <ul className="mt-2 space-y-1.5 text-sm">
            {failedGates.map((g) => (
              <li key={g.id} className="flex items-start gap-2">
                <CircleX className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
                <span>
                  <span className="text-fg">{g.label}:</span> <span className="text-fg-muted">{g.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {missing > 0 && !run.parentRunId && (
          <Button type="button" shape="pill" size="sm" disabled={rerunning} onClick={() => void rerun()}>
            {rerunning ? <Spinner /> : <RotateCcw aria-hidden="true" />} Rerun {missing} check{missing === 1 ? "" : "s"} without a verdict
          </Button>
        )}
        {problems > 0 && onProblems && (
          <Button type="button" variant="outline" shape="pill" size="sm" onClick={onProblems}>
            <ListChecks aria-hidden="true" /> See {problems} problem{problems === 1 ? "" : "s"}
          </Button>
        )}
        <a href={`/v1/testing-runs/${run.id}/export?format=md`} download className={buttonVariants({ variant: "outline", shape: "pill", size: "sm" })}>
          <Download aria-hidden="true" /> Report (Markdown)
        </a>
        <a href={`/v1/testing-runs/${run.id}/export?format=json`} download className={buttonVariants({ variant: "outline", shape: "pill", size: "sm" })}>
          <Download aria-hidden="true" /> Full data (JSON)
        </a>
      </div>
      {error && (
        <Alert>
          {error.message} {error.fix}
        </Alert>
      )}
    </Card>
  );
}

/** Level 2: what is proven, what is not, and what to do next. */
export function ProvenPanel({ report }: { report: TestingReport }) {
  const proved = (report.claims ?? []).filter((c) => c.kind === "proved");
  const notProved = (report.claims ?? []).filter((c) => c.kind !== "proved");
  const next = report.nextActions ?? [];
  const col = (title: string, Icon: typeof CircleCheck, tone: string, items: string[], empty: string) => (
    <div>
      <p className="flex items-center gap-2 text-sm font-medium text-fg">
        <Icon className={cn("size-4", tone)} aria-hidden="true" /> {title}
      </p>
      {items.length ? (
        <ul className="mt-2 space-y-1.5 text-sm text-fg-muted">
          {items.map((t, i) => (
            <li key={`${t}-${i}`}>{t}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-fg-muted">{empty}</p>
      )}
    </div>
  );
  return (
    <Card>
      <div className="grid gap-6 md:grid-cols-3">
        {col("Proven", CircleCheck, "text-success", proved.map((c) => c.text), "Nothing was proven by a decisive check.")}
        {col("Not proven, or a problem", CircleAlert, "text-warning", notProved.map((c) => c.text), "Every planned area has evidence.")}
        {col("Next action", CircleHelp, "text-accent", next.map((n) => n.label), "No action needed.")}
      </div>
    </Card>
  );
}

/** Level 2: one row per layer, so gaps are visible where they are. */
export function LayerMatrix({ report }: { report: TestingReport }) {
  const rows = report.layers ?? [];
  if (!rows.length) return null;
  const conf = { strong: "good", partial: "warn", weak: "warn", none: "muted" } as const;
  return (
    <Card className="space-y-4">
      <div>
        <CardTitle>Coverage by layer</CardTitle>
        <p className="mt-1 text-sm text-fg-muted">Decisive means a pass or fail verdict. Completeness weighs each check by risk and by the strength of its evidence.</p>
      </div>
      <DataTable
        rows={rows}
        rowKey={(r) => r.layer}
        empty="No layers."
        columns={[
          { label: "Layer", cell: (r) => <span className="font-medium text-fg">{LAYER_NAME[r.layer] ?? r.layer}</span> },
          { label: "Decisive", cell: (r) => <span className="tabular-nums">{r.decisive} of {r.planned}</span> },
          { label: "Passed / failed", cell: (r) => <span className="tabular-nums">{r.passed} / {r.failed}{r.flaky ? ` (+${r.flaky} flaky)` : ""}</span>, className: "hidden sm:table-cell" },
          { label: "Completeness", cell: (r) => <span className="tabular-nums">{r.completeness == null ? "n/a" : `${r.completeness}%`}</span> },
          { label: "Confidence", cell: (r) => <Badge tone={conf[r.confidence]}>{r.confidence}</Badge>, className: "hidden md:table-cell" },
          { label: "Gap and next action", cell: (r) => (r.gap ? <span className="block max-w-sm text-xs text-fg-muted">{r.gap}{r.nextAction ? `. ${r.nextAction}.` : ""}</span> : <span className="text-xs text-fg-muted">none</span>), className: "hidden lg:table-cell" },
        ]}
      />
    </Card>
  );
}

/** Level 3: coverage by product capability (user goal), with the kind of proof behind each. */
export function CapabilityMatrix({ report }: { report: TestingReport }) {
  const rows = report.capabilities ?? [];
  if (!rows.length) return null;
  return (
    <Card className="space-y-4">
      <div>
        <CardTitle>Coverage by capability</CardTitle>
        <p className="mt-1 text-sm text-fg-muted">Grouped by what users do. Existing tests are matched to a capability by file and test names.</p>
      </div>
      <DataTable
        rows={rows}
        rowKey={(r) => r.name}
        empty="No capabilities."
        searchText={(r) => r.name}
        searchLabel="Search capabilities"
        columns={[
          { label: "Capability", cell: (r) => <span className="font-medium text-fg">{r.name}</span> },
          { label: "Decisive", cell: (r) => <span className="tabular-nums">{r.decisive} of {r.obligations}</span> },
          { label: "Failed", cell: (r) => <span className={cn("tabular-nums", r.failed ? "text-danger" : "text-fg-muted")}>{r.failed}</span>, className: "hidden sm:table-cell" },
          {
            label: "Proven by",
            cell: (r) =>
              r.proofClasses.length ? (
                <span className="flex flex-wrap gap-1">
                  {r.proofClasses.map((p) => (
                    <Badge key={p} tone={["business_behavior", "state_change", "journey"].includes(p) ? "good" : "muted"}>{PROOF_NAME[p] ?? p}</Badge>
                  ))}
                </span>
              ) : (
                <span className="text-xs text-fg-muted">nothing yet</span>
              ),
          },
          { label: "Your tests", cell: (r) => <span className="tabular-nums text-fg-muted">{r.existingTests}</span>, className: "hidden md:table-cell" },
          { label: "Missing", cell: (r) => <span className="text-xs text-fg-muted">{r.missing ?? "none"}</span>, className: "hidden lg:table-cell" },
        ]}
      />
    </Card>
  );
}
