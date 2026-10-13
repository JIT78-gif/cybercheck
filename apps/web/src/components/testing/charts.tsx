"use client";

// Charts of a Testing run. Each one has visible numbers next to it and a screen-reader table, so no
// information lives only in a colour or a shape.

import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Obligation, RepairAttempt, ReviewedReport, TestFinding, TestingReport } from "@cybercheck/contracts";
import { cn } from "@/lib/cn";
import { LAYER_NAME } from "./release-panels";

const C = {
  passed: "var(--success)",
  failed: "var(--danger)",
  flaky: "var(--warning)",
  none: "var(--chart-muted)",
  accent: "var(--accent)",
  soft: "var(--chart-soft)",
  grid: "var(--border)",
  text: "var(--fg-muted)",
};

const tooltipStyle = {
  contentStyle: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    fontSize: 12,
    color: "var(--fg)",
  },
  labelStyle: { color: "var(--fg)", fontWeight: 600 },
  itemStyle: { color: "var(--fg)" },
  cursor: { fill: "var(--surface-2)" },
};
const axis = {
  tick: { fill: C.text, fontSize: 12 },
  axisLine: { stroke: C.grid },
  tickLine: false,
} as const;

/** Visible legend with numbers: the chart's text equivalent. */
function Legend({ items }: { items: Array<{ label: string; value: string | number; color: string }> }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
      {items.map((i) => (
        <li key={i.label} className="flex items-center gap-1.5">
          <span className="size-2.5 shrink-0 rounded-sm" style={{ background: i.color }} aria-hidden="true" />
          <span className="text-fg-muted">{i.label}</span>
          <span className="font-medium text-fg tabular-nums">{i.value}</span>
        </li>
      ))}
    </ul>
  );
}

