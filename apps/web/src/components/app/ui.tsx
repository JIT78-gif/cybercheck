import { CircleCheck, CircleDashed, CircleX, LoaderCircle, TriangleAlert } from "lucide-react";
import type { SnapshotStatus } from "@cybercheck/contracts";
import { cn } from "@/lib/cn";

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
  BASELINED: { label: "Ready", icon: CircleCheck, cls: "border-success/30 bg-success/8 text-success" },
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
