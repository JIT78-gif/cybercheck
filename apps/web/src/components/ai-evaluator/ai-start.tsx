"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileUp, Play } from "lucide-react";
import type { AiDatasetValidationIssue, AiEvaluationProfile } from "@cybercheck/contracts";
import { Mono } from "@/components/architecture/parts";
import { Button } from "@/components/ui/button";
import { Alert, Spinner } from "@/components/ui/form";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { startAiEvaluation, uploadAiDataset, useAiDatasets } from "./use-ai-evaluator";

const PROFILES: Array<{ id: AiEvaluationProfile; label: string; note: string }> = [
  { id: "quick", label: "Quick", note: "Up to 20 cases; skips the slow provider-timeout case." },
  { id: "standard", label: "Standard", note: "Up to 75 cases, including the provider-timeout case." },
  { id: "deep", label: "Deep", note: "Up to 200 cases, for large uploaded datasets." },
];

/** Start panel on the AI Evaluator tab: profile, optional JSONL datasets, then start. */
export function AiStart({ projectId, snapshotId, onStarted }: { projectId: string; snapshotId: string | null; onStarted: () => void }) {
  const router = useRouter();
  const { datasets, reload } = useAiDatasets(projectId);
  const [profile, setProfile] = useState<AiEvaluationProfile>("standard");
  const [chosen, setChosen] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [issues, setIssues] = useState<{ message: string; issues: AiDatasetValidationIssue[] } | null>(null);
  const file = useRef<HTMLInputElement>(null);

  async function upload(f: File) {
    setUploading(true);
    setIssues(null);
    try {
      if (f.size > 5 * 1024 * 1024) {
        setIssues({ message: "The file is larger than 5 MB.", issues: [] });
        return;
      }
      const name = f.name.replace(/\.jsonl?$/i, "").replace(/[^\w .-]/g, "-").slice(0, 80) || "dataset";
      const r = await uploadAiDataset(projectId, name, await f.text());
      if ("dataset" in r) {
        reload();
        setChosen((c) => [...c, r.dataset.id].slice(-10));
      } else setIssues(r);
    } finally {
      setUploading(false);
      if (file.current) file.current.value = "";
    }
  }

  async function start() {
    if (!snapshotId) return;
    setStarting(true);
    setError(null);
    try {
      const { run } = await startAiEvaluation(snapshotId, { profile, datasetIds: chosen });
      onStarted();
      router.push(`/app/projects/${projectId}/ai-evaluator/${run.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.message} ${e.fix ?? ""}` : "The check could not start. Try again.");
      setStarting(false);
    }
  }

  return (
    <div className="space-y-5">
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-fg">Profile</legend>
        <div className="grid gap-2">
          {PROFILES.map((p) => (
            <label key={p.id} className={cn("flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors", profile === p.id ? "border-accent bg-accent/5" : "border-border hover:border-fg/20")}>
              <input type="radio" name="ai-profile" value={p.id} checked={profile === p.id} onChange={() => setProfile(p.id)} className="mt-1 accent-[var(--color-accent)]" />
              <span>
                <span className="block text-sm font-medium text-fg">{p.label}</span>
                <span className="block text-xs text-fg-muted">{p.note}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-1 text-sm font-medium text-fg">Your own test cases (optional)</legend>
        <p className="mb-2 text-xs text-fg-muted">
          A JSONL file, one case per line, up to 5 MB and 2000 cases. Use synthetic data only: links, commands, credentials and personal data are refused. Add <Mono>replay</Mono> turns to script the model&apos;s answer.
        </p>
        {datasets === null ? (
          <p className="flex items-center gap-2 text-sm text-fg-muted">
            <Spinner /> Loading datasets
          </p>
        ) : datasets.length > 0 ? (
          <ul className="mb-3 space-y-1.5">
            {datasets.map((d) => (
              <li key={d.id}>
                <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 hover:bg-surface-2/60">
                  <input type="checkbox" checked={chosen.includes(d.id)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, d.id].slice(-10) : c.filter((x) => x !== d.id)))} className="accent-[var(--color-accent)]" />
                  <span className="min-w-0 text-sm text-fg">
                    {d.name} <span className="text-fg-muted">v{d.version}, {d.caseCount} case(s)</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        ) : null}
        <input
          ref={file}
          id="ai-dataset-file"
          type="file"
          accept=".jsonl,.json,application/jsonl,application/x-ndjson"
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
        <Button type="button" variant="outline" shape="pill" size="sm" disabled={uploading} onClick={() => file.current?.click()}>
          {uploading ? <Spinner /> : <FileUp aria-hidden="true" />} Upload a JSONL dataset
        </Button>
        {issues && (
          <Alert className="mt-3">
            <p>{issues.message}</p>
            {issues.issues.length > 0 && (
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {issues.issues.slice(0, 8).map((i, k) => (
                  <li key={k}>
                    {i.line ? `Line ${i.line}` : "File"}
                    {i.caseId ? ` (${i.caseId})` : ""}: {i.problem}
                  </li>
                ))}
                {issues.issues.length > 8 && <li>and {issues.issues.length - 8} more</li>}
              </ul>
            )}
          </Alert>
        )}
      </fieldset>

      <Button type="button" shape="pill" size="lg" className="w-full" disabled={!snapshotId || starting} onClick={() => void start()}>
        {starting ? <Spinner /> : <Play aria-hidden="true" />} Start AI Evaluator check
      </Button>
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
