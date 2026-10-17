import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { BrowserScreen, DatabaseStrategy, TestRequirement, LoadThresholds, Obligation, ProjectDossier, TestExecution, TestFinding, TestingPolicyInput, TestingProfile } from "@cybercheck/contracts";
import { LiveAction, PROFILE_TARGET } from "@cybercheck/contracts";
import type { ObjectStore } from "../storage/object-store.ts";
import type { AiSession } from "../understanding/ai/gateway.ts";
import { redactSecrets, type SnapshotSource } from "../understanding/source.ts";
import { APP_ROOT } from "./adapters.ts";
import type { buildReport } from "./report.ts";
import type { Service } from "./services.ts";
import type { SandboxProvider, SandboxRunRequest, SandboxRunResult } from "./sandbox/provider.ts";
import type { RunStore } from "./store.ts";

/**
 * Shared runtime of a Testing run: the run context, sandbox execution with evidence, and the
 * ledger writes every worker uses. Workers (build, suites, probes, browser, database, load) import it.
 */

/** Bump whenever prompts, planning rules or verdict logic change: it keys the plan and image caches. */
/** The previous engine, kept behind TESTING_LEGACY_ENGINE=1 while the behaviour-first engine proves itself. */
export const LEGACY_ENGINE = process.env.TESTING_LEGACY_ENGINE === "1";
export const ENGINE_VERSION = LEGACY_ENGINE ? "2026-10-12.v2u" : "2026-10-14.v3h";
export const TSX = "/opt/cc-tools/node_modules/tsx/dist/loader.mjs";
/** Browser tooling installed into the prepared image when the project has screens (pinned versions). */
export const BROWSER_DIR = "/opt/cc-browser";
export const K6 = "/opt/cc-k6/k6";

export const POLICY = {
  image: "docker.io/library/node:22-bookworm",
  installTimeoutSec: 900,
  commandTimeoutSec: 600,
  /** Build, typecheck and lint print constantly; silence this long means a prompt or a hang. */
  stepIdleSec: 120,
  suiteTimeoutSec: 300,
  /** A suite that prints nothing for this long is stopped as hung. */
  suiteIdleSec: 150,
  /** Extra runs when a test fails in all of the first runs. */
  confirmRuns: 2,
  bootTimeoutSec: 90,
  maxParallel: 8,
  // The behaviour-first engine is limited by its triage budget share instead of a count.
  maxTriage: LEGACY_ENGINE ? 16 : 40,
};

export type LoadStageName = "smoke" | "average" | "stress" | "spike" | "breakpoint";

/** Stages in the order they run: gentle first, and the breakpoint (which pushes until the app gives way) last. */
export const LOAD_ORDER: LoadStageName[] = ["smoke", "average", "stress", "spike", "breakpoint"];

/** About how long each stage takes, in seconds (the breakpoint stops early once the app gives way). */
export const LOAD_SECONDS: Record<LoadStageName, number> = { smoke: 20, average: 60, stress: 60, spike: 35, breakpoint: 120 };

/**
 * What each profile runs. Fast is a quick PR check; Standard is the release check; Deep adds repeats, viewports
 * and load stages. A healthy suite runs once (failures get confirmation runs); only Deep samples it repeatedly.
 * `load` is with load testing switched on; `loadOff` without it.
 */
export const PROFILES: Record<TestingProfile, { suiteRuns: number; browser: boolean; viewports: number[]; maxJourneys: number; database: boolean; load: LoadStageName[]; loadOff: LoadStageName[]; loadDefault: boolean }> = {
  fast: { suiteRuns: 1, browser: true, viewports: [1440], maxJourneys: 2, database: false, load: ["smoke"], loadOff: [], loadDefault: false },
  standard: { suiteRuns: 1, browser: true, viewports: [1440, 375], maxJourneys: 6, database: true, load: ["smoke", "average", "stress"], loadOff: ["smoke"], loadDefault: false },
  deep: { suiteRuns: 4, browser: true, viewports: [1440, 768, 375], maxJourneys: 9, database: true, load: ["smoke", "average", "stress", "spike", "breakpoint"], loadOff: ["smoke"], loadDefault: true },
};

/** The settings a run uses: the profile's defaults with the user's choices applied. */
export type EffectivePolicy = {
  profile: TestingProfile;
  targetCompleteness: number;
  budgetUsd: number;
  maxSandboxMinutes: number | null;
  browser: boolean;
  loadStages: LoadStageName[];
  generatedTests: boolean;
  allowAcceptedRisk: boolean;
};

