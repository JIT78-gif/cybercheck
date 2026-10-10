import { CircleX, FolderMinus, TriangleAlert } from "lucide-react";
import type { IntakeIssue, SnapshotSummary } from "@cybercheck/contracts";
import { Chip } from "@/components/app/ui";
import { formatBytes, formatCount, shortDigest } from "@/lib/format";

export function IssueList({ items, tone }: { items: IntakeIssue[]; tone: "danger" | "warning" }) {
  const Icon = tone === "danger" ? CircleX : TriangleAlert;
  return (
    <ul className="space-y-3">
      {items.map((i, n) => (
        <li key={`${i.code}-${n}`} className="flex gap-3">
          <Icon className={`mt-0.5 size-4 shrink-0 ${tone === "danger" ? "text-danger" : "text-warning"}`} aria-hidden="true" />
          <div className="min-w-0 text-sm">
            <p className="text-fg">{i.message}</p>
            {i.path && <p className="mt-0.5 truncate font-mono text-xs text-fg-muted">{i.path}</p>}
            <p className="mt-1 text-fg-muted">
              <span className="font-medium text-fg">How to fix: </span>
              {i.fix}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Facts about a baselined snapshot: what was frozen and what we detected. */
export function SnapshotFacts({ snapshot }: { snapshot: SnapshotSummary }) {
  const d = snapshot.detection;
  const stack = d
    ? [
        ...d.languages.slice(0, 3),
        ...d.frameworks,
        ...(d.packageManager ? [d.packageManager] : []),
      ]
    : [];
  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div>
          <dt className="text-xs text-fg-muted">Files</dt>
          <dd className="mt-1 font-mono text-sm text-fg tabular-nums">{formatCount(snapshot.fileCount, "file")}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">Size</dt>
          <dd className="mt-1 font-mono text-sm text-fg tabular-nums">{formatBytes(snapshot.totalBytes)}</dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">{snapshot.resolvedRevision ? "Commit" : "Content digest"}</dt>
          <dd className="mt-1 font-mono text-sm text-fg" title={snapshot.resolvedRevision ?? snapshot.contentDigest ?? ""}>
            {shortDigest(snapshot.resolvedRevision ?? snapshot.contentDigest) ?? "n/a"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-fg-muted">AI components</dt>
          <dd className="mt-1 text-sm text-fg">{d && d.aiSdks.length > 0 ? d.aiSdks.join(", ") : "None detected"}</dd>
        </div>
      </dl>
      {stack.length > 0 && (
        <div>
          <p className="text-xs text-fg-muted">Detected stack</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {stack.map((s) => (
              <Chip key={s}>{s}</Chip>
            ))}
            {d?.typescript && !stack.includes("TypeScript") && <Chip>TypeScript</Chip>}
          </div>
        </div>
      )}
      {snapshot.exclusions.length > 0 && (
        <div className="flex items-start gap-2 text-sm text-fg-muted">
          <FolderMinus className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>
            Left out (re-installable or generated): <span className="text-fg">{snapshot.exclusions.join(", ")}</span>
          </p>
        </div>
      )}
      {snapshot.warnings.length > 0 && (
        <div>
          <p className="mb-2 text-xs text-fg-muted">
            {formatCount(snapshot.warnings.length, "note")} (the snapshot is still usable)
          </p>
          <IssueList items={snapshot.warnings} tone="warning" />
        </div>
      )}
    </div>
  );
}
