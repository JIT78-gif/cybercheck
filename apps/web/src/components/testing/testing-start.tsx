"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronDown, Clock, Coins, Gauge, Info, Play, SlidersHorizontal, TriangleAlert } from "lucide-react";
import { PROFILE_TARGET, type RunOptions, type TestingPreview, type TestingProfile } from "@cybercheck/contracts";
import { Button } from "@/components/ui/button";
import { Alert, Spinner } from "@/components/ui/form";
import { cn } from "@/lib/cn";
import { ApiError } from "@/lib/api";
import { previewTesting, startTesting } from "./use-testing";

const PROFILES: Array<{ id: TestingProfile; label: string; detail: string }> = [
  { id: "fast", label: "Fast", detail: "Aims at 50% completeness. Build, your tests once, the main API checks and screens. A quick check before a merge; no load test unless you switch it on." },
  { id: "standard", label: "Standard", detail: "Aims at 70% completeness. The release check: your tests once (failures are confirmed), sign-in and data set up for the API, every screen at desktop and phone width with accessibility, the critical journeys, database probes and a one-user load smoke test." },
  { id: "deep", label: "Deep", detail: "Aims at 90% completeness. Standard plus repeated test runs to catch flaky tests, a tablet width, more journeys, and every load test up to the breakpoint. Takes longer and costs more." },
];

type LoadStage = NonNullable<RunOptions["loadStages"]>[number];

/** The load tests after the one-user smoke test, which always runs. All of them stay inside the sandbox. */
const LOAD_TESTS: Array<{ id: LoadStage; label: string; detail: string; seconds: number }> = [
  { id: "average", label: "Average", detail: "20 users for a minute: everyday traffic", seconds: 60 },
  { id: "stress", label: "Stress", detail: "50 users for a minute: heavy traffic", seconds: 60 },
  { id: "spike", label: "Spike", detail: "0 to 100 users in 10 s: a sudden rush", seconds: 35 },
  { id: "breakpoint", label: "Breakpoint", detail: "Raises requests per second until the app gives way, and reports that limit", seconds: 120 },
];
const LOAD_DEFAULT: Record<TestingProfile, LoadStage[]> = { fast: [], standard: ["average", "stress"], deep: ["average", "stress", "spike", "breakpoint"] };

const LAYER: Record<string, string> = {
  environment: "build and start",
  existing_suite: "your tests",
  api: "API",
  unit: "unit",
  data: "database",
  ui: "screens",
  accessibility: "accessibility",
  performance: "load",
  reliability: "reliability",
  job: "jobs",
  integration: "integrations",
  deployment: "deployment",
};