export function effectivePolicy(p: Partial<TestingPolicyInput> & { profile?: TestingProfile }, serverBudgetUsd: number): EffectivePolicy {
  const profile = p.profile ?? "standard";
  const prof = PROFILES[profile];
  const load = p.load ?? prof.loadDefault;
  return {
    profile,
    targetCompleteness: p.targetCompleteness ?? PROFILE_TARGET[profile],
    budgetUsd: Math.min(serverBudgetUsd, p.budgetUsd ?? serverBudgetUsd),
    maxSandboxMinutes: p.maxSandboxMinutes ?? null,
    browser: p.browser ?? prof.browser,
    // The user's own stage list wins when load is on; the smoke test always runs when any load stage does.
    loadStages: !load ? prof.loadOff : p.loadStages ? LOAD_ORDER.filter((n) => n === "smoke" || p.loadStages!.includes(n as never)) : prof.load,
    generatedTests: p.generatedTests ?? true,
    allowAcceptedRisk: p.allowAcceptedRisk ?? true,
  };
}

export type Deps = {
  provider: SandboxProvider;
  session: AiSession | null;
  objects: ObjectStore;
  signal: AbortSignal;
};

export type Ctx = Deps & {
  /** What the project says it must do, with the source of each statement. */
  requirements?: TestRequirement[];
  /** How the database lane checks integrity (direct, or through the app for an in-memory database). */
  databaseStrategy?: DatabaseStrategy;
  /** Screens found outside a frontend router (pages the backend serves), for the report. */
  screensFound?: BrowserScreen[];
  /** Authoring steps that were skipped or cut short for lack of AI budget, for the report's limitations. */
  authoringGaps?: string[];
  /** After this time (ms epoch) no new check starts: the user's sandbox time limit. */
  deadline?: number | null;
  /** A repair's patched files, mounted over the project in this run's sandboxes (never in cached images). */
  overlay?: Array<{ path: string; fileId: string }>;
  store: RunStore;
  runId: string;
  d: ProjectDossier;
  src: SnapshotSource;
  obligations: Map<string, Obligation>;
  executions: TestExecution[];
  findings: TestFinding[];
  sandboxOps: number;
  sandboxCpu: number;
  suiteSummaries: Parameters<typeof buildReport>[0]["suiteSummaries"];
  /** Local services (Postgres, Redis) the project uses; started inside sandboxes that need them. */
  services: Service[];
  profile: TestingProfile;
  /** Directories put first on PATH for the app and setup commands (the project's virtualenvs and node_modules/.bin). */
  pathPrepend?: string[];
  thresholds: LoadThresholds | null;
};

export class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
export const tail = (s: string, n = 4000) => (s.length > n ? `[...]\n${s.slice(-n)}` : s);
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Paths in runner output point into the sandbox; show them as project paths. */
export const toProjectPaths = (s: string) => s.split(`${APP_ROOT}/`).join("");

// ---------------------------------------------------------------- sandbox execution with evidence

const gate = new Semaphore(POLICY.maxParallel);

/** Lines the harnesses print for the live view: "@@cc {json}". */
const LIVE_LINE = /^@@cc (\{.*\})\s*$/;
/** At most this many live actions are stored per sandbox operation; the rest are summarised in one note. */
export const LIVE_CAP = 400;

/**
 * Reads the live actions out of a sandbox's output so far. Output arrives as a growing (possibly cut) snapshot,
 * so each action is identified by its own text: one seen before is never stored twice.
 */
export function liveActions(output: string, seen: Set<string>): LiveAction[] {
  const out: LiveAction[] = [];
  for (const line of output.split("\n")) {
    const m = line.match(LIVE_LINE);
    if (!m || seen.has(m[1]!)) continue;
    seen.add(m[1]!);
    try {
      const parsed = LiveAction.safeParse(JSON.parse(m[1]!));
      if (parsed.success) out.push(parsed.data);
    } catch {}
  }
  return out;
}