function SrTable({ caption, head, rows }: { caption: string; head: string[]; rows: Array<Array<string | number>> }) {
  return (
    // The wrapper does the hiding: a table ignores the 1px size of sr-only and would widen the page.
    <div className="sr-only">
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const NO_VERDICT = new Set(["blocked", "inconclusive", "skipped", "unsupported"]);

function bucket(obs: Obligation[]) {
  const n = (f: (o: Obligation) => boolean) => obs.filter(f).length;
  return {
    passed: n((o) => o.status === "passed"),
    failed: n((o) => o.status === "failed"),
    flaky: n((o) => o.status === "flaky"),
    none: n((o) => NO_VERDICT.has(o.status)),
    pending: n((o) => o.status === "planned" || o.status === "running"),
    na: n((o) => o.status === "not_applicable"),
  };
}

/** Donut of every planned check by result; the centre shows the share that passed. */
export function ResultsDonut({ obligations }: { obligations: Obligation[] }) {
  const b = bucket(obligations);
  const data = [
    { name: "Passed", value: b.passed, color: C.passed },
    { name: "Failed", value: b.failed, color: C.failed },
    { name: "Flaky", value: b.flaky, color: C.flaky },
    { name: "No verdict", value: b.none, color: C.none },
    { name: "Not run yet", value: b.pending, color: C.soft },
  ].filter((d) => d.value > 0);
  const applicable = obligations.length - b.na;
  const pct = applicable ? Math.round((b.passed / applicable) * 100) : 0;
  return (
    <figure className="space-y-3">
      <figcaption className="text-sm font-medium text-fg">All checks</figcaption>
      <div className="relative mx-auto h-44 w-44 overflow-hidden" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius="68%" outerRadius="100%" paddingAngle={data.length > 1 ? 2 : 0} stroke="none" isAnimationActive={false}>
              {data.map((d) => (
                <Cell key={d.name} fill={d.color} />
              ))}
            </Pie>
            <Tooltip {...tooltipStyle} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-semibold text-fg tabular-nums">{pct}%</span>
          <span className="text-xs text-fg-muted">passed</span>
        </div>
      </div>
      <Legend
        items={data.map((d) => ({
          label: d.name,
          value: d.value,
          color: d.color,
        }))}
      />
      {b.na > 0 && <p className="text-xs text-fg-muted">{b.na} not applicable to this project, left out.</p>}
      <SrTable caption="Checks by result" head={["Result", "Checks"]} rows={data.map((d) => [d.name, d.value])} />
    </figure>
  );
}

const LAYER_ORDER = ["environment", "existing_suite", "api", "unit", "ui", "accessibility", "data", "job", "integration", "performance", "reliability", "deployment"];

/** One stacked bar per layer: passed, failed, flaky and without a verdict. */
export function LayerBars({ obligations, onLayer }: { obligations: Obligation[]; onLayer?: (layer: string) => void }) {
  const data = LAYER_ORDER.filter((l) => obligations.some((o) => o.layer === l && o.status !== "not_applicable")).map((l) => {
    const b = bucket(obligations.filter((o) => o.layer === l));
    return {
      layer: l,
      name: LAYER_NAME[l] ?? l,
      Passed: b.passed,
      Failed: b.failed,
      Flaky: b.flaky,
      "No verdict": b.none + b.pending,
    };
  });
  if (!data.length) return null;
  return (
    <figure className="min-w-0 space-y-3">
      <figcaption className="text-sm font-medium text-fg">
        Results by layer
        {onLayer ? <span className="font-normal text-fg-muted"> · click a bar to see its checks</span> : null}
      </figcaption>
      <div className="overflow-hidden" style={{ height: Math.max(140, data.length * 34 + 30) }} aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }} barCategoryGap={8}>
            <CartesianGrid horizontal={false} stroke={C.grid} />
            <XAxis type="number" allowDecimals={false} {...axis} />
            <YAxis type="category" dataKey="name" width={150} {...axis} />
            <Tooltip {...tooltipStyle} />
            {(["Passed", "Failed", "Flaky", "No verdict"] as const).map((k, i, all) => (
              <Bar
                key={k}
                dataKey={k}
                stackId="s"
                fill={k === "Passed" ? C.passed : k === "Failed" ? C.failed : k === "Flaky" ? C.flaky : C.none}
                radius={i === all.length - 1 ? [0, 4, 4, 0] : 0}
                isAnimationActive={false}
                cursor={onLayer ? "pointer" : undefined}
                onClick={onLayer ? (d) => onLayer((d as unknown as { payload: { layer: string } }).payload.layer) : undefined}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <Legend
        items={[
          {
            label: "Passed",
            value: data.reduce((n, d) => n + d.Passed, 0),
            color: C.passed,
          },
          {
            label: "Failed",
            value: data.reduce((n, d) => n + d.Failed, 0),
            color: C.failed,
          },
          {
            label: "Flaky",
            value: data.reduce((n, d) => n + d.Flaky, 0),
            color: C.flaky,
          },
          {
            label: "No verdict",
            value: data.reduce((n, d) => n + d["No verdict"], 0),
            color: C.none,
          },
        ].filter((x) => x.value > 0)}
      />
      <SrTable caption="Checks by layer" head={["Layer", "Passed", "Failed", "Flaky", "No verdict"]} rows={data.map((d) => [d.name, d.Passed, d.Failed, d.Flaky, d["No verdict"]])} />
    </figure>
  );
}

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;

/** Product problems by severity, split by where human review left them. */
export function ProblemBars({ findings, reviewed }: { findings: TestFinding[]; reviewed: ReviewedReport | null }) {
  const product = findings.filter((f) => f.kind === "product_defect" && f.status !== "rejected");
  if (!product.length) return null;
  const queue = (f: TestFinding) => reviewed?.findings.find((x) => x.findingId === f.id)?.queue ?? null;
  const data = SEVERITIES.map((s) => {
    const fs = product.filter((f) => f.severity === s);
    return {
      name: s[0]!.toUpperCase() + s.slice(1),
      Confirmed: fs.filter((f) => (reviewed ? queue(f) === "confirmed" : f.status === "confirmed")).length,
      "To review": fs.filter((f) => (reviewed ? queue(f) === "awaiting" : f.status === "suspected")).length,
      "Accepted or unsure": fs.filter((f) => queue(f) === "accepted_or_unsure").length,
      Rejected: fs.filter((f) => queue(f) === "rejected").length,
    };
  }).filter((d) => d.Confirmed + d["To review"] + d["Accepted or unsure"] + d.Rejected > 0);
  const keys = [
    { k: "Confirmed", c: C.failed },
    { k: "To review", c: C.flaky },
    { k: "Accepted or unsure", c: C.soft },
    { k: "Rejected", c: C.none },
  ] as const;
  const totals = keys
    .map((x) => ({
      label: x.k,
      value: data.reduce((n, d) => n + d[x.k], 0),
      color: x.c,
    }))
    .filter((x) => x.value > 0);
  return (
    <figure className="min-w-0 space-y-3">
      <figcaption className="text-sm font-medium text-fg">Problems by severity</figcaption>
      <div className="h-44 overflow-hidden" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -20 }} barCategoryGap="28%">
            <CartesianGrid vertical={false} stroke={C.grid} />
            <XAxis dataKey="name" {...axis} />
            <YAxis allowDecimals={false} {...axis} />
            <Tooltip {...tooltipStyle} />
            {keys.map((x, i) => (
              <Bar key={x.k} dataKey={x.k} stackId="s" fill={x.c} radius={i === keys.length - 1 ? [4, 4, 0, 0] : 0} isAnimationActive={false} maxBarSize={56} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <Legend items={totals} />
      <SrTable caption="Problems by severity and review state" head={["Severity", ...keys.map((x) => x.k)]} rows={data.map((d) => [d.name, ...keys.map((x) => d[x.k])])} />
    </figure>
  );
}

type Load = NonNullable<TestingReport["load"]>;

/** Load stages side by side: latency (p50 and p95), throughput and server errors. */
export function LoadCharts({ load }: { load: Load }) {
  const data = load.stages.map((s) => ({
    name: s.name[0]!.toUpperCase() + s.name.slice(1),
    users: s.vus,
    p50: s.p50Ms,
    p95: s.p95Ms,
    rps: s.verdict === "invalid" ? null : s.rps,
    errors: s.errorRatePct,
    invalid: s.verdict === "invalid",
  }));
  const card = (title: string, note: string, children: React.ReactNode, legend: React.ReactNode, overlay?: string) => (
    <figure className="min-w-0 space-y-2 rounded-xl border border-border p-4">
      <figcaption>
        <span className="block text-sm font-medium text-fg">{title}</span>
        <span className="block text-xs text-fg-muted">{note}</span>
      </figcaption>
      <div className="relative h-48 overflow-hidden" aria-hidden={overlay ? undefined : true}>
        <ResponsiveContainer width="100%" height="100%">
          {children as React.ReactElement}
        </ResponsiveContainer>
        {overlay && <p className="absolute inset-x-0 top-1/3 text-center text-sm font-medium text-success">{overlay}</p>}
      </div>
      {legend}
    </figure>
  );
  const maxErr = Math.max(5, Math.ceil(Math.max(0, ...data.map((d) => d.errors))));
  const tick = (d: { name: string; users: number }) => `${d.name} (${d.users})`;
  const xAxis = <XAxis dataKey={(d: (typeof data)[number]) => tick(d)} {...axis} interval={0} />;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-3">
        {card(
          "Response time",
          "Milliseconds; lower is better. Stage (virtual users).",
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
            <CartesianGrid vertical={false} stroke={C.grid} />
            {xAxis}
            <YAxis {...axis} unit=" ms" width={78} />
            <Tooltip {...tooltipStyle} formatter={(v) => (v == null ? "not measured" : `${v} ms`)} />
            <Bar dataKey="p50" name="p50" fill={C.soft} radius={[4, 4, 0, 0]} isAnimationActive={false} maxBarSize={56} />
            <Bar dataKey="p95" name="p95" fill={C.accent} radius={[4, 4, 0, 0]} isAnimationActive={false} maxBarSize={56} />
          </BarChart>,
          <Legend
            items={[
              { label: "p50 (typical)", value: "", color: C.soft },
              { label: "p95 (slowest 5%)", value: "", color: C.accent },
            ]}
          />,
        )}
        {card(
          "Throughput",
          "Requests per second the app answered.",
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
            <CartesianGrid vertical={false} stroke={C.grid} />
            {xAxis}
            <YAxis {...axis} width={48} />
            <Tooltip {...tooltipStyle} formatter={(v) => (v == null ? "not valid: the app stopped" : `${v} req/s`)} />
            <Bar dataKey="rps" name="Requests/s" fill={C.passed} radius={[4, 4, 0, 0]} isAnimationActive={false} maxBarSize={56} />
          </BarChart>,
          null,
        )}
        {card(
          "Server errors and timeouts",
          "Percent of requests; 0 is the goal.",
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
            <CartesianGrid vertical={false} stroke={C.grid} />
            {xAxis}
            <YAxis {...axis} unit="%" width={48} domain={[0, maxErr]} ticks={maxErr === 5 ? [0, 1, 2, 3, 4, 5] : undefined} />
            <Tooltip {...tooltipStyle} formatter={(v) => `${v}%`} />
            <Bar dataKey="errors" name="Errors" radius={[4, 4, 0, 0]} isAnimationActive={false} maxBarSize={56}>
              {data.map((d) => (
                <Cell key={d.name} fill={d.errors > 0 ? C.failed : C.passed} />
              ))}
            </Bar>
          </BarChart>,
          null,
          data.every((d) => d.errors === 0) ? "No server errors in any stage" : undefined,
        )}
      </div>
      <SrTable
        caption="Load stages"
        head={["Stage", "Virtual users", "p50 ms", "p95 ms", "Requests per second", "Error %"]}
        rows={data.map((d) => [d.name, d.users, d.p50 ?? "not measured", d.p95 ?? "not measured", d.rps ?? "not valid", d.errors])}
      />
    </div>
  );
}

type Stage = Load["stages"][number];
const stageName = (n: string) => n[0]!.toUpperCase() + n.slice(1);

/** One small line chart over a stage's seconds. */
function TimeChart({ title, note, data, lines, unit, refY }: { title: string; note: string; data: NonNullable<Stage["series"]>; lines: Array<{ key: "rps" | "p50Ms" | "p95Ms" | "errorRatePct" | "vus"; name: string; color: string; dashed?: boolean }>; unit: string; refY?: { y: number; label: string } }) {
  return (
    <figure className="min-w-0 space-y-2 rounded-xl border border-border p-4">
      <figcaption>
        <span className="block text-sm font-medium text-fg">{title}</span>
        <span className="block text-xs text-fg-muted">{note}</span>
      </figcaption>
      <div className="h-44 overflow-hidden" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -12 }}>
            <CartesianGrid vertical={false} stroke={C.grid} />
            <XAxis dataKey="t" {...axis} unit=" s" type="number" domain={["dataMin", "dataMax"]} allowDecimals={false} />
            <YAxis {...axis} width={unit === " ms" ? 78 : 56} unit={unit} allowDecimals={false} />
            <Tooltip {...tooltipStyle} labelFormatter={(t) => `${t} s into the stage`} formatter={(v, n) => [v == null ? "none" : `${v}${unit}`, n]} />
            {refY && <ReferenceLine y={refY.y} stroke={C.failed} strokeDasharray="4 4" label={{ value: refY.label, fill: C.failed, fontSize: 11, position: "insideTopRight" }} />}
            {lines.map((l) => (
              <Line key={l.key} type="monotone" dataKey={l.key} name={l.name} stroke={l.color} strokeWidth={2} strokeDasharray={l.dashed ? "5 4" : undefined} dot={false} connectNulls isAnimationActive={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <Legend items={lines.map((l) => ({ label: l.name, value: "", color: l.color }))} />
    </figure>
  );
}

/** Second by second, for the stage the user picks: throughput and users, latency, and server errors. */
export function LoadTimeline({ load }: { load: Load }) {
  const withSeries = load.stages.filter((s) => (s.series?.length ?? 0) > 1);
  const [picked, setPicked] = useState<string | null>(null);
  if (!withSeries.length) return null;
  const s = withSeries.find((x) => x.name === picked) ?? withSeries.find((x) => x.name === "breakpoint") ?? withSeries.at(-1)!;
  const data = s.series!;
  return (
    <section className="space-y-3" aria-label="Second by second">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-fg">Second by second</h3>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Load stage">
          {withSeries.map((x) => (
            <button key={x.name} type="button" aria-pressed={x.name === s.name} onClick={() => setPicked(x.name)} className={cn("min-h-9 cursor-pointer rounded-full px-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring", x.name === s.name ? "bg-fg text-bg" : "bg-surface-2 text-fg-muted hover:text-fg")}>
              {stageName(x.name)}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        <TimeChart
          title="Requests per second"
          note={s.name === "breakpoint" ? "The rate k6 pushed, and the virtual users it needed." : "What the app answered, and the virtual users sending."}
          data={data}
          unit=""
          lines={[
            { key: "rps", name: "Requests/s", color: C.passed },
            { key: "vus", name: "Virtual users", color: C.text, dashed: true },
          ]}
          refY={s.limitRps != null && s.brokeBy && s.brokeBy !== "generator" ? { y: s.limitRps, label: `limit ${Math.round(s.limitRps)}/s` } : undefined}
        />
        <TimeChart
          title="Response time"
          note="Milliseconds; the line marks 2 s, where the breakpoint calls it unhealthy."
          data={data}
          unit=" ms"
          lines={[
            { key: "p50Ms", name: "p50 (typical)", color: C.soft },
            { key: "p95Ms", name: "p95 (slowest 5%)", color: C.accent },
          ]}
          refY={s.name === "breakpoint" ? { y: 2000, label: "2 s" } : undefined}
        />
        <TimeChart title="Server errors and timeouts" note="Percent of requests in each second." data={data} unit="%" lines={[{ key: "errorRatePct", name: "Errors", color: C.failed }]} refY={s.name === "breakpoint" ? { y: 5, label: "5%" } : undefined} />
      </div>
      <SrTable caption={`${stageName(s.name)} stage, second by second`} head={["Second", "Requests per second", "p50 ms", "p95 ms", "Error %", "Virtual users"]} rows={data.map((p) => [p.t, p.rps, p.p50Ms ?? "none", p.p95Ms ?? "none", p.errorRatePct, p.vus ?? "none"])} />
    </section>
  );
}

const BROKE: Record<NonNullable<Stage["brokeBy"]>, string> = {
  errors: "more than 5% of requests failed",
  latency: "the slowest 5% of answers took over 2 s",
  crash: "the app process stopped",
  generator: "the load generator reached its own limit first",
};

/** The breakpoint's answer in one card: the rate the app handles, and what gave way above it. */
export function BreakpointCard({ stage }: { stage: Stage }) {
  const top = Math.round(Math.max(0, ...(stage.series ?? []).map((p) => p.rps)));
  const limit = stage.limitRps != null ? Math.round(stage.limitRps) : null;
  const broke = stage.brokeBy ?? null;
  return (
    <section aria-label="Breakpoint" className={cn("rounded-2xl border p-5", broke && broke !== "generator" ? "border-warning/40 bg-warning/5" : "border-success/40 bg-success/5")}>
      <p className="text-xs font-medium tracking-wide text-fg-muted uppercase">Breakpoint</p>
      <p className="mt-1 text-2xl font-semibold text-fg">
        {limit != null ? (
          <>
            {broke === "generator" || !broke ? "At least " : "About "}
            <span className="tabular-nums">{limit}</span> requests per second
          </>
        ) : broke ? (
          "Unhealthy from the start of the ramp"
        ) : (
          <>
            <span className="tabular-nums">{top}</span> requests per second, still healthy
          </>
        )}
      </p>
      <p className="mt-1 text-sm text-fg-muted">
        {!broke ? `The app handled the whole ramp (up to ${top} per second) with errors under 5% and 95% of answers within 2 s.` : broke === "generator" ? `Still healthy at that rate; ${BROKE.generator}, so the real limit is higher.` : `Above that, ${BROKE[broke]}.`} Measured inside one 4 vCPU sandbox with the load generator on the same machine: compare runs, not production capacity.
      </p>
    </section>
  );
}

/** Before and after a repair attempt: how many of its checks passed, failed or had no verdict. */
export function RepairBeforeAfter({ attempt }: { attempt: RepairAttempt }) {
  if (!attempt.checks.length) return null;
  const status = (c: RepairAttempt["checks"][number], k: "before" | "after") => (k === "after" && c.targetResolved ? "passed" : c[k]);
  const count = (k: "before" | "after") => ({
    name: k === "before" ? "Before" : "After the patch",
    Passed: attempt.checks.filter((c) => status(c, k) === "passed").length,
    Failed: attempt.checks.filter((c) => status(c, k) === "failed").length,
    Other: attempt.checks.filter((c) => status(c, k) !== "passed" && status(c, k) !== "failed").length,
  });
  const data = [count("before"), count("after")];
  return (
    <figure className="space-y-2">
      <figcaption className="text-xs text-fg-muted">Checks of this repair, before and after the patch</figcaption>
      <div className="h-24 overflow-hidden" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }} barCategoryGap={6}>
            <XAxis type="number" hide allowDecimals={false} />
            <YAxis type="category" dataKey="name" width={110} {...axis} />
            <Tooltip {...tooltipStyle} />
            <Bar dataKey="Passed" stackId="s" fill={C.passed} isAnimationActive={false} maxBarSize={56} />
            <Bar dataKey="Failed" stackId="s" fill={C.failed} isAnimationActive={false} maxBarSize={56} />
            <Bar dataKey="Other" name="No verdict" stackId="s" fill={C.none} radius={[0, 4, 4, 0]} isAnimationActive={false} maxBarSize={56} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <Legend
        items={[
          { label: "Passed, before → after:", value: `${data[0]!.Passed} → ${data[1]!.Passed}`, color: C.passed },
          { label: "Failed, before → after:", value: `${data[0]!.Failed} → ${data[1]!.Failed}`, color: C.failed },
          ...(data[0]!.Other + data[1]!.Other ? [{ label: "No verdict, before → after:", value: `${data[0]!.Other} → ${data[1]!.Other}`, color: C.none }] : []),
        ]}
      />
      <SrTable caption="Repair checks before and after" head={["When", "Passed", "Failed", "No verdict"]} rows={data.map((d) => [d.name, d.Passed, d.Failed, d.Other])} />
    </figure>
  );
}

/** Tiny trend of a project's problems over its recent checks. */
export function ProblemSparkline({ history, className }: { history: Array<{ runId: string; problems: number }>; className?: string }) {
  if (history.length < 2) return null;
  const first = history[0]!.problems;
  const last = history.at(-1)!.problems;
  const label = `Problems over the last ${history.length} tests: ${history.map((h) => h.problems).join(", ")}`;
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)} role="img" aria-label={label} title={label}>
      <span className="inline-block h-6 w-20" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={history} margin={{ top: 3, right: 2, bottom: 3, left: 2 }}>
            <YAxis hide domain={[0, "dataMax"]} />
            <Line type="monotone" dataKey="problems" stroke={last > first ? C.failed : last < first ? C.passed : C.text} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </span>
      <span className="text-xs text-fg-muted tabular-nums">{last < first ? `down from ${first}` : last > first ? `up from ${first}` : "no change"}</span>
    </span>
  );
}
