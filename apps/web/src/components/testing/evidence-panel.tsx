"use client";

import { CircleCheck, CircleX, Database, FileText, Monitor } from "lucide-react";
import type { AssertionProof, Obligation, TestingReport, TestingRunDetail } from "@cybercheck/contracts";
import { Card, CardTitle } from "@/components/app/ui";
import { Badge } from "@/components/architecture/parts";
import { cn } from "@/lib/cn";
import { STATUS_STYLE } from "./run-parts";

const KIND: Record<string, string> = { endpoint: "Endpoints", screen: "Screens", entity: "Tables", relationship: "Relationships", job: "Background jobs", integration: "Integrations", module: "Modules", function: "Functions" };
const DB: Record<string, string> = {
  direct_sqlite_file: "Opened directly: the SQLite file the app writes.",
  direct_postgres: "Opened directly: the sandbox's Postgres.",
  api_level: "Through the app: the database is in memory inside the app process, so it was judged from its schema, SQLite's rules and the app's own endpoints, never opened from outside.",
  none: "Not checked: no supported database was found.",
};

/** What the result rests on: how much of the project was discovered and really tested, and how strong the proof is. */
export function EvidencePanel({ report: r }: { report: TestingReport }) {
  const inv = r.inventory ?? [];
  const kinds = [...new Set(inv.map((a) => a.kind))];
  const p = r.proofSummary;
  if (!inv.length && !p?.business && !r.databaseStrategy) return null;
  return (
    <Card className="space-y-5" aria-label="Evidence behind this result">
      <div>
        <CardTitle>Evidence behind this result</CardTitle>
        <p className="mt-1 text-sm text-fg-muted">Everything found in the code counts, including what no check reached, so gaps cannot drop out of the picture.</p>
      </div>
      {kinds.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {kinds.map((k) => {
            const all = inv.filter((a) => a.kind === k);
            const done = all.filter((a) => a.executed).length;
            return (
              <li key={k}>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="text-fg">{KIND[k] ?? k}</span>
                  <span className="text-fg-muted tabular-nums">
                    {done} of {all.length} tested
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2" role="meter" aria-label={`${KIND[k] ?? k} tested`} aria-valuemin={0} aria-valuemax={all.length} aria-valuenow={done}>
                  <div className={cn("h-full rounded-full", done === all.length ? "bg-success" : "bg-accent")} style={{ width: `${all.length ? (done / all.length) * 100 : 0}%` }} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {p && p.business > 0 && (
        <p className="text-sm text-fg">
          <span className="font-medium">Business behaviour:</span> {p.business} check(s) with a verdict. <span className="text-success">{p.state} read the stored state back</span>, {p.response} checked the response
          {p.statusOnly > 0 ? (
            <>
              , <span className="text-warning">{p.statusOnly} saw only a status code</span> (counted as availability, not as proof of behaviour)
            </>
          ) : null}
          {p.legacy ? `, ${p.legacy} from earlier check types` : ""}.
        </p>
      )}
      <div className="grid gap-3 text-sm sm:grid-cols-2">
        {r.databaseStrategy && (
          <p className="flex items-start gap-2 text-fg-muted">
            <Database className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> <span><span className="font-medium text-fg">Database: </span>{DB[r.databaseStrategy]}</span>
          </p>
        )}
        {r.screens && r.screens.length > 0 && (
          <p className="flex items-start gap-2 text-fg-muted">
            <Monitor className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> <span><span className="font-medium text-fg">Screens served by the backend: </span>{r.screens.map((s) => s.path).join(", ")}, opened on the app with no frontend build.</span>
          </p>
        )}
      </div>
    </Card>
  );
}

/** What each assertion expected and what it saw, for the checks given. */
export function ProofList({ obligations, onlyFailed = false }: { obligations: Obligation[]; onlyFailed?: boolean }) {
  const proofs = obligations.flatMap((o) => (o.proofs ?? []).map((pr) => ({ pr, o }))).filter(({ pr }) => !onlyFailed || !pr.passed);
  if (!proofs.length) return null;
  const show = (v: unknown) => (v === undefined ? "nothing" : JSON.stringify(v));
  return (
    <ul className="space-y-1.5 text-sm">
      {proofs.slice(0, 12).map(({ pr }: { pr: AssertionProof }) => (
        <li key={`${pr.scenarioId}:${pr.assertionId}`} className="flex items-start gap-2">
          {pr.passed ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-label="held" /> : <CircleX className="mt-0.5 size-4 shrink-0 text-danger" aria-label="did not hold" />}
          <span className="min-w-0">
            <span className="font-mono text-xs text-fg-muted">{pr.assertionId}</span> expected <span className="font-mono text-xs text-fg">{show(pr.expected)}</span>, saw <span className={cn("font-mono text-xs", pr.passed ? "text-fg" : "text-danger")}>{show(pr.observed)}</span>
            {pr.stateVerified ? <span className="ml-1 text-xs text-success">(state read back)</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** The documented requirements: their source, the proof they need, and what the checks found. */
export function RequirementsList({ run }: { run: TestingRunDetail }) {
  const reqs = run.report?.requirements ?? [];
  if (!reqs.length) return <p className="text-sm text-fg-muted">No requirements were read from this project&apos;s documentation or tests.</p>;
  return (
    <ul className="space-y-3">
      {reqs.map((q) => {
        const mine = run.obligations.filter((o) => o.requirementIds?.includes(q.id));
        const worst = mine.find((o) => o.status === "failed") ?? mine.find((o) => o.status !== "passed") ?? mine[0];
        const st = worst ? STATUS_STYLE[worst.status] : null;
        return (
          <li key={q.id} className="space-y-2 rounded-xl border border-border p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <p className="min-w-0 font-medium text-fg">{q.expectedBehavior}</p>
              {st ? (
                <Badge tone={st.tone}>
                  <st.icon className="size-3.5" aria-hidden="true" /> {st.label}
                </Badge>
              ) : (
                <Badge tone="muted">Not checked</Badge>
              )}
            </div>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-muted">
              <FileText className="size-3.5" aria-hidden="true" />
              {q.source.kind === "implementation" ? "suggested by the code only (cannot define correct behaviour)" : q.source.kind}
              {q.source.path ? ` · ${q.source.path}${q.source.line ? `:${q.source.line}` : ""}` : ""}
              {q.source.quote ? <span className="italic">&ldquo;{q.source.quote}&rdquo;</span> : null}
              <span>· needs {q.requiredProof} proof{q.template ? ` · ${q.template.replace(/_/g, " ")}` : ""}</span>
            </p>
            {worst?.reason && worst.status !== "passed" && <p className="text-sm text-fg-muted">{worst.reason}</p>}
            <ProofList obligations={mine} />
          </li>
        );
      })}
    </ul>
  );
}