/** Start a Testing run: choose the profile, see what it will do and cost, and avoid paying for an identical rerun. */
export function TestingStart({ projectId, snapshotId, ready }: { projectId: string; snapshotId: string | null; ready: boolean }) {
  const router = useRouter();
  const [profile, setProfile] = useState<TestingProfile>("standard");
  const [p95, setP95] = useState("");
  const [errPct, setErrPct] = useState("");
  // Run options; empty or null means the profile default.
  const [target, setTarget] = useState("");
  const [budget, setBudget] = useState("");
  const [minutes, setMinutes] = useState("");
  const [browser, setBrowser] = useState(true);
  const [load, setLoad] = useState<boolean | null>(null);
  const [generated, setGenerated] = useState(true);
  const [acceptRisk, setAcceptRisk] = useState(true);
  const loadOn = load ?? profile === "deep";
  // Null: the profile's own load tests. A list: exactly the tests the user ticked.
  const [stages, setStages] = useState<LoadStage[] | null>(null);
  const chosenStages = stages ?? LOAD_DEFAULT[profile];
  const options: RunOptions = {
    ...(target ? { targetCompleteness: Number(target) } : {}),
    ...(budget ? { budgetUsd: Number(budget) } : {}),
    ...(minutes ? { maxSandboxMinutes: Number(minutes) } : {}),
    ...(browser ? {} : { browser: false }),
    ...(load == null ? {} : { load }),
    ...(loadOn && stages ? { loadStages: LOAD_TESTS.map((t) => t.id).filter((id) => stages.includes(id)) } : {}),
    ...(generated ? {} : { generatedTests: false }),
    ...(acceptRisk ? {} : { allowAcceptedRisk: false }),
  };
  const optionsKey = JSON.stringify(options);
  const badOption = (target !== "" && !(Number(target) >= 10 && Number(target) <= 100)) || (budget !== "" && !(Number(budget) > 0 && Number(budget) <= 50)) || (minutes !== "" && !(Number(minutes) >= 2 && Number(minutes) <= 120));
  // The preview belongs to the options it was computed for; a stale one is never shown.
  const [result, setResult] = useState<{ key: string; preview: TestingPreview | null; error: string | null } | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const thresholds = p95 || errPct ? { ...(p95 ? { p95Ms: Number(p95) } : {}), ...(errPct ? { errorRatePct: Number(errPct) } : {}) } : undefined;
  const thresholdsKey = JSON.stringify(thresholds ?? null);
  const key = `${snapshotId}:${profile}:${thresholdsKey}:${optionsKey}`;
  const current = result?.key === key ? result : null;
  const preview = current?.preview ?? null;
  const previewError = current?.error ?? null;

  useEffect(() => {
    if (!snapshotId || !ready) return;
    let alive = true;
    const t = setTimeout(() => {
      const k = `${snapshotId}:${profile}:${thresholdsKey}:${optionsKey}`;
      previewTesting(snapshotId, { profile, thresholds: thresholdsKey === "null" ? undefined : JSON.parse(thresholdsKey), ...JSON.parse(optionsKey) })
        .then((r) => alive && setResult({ key: k, preview: r.preview, error: null }))
        .catch((e) => alive && setResult({ key: k, preview: null, error: e instanceof ApiError ? e.message : "The preview is not available." }));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [snapshotId, ready, profile, thresholdsKey, optionsKey]);

  async function start(force = false) {
    if (!snapshotId) return;
    setStarting(true);
    setError(null);
    try {
      const { run } = await startTesting(snapshotId, { profile, thresholds, force, ...options });
      router.push(`/app/projects/${projectId}/testing/${run.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "unexpected", "The check could not start.", "Try again."));
      setStarting(false);
    }
  }

  const identical = preview?.identicalRun ?? null;
  const badThreshold = (p95 !== "" && !(Number(p95) > 0)) || (errPct !== "" && !(Number(errPct) >= 0 && Number(errPct) <= 100)) || badOption;

  return (
    <div className="space-y-5">
      <fieldset>
        <legend className="mb-1.5 text-sm font-medium text-fg">Profile</legend>
        <div className="grid grid-cols-3 gap-1 rounded-xl bg-surface-2 p-1" role="radiogroup" aria-label="Testing profile">
          {PROFILES.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={profile === p.id}
              onClick={() => setProfile(p.id)}
              className={cn("min-h-11 cursor-pointer rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring", profile === p.id ? "bg-surface text-fg shadow-sm" : "text-fg-muted hover:text-fg")}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-sm text-fg-muted">{PROFILES.find((p) => p.id === profile)!.detail}</p>
      </fieldset>

      <details className="group/o rounded-xl border border-border [&_summary::-webkit-details-marker]:hidden">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 text-sm font-medium text-fg">
          <span className="inline-flex items-center gap-2">
            <SlidersHorizontal className="size-4 text-fg-muted" aria-hidden="true" /> Coverage target, budget and what runs
          </span>
          <span className="flex items-center gap-2 text-xs font-normal text-fg-muted">
            aim {target || PROFILE_TARGET[profile]}%
            <ChevronDown className="size-4 transition-transform group-open/o:rotate-180" aria-hidden="true" />
          </span>
        </summary>
        <div className="space-y-4 px-4 pb-4">
          <p className="text-sm text-fg-muted">The completeness target is what the run aims for, not a promise: if it stops below the target, the report says why. Higher targets take longer and cost more.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <NumberField label="Completeness target (%)" value={target} onChange={setTarget} placeholder={`${PROFILE_TARGET[profile]} (default)`} />
            <NumberField label="AI budget at most ($)" value={budget} onChange={setBudget} placeholder="server default" decimal />
            <NumberField label="Sandbox time at most (min)" value={minutes} onChange={setMinutes} placeholder="no limit" />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <Toggle checked={browser} onChange={setBrowser} label="Browser checks" hint="Open every screen at desktop and phone width, accessibility, journeys" />
            <Toggle checked={loadOn} onChange={(v) => setLoad(v)} label="Load testing" hint={loadOn ? "Choose the load tests below" : "Only a one-user smoke test; switch on for average, stress, spike and breakpoint"} />
            <Toggle checked={generated} onChange={setGenerated} label="Extra tests written by AI" hint="Request scenarios and unit tests beyond the rules" />
            <Toggle checked={acceptRisk} onChange={setAcceptRisk} label="Reviewers may accept risks" hint="Lets a reviewer release with a known high-severity problem" />
          </div>
          {loadOn && (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium text-fg">Load tests</legend>
              <p className="text-xs text-fg-muted">A one-user smoke test always runs first. They all run against your app inside the sandbox; nothing reaches your real servers. About {Math.ceil((20 + chosenStages.reduce((n, id) => n + LOAD_TESTS.find((t) => t.id === id)!.seconds, 0)) / 60)} min of load in total.</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {LOAD_TESTS.map((t) => (
                  <Toggle
                    key={t.id}
                    checked={chosenStages.includes(t.id)}
                    onChange={(v) => setStages(v ? [...chosenStages, t.id] : chosenStages.filter((x) => x !== t.id))}
                    label={t.label}
                    hint={`About ${t.seconds < 60 ? `${t.seconds} s` : `${Math.round(t.seconds / 60)} min`}. ${t.detail}.`}
                  />
                ))}
              </div>
            </fieldset>
          )}
          {badOption && <p className="text-sm text-danger">The target is 10 to 100%, the budget up to $50, and the time limit 2 to 120 minutes.</p>}
        </div>
      </details>

      <details className="group rounded-xl border border-border [&_summary::-webkit-details-marker]:hidden">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 text-sm font-medium text-fg">
          <span className="inline-flex items-center gap-2">
            <Gauge className="size-4 text-fg-muted" aria-hidden="true" /> Load thresholds (optional)
          </span>
          <ChevronDown className="size-4 text-fg-muted transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div className="space-y-3 px-4 pb-4">
          <p className="text-sm text-fg-muted">Without thresholds the load test reports measurements only, never pass or fail. The load stays inside the sandbox; nothing is sent to your real servers.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              <span className="font-medium text-fg">p95 response time (ms)</span>
              <input inputMode="numeric" value={p95} onChange={(e) => setP95(e.target.value.replace(/[^\d]/g, ""))} placeholder="for example 500" className="mt-1 h-11 w-full rounded-xl border border-border bg-surface px-3 text-base text-fg focus-visible:outline-2 focus-visible:outline-ring" />
            </label>
            <label className="block text-sm">
              <span className="font-medium text-fg">Server errors at most (%)</span>
              <input inputMode="decimal" value={errPct} onChange={(e) => setErrPct(e.target.value.replace(/[^\d.]/g, ""))} placeholder="for example 1" className="mt-1 h-11 w-full rounded-xl border border-border bg-surface px-3 text-base text-fg focus-visible:outline-2 focus-visible:outline-ring" />
            </label>
          </div>
          {badThreshold && <p className="text-sm text-danger">Enter a positive time and an error rate between 0 and 100.</p>}
        </div>
      </details>

      {ready && snapshotId && (
        <section aria-label="What this run will do" className="rounded-xl bg-surface-2/60 p-4 text-sm">
          {!preview && !previewError && (
            <p className="flex items-center gap-2 text-fg-muted">
              <Spinner /> Working out what this run will check
            </p>
          )}
          {previewError && <p className="text-fg-muted">{previewError}</p>}
          {preview && (
            <div className="space-y-2">
              <p className="text-fg">
                <span className="font-medium tabular-nums">{preview.obligations}</span> planned checks:{" "}
                {preview.byLayer
                  .filter((l) => l.planned > 0)
                  .map((l) => `${l.planned} ${LAYER[l.layer] ?? l.layer}`)
                  .join(", ")}
                .
              </p>
              <p className="flex flex-wrap gap-x-4 gap-y-1 text-fg-muted">
                <span className="inline-flex items-center gap-1.5">
                  <Clock className="size-4" aria-hidden="true" /> about {preview.estimate.minutes[0]} to {preview.estimate.minutes[1]} min
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Coins className="size-4" aria-hidden="true" /> AI ${preview.estimate.costUsd[0].toFixed(2)} to ${preview.estimate.costUsd[1].toFixed(2)}
                </span>
              </p>
              <p className="text-xs text-fg-muted">Estimate from {preview.estimate.basis}.</p>
              {preview.unsupported.length > 0 && (
                <details className="text-xs text-fg-muted">
                  <summary className="cursor-pointer">What this run cannot test ({preview.unsupported.length})</summary>
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {preview.unsupported.map((u) => (
                      <li key={u}>{u}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </section>
      )}

      {identical && (
        <Alert tone="info">
          <span className="inline-flex items-start gap-2">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>
              This exact code was already tested with these settings{identical.finishedAt ? ` (${new Date(identical.finishedAt).toLocaleString()})` : ""}. Running it again adds no new evidence.{" "}
              <Link href={`/app/projects/${projectId}/testing/${identical.id}`} className="font-medium text-accent underline-offset-4 hover:underline">
                Open that run
              </Link>{" "}
              to rerun only the missing checks.
            </span>
          </span>
        </Alert>
      )}

      <div>
        {identical ? (
          <Button type="button" variant="outline" shape="pill" size="lg" className="w-full" disabled={starting || badThreshold} onClick={() => void start(true)}>
            {starting ? <Spinner /> : <Play aria-hidden="true" />} Run everything again anyway
          </Button>
        ) : (
          <Button type="button" shape="pill" size="lg" className="w-full" disabled={!ready || !snapshotId || starting || badThreshold} onClick={() => void start(false)}>
            {starting ? <Spinner /> : <Play aria-hidden="true" />} Start Testing check
          </Button>
        )}
        {error && (
          <Alert className="mt-3">
            {error.message} {error.fix}
          </Alert>
        )}
        <p className="mt-2 flex items-start gap-2 text-xs text-fg-muted">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          Everything runs in an isolated sandbox with synthetic settings; your code and your real secrets are never touched.
        </p>
      </div>
    </div>
  );
}

function NumberField({ label, value, onChange, placeholder, decimal = false }: { label: string; value: string; onChange: (v: string) => void; placeholder: string; decimal?: boolean }) {
  return (
    <label className="block text-sm">
      <span className="font-medium text-fg">{label}</span>
      <input
        inputMode={decimal ? "decimal" : "numeric"}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(decimal ? /[^0-9.]/g : /[^0-9]/g, ""))}
        placeholder={placeholder}
        className="mt-1 h-11 w-full rounded-xl border border-border bg-surface px-3 text-base text-fg focus-visible:outline-2 focus-visible:outline-ring"
      />
    </label>
  );
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-border px-3 py-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-4 accent-accent" />
      <span>
        <span className="font-medium text-fg">{label}</span>
        <span className="block text-xs text-fg-muted">{hint}</span>
      </span>
    </label>
  );
}
