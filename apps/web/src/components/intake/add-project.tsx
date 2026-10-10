"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, CircleCheck, FileArchive, FolderOpen, FolderUp, Upload } from "lucide-react";
import { DEFAULT_EXCLUSIONS, INTAKE_LIMITS, type GithubStatus, type ProjectSummary, type SnapshotSummary } from "@cybercheck/contracts";
import { useAppData } from "@/components/app/app-data";
import { GitHubIcon } from "@/components/auth/provider-icons";
import { Button } from "@/components/ui/button";
import { Alert, Field, Spinner } from "@/components/ui/form";
import { ApiError, api, uploadWithProgress } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatBytes, formatCount } from "@/lib/format";
import { GithubImport } from "./github-import";
import { checkFolder, fromDirectoryInput, readDroppedEntries, zipFolder, type FolderScan } from "./pack-folder";
import { ProgressView } from "./progress-view";

export type AddSource = "github" | "upload";
type Step = "source" | "pick" | "details" | "progress";

const STEP_LABELS: Record<AddSource | "none", string[]> = {
  none: ["Source", "Choose", "Confirm", "Snapshot"],
  github: ["Source", "Repository", "Configure", "Snapshot"],
  upload: ["Source", "Files", "Name and permission", "Snapshot"],
};
const STEP_INDEX: Record<Step, number> = { source: 0, pick: 1, details: 2, progress: 3 };
const ACCEPT = [".zip", ".tar.gz", ".tgz"];
const MAX_MB = INTAKE_LIMITS.maxUploadBytes / 1024 / 1024;

