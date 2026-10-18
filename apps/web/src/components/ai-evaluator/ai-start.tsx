"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, FileUp, Play } from "lucide-react";
import type { AiDatasetValidationIssue, AiEvaluationProfile, AiEvaluationTarget, AiModelMode } from "@cybercheck/contracts";
import { Mono } from "@/components/architecture/parts";
import { Button } from "@/components/ui/button";
import { Alert, Spinner } from "@/components/ui/form";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { startAiEvaluation, uploadAiDataset, useAiDatasets, useAiRuns } from "./use-ai-evaluator";

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
  const [judge, setJudge] = useState<"auto" | "off">("auto");
  const [modelMode, setModelMode] = useState<AiModelMode>("auto");
  const [runtime, setRuntime] = useState<"auto" | "nebius" | "local" | "static">("auto");
  const [baselineRunId, setBaselineRunId] = useState("");
  const { runs } = useAiRuns(projectId);
  const [chosen, setChosen] = useState<string[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [issues, setIssues] = useState<{ message: string; issues: AiDatasetValidationIssue[] } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  // Declaring the endpoint is optional: cybercheck binds one unambiguous route on its own. Use this when a prior run
  // reported no target or an ambiguous one (the component id, e.g. ai:1, is listed there).
  const [declare, setDeclare] = useState(false);
  const [t, setT] = useState({ componentId: "ai:1", method: "POST" as "POST" | "GET", path: "", messageField: "message", responseSelector: "reply", citationSelector: "", conversationSelector: "", historyPath: "" });
  const field = (k: keyof typeof t, label: string, placeholder: string, required = false) => (
    <label className="block text-sm">
      <span className="text-fg-muted">{label}{required && <span className="text-danger"> *</span>}</span>
      <input value={t[k] as string} onChange={(e) => setT((s) => ({ ...s, [k]: e.target.value }))} placeholder={placeholder} className="mt-1 h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg focus-visible:outline-2 focus-visible:outline-ring" />
    </label>
  );
  const target = (): AiEvaluationTarget | undefined => {
    if (!declare || !t.path.trim()) return undefined;
    return {
      componentId: t.componentId.trim() || "ai:1",
      transport: "http",
      method: t.method,
      path: t.path.trim(),
      requestTemplate: { [t.messageField.trim() || "message"]: "{{message}}" },
      responseSelector: t.responseSelector.trim() || "reply",
      ...(t.citationSelector.trim() ? { citationSelector: t.citationSelector.trim() } : {}),
      ...(t.conversationSelector.trim() ? { conversationSelector: t.conversationSelector.trim() } : {}),
      ...(t.historyPath.trim() ? { historyPath: t.historyPath.trim() } : {}),
    };
  };

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
      const { run } = await startAiEvaluation(snapshotId, { profile, judge, modelMode, runtime, baselineRunId: baselineRunId || undefined, datasetIds: chosen, target: target() });
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
              <input type="radio" name="ai-profile" value={p.id} checked={profile === p.id} onChange={() => setProfile(p.id)} className="mt-1 accent-(--color-accent)" />
              <span>
                <span className="block text-sm font-medium text-fg">{p.label}</span>
                <span className="block text-xs text-fg-muted">{p.note}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-fg">AI judge</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {([{ id: "auto", label: "Automatic", note: "Use a calibrated judge for questions of meaning, when a model and credit are available." }, { id: "off", label: "Off", note: "Deterministic checks only; subjective cases stay inconclusive." }] as const).map((j) => (
            <label key={j.id} className={cn("flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 transition-colors", judge === j.id ? "border-accent bg-accent/5" : "border-border hover:border-fg/20")}>
              <input type="radio" name="ai-judge" value={j.id} checked={judge === j.id} onChange={() => setJudge(j.id)} className="mt-1 accent-(--color-accent)" />
              <span>
                <span className="block text-sm font-medium text-fg">{j.label}</span>
                <span className="block text-xs text-fg-muted">{j.note}</span>
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
                  <input type="checkbox" checked={chosen.includes(d.id)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, d.id].slice(-10) : c.filter((x) => x !== d.id)))} className="accent-(--color-accent)" />
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

      <details className="group rounded-xl border border-border [&_summary::-webkit-details-marker]:hidden" open={declare} onToggle={(e) => setDeclare((e.target as HTMLDetailsElement).open)}>
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 text-sm font-medium text-fg">
          <span>Advanced options</span>
          <ChevronDown className="size-4 text-fg-muted transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="space-y-4 px-4 pb-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block text-sm">
              <span className="text-fg-muted">Model mode</span>
              <select value={modelMode} onChange={(e) => setModelMode(e.target.value as AiModelMode)} className="mt-1 h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg focus-visible:outline-2 focus-visible:outline-ring">
                <option value="auto">Automatic</option>
                <option value="replay">Replay (scripted model)</option>
                <option value="live">Live (real model)</option>
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-fg-muted">Runtime</span>
              <select value={runtime} onChange={(e) => setRuntime(e.target.value as typeof runtime)} className="mt-1 h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg focus-visible:outline-2 focus-visible:outline-ring">
                <option value="auto">Automatic</option>
                <option value="nebius">Nebius sandbox</option>
                <option value="local">Local Docker</option>
                <option value="static">Analysis only</option>
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-fg-muted">Baseline run (for comparison)</span>
              <select value={baselineRunId} onChange={(e) => setBaselineRunId(e.target.value)} className="mt-1 h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg focus-visible:outline-2 focus-visible:outline-ring">
                <option value="">None</option>
                {(runs ?? []).filter((r) => r.status === "completed").slice(0, 10).map((r) => (
                  <option key={r.id} value={r.id}>
                    {new Date(r.createdAt).toLocaleString()} ({r.decision ?? r.status})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs text-fg-muted">Live mode and a pairwise baseline comparison need a real model and credits; without them, live is reported as blocked and automatic falls back to the replay model.</p>
          <div className="border-t border-border" />
          <p className="text-xs text-fg-muted">
            cybercheck binds one unambiguous route on its own. Declare the endpoint only when a run reported no target or an ambiguous one; the component id (such as <span className="font-mono">ai:1</span>) is listed in that run&apos;s Components tab.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="text-fg-muted">Method</span>
              <select value={t.method} onChange={(e) => setT((s) => ({ ...s, method: e.target.value as "POST" | "GET" }))} className="mt-1 h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-fg focus-visible:outline-2 focus-visible:outline-ring">
                <option value="POST">POST</option>
                <option value="GET">GET</option>
              </select>
            </label>
            {field("path", "Path", "/api/assistant", true)}
            {field("componentId", "Component id", "ai:1")}
            {field("messageField", "Message field", "message")}
            {field("responseSelector", "Response selector", "reply")}
            {field("citationSelector", "Citation selector", "citations")}
            {field("conversationSelector", "Conversation selector", "conversationId")}
            {field("historyPath", "History endpoint", "/api/assistant/history")}
          </div>
        </div>
      </details>

      <Button type="button" shape="pill" size="lg" className="w-full" disabled={!snapshotId || starting || (declare && !t.path.trim())} onClick={() => void start()}>
        {starting ? <Spinner /> : <Play aria-hidden="true" />} Start AI Evaluator check
      </Button>
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