/** A one-line description of a live action, stored as the event message. */
export function describeAction(a: LiveAction): string {
  if (a.k === "req") return `${a.method} ${a.path} answered ${a.status ?? "nothing"}${a.as ? ` (as ${a.as})` : ""}`;
  if (a.k === "screen") return `Opened ${a.path} at ${a.vp} px${a.as ? ` as ${a.as}` : ""}: ${a.status ?? "no answer"}${a.axe ? `, ${a.axe} accessibility problem(s)` : ""}`;
  if (a.k === "step") return `${a.title}: step ${a.n} of ${a.of}, ${a.action}${a.target ? ` "${a.target}"` : ""}${a.ok ? "" : " (failed)"}`;
  if (a.k === "load") return a.state === "start" ? `Load stage ${a.stage} started (${a.vus} users)` : `Load stage ${a.stage} finished: ${a.rps ?? 0}/s, p95 ${a.p95 ?? "?"} ms, ${a.errors ?? 0}% errors`;
  return a.text;
}

/** The output without the live-view lines, as it is saved and shown in the evidence. */
export const withoutLiveLines = (output: string) => output.split("\n").filter((l) => !l.startsWith("@@cc ")).join("\n");

export async function execute(
  ctx: Ctx,
  meta: { kind: TestExecution["kind"]; label: string; workspace: string | null; retryOf?: string | null; fetch?: string[]; idleSec?: number; /** A JSON file of name -> base64 images, stored as one artifact per image. */ bundle?: string },
  req: Omit<SandboxRunRequest, "signal">,
): Promise<{ exec: TestExecution; result: SandboxRunResult; files: Map<string, Buffer> }> {
  return gate.use(async () => {
    if (ctx.signal.aborted) throw new DOMException("cancelled", "AbortError");
    const exec: TestExecution = {
      id: randomUUID(),
      kind: meta.kind,
      label: meta.label,
      workspace: meta.workspace,
      command: req.command,
      network: req.network,
      sandbox: { provider: ctx.provider.name, operationId: null, imageId: req.image },
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      exitCode: null,
      timedOut: false,
      outcome: "running",
      outputTail: "",
      artifacts: [],
      envNames: Object.keys(req.env ?? {}).sort(),
      resources: { cpuSeconds: null, maxRssKb: null },
      retryOf: meta.retryOf ?? null,
    };
    ctx.executions.push(exec);
    await ctx.store.putExecution(exec);
    // Optional idle cut-off: a command that prints nothing for idleSec is stopped as hung (saves waiting for the full limit).
    const idle = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (!meta.idleSec) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(), meta.idleSec * 1000);
    };
    arm();
    let lastSeen = "";
    // Live view: the actions the harness prints are stored as they appear (each sandbox poll, about every 2 s).
    const seen = new Set<string>();
    let liveCount = 0;
    let live: Promise<unknown> = Promise.resolve();
    const relay = (out: string) => {
      const actions = liveActions(out, seen);
      if (!actions.length) return;
      const take = actions.slice(0, Math.max(0, LIVE_CAP - liveCount)).map((a) => (a.k === "screen" || a.k === "step" ? { ...a, exec: exec.id } : a));
      liveCount += actions.length;
      if (take.length) live = live.then(() => ctx.store.actions(take.map((d) => ({ message: describeAction(d), data: d })))).catch(() => undefined);
    };
    // A repair validation run sees the patched files; the cached install images never do.
    const cached = meta.kind === "prepare" && /^(Unpack snapshot|Install)/.test(meta.label);
    const mounted = ctx.overlay?.length && !cached ? [...(req.files ?? []), ...ctx.overlay] : req.files;
    const result = await ctx.provider.run({
      ...req,
      files: mounted,
      signal: AbortSignal.any([ctx.signal, idle.signal]),
      onOutput: (out) => {
        relay(out);
        if (meta.idleSec) {
          lastSeen = out;
          arm();
        }
      },
    });
    relay(result.stdout ?? "");
    if (liveCount > LIVE_CAP) {
      const text = `${liveCount - LIVE_CAP} more actions in this step are not shown live`;
      live = live.then(() => ctx.store.actions([{ message: text, data: { k: "note", text } }])).catch(() => undefined);
    }
    await live;
    // A stopped operation may come back without its output; the live output seen before stopping is the evidence.
    if (!result.stdout && lastSeen) result.stdout = lastSeen;
    clearTimeout(idleTimer);
    const stalled = idle.signal.aborted && !ctx.signal.aborted;
    if (stalled) result.status = "timed_out";
    if (ctx.signal.aborted) throw new DOMException("cancelled", "AbortError");
    ctx.sandboxOps++;
    ctx.sandboxCpu += result.cpuSeconds ?? 0;
    const output = withoutLiveLines(redactSecrets(toProjectPaths(`${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`)).text);
    const files = new Map<string, Buffer>();
    const artifacts: TestExecution["artifacts"] = [];
    const save = async (name: string, body: Buffer) => {
      const key = `testing/${ctx.runId}/${exec.id}/${name.replace(/[^a-z0-9._-]+/gi, "-").toLowerCase()}`;
      await ctx.objects.put(key, Readable.from([body]));
      artifacts.push({ name, key, bytes: body.length, sha256: sha(body) });
    };
    await save("output.txt", Buffer.from(output));
    if (result.resultImage) {
      for (const path of meta.fetch ?? []) {
        const body = await ctx.provider.readFile(result.resultImage, path).catch(() => null);
        if (body) {
          files.set(path, body);
          await save(path.split("/").pop()!, body);
        }
      }
      if (meta.bundle) {
        const raw = await ctx.provider.readFile(result.resultImage, meta.bundle).catch(() => null);
        let images: Record<string, string> = {};
        try {
          images = raw ? (JSON.parse(raw.toString("utf8")) as Record<string, string>) : {};
        } catch {}
        for (const [name, b64] of Object.entries(images)) if (/^[\w.-]+\.(jpe?g|png)$/i.test(name)) await save(name, Buffer.from(b64, "base64"));
      }
    }
    Object.assign(exec, {
      sandbox: { provider: ctx.provider.name, operationId: result.operationId, imageId: req.image },
      finishedAt: new Date().toISOString(),
      durationMs: result.durationMs,
      exitCode: result.exitCode,
      timedOut: result.status === "timed_out",
      outcome: result.status === "ok" ? (result.exitCode === 0 ? "ok" : "failed") : result.status,
      outputTail: tail(stalled ? `${output}
[cybercheck] Stopped: no output for ${meta.idleSec}s.` : output),
      artifacts,
      resources: { cpuSeconds: result.cpuSeconds, maxRssKb: result.maxRssKb },
    } satisfies Partial<TestExecution>);
    await ctx.store.putExecution(exec);
    return { exec, result, files };
  });
}