function Stepper({ source, current }: { source: AddSource | null; current: number }) {
  const labels = STEP_LABELS[source ?? "none"];
  return (
    <ol className="flex items-center gap-2" aria-label="Progress">
      {labels.map((label, i) => (
        <li key={label} className="flex flex-1 items-center gap-2" aria-current={i === current ? "step" : undefined}>
          <span
            className={cn(
              "inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors duration-300",
              i < current ? "bg-success text-white" : i === current ? "bg-primary text-primary-fg" : "bg-surface-2 text-fg-muted",
            )}
          >
            {i < current ? <CircleCheck className="size-4" aria-hidden="true" /> : i + 1}
          </span>
          <span className={cn("hidden text-xs sm:inline", i === current ? "font-medium text-fg" : "text-fg-muted")}>{label}</span>
          {i < labels.length - 1 && <span className="h-px flex-1 bg-border" aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
}

function SourceCard({
  icon,
  title,
  body,
  badge,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  badge?: string | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group cursor-pointer rounded-2xl border border-border bg-surface p-5 text-left transition duration-200 hover:-translate-y-0.5 hover:border-accent/50 hover:shadow-md"
    >
      <div className="flex items-start justify-between gap-3">
        <span className="inline-flex size-10 items-center justify-center rounded-xl bg-accent/10 text-accent transition-colors group-hover:bg-accent group-hover:text-white">
          {icon}
        </span>
        {badge && <span className="rounded-full bg-success/10 px-2.5 py-1 text-xs font-medium text-success">{badge}</span>}
      </div>
      <p className="mt-4 font-semibold text-fg">{title}</p>
      <p className="mt-1 text-sm text-fg-muted">{body}</p>
    </button>
  );
}

/** Upload from the computer: a folder (zipped here) or a ready-made archive. */
function LocalPicker({ onReady }: { onReady: (file: File, suggestedName: string, scan: FolderScan | null) => void }) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [packing, setPacking] = useState<{ files: number; fraction: number } | null>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  // React has no typed prop for directory pickers; set the attributes directly.
  useEffect(() => {
    folderRef.current?.setAttribute("webkitdirectory", "");
    folderRef.current?.setAttribute("directory", "");
  }, []);

  function takeArchive(f: File) {
    const lower = f.name.toLowerCase();
    if (!ACCEPT.some((ext) => lower.endsWith(ext))) {
      setError("Choose a project folder, or a .zip, .tar.gz or .tgz file.");
      return;
    }
    if (f.size > INTAKE_LIMITS.maxUploadBytes) {
      setError(`This file is ${formatBytes(f.size)}. The limit is ${MAX_MB} MB: delete node_modules and build output, then try again.`);
      return;
    }
    if (f.size === 0) {
      setError("This file is empty.");
      return;
    }
    onReady(f, f.name.replace(/\.(zip|tar\.gz|tgz)$/i, ""), null);
  }

  async function takeFolder(raw: { rootName: string; files: import("./pack-folder").FolderFile[]; skipped: number }) {
    const scan = checkFolder(raw);
    if (scan.problems.length > 0) {
      setError(scan.problems.join(" "));
      return;
    }
    setPacking({ files: scan.files.length, fraction: 0 });
    try {
      const zip = await zipFolder(scan, (fraction) => setPacking({ files: scan.files.length, fraction }));
      if (zip.size > INTAKE_LIMITS.maxUploadBytes) {
        setError(`Even compressed, this folder is ${formatBytes(zip.size)} (limit ${MAX_MB} MB). Remove large media or data files.`);
        return;
      }
      onReady(zip, scan.rootName, scan);
    } catch {
      setError("We couldn't read some files in that folder. Check permissions and try again, or upload a .zip.");
    } finally {
      setPacking(null);
    }
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    setError(null);
    const folder = await readDroppedEntries(e.dataTransfer.items).catch(() => null);
    if (folder) return takeFolder(folder);
    const f = e.dataTransfer.files[0];
    if (f) takeArchive(f);
  }

  if (packing) {
    return (
      <div className="rounded-2xl border border-border p-6" aria-live="polite">
        <p className="flex items-center gap-2 font-medium text-fg">
          <Spinner /> Packing {formatCount(packing.files, "file")}
        </p>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-2">
          <div className="h-full origin-left rounded-full bg-accent transition-transform" style={{ transform: `scaleX(${packing.fraction})` }} />
        </div>
        <p className="mt-2 text-xs text-fg-muted">Compressing in your browser. Your files are only read, never run.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors duration-200",
          dragging ? "border-accent bg-accent/5" : "border-border bg-surface-2/40",
        )}
      >
        <FolderUp className={cn("size-10 transition-transform duration-200", dragging ? "scale-110 text-accent" : "text-fg-muted")} aria-hidden="true" />
        <p className="mt-4 font-medium text-fg">Drag your project folder here</p>
        <p className="mt-1 text-sm text-fg-muted">or a .zip / .tar.gz up to {MAX_MB} MB</p>
        <div className="mt-5 flex flex-wrap justify-center gap-3">
          <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-full bg-primary px-4 text-sm font-medium text-primary-fg transition hover:opacity-90">
            <FolderOpen className="size-4" aria-hidden="true" /> Choose folder
            <input
              ref={folderRef}
              type="file"
              multiple
              className="sr-only"
              data-testid="folder-input"
              onChange={(e) => e.target.files?.length && takeFolder(fromDirectoryInput(e.target.files))}
            />
          </label>
          <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border border-border px-4 text-sm font-medium text-fg transition hover:bg-surface-2">
            <FileArchive className="size-4" aria-hidden="true" /> Choose .zip or .tar.gz
            <input
              type="file"
              accept=".zip,.tar.gz,.tgz,application/zip,application/gzip"
              className="sr-only"
              data-testid="archive-input"
              onChange={(e) => e.target.files?.[0] && takeArchive(e.target.files[0])}
            />
          </label>
        </div>
      </div>
      {error && <Alert>{error}</Alert>}
      <p className="text-xs text-fg-muted">
        We leave out {DEFAULT_EXCLUSIONS.join(" ")} automatically, so there&apos;s no need to delete them first.
      </p>
    </div>
  );
}

export function AddProjectFlow({
  onDone,
  onCancel,
  existingProject,
  initialSource,
}: {
  onDone?: (project: ProjectSummary) => void;
  onCancel?: () => void;
  /** Add a new snapshot to this project instead of creating one. */
  existingProject?: ProjectSummary;
  initialSource?: AddSource;
}) {
  const { workspace, upsertProject } = useAppData();
  const startSource: AddSource | null = existingProject ? (existingProject.sourceType === "github" ? "github" : "upload") : (initialSource ?? null);
  const [source, setSource] = useState<AddSource | null>(startSource);
  const [step, setStep] = useState<Step>(startSource ? "pick" : "source");
  const [github, setGithub] = useState<GithubStatus | null>(null);

  // upload state
  const [file, setFile] = useState<File | null>(null);
  const [scan, setScan] = useState<FolderScan | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [attest, setAttest] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<ApiError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState(0);
  const idempotencyKey = useRef("");

  const [project, setProject] = useState<ProjectSummary | null>(existingProject ?? null);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  // Show "@login connected" on the GitHub card.
  useEffect(() => {
    if (step !== "source") return;
    let cancelled = false;
    api<GithubStatus>("/v1/github/status")
      .then((s) => !cancelled && setGithub(s))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [step]);

  function choose(s: AddSource) {
    setSource(s);
    setStep("pick");
  }

  async function submitUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!file || !workspace || !attest) return;
    setSubmitError(null);
    setNameError(null);
    if (!project && !name.trim()) {
      setNameError("Give your project a name.");
      return;
    }
    setSubmitting(true);
    try {
      let target = project;
      if (!target) {
        const r = await api<{ project: ProjectSummary }>(`/v1/workspaces/${workspace.id}/projects`, {
          method: "POST",
          json: { name: name.trim(), description: description.trim() || undefined, sourceType: "archive" },
        });
        target = r.project;
        setProject(target);
        upsertProject(target);
      }
      const form = new FormData();
      form.append("attest", "true"); // must precede the file part
      form.append("file", file, file.name);
      setProgress(0);
      const r = await uploadWithProgress<{ snapshot: SnapshotSummary }>(
        `/v1/projects/${target.id}/snapshots/archive`,
        form,
        { "Idempotency-Key": idempotencyKey.current },
        setProgress,
      );
      setSnapshotId(r.snapshot.id);
      setStep("progress");
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : new ApiError(0, "unexpected", "Upload failed.", "Try again.");
      if (apiErr.code === "project_name_taken" || apiErr.code === "invalid_request") setNameError(`${apiErr.message} ${apiErr.fix ?? ""}`);
      else setSubmitError(apiErr);
    } finally {
      setSubmitting(false);
    }
  }

  const heading = (text: string) => (
    <h3 ref={headingRef} tabIndex={-1} className="text-lg font-semibold text-fg outline-none">
      {text}
    </h3>
  );

  return (
    <div className="space-y-6">
      <Stepper source={source} current={source === "github" && step === "pick" ? 1 : STEP_INDEX[step]} />

      {step === "source" && (
        <div className="space-y-4">
          {heading("Where is your project?")}
          <div className="grid gap-3 sm:grid-cols-2">
            <SourceCard
              icon={<GitHubIcon className="size-5" />}
              title="Import from GitHub"
              body="Pick from your repositories, public or private. Read-only, pinned to an exact commit."
              badge={github?.authorized && github.login ? `@${github.login}` : null}
              onClick={() => choose("github")}
            />
            <SourceCard
              icon={<Upload className="size-5" aria-hidden="true" />}
              title="Upload from your computer"
              body={`Drop a project folder, or a .zip / .tar.gz up to ${MAX_MB} MB.`}
              onClick={() => choose("upload")}
            />
          </div>
          {onCancel && (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      )}

      {step === "pick" && source === "github" && (
        <div className="space-y-4">
          {heading(existingProject ? "Import a newer commit" : "Import a GitHub repository")}
          <GithubImport
            existingProject={existingProject}
            onBack={existingProject ? undefined : () => setStep("source")}
            onStarted={(p, id) => {
              setProject(p);
              setSnapshotId(id);
              setStep("progress");
            }}
          />
        </div>
      )}

      {step === "pick" && source === "upload" && (
        <div className="space-y-4">
          {heading("Upload from your computer")}
          <LocalPicker
            onReady={(f, suggested, s) => {
              setFile(f);
              setScan(s);
              idempotencyKey.current = crypto.randomUUID();
              if (!project) setName((n) => n || suggested.replace(/[^\w .()-]/g, "-").slice(0, 80));
              setStep("details");
            }}
          />
          {!existingProject && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setStep("source")}>
              <ArrowLeft aria-hidden="true" /> Back
            </Button>
          )}
        </div>
      )}

      {step === "details" && file && (
        <form onSubmit={submitUpload} noValidate className="space-y-5">
          {heading(project ? "Confirm and upload" : "Name your project")}
          <div className="flex items-center gap-3 rounded-xl border border-border bg-surface-2/50 p-3">
            {scan ? <FolderOpen className="size-5 shrink-0 text-accent" aria-hidden="true" /> : <FileArchive className="size-5 shrink-0 text-accent" aria-hidden="true" />}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-fg">{scan ? `${scan.rootName}/` : file.name}</p>
              <p className="text-xs text-fg-muted">
                {scan
                  ? `${formatCount(scan.files.length, "file")} · ${formatBytes(scan.totalBytes)} · ${formatCount(scan.skipped, "item")} left out`
                  : formatBytes(file.size)}
              </p>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setStep("pick")} disabled={submitting}>
              Change
            </Button>
          </div>

          {project ? (
            <p className="text-sm text-fg-muted">
              Adding a new snapshot to <span className="font-medium text-fg">{project.name}</span>.
            </p>
          ) : (
            <>
              <Field
                label="Project name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                error={nameError ?? undefined}
                hint="Shown in every check tab."
                maxLength={80}
                disabled={submitting}
              />
              <Field label="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} disabled={submitting} />
            </>
          )}

          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-4">
            <input
              type="checkbox"
              checked={attest}
              onChange={(e) => setAttest(e.target.checked)}
              className="mt-0.5 size-5 shrink-0 cursor-pointer accent-primary"
              disabled={submitting}
              required
            />
            <span className="text-sm">
              <span className="font-medium text-fg">I own this code or am authorized to assess it.</span>
              <span className="mt-0.5 block text-fg-muted">We record this with the snapshot. Checks only ever run on isolated copies.</span>
            </span>
          </label>

          {submitting && (
            <div aria-live="polite">
              <div className="flex justify-between text-xs text-fg-muted">
                <span>Uploading</span>
                <span className="tabular-nums">{Math.round(progress * 100)}%</span>
              </div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full origin-left rounded-full bg-accent transition-transform duration-200" style={{ transform: `scaleX(${progress})` }} />
              </div>
            </div>
          )}
          {submitError && (
            <Alert>
              {submitError.message} {submitError.fix}
            </Alert>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" shape="pill" disabled={submitting || !attest}>
              {submitting ? <Spinner /> : <Upload aria-hidden="true" />}
              {submitting ? "Uploading" : project ? "Upload snapshot" : "Create project and upload"}
            </Button>
            {!attest && <span className="text-xs text-fg-muted">Tick the confirmation to continue.</span>}
          </div>
        </form>
      )}

      {step === "progress" && project && snapshotId && (
        <ProgressView
          snapshotId={snapshotId}
          project={project}
          source={source === "github" ? "github" : "archive"}
          onDone={(p) => onDone?.(p)}
          retryLabel={source === "github" ? "Try again" : "Try another file"}
          onRetry={() => {
            setSnapshotId(null);
            setFile(null);
            setScan(null);
            setStep("pick");
          }}
        />
      )}
    </div>
  );
}

/** Modal wrapper (Overview / Projects). Uses the native <dialog> for focus trapping and Escape. */
export function AddProjectDialog({
  open,
  onClose,
  onDone,
  initialSource,
}: {
  open: boolean;
  onClose: () => void;
  onDone?: (p: ProjectSummary) => void;
  initialSource?: AddSource;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="add-project-title"
      className="m-auto w-[min(680px,calc(100%-2rem))] rounded-3xl border border-border bg-surface p-0 text-fg shadow-2xl backdrop:bg-black/40 backdrop:backdrop-blur-[2px]"
    >
      {open && (
        <div className="p-6 sm:p-8">
          <div className="mb-6 flex items-start justify-between gap-4">
            <div>
              <h2 id="add-project-title" className="text-xl font-semibold tracking-tight">
                Add a project
              </h2>
              <p className="mt-1 text-sm text-fg-muted">Saved once, available in every check tab.</p>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="Close">
              Close
            </Button>
          </div>
          <AddProjectFlow
            initialSource={initialSource}
            onCancel={onClose}
            onDone={(p) => {
              onDone?.(p);
              onClose();
            }}
          />
        </div>
      )}
    </dialog>
  );
}
