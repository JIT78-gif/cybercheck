import { CircleCheck, CircleDashed, CircleX, LoaderCircle, TriangleAlert } from "lucide-react";
import type { ProjectAnalysis, SnapshotStatus } from "@cybercheck/contracts";
import { cn } from "@/lib/cn";

/** Stages where the analysis is still working; the UI keeps refreshing while any project is in one. */
export const RUNNING_STAGES = new Set<ProjectAnalysis["stage"]>(["processing", "reading_code", "explaining"]);

const analysisStyle: Record<ProjectAnalysis["stage"], { label: string; icon: typeof CircleCheck; cls: string; spin?: boolean }> = {
  processing: { label: "Checking upload", icon: LoaderCircle, cls: "border-accent/30 bg-accent/8 text-accent", spin: true },
  reading_code: { label: "Reading code", icon: LoaderCircle, cls: "border-accent/30 bg-accent/8 text-accent", spin: true },
  explaining: { label: "AI explaining", icon: LoaderCircle, cls: "border-accent/30 bg-accent/8 text-accent", spin: true },
  ready: { label: "Ready", icon: CircleCheck, cls: "border-success/30 bg-success/8 text-success" },
  failed: { label: "Failed", icon: TriangleAlert, cls: "border-warning/30 bg-warning/8 text-warning" },
  rejected: { label: "Rejected", icon: CircleX, cls: "border-danger/30 bg-danger/8 text-danger" },
  none: { label: "No snapshot", icon: CircleDashed, cls: "border-border bg-surface-2 text-fg-muted" },
};

/** Project readiness for the checks: "Ready" only once the code is read and explained. */
export function AnalysisChip({ analysis, className }: { analysis: ProjectAnalysis; className?: string }) {
  const s = analysisStyle[analysis.stage];
  const pct = analysis.progress != null && RUNNING_STAGES.has(analysis.stage) ? ` ${Math.round(analysis.progress * 100)}%` : "";
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium", s.cls, className)}
      title={analysis.step ?? analysis.error ?? s.label}
    >
      <s.icon className={cn("size-3.5", s.spin && "animate-spin")} aria-hidden="true" />
      {s.label}
      {pct && <span className="tabular-nums opacity-80">{pct}</span>}
    </span>
  );
}

/** Live progress line with a bar, for project pages and the check tabs. */
export function AnalysisProgress({ analysis }: { analysis: ProjectAnalysis }) {
  if (!RUNNING_STAGES.has(analysis.stage)) return null;
  return (
    <div className="space-y-2" role="status" aria-live="polite">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="min-w-0 truncate text-fg">{analysis.step ?? "Working"}</span>
        {analysis.progress != null && <span className="shrink-0 text-xs text-fg-muted tabular-nums">{Math.round(analysis.progress * 100)}%</span>}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden="true">
        {analysis.progress != null ? (
          <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(4, analysis.progress * 100)}%` }} />
        ) : (
          <div className="h-full w-1/3 animate-pulse rounded-full bg-accent/60" />
        )}
      </div>
      <p className="text-xs text-fg-muted">The project can be checked once this finishes. A full analysis usually takes 2 to 5 minutes.</p>
    </div>
  );
}

export function Card({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      className={cn("rounded-2xl border border-border bg-surface p-5 shadow-[0_1px_2px_rgb(0_0_0/0.04)] sm:p-7", className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return <h2 className={cn("text-lg font-semibold tracking-tight text-fg", className)} {...props} />;
}

export function PageHeader({ section, title, actions }: { section: string; title: string; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <nav aria-label="Breadcrumb" className="text-sm text-fg-muted">
          <ol className="flex items-center gap-1.5">
            <li>Pages</li>
            <li aria-hidden="true">/</li>
            <li aria-current="page" className="text-fg">
              {section}
            </li>
          </ol>
        </nav>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-fg sm:text-4xl">{title}</h1>
      </div>
      {actions}
    </div>
  );
}

const statusStyle: Record<SnapshotStatus | "NONE", { label: string; icon: typeof CircleCheck; cls: string; spin?: boolean }> = {
  BASELINED: { label: "Saved", icon: CircleCheck, cls: "border-success/30 bg-success/8 text-success" },
  RECEIVED: { label: "Processing", icon: LoaderCircle, cls: "border-accent/30 bg-accent/8 text-accent", spin: true },
  VALIDATING: { label: "Processing", icon: LoaderCircle, cls: "border-accent/30 bg-accent/8 text-accent", spin: true },
  REJECTED: { label: "Rejected", icon: CircleX, cls: "border-danger/30 bg-danger/8 text-danger" },
  FAILED: { label: "Failed", icon: TriangleAlert, cls: "border-warning/30 bg-warning/8 text-warning" },
  NONE: { label: "No snapshot", icon: CircleDashed, cls: "border-border bg-surface-2 text-fg-muted" },
};

export function StatusChip({ status, className }: { status: SnapshotStatus | null | undefined; className?: string }) {
  const s = statusStyle[status ?? "NONE"];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium",
        s.cls,
        className,
      )}
    >
      <s.icon className={cn("size-3.5", s.spin && "animate-spin")} aria-hidden="true" />
      {s.label}
    </span>
  );
}

export function Chip({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center rounded-md bg-surface-2 px-2 py-0.5 text-xs text-fg", className)}>
      {children}
    </span>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: typeof CircleCheck;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-4 py-10 text-center">
      <span className="inline-flex size-12 items-center justify-center rounded-2xl bg-surface-2 text-fg-muted">
        <Icon className="size-6" aria-hidden="true" />
      </span>
      <p className="mt-4 font-medium text-fg">{title}</p>
      <p className="mt-1 max-w-sm text-sm text-fg-muted">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
