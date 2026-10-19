"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";
import type { AdversarialProfile } from "@cybercheck/contracts";
import { Button } from "@/components/ui/button";
import { Alert, Spinner } from "@/components/ui/form";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { startAdversarial } from "./use-adversarial";

const PROFILES: Array<{ id: AdversarialProfile; label: string; note: string }> = [
  { id: "quick", label: "Quick", note: "Up to 8 high-priority campaigns." },
  { id: "standard", label: "Standard", note: "Up to 24 campaigns across every applicable lane." },
  { id: "deep", label: "Deep", note: "Up to 60 campaigns with the largest bounded budget." },
];

export function AdversarialStart({ projectId, snapshotId, onStarted }: { projectId: string; snapshotId: string | null; onStarted: () => void }) {
  const router = useRouter();
  const [profile, setProfile] = useState<AdversarialProfile>("standard");
  const [runtime, setRuntime] = useState<"auto" | "nebius" | "local">("auto");
  const [aiAttacker, setAiAttacker] = useState<"auto" | "off">("auto");
  const [aiCritic, setAiCritic] = useState<"auto" | "off">("auto");
  const [component, setComponent] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    if (!snapshotId) return;
    setStarting(true);
    setError(null);
    try {
      const { run } = await startAdversarial(snapshotId, { profile, runtime, aiAttacker, aiCritic, targetComponentId: component.trim() || null });
      onStarted();
      router.push(`/app/projects/${projectId}/adversarial/${run.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? `${e.message} ${e.fix ?? ""}` : "The check could not start. Try again.");
      setStarting(false);
    }
  };
  return (
    <div className="space-y-5">
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-fg">Attack profile</legend>
        <div className="grid gap-2">
          {PROFILES.map((p) => (
            <label key={p.id} className={cn("flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border px-4 py-3", profile === p.id ? "border-accent bg-accent/5" : "border-border hover:border-fg/20")}>
              <input type="radio" name="adversarial-profile" checked={profile === p.id} onChange={() => setProfile(p.id)} className="mt-1 accent-(--color-accent)" />
              <span><span className="block text-sm font-medium text-fg">{p.label}</span><span className="block text-xs text-fg-muted">{p.note}</span></span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm text-fg-muted">Runtime
          <select value={runtime} onChange={(e) => setRuntime(e.target.value as typeof runtime)} className="mt-1 h-10 w-full rounded-lg border border-border bg-surface px-3 text-fg">
            <option value="auto">Automatic</option><option value="nebius">Nebius sandbox</option><option value="local">Local Docker</option>
          </select>
        </label>
        <label className="text-sm text-fg-muted">Component id (only if ambiguous)
          <input value={component} onChange={(e) => setComponent(e.target.value)} placeholder="ai:1" className="mt-1 h-10 w-full rounded-lg border border-border bg-surface px-3 text-fg" />
        </label>
        <label className="text-sm text-fg-muted">Optional AI attacker
          <select value={aiAttacker} onChange={(e) => setAiAttacker(e.target.value as typeof aiAttacker)} className="mt-1 h-10 w-full rounded-lg border border-border bg-surface px-3 text-fg"><option value="auto">Automatic</option><option value="off">Off</option></select>
        </label>
        <label className="text-sm text-fg-muted">Optional AI critic
          <select value={aiCritic} onChange={(e) => setAiCritic(e.target.value as typeof aiCritic)} className="mt-1 h-10 w-full rounded-lg border border-border bg-surface px-3 text-fg"><option value="auto">Automatic</option><option value="off">Off</option></select>
        </label>
      </div>
      <Alert tone="info">Deterministic attacks run without AI credits. If an attacker or critic model is unavailable, the run continues and reports that limitation.</Alert>
      <Button type="button" shape="pill" size="lg" className="w-full" disabled={!snapshotId || starting} onClick={() => void start()}>{starting ? <Spinner /> : <Play aria-hidden="true" />} Start AI Adversarial check</Button>
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