export async function setOb(ctx: Ctx, id: string, patch: Partial<Obligation>) {
  const o = ctx.obligations.get(id);
  if (!o) return;
  Object.assign(o, patch, {
    executionIds: [...new Set([...o.executionIds, ...(patch.executionIds ?? [])])],
    findingIds: [...new Set([...o.findingIds, ...(patch.findingIds ?? [])])],
  });
  await ctx.store.putObligations([o]);
}

const MONEY = /\b(total|subtotal|price|amount|charge[ds]?|payment|paid|refund|balance|invoice|discount|tax|billing|fee)\b/i;
const OUTAGE = /\b(crash(es|ed)?|stops the (whole )?(server|app|process)|process (exits|stops)|data loss|loses data|deletes? (all|other)|corrupt)/i;

/** Wrong money and crashes or data loss are at least high, whatever severity the model chose. */
export function severityFloor(f: Pick<TestFinding, "kind" | "severity" | "title" | "rootCause" | "expected" | "layer">): TestFinding["severity"] {
  if (f.kind !== "product_defect" || f.layer === "accessibility" || f.severity === "critical" || f.severity === "high") return f.severity;
  const text = `${f.title} ${f.rootCause ?? ""} ${f.expected ?? ""}`;
  return MONEY.test(text) || OUTAGE.test(text) ? "high" : f.severity;
}

export async function addFinding(ctx: Ctx, f: Omit<TestFinding, "id">) {
  // Ids keep counting after merges remove findings, so they never collide.
  const next = ctx.findings.reduce((m, x) => Math.max(m, Number(x.id.slice(1)) || 0), 0) + 1;
  // A product defect cites the checks it explains, never one that passed.
  const obligationIds = f.kind === "product_defect" ? f.obligationIds.filter((id) => ctx.obligations.get(id)?.status !== "passed") : f.obligationIds;
  const finding: TestFinding = { id: `F${next}`, ...f, obligationIds, severity: severityFloor(f), layer: f.layer ?? ctx.obligations.get(f.obligationIds[0] ?? "")?.layer };
  ctx.findings.push(finding);
  await ctx.store.putFinding(finding);
  for (const oid of f.obligationIds) await setOb(ctx, oid, { findingIds: [finding.id] });
  return finding;
}

export const CI_ENV = { CI: "true", npm_config_update_notifier: "false", npm_config_fund: "false", PIP_DISABLE_PIP_VERSION_CHECK: "1", NODE_OPTIONS: "--max-old-space-size=3072" };
