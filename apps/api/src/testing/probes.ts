import { readFileSync } from "node:fs";
import type { CompiledScenario, TestExecution, TestRequirement } from "@cybercheck/contracts";
import { redactSecrets } from "../understanding/source.ts";
import { OUT, wsPath } from "./adapters.ts";
import { OFFLINE, codeUnderTest, excerpt, repairGraph, syntheticValue, type BootApp } from "./agents.ts";
import { produces, validateGraph } from "./fixtures.ts";
import { isAuthEntry, type FixtureNode, type Probe } from "./plan.ts";
import type { FixtureSummary } from "./report.ts";
import { serviceEnv, startServices } from "./services.ts";
import { stackLocations, type Candidate } from "./triage.ts";
import { CI_ENV, LEGACY_ENGINE, POLICY, addFinding, execute, setOb, sha, tail, toProjectPaths, type Ctx } from "./runtime.ts";
import { obligationFromScenario, routeKey, type ScenarioRun } from "./scenarios.ts";

/** A compiled scenario to send, with the obligation that records each requirement it checks. */
export type ScenarioJob = { scenario: CompiledScenario; obligations: Record<string, string>; requirements: TestRequirement[] };
type ScenarioOut = ScenarioRun & { blockedBy?: "fixture" | "prerequisite"; logFrom?: number; logTo?: number; appExited?: boolean };

// The running app over HTTP: boot, the fixture graph (seed, data, sign-in) and probes in one sandbox;
// a failed setup gets one bounded repair; failures are repeated in a fresh sandbox before triage.

export const HARNESS_LIB = readFileSync(new URL("./harness/lib.mjs", import.meta.url));
const HARNESS = readFileSync(new URL("./harness/harness.mjs", import.meta.url));

type StepOut = { method: string; path: string; setup?: boolean; status: number | null; ms: number; ok: boolean; why: string | null; body?: string; contentType?: string | null; location?: string | null; headers?: Record<string, string>; error?: string | null; logFrom?: number; logTo?: number; appExited?: boolean; skipped?: boolean };
export type FixtureResult = { id: string; kind: string; ok: boolean; skipped?: boolean; note: string; output?: string; steps?: Array<{ method: string; path: string; status: number | null; ok: boolean; why: string | null; body?: string; corrected?: Record<string, unknown> }> };
export type HarnessOut = {
  prepare: Array<{ command: string; exitCode: number | null; ms: number; tail: string }>;
  boot: { ok: boolean; ms: number | null; reason: string | null; exitCode: number | null };
  identities: Array<{ name: string; kind: string; ok: boolean; note: string | null }>;
  fixtures: FixtureResult[];
  probes: Array<{ id: string; ok: boolean; blocked?: { node: string; note: string }; steps: StepOut[] }>;
  latencies: number[];
  shutdown?: { graceful: boolean };
  scenarios?: ScenarioOut[];
  /** SSRF canary tokens the app was made to fetch (Security proofs). */
  canaryHits?: string[];
  /** AI Evaluator cases: each turn's response and the replay-model calls it caused. */
  aiCases?: HarnessAiCase[];
  replayError?: string;
  aiBudget?: { modelRequests: number; overBudget: boolean };
};

export type HarnessAiTurn = { status: number | null; ms: number; body: string; contentType: string | null; error: string | null; model: Array<{ path: string; body: string; served: string; inputTokens?: number; outputTokens?: number; costUsd?: number }>; logFrom?: number; logTo?: number };
export type HarnessAiCase = { id: string; blocked?: { node: string; note: string }; turns: HarnessAiTurn[]; alive: boolean | null; appExited: boolean };
/** What an AI Evaluator run adds to the harness spec. */
export type HarnessAiSpec = {
  aiCases: Array<{ id: string; needs: string[]; alivePath: string; turns: Array<{ method: string; path: string; json?: Record<string, unknown>; as: string | null; replay: unknown[] | null; timeoutMs: number; capture?: { name: string; path: string }; parallelGroup?: string }> }>;
  replay: { port: number } | null;
  timeoutSec: number;
  /** Wall-clock budget for the AI cases; once reached, no new case is started. */
  deadlineMs?: number;
  /** Model-request budget for the run; once reached, no new case is started. */
  maxModelRequests?: number;
};

/** Settings for an app: synthetic values for everything without a default, plus every ${ENV:X} the fixture graph uses. */
export function appEnv(ctx: Ctx, app: Pick<BootApp, "port" | "config" | "identities">, extra: Record<string, string> = {}, graph: FixtureNode[] = []) {
  const env: Record<string, string> = { ...serviceEnv(ctx.services) };
  for (const e of ctx.d.config.envVars.filter((x) => x.side === "server")) {
    const groupFirst = ctx.d.runPlan.requiredOneOf.some((g) => g[0] === e.name);
    // Anything without a default gets a value: a missing setting must not stop the app from starting.
    if (env[e.name]) continue;
    if (e.required === true || groupFirst || (e.required !== false && !e.hasDefault)) env[e.name] = syntheticValue(e.name, ctx.runId);
  }
  for (const n of ctx.d.runPlan.requiredEnv) env[n] ??= syntheticValue(n, ctx.runId);
  // Identities and setup steps may reference settings the dossier didn't mark as required.
  for (const m of JSON.stringify([app.identities, graph]).matchAll(/\$\{ENV:([A-Z0-9_]+)\}/g)) env[m[1]!] ??= syntheticValue(m[1]!, ctx.runId);
  for (const c of app.config) env[c.name] = c.value;
  Object.assign(env, extra);
  env.PORT ??= String(app.port);
  // Re-applied inside each login shell by the harness (a login shell resets PATH).
  if (ctx.pathPrepend?.length) env.CC_PATH = ctx.pathPrepend.join(":");
  return env;
}

/** Variable names an app's start-up output complains about (missing or invalid settings). */
export function missingVars(ctx: Ctx, log: string, already: Record<string, string>) {
  const known = new Set(ctx.d.config.envVars.map((e) => e.name));
  const out = new Set<string>();
  for (const line of log.split("\n")) {
    if (!/missing|required|not set|must be set|undefined|not defined|invalid|expected|ZodError|is empty/i.test(line)) continue;
    for (const m of line.matchAll(/\b([A-Z][A-Z0-9]*_[A-Z0-9_]+|[A-Z]{4,})\b/g)) {
      const n = m[1]!;
      if ((known.has(n) || /_(KEY|TOKEN|SECRET|URL|ID|PASSWORD)$/.test(n)) && !already[n]) out.add(n);
    }
  }
  return [...out].slice(0, 8);
}

/** The graph a probe run sends: only what the harness needs (no evidence, no labels). */
const graphSpec = (graph: FixtureNode[]) => graph.map((n) => ({ id: n.id, kind: n.kind, dependsOn: n.dependsOn, command: n.command, exports: n.exports, identity: n.identity ?? null, steps: n.steps, auth: n.auth, verify: n.verify ?? null, forge: n.forge ?? null }));

export async function runHarness(ctx: Ctx, image: string, app: BootApp, graph: FixtureNode[], probes: Probe[], label: string, retryOf: string | null, extra: Record<string, string> = {}, scenarios: ScenarioJob[] = [], canaryPort?: number, ai?: HarnessAiSpec, executionKind: TestExecution["kind"] = "probe") {
  const env = appEnv(ctx, app, extra, graph);
  const spec = { cwd: wsPath(app.workspace), prepare: app.prepare, start: app.start, port: app.port, readyPath: app.readyPath, bootTimeoutSec: POLICY.bootTimeoutSec, env, graph: graphSpec(graph), probes: probes.map((p) => ({ id: p.id, identity: p.identity, needs: p.needs ?? [], steps: p.steps })), scenarios: scenarios.map((j) => ({ scenario: j.scenario })), canaryPort, ...(ai ? { aiCases: ai.aiCases, replay: ai.replay, aiDeadlineMs: ai.deadlineMs, aiMaxModelRequests: ai.maxModelRequests } : {}) };
  const [libId, harnessId, specId] = await Promise.all([ctx.provider.upload(HARNESS_LIB), ctx.provider.upload(HARNESS), ctx.provider.upload(Buffer.from(JSON.stringify(spec)))]);
  const r = await execute(ctx, { kind: executionKind, label, workspace: app.workspace, retryOf, fetch: [`${OUT}/harness.json`, `${OUT}/server.log`] }, {
    image,
    command: `${startServices(ctx.services)}mkdir -p ${OUT} && node /cc/harness.mjs /cc/spec.json ${OUT}`,
    // Evaluated project code never receives general outbound network access.
    network: false,
    keep: true,
    timeoutSec: (ai?.timeoutSec ?? POLICY.commandTimeoutSec) + POLICY.bootTimeoutSec,
    env: { ...CI_ENV, ...env },
    files: [
      { path: "/cc/lib.mjs", fileId: libId },
      { path: "/cc/harness.mjs", fileId: harnessId },
      { path: "/cc/spec.json", fileId: specId },
    ],
  });
  const raw = r.files.get(`${OUT}/harness.json`);
  const out: HarnessOut | null = raw ? JSON.parse(raw.toString("utf8")) : null;
  const log = redactSecrets(toProjectPaths(r.files.get(`${OUT}/server.log`)?.toString("utf8") ?? "")).text;
  const rawLog = r.files.get(`${OUT}/server.log`) ?? Buffer.alloc(0);
  const slice = (from?: number, to?: number) => (from == null || to == null ? "" : redactSecrets(toProjectPaths(rawLog.subarray(from, Math.min(to, from + 6000)).toString("utf8"))).text);
  return { exec: r.exec, out, log, slice, env };
}

/** Every request of a probe in order, with how the client signs in (setting names, never values). */
export function probeReproduction(app: BootApp, graph: FixtureNode[], probe: Probe, sentPaths: string[], results: FixtureResult[] = []) {
  const actors = new Set([probe.identity, ...probe.steps.map((st) => st.as)].filter(Boolean));
  // Setup steps the check names, its sign-ins, and every step that produces a {{value}} the check uses.
  const used = new Set([...JSON.stringify(probe.steps).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]!));
  const needed = graph.filter((n) => (probe.needs ?? []).includes(n.id) || actors.has(n.id) || produces(n).some((v) => used.has(v)));
  const setup: string[] = [];
  const seen = new Set<string>();
  const visit = (n: FixtureNode) => {
    if (seen.has(n.id)) return;
    seen.add(n.id);
    for (const dep of n.dependsOn) {
      const m = graph.find((x) => x.id === dep);
      if (m) visit(m);
    }
    if (n.kind === "command") setup.push(`Run: ${n.command}${n.exports?.length ? ` (it prints ${n.exports.map((x) => `${x}=...`).join(", ")}; keep ${n.exports.length === 1 ? "that value" : "those values"} as ${n.exports.map((x) => `{{${x}}}`).join(", ")})` : ""}`);
    else if (n.kind === "request") {
      const done = results.find((r) => r.id === n.id)?.steps ?? [];
      (n.steps ?? []).forEach((s, i) => {
        // The body as sent: the planned one with the fields cybercheck had to correct after a 422.
        const fix = done[i]?.corrected;
        const body = s.json !== undefined && s.json && typeof s.json === "object" && !Array.isArray(s.json) && fix ? { ...(s.json as object), ...fix } : s.json;
        setup.push(`${s.method} ${s.path}${body !== undefined ? ` with JSON body ${JSON.stringify(body).slice(0, 300)}` : ""}${s.headers ? ` and headers ${JSON.stringify(s.headers)}` : ""}${n.identity ? ` (signed in as ${n.identity})` : ""}${s.capture ? ` (keep ${s.capture.path} from the answer as {{${s.capture.name}}})` : ""}`);
      });
    }
    else if (n.auth?.kind === "login" && n.auth.request) setup.push(`Sign in as ${n.id}: ${n.auth.request.method} ${n.auth.request.path} with ${JSON.stringify(n.auth.request.json ?? n.auth.request.form ?? {})} and keep the session cookie${n.auth.tokenPath ? ` or the token at ${n.auth.tokenPath}` : ""}.`);
    else if (n.auth?.kind === "bearer") setup.push(`As ${n.id}, send the header Authorization: Bearer ${n.auth.token}.`);
    else if (n.auth?.kind === "header") setup.push(`As ${n.id}, send the header ${n.auth.header}: ${n.auth.value}.`);
    else if (n.auth) setup.push(`As ${n.id}, use basic auth ${n.auth.user}.`);
  };
  needed.forEach(visit);
  const steps = probe.steps.map((st, i) => `${setup.length + i + 1}. ${st.method} ${sentPaths[i] ?? st.path}${st.json !== undefined ? ` with JSON body ${JSON.stringify(st.json).slice(0, 400)}` : st.raw !== undefined ? ` with raw body ${st.raw}` : ""}${(st.as ?? probe.identity) ? ` (signed in as ${st.as ?? probe.identity})` : " (no credentials)"}${st.headers ? ` with headers ${JSON.stringify(st.headers)}` : ""}`);
  return [`App started with: ${app.start} (port ${app.port}), on an empty database.`, ...setup.map((s, i) => `${i + 1}. ${s}`), ...steps, "{{name}} is a value kept from an earlier answer; ${ENV:NAME} is a synthetic setting cybercheck used (never your real secrets)."].join("\n");
}

/**
 * For a 403 to a working sign-in: the frontend code that calls this endpoint. If a screen that role can open calls
 * it, the refusal breaks that screen (a product defect); if no such screen exists, the check expected the wrong role.
 */
function roleContext(ctx: Ctx, app: BootApp, path: string, actor: string | null | undefined): string[] {
  const prefix = path.split("/").filter(Boolean).filter((s) => !/^[:{<[]/.test(s)).slice(0, 3);
  if (prefix.length < 2) return [];
  const needle = `/${prefix.join("/")}`;
  const hits: string[] = [];
  for (const [file, f] of ctx.src.files) {
    if (file.startsWith(`${app.workspace === "." ? "" : app.workspace}/`) && app.workspace !== ".") continue;
    if (!/\.(tsx?|jsx?|vue|svelte)$/.test(file)) continue;
    const line = f.text.split("\n").findIndex((l) => l.includes(needle));
    if (line >= 0) {
      // The screen this file renders, and every place that links to it with the roles allowed to see the link.
      const route = file.match(/(?:^|\/)(?:app|pages)(\/.*?)\/(?:page|index)\.[jt]sx?$/)?.[1]?.replace(/\/\([^)]*\)/g, "") ?? null;
      const links = route
        ? [...ctx.src.files].flatMap(([p, g]) => g.text.split("\n").flatMap((l, i) => (l.includes(`"${route}"`) || l.includes(`'${route}'`) ? [`${p}:${i + 1}: ${l.trim().slice(0, 200)}`] : []))).slice(0, 4)
        : [];
      hits.push(`${excerpt(ctx.src, file, line + 1, 3, 8) ?? `${file}:${line + 1}`}${route ? `\nThis file is the screen ${route}. Links to it, with the roles allowed to see them:\n${links.join("\n") || "(no link found)"}` : ""}`);
    }
    if (hits.length >= 3) break;
  }
  return [
    `The request was refused with 403 for "${actor}", a sign-in that works on other endpoints. Decide which is true: (a) the app is right to refuse this role here and the check expected the wrong role (test_defect), or (b) a screen that "${actor}" is allowed to open calls this endpoint, so the refusal breaks that role's screen (product_defect). Decide from which roles can open the calling screen (its route prefix, navigation entries and their role lists), never from variable or parameter names: a token variable called staffToken says nothing about who may open the screen.`,
    hits.length ? `Frontend code that calls ${needle}:\n${hits.join("\n\n")}` : `No frontend code calls ${needle}, so no screen of "${actor}" depends on it.`,
  ];
}

/**
 * The declared schema (CREATE TABLE, ORM model) of the tables a handler writes, so a claim about a missing
 * constraint is checked against what the schema actually declares.
 */
export function schemaContext(ctx: Pick<Ctx, "src">, handlerPath: string, line: number): string[] {
  const body = (ctx.src.files.get(handlerPath)?.text ?? "").split("\n").slice(Math.max(0, line - 1), line + 40).join("\n");
  const tables = [...new Set([...body.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+["'`]?(\w+)/gi)].map((m) => m[1]!.toLowerCase()))].slice(0, 2);
  const out: string[] = [];
  for (const t of tables) {
    for (const [p, f] of ctx.src.files) {
      const lines = f.text.split("\n");
      const i = lines.findIndex((l) => new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["'\`]?${t}["'\`]?\\b`, "i").test(l) || new RegExp(`__tablename__\\s*=\\s*["']${t}["']`).test(l) || new RegExp(`@@map\\(["']${t}["']\\)|pgTable\\(["']${t}["']`).test(l));
      if (i < 0) continue;
      const ex = excerpt(ctx.src, p, i + 1, 2, 14);
      if (ex) out.push(`Declared schema of table "${t}":\n${ex}`);
      break;
    }
  }
  return out;
}

export function probeObligationKind(id: string) {
  return id.split(":").at(-1) ?? "";
}

/** Fixture nodes a probe depends on, directly or through its identity. */
const refsOf = (p: Probe) => [...new Set([...(p.needs ?? []), ...(p.identity ? [p.identity] : [])])];

export function summarise(graph: FixtureNode[], results: FixtureResult[]): FixtureSummary {
  const nodes = graph.map((n) => {
    const r = results.find((x) => x.id === n.id);
    return { id: n.id, label: n.label, ok: r ? r.ok : null, detail: r ? redactSecrets(r.note).text.slice(0, 400) : "not run" };
  });
  return { digest: sha(JSON.stringify(graphSpec(graph))).slice(0, 16), nodes };
}

export async function judgeProbes(ctx: Ctx, image: string, app: BootApp, initialGraph: FixtureNode[], probes: Probe[], candidates: Candidate[], authoredEvidence: Map<string, string>, scenarios: ScenarioJob[] = []) {
  const appLabel = app.workspace === "." ? "the app" : `the ${app.workspace} app`;
  const bootOb = `env:boot:${app.workspace}`;
  let graph = initialGraph;
  let extra: Record<string, string> = {};
  let first = await runHarness(ctx, image, app, graph, probes, `Start ${appLabel}, set up test data and probe ${probes.length} request(s)${scenarios.length ? ` and ${scenarios.length} scenario(s)` : ""}`, null, {}, scenarios);
  // Start-up repair: if the app names settings it is missing, give them synthetic values and try again (twice at most).
  for (let attempt = 0; attempt < 2 && first.out && !first.out.boot.ok && !first.out.prepare.some((p) => p.exitCode !== 0); attempt++) {
    const missing = missingVars(ctx, first.log, first.env);
    if (!missing.length) break;
    extra = { ...extra, ...Object.fromEntries(missing.map((n) => [n, syntheticValue(n, ctx.runId)])) };
    await ctx.store.event("executing", `${appLabel} stopped because it needs ${missing.join(", ")}; starting it again with synthetic values`);
    first = await runHarness(ctx, image, app, graph, probes, `Start ${appLabel} again with ${missing.join(", ")} set`, first.exec.id, extra, scenarios);
  }
  const out = first.out;
  const probeObs = [...probes.map((p) => p.obligationId), ...scenarios.flatMap((j) => Object.values(j.obligations))];
  const empty = { latencies: [] as number[], fixtures: summarise(graph, []), graceful: null as boolean | null, graph };

  if (!out || !out.boot.ok) {
    const prepFail = out?.prepare.find((p) => p.exitCode !== 0);
    const reason = !out ? `The probe run produced no result (${first.exec.outcome}).` : prepFail ? `"${prepFail.command}" failed before the app could start (exit ${prepFail.exitCode}).` : (out.boot.reason ?? "The app did not start.");
    await setOb(ctx, bootOb, { status: "failed", reason, executionIds: [first.exec.id] });
    for (const id of probeObs) await setOb(ctx, id, { status: "blocked", blockedBy: "prerequisite", reason: `Not run: ${appLabel} did not start (${reason}).`, executionIds: [first.exec.id] });
    const logTail = tail(prepFail ? prepFail.tail : first.log, 3500);
    candidates.push({
      source: "boot",
      label: `${appLabel} does not start`,
      obligationIds: [bootOb],
      executionIds: [first.exec.id],
      reproduced: 1,
      of: 1,
      context: [
        `The app was started in a clean sandbox with no internet, synthetic values for these variables: ${Object.keys(first.env).sort().join(", ")}.`,
        `Prepare commands: ${JSON.stringify(app.prepare)}; start: ${app.start}; expected port ${app.port}.`,
        `Result: ${reason}`,
        `Output:\n${logTail}`,
        ...stackLocations(ctx.src, app.workspace, logTail).map((l) => excerpt(ctx.src, l.path, l.line, 10, 10)).filter(Boolean),
      ].join("\n\n"),
      locations: stackLocations(ctx.src, app.workspace, logTail),
      workspace: app.workspace,
      forced: app.needsServices.length ? "environment_failure" : undefined,
    });
    return empty;
  }
  await setOb(ctx, bootOb, { status: "passed", reason: `Answered on port ${app.port} after ${Math.round((out.boot.ms ?? 0) / 100) / 10}s.`, executionIds: [first.exec.id] });

  // ---------------- setup repair: one bounded attempt when seed, data or sign-in steps failed
  let fixtureResults = out.fixtures ?? [];
  let resultFor = new Map(out.probes.map((p) => [p.id, { res: p, exec: first.exec, slice: first.slice }]));
  const failedNodes = fixtureResults.filter((r) => !r.ok && !r.skipped);
  if (failedNodes.length && ctx.session) {
    await ctx.store.event("executing", `${failedNodes.length} setup step(s) failed (${failedNodes.map((f) => f.id).join(", ")}); asking the fixture planner for one repair`);
    try {
      const repaired = await repairGraph(ctx.session, ctx.d, ctx.src, graph, failedNodes.map((f) => ({ id: f.id, note: f.note, output: f.output ?? f.steps?.map((s) => `${s.method} ${s.path} -> ${s.status}: ${s.why ?? ""} ${s.body ?? ""}`).join("\n"), log: tail(first.log, 1500) })));
      const merged = [...graph.filter((n) => !repaired.nodes.some((r) => r.id === n.id)), ...repaired.nodes];
      let { nodes: valid, problems } = validateGraph(merged, ctx.d, ctx.src);
      const rejected = problems.filter((x) => repaired.nodes.some((r) => r.id === x.id));
      for (const p of rejected) await ctx.store.event("executing", `The repaired setup step "${p.id}" was not used: ${p.reason}`);
      // An invalid repair never removes a step that existed before: the original (and what depends on it) stays.
      if (rejected.length) {
        const keepOriginal = new Set(rejected.map((p) => p.id));
        ({ nodes: valid, problems } = validateGraph([...merged.filter((n) => !keepOriginal.has(n.id) || n.origin !== "repair"), ...graph.filter((n) => keepOriginal.has(n.id))], ctx.d, ctx.src));
      }
      void problems;
      const changed = valid.filter((n) => n.origin === "repair");
      if (changed.length) {
        // Rerun only the probes that were not sent (or need a repaired node), with the repaired graph.
        const affected = probes.filter((p) => resultFor.get(p.id)?.res.blocked);
        if (affected.length) {
          graph = valid;
          const second = await runHarness(ctx, image, app, graph, affected, `Repaired setup: rerun ${affected.length} request(s) on ${appLabel}`, first.exec.id, extra);
          if (second.out?.boot.ok) {
            fixtureResults = second.out.fixtures ?? fixtureResults;
            for (const p of second.out.probes) resultFor.set(p.id, { res: p, exec: second.exec, slice: second.slice });
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "BudgetExceededError") await ctx.store.event("executing", `Setup repair failed: ${(err as Error).message.slice(0, 160)}`);
    }
  }
  const fixtureOk = new Map(fixtureResults.map((r) => [r.id, r.ok]));
  // Setup steps that did not work are cybercheck's own problem: one testing-system finding names them and what they block.
  const brokenSetup = fixtureResults.filter((r) => !r.ok && !r.skipped);
  if (brokenSetup.length) {
    const blockedIds = probes.filter((p) => resultFor.get(p.id)?.res.blocked).map((p) => p.obligationId);
    await addFinding(ctx, {
      kind: "test_defect",
      status: "confirmed",
      // Scaled with what it cost: a setup failure that keeps many checks from running is a serious gap in this run.
      severity: blockedIds.length >= 15 ? "high" : blockedIds.length >= 5 ? "medium" : "low",
      confidence: "high",
      title: `${brokenSetup.length} setup step(s) cybercheck planned did not work (${blockedIds.length} check(s) could not be sent)`,
      expected: "cybercheck creates the sign-in and test data the checks need",
      actual: brokenSetup.slice(0, 6).map((r) => `${graph.find((n) => n.id === r.id)?.label ?? r.id}: ${redactSecrets(r.note).text.slice(0, 240)}`).join("\n"),
      reproduction: "Internal to cybercheck: the setup steps and their answers are in the run's setup evidence.",
      rootCause: "The setup planner sent requests the app rejected (wrong fields, wrong sign-in) and one automatic repair did not fix them.",
      location: null,
      obligationIds: blockedIds.slice(0, 200),
      executionIds: [first.exec.id],
      validation: "Each setup step's request and answer were recorded in the sandbox.",
      limitation: null,
      layer: "api",
      nextAction: "Rerun the checks without a verdict (cybercheck plans the setup again), or tell cybercheck how a test account and its data are created.",
    });
  }

  const failed: Array<{ probe: Probe; result: HarnessOut["probes"][number]; exec: TestExecution; slice: (a?: number, b?: number) => string }> = [];
  for (const p of probes) {
    const hit = resultFor.get(p.id);
    const id = p.obligationId;
    const fixtureRefs = refsOf(p);
    if (!hit) {
      await setOb(ctx, id, { status: "blocked", blockedBy: "prerequisite", reason: "Not reached: the probe run stopped early (the app may have crashed or the run hit its time limit).", executionIds: [first.exec.id], fixtureRefs });
      continue;
    }
    const { res, exec } = hit;
    if (res.blocked) {
      const node = graph.find((n) => n.id === res.blocked!.node);
      await setOb(ctx, id, { status: "blocked", blockedBy: "fixture", reachedTarget: false, reason: `Not sent: cybercheck's own setup step "${node?.label ?? res.blocked.node}" did not work (${redactSecrets(res.blocked.note).text.slice(0, 220)}). This is a testing-system problem, not a finding about your code.`, executionIds: [exec.id], fixtureRefs });
      continue;
    }
    const step = res.steps.find((s) => !s.ok) ?? res.steps.at(-1)!;
    const kind = probeObligationKind(id);
    const usedAuth = Boolean(p.identity);
    if (step.setup && !step.ok) {
      await setOb(ctx, id, { status: "inconclusive", reachedTarget: false, reason: `Could not create the data this check needs (${step.why}).`, executionIds: [exec.id], fixtureRefs });
      continue;
    }
    const expected = p.steps[res.steps.indexOf(step)]?.expect;
    const actorOfStep = p.steps[res.steps.indexOf(step)]?.as ?? p.identity;
    const guardAnswer = step.status != null && [401, 403].includes(step.status);
    // A 401/403 meets a generic "4xx" expectation only for a check about access itself (no credentials, wrong role);
    // for a validation or behaviour check it is the sign-in or role check answering before the code under test.
    const rejectionExpected = step.status != null && (Boolean(expected?.status?.includes(step.status)) || (Boolean(expected?.statusClass?.includes("4xx")) && (!guardAnswer || kind === "unauthenticated" || kind === "wrong-role" || !actorOfStep)));
    const endpoint = ctx.d.entryPoints.find((x) => x.id === ctx.obligations.get(id)?.asset.ref);
    // A 401/403 from a public endpoint (e.g. a login refusing bad credentials) is its handler answering.
    const publicHandler = endpoint?.control.kind === "public_intentional" || Boolean(endpoint && isAuthEntry(endpoint));
    const actor = p.steps[res.steps.indexOf(step)]?.as ?? p.identity;
    // A 403 to a working sign-in on a check cybercheck wrote is a real question, not a setup problem: either the
    // check expected a role the account lacks, or the app refuses a role it shows the feature to. Triage decides.
    const roleQuestion = step.status === 403 && Boolean(actor && fixtureOk.get(actor)) && ctx.obligations.get(id)?.origin === "authored";
    // A 401/403 means the request never reached the code under test: never a pass, whatever the expectation.
    // A check that expected some rejection got the role check's 403 instead: the validation it meant was not reached.
    if (roleQuestion && res.ok && !rejectionExpected) {
      await setOb(ctx, id, { status: "inconclusive", reachedTarget: false, reason: `Refused with 403 by the role check as "${actor}" before the rule this check targets was reached; it needs a role allowed on this endpoint.`, executionIds: [exec.id], fixtureRefs });
      continue;
    }
    if (step.status != null && [401, 403].includes(step.status) && kind !== "unauthenticated" && kind !== "public" && !rejectionExpected && !publicHandler && !roleQuestion) {
      const verified = p.identity ? fixtureOk.get(p.identity) : undefined;
      await setOb(ctx, id, {
        status: "inconclusive",
        reachedTarget: false,
        blockedBy: usedAuth ? "fixture" : null,
        reason: usedAuth ? `Rejected with ${step.status} although signed in as "${p.identity}"${verified ? " (that sign-in works elsewhere, so cybercheck probably used the wrong sign-in for this endpoint)" : ""}; the endpoint's handling was not reached.` : `Rejected with ${step.status}: it needs credentials cybercheck could not obtain, so the endpoint's handling was not reached.`,
        executionIds: [exec.id],
        fixtureRefs,
      });
      continue;
    }
    if (!usedAuth && kind === "public" && step.status != null && [401, 403].includes(step.status)) {
      await setOb(ctx, id, { status: "inconclusive", reachedTarget: false, reason: `Answered ${step.status}: it may need credentials after all, which contradicts the analysis's "public by design".`, executionIds: [exec.id] });
      continue;
    }
    // A made-up path id refused before the handler ran proves nothing about the handler:
    // body checks answered 400/404/422, and unknown-id checks answered 400/422 (invalid format, not "not found").
    const madeUpId = /[:{<[]/.test(endpoint?.path ?? "") && !(p.needs ?? []).length && !p.steps.some((s) => s.setup) && step.status != null;
    const bodyCheck = kind === "malformed-body" || kind === "empty-body";
    // A 422 that names the body (FastAPI's "loc": ["body", ...]) came from body validation: the id was accepted.
    const bodyRefused = step.status === 422 && /"loc"\s*:\s*\[\s*"body"/.test(step.body ?? "");
    if (madeUpId && !bodyRefused && ((bodyCheck && [400, 404, 422].includes(step.status!)) || (!bodyCheck && kind !== "unauthenticated" && kind !== "invalid-id" && ctx.obligations.get(id)?.origin === "dossier" && [400, 422].includes(step.status!)))) {
      await setOb(ctx, id, {
        status: "inconclusive",
        reachedTarget: false,
        reason: step.status === 404 ? "The test id does not exist (404), so the body handling was not reached; no way to create a real one was found." : `The made-up id in the path was refused (${step.status}) before the handler ran, so this behaviour was not reached; no way to create a real record was found.`,
        executionIds: [exec.id],
        fixtureRefs,
      });
      continue;
    }
    // A malformed id refused by sign-in (401/403) was never read by the handler.
    if (kind === "invalid-id" && step.status != null && [401, 403].includes(step.status)) {
      await setOb(ctx, id, { status: "inconclusive", blockedBy: p.identity ? "fixture" : null, reachedTarget: false, reason: `Refused with ${step.status} before the id was read${p.identity ? ` although signed in as "${p.identity}"` : " (no sign-in available)"}.`, executionIds: [exec.id], fixtureRefs });
      continue;
    }
    // A role check expected only from the route's prefix (/admin/...), on a route whose code asks for any signed-in
    // user: being let in is a policy question for the owner, not a proven defect.
    const ob = ctx.obligations.get(id);
    // The same for anonymous access: the code shows no guard, only its neighbours have one. An open answer may be
    // the intended design (a public search), so it is a question for the owner, not a proven defect.
    if (kind === "unauthenticated" && ob?.oracle.source === "policy" && step.status != null && step.status < 300) {
      await setOb(ctx, id, { status: "inconclusive", blockedBy: "approval", reachedTarget: true, reason: `Answered ${step.status} without credentials. Other routes in this area require sign-in, but this one's code has no guard (${endpoint?.control.reason ?? "none found"}); confirm whether it is meant to be public.`, executionIds: [exec.id], fixtureRefs });
      continue;
    }
    if (kind === "wrong-role" && ob?.oracle.source === "policy" && step.status != null && step.status < 300) {
      await setOb(ctx, id, { status: "inconclusive", blockedBy: "approval", reachedTarget: true, reason: `Answered ${step.status} to "${p.identity}" (a lower role). The route sits under an admin-style prefix, but its code only requires a signed-in user (${endpoint?.control.reason ?? "no role check found"}); confirm whether "${p.identity}" is meant to have this access.`, executionIds: [exec.id], fixtureRefs });
      continue;
    }
    // Another 4xx (not found, invalid body) for a lower-role account says nothing about the role check.
    if (kind === "wrong-role" && step.status != null && step.status >= 400 && step.status < 500 && ![401, 403].includes(step.status)) {
      await setOb(ctx, id, { status: "inconclusive", reachedTarget: false, reason: `Signed in as "${p.identity}" (fewer rights), the request was refused with ${step.status} before the role check could be observed.`, executionIds: [exec.id], fixtureRefs });
      continue;
    }
    // A body check answered with a business-state refusal (409) shows no crash, but not that the body was validated.
    if (res.ok && bodyCheck && step.status === 409) {
      await setOb(ctx, id, { status: "passed", reachedTarget: true, proofClass: "availability", oracleStrength: "weak", reason: `Answered 409 from a business rule (${step.method} ${step.path}): no server error, but this does not show the body being validated; the endpoint may not read one.`, executionIds: [exec.id], fixtureRefs });
      continue;
    }
    if (res.ok) {
      const ignoredBody = bodyCheck && step.status != null && step.status < 300;
      // A write confirmed by a later read of the same data, with field checks, is a verified state change.
      const firstWrite = p.steps.findIndex((s) => !["GET", "HEAD"].includes(s.method));
      // Only when the read-back checks a field the write sent: reading the order back and checking its id does not
      // prove the stored quantity or total.
      const written = new Set<string>();
      const collect = (v: unknown): void => {
        if (Array.isArray(v)) v.forEach(collect);
        else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (written.add(k.toLowerCase()), collect(x));
      };
      p.steps.filter((s) => !["GET", "HEAD"].includes(s.method)).forEach((s) => collect(s.json));
      const leaf = (path: string) => path.split(/[.[\]]/).reverse().find((k) => k && !/^\d+$/.test(k) && k !== "length")?.toLowerCase() ?? "";
      const stateVerified = firstWrite >= 0 && p.steps.slice(firstWrite + 1).some((s) => s.method === "GET" && (s.expect.json ?? []).some((c) => written.has(leaf(c.path))));
      // A scenario that ends expecting a rejection proves validation (or, for 401/403, a guard), not that the feature works.
      const last = p.steps.at(-1)!.expect;
      const rejection = Boolean(last.status?.length ? last.status.every((c) => c >= 400) : last.statusClass?.length && last.statusClass.every((c) => c === "4xx"));
      const guard = rejection && Boolean(last.status?.length && last.status.every((c) => c === 401 || c === 403));
      // Strong evidence: a write whose result was read back and checked, or a read whose content was checked.
      // A write accepted with the right status code, without a read-back, is moderate.
      const writes = firstWrite >= 0;
      const contentChecked = p.steps.some((s) => (s.expect.json?.length ?? 0) > 0);
      const strong = rejection ? Boolean(last.status?.length) : writes ? stateVerified : contentChecked;
      // A probe the AI wrote from reading the code checks what the code does, not what it should do: in the
      // behaviour-first engine its pass shows availability (or a guard, or validation), never business behaviour.
      // Documented requirements are proven by the typed scenarios instead.
      const fromCode = !LEGACY_ENGINE && !rejection;
      const patch = ctx.obligations.get(id)?.origin === "authored" ? { proofClass: guard ? ("guard" as const) : rejection ? ("validation" as const) : fromCode ? ("availability" as const) : stateVerified ? ("state_change" as const) : ("business_behavior" as const), oracleStrength: fromCode ? ("moderate" as const) : strong ? ("strong" as const) : ("moderate" as const), stateVerified: !rejection && stateVerified } : {};
      await setOb(ctx, id, { status: "passed", reachedTarget: true, ...patch, reason: `${res.steps.map((s) => `${s.method} ${s.path} answered ${s.status}`).join("; ")}.${ignoredBody ? " The endpoint accepted it, so it does not read this body; no crash." : ""}`, executionIds: [exec.id], fixtureRefs });
    } else if (step.skipped) {
      await setOb(ctx, id, { status: "blocked", blockedBy: "prerequisite", reason: "The app had stopped before this check ran.", executionIds: [exec.id], fixtureRefs });
    } else {
      failed.push({ probe: p, result: res, exec, slice: hit.slice });
    }
  }

  // Reproduce every failure once more in a fresh sandbox before anything is reported.
  let again = new Map<string, HarnessOut["probes"][number]>();
  let retryExec: TestExecution | null = null;
  let retrySlice: ((a?: number, b?: number) => string) | null = null;
  if (failed.length) {
    await ctx.store.event("executing", `Reproducing ${failed.length} failed request(s) in a fresh sandbox`);
    const second = await runHarness(ctx, image, app, graph, failed.map((f) => f.probe), `Reproduce ${failed.length} failed request(s) on ${appLabel}`, first.exec.id, extra);
    retryExec = second.exec;
    retrySlice = second.slice;
    again = new Map((second.out?.probes ?? []).map((p) => [p.id, p]));
  }
  const shared: Array<{ id: string; why: string }> = [];
  const rateLimited: string[] = [];
  for (const { probe, result, exec, slice } of failed) {
    const id = probe.obligationId;
    const step = result.steps.find((s) => !s.ok)!;
    const rerun = again.get(probe.id);
    const execIds = [exec.id, ...(retryExec ? [retryExec.id] : [])];
    const reproduced = rerun ? !rerun.ok && !rerun.blocked : false;
    // The app's rate limiter refused cybercheck's own traffic: says nothing about the behaviour under test.
    const limited = [step.status, rerun?.steps.find((s) => !s.ok)?.status].includes(429);
    if (limited && !(rerun && rerun.ok)) {
      rateLimited.push(id);
      await setOb(ctx, id, { status: "inconclusive", blockedBy: "environment", reachedTarget: false, reason: `The app's rate limiter answered 429 to cybercheck's own test traffic, so this behaviour was not reached (${step.method} ${step.path}).`, executionIds: execIds, fixtureRefs: refsOf(probe) });
      continue;
    }
    if (rerun && rerun.ok) {
      // The repeat runs only the failed checks on a fresh database: passing there is a real verdict for the
      // behaviour; the first failure came from records or traffic other checks shared (cybercheck's problem).
      shared.push({ id, why: limited ? "rate limit (429) from earlier checks" : step.why ?? "failed" });
      await setOb(ctx, id, { status: "passed", reachedTarget: true, reason: `Passed in a fresh sandbox with only the repeated checks (${rerun.steps.map((s) => `${s.method} ${s.path} answered ${s.status}`).join("; ")}). In the first run it failed alongside the other checks (${limited ? "rate limited with 429" : step.why}), because it shared records or traffic with them.`, executionIds: execIds, fixtureRefs: refsOf(probe) });
      continue;
    }
    const logText = slice(step.logFrom, step.logTo) || (retrySlice && rerun ? retrySlice(rerun.steps.find((s) => !s.ok)?.logFrom, rerun.steps.find((s) => !s.ok)?.logTo) : "");
    const ob = ctx.obligations.get(id)!;
    const e = ctx.d.entryPoints.find((x) => x.id === ob.asset.ref);
    const request = result.steps.map((s) => `${s.method} ${s.path}`).join(" then ");
    const sent = probe.steps[result.steps.indexOf(step)] ?? probe.steps[0]!;
    const body = sent.raw ?? (sent.json !== undefined ? JSON.stringify(sent.json) : "");
    const locs = [...stackLocations(ctx.src, app.workspace, logText), ...(e ? [e.handler] : [])].slice(0, 3);
    candidates.push({
      source: "probe",
      label: `${ob.asset.label}: ${ob.objective}`,
      obligationIds: [id],
      executionIds: execIds,
      reproduced: rerun ? (reproduced ? 2 : 1) : 1,
      of: rerun ? 2 : 1,
      reproduction: probeReproduction(app, graph, probe, result.steps.map((s) => s.path), fixtureResults),
      probe: { request: `${step.method} ${step.path}${body ? ` with body ${body.slice(0, 300)}` : ""}${probe.identity ? ` (signed in as ${probe.identity})` : " (no credentials)"}`, status: step.status },
      context: [
        `HTTP check against the running app (sandbox, no internet, synthetic configuration, database created empty and filled only by the setup steps). Obligation: ${ob.objective}. Oracle (${ob.oracle.source}): ${ob.oracle.expected}.`,
        authoredEvidence.get(id) ? `Why this was expected (from the probe author): ${authoredEvidence.get(id)}` : "",
        `Request: ${request}${body ? `\nBody sent: ${body.slice(0, 600)}` : ""}${probe.identity ? `\nSigned in as: ${probe.identity}` : "\nNo credentials sent."}`,
        `Observed: ${step.why}. Response body (start): ${(step.body ?? "").slice(0, 600)}`,
        `Reproduced in a second fresh sandbox: ${rerun ? (reproduced ? "yes" : "no") : "not attempted"}.`,
        logText ? `Server log written during this request:\n${tail(logText, 2500)}` : "No server log lines were written during this request.",
        ...locs.map((l) => excerpt(ctx.src, l.path, l.line, 8, 30)).filter(Boolean),
        ...(e ? ["Code the handler calls:", ...codeUnderTest(ctx.src, e.handler.path, 10_000)] : []),
        ...(e ? schemaContext(ctx, e.handler.path, e.handler.line) : []),
        ...(step.status === 403 && e ? roleContext(ctx, app, e.path, probe.steps[result.steps.indexOf(step)]?.as ?? probe.identity) : []),
      ].filter(Boolean).join("\n\n"),
      locations: locs,
      workspace: app.workspace,
      forced: OFFLINE.test(logText) || OFFLINE.test(step.body ?? "") ? "environment_failure" : undefined,
    });
    await setOb(ctx, id, { status: "failed", reachedTarget: true, reason: `${step.why} (${request}).`, executionIds: execIds, fixtureRefs: refsOf(probe) });
  }

  await judgeScenarios(ctx, image, app, graph, scenarios, out.scenarios ?? [], first, extra, candidates, shared);

  if (shared.length) {
    await addFinding(ctx, { kind: "test_defect", status: "confirmed", severity: "low", confidence: "high", title: `${shared.length} check(s) cybercheck wrote shared records with other checks`, expected: "Each check works on records of its own", actual: shared.slice(0, 8).map((s) => `${s.id}: failed in the shared run (${s.why}), passed when repeated in a fresh sandbox`).join("\n"), reproduction: "Internal to cybercheck: compare the first run with the fresh-sandbox repeat in the run's executions.", rootCause: "The checks ran in one app instance and changed the same records (or used up a rate limit) before each other.", location: null, obligationIds: shared.map((s) => s.id), executionIds: [first.exec.id], validation: "Each one passed when repeated in a fresh sandbox; that repeat is its verdict.", limitation: null, layer: "api", nextAction: "Nothing for you: cybercheck gives each check its own records in a later version; the verdicts above already come from the clean repeat." });
  }
  if (rateLimited.length) {
    await addFinding(ctx, { kind: "test_defect", status: "confirmed", severity: "low", confidence: "high", title: `The app's rate limiter refused ${rateLimited.length} of cybercheck's checks (429)`, expected: "Checks stay under the app's rate limit", actual: rateLimited.slice(0, 8).join("\n"), reproduction: "Internal to cybercheck: these checks were answered 429 Too Many Requests.", rootCause: "cybercheck sent more requests to a rate-limited endpoint than the limit allows within its window; the limiter worked as designed.", location: null, obligationIds: rateLimited, executionIds: [first.exec.id], validation: "Answered 429 in the first run and in the repeat.", limitation: null, layer: "api", nextAction: "Rerun the missing evidence: a targeted rerun sends only these checks, which stays under the limit." });
  }

  // Shutdown: the harness sends SIGTERM and waits 3 s before forcing the app to stop.
  const graceful = out.shutdown?.graceful ?? null;
  if (graceful != null && ctx.obligations.has("reliability:graceful-shutdown") && ctx.obligations.get("reliability:graceful-shutdown")!.status === "planned") {
    await setOb(ctx, "reliability:graceful-shutdown", { status: graceful ? "passed" : "failed", reachedTarget: true, reason: graceful ? "The app exited within 3 s of SIGTERM." : "The app was still running 3 s after SIGTERM and had to be killed.", executionIds: [first.exec.id] });
    if (!graceful) {
      await addFinding(ctx, {
        kind: "product_defect",
        status: "suspected",
        severity: "low",
        confidence: "medium",
        title: `${appLabel[0]!.toUpperCase()}${appLabel.slice(1)} does not stop on SIGTERM`,
        expected: "The process exits within a few seconds of a termination signal (deployments and restarts send SIGTERM)",
        actual: "It was still running 3 s after SIGTERM and had to be killed with SIGKILL.",
        reproduction: `Start it with ${app.start}, then send SIGTERM to the process and watch whether it exits.`,
        rootCause: null,
        location: null,
        obligationIds: ["reliability:graceful-shutdown"],
        executionIds: [first.exec.id],
        validation: "Measured once by the probe harness; a slow shutdown hook can also cause this.",
        limitation: "The start command may wrap the app in a shell or package manager that does not forward signals.",
        layer: "reliability",
        nextAction: "Handle SIGTERM: close the server and database connections, then exit.",
      });
    }
  }
  return { latencies: [...out.latencies], fixtures: summarise(graph, fixtureResults), graceful, graph };
}

/** A failed scenario in words: every request in order, then each assertion that did not hold. */
export function scenarioReproduction(s: CompiledScenario, run: ScenarioRun) {
  const lines = s.requests.map((r, i) => {
    const params = Object.keys(r.pathParams).length ? ` with ${Object.entries(r.pathParams).map(([k, v]) => `{${k}} = ${JSON.stringify(v)}`).join(", ")}` : "";
    const query = r.query.length ? ` and query ${r.query.map((q) => `${q.name}=${JSON.stringify(q.value)}`).join("&")}` : "";
    const body = r.body ? ` with body ${JSON.stringify(r.body.kind === "json" ? r.body.value : r.body.kind === "form" ? r.body.fields : r.body.text).slice(0, 300)}` : "";
    return `${i + 1}. ${r.method} ${r.path}${params}${query}${body}${r.as ? ` (signed in as ${r.as})` : " (no credentials)"}`;
  });
  const failed = run.proofs
    .filter((p) => !p.passed)
    .map((p) => {
      const a = s.assertions.find((x) => x.id === p.assertionId);
      return `Expected: ${a?.says ?? p.assertionId} (${JSON.stringify(p.expected)}). Observed: ${JSON.stringify(p.observed)}.`;
    });
  return [...lines, ...failed].join("\n");
}

/**
 * Compiled scenarios after the probe run: each requirement's obligation gets its verdict through the proof gate.
 * A failure is repeated once in a fresh sandbox before it is reported; passing there means the first run shared
 * records with other checks.
 */
async function judgeScenarios(ctx: Ctx, image: string, app: BootApp, graph: FixtureNode[], jobs: ScenarioJob[], results: ScenarioOut[], first: Awaited<ReturnType<typeof runHarness>>, extra: Record<string, string>, candidates: Candidate[], shared: Array<{ id: string; why: string }>) {
  if (!jobs.length) return;
  const byId = new Map(results.map((r) => [r.scenarioId, r]));
  const record = async (job: ScenarioJob, run: ScenarioOut, execIds: string[]) => {
    for (const [req, obId] of Object.entries(job.obligations)) {
      const patch = obligationFromScenario(job.scenario, run, req, execIds[0]!);
      await setOb(ctx, obId, { ...patch, ...(run.blockedBy ? { status: "blocked" as const, blockedBy: run.blockedBy } : {}), executionIds: execIds });
    }
  };
  const failed: ScenarioJob[] = [];
  for (const job of jobs) {
    const run = byId.get(job.scenario.id);
    if (!run) {
      for (const obId of Object.values(job.obligations)) await setOb(ctx, obId, { status: "blocked", blockedBy: "prerequisite", reason: "Not reached: the probe run stopped before this scenario.", executionIds: [first.exec.id] });
    } else if (run.status === "failed") failed.push(job);
    else await record(job, run, [first.exec.id]);
  }
  if (!failed.length) return;
  await ctx.store.event("executing", `Reproducing ${failed.length} failed scenario(s) in a fresh sandbox`);
  const second = await runHarness(ctx, image, app, graph, [], `Reproduce ${failed.length} failed scenario(s) on ${app.workspace === "." ? "the app" : app.workspace}`, first.exec.id, extra, failed);
  const again = new Map((second.out?.scenarios ?? []).map((r) => [r.scenarioId, r]));
  for (const job of failed) {
    const run = byId.get(job.scenario.id)!;
    const rerun = again.get(job.scenario.id);
    const execIds = [first.exec.id, second.exec.id];
    if (rerun?.status === "passed") {
      for (const obId of Object.values(job.obligations)) shared.push({ id: obId, why: run.reason });
      await record(job, rerun, [second.exec.id, first.exec.id]);
      continue;
    }
    await record(job, run, execIds);
    const action = job.scenario.requests.find((r) => r.role === "action")!;
    const e = ctx.d.entryPoints.find((x) => routeKey(x.method, x.path) === routeKey(action.method, action.path));
    const logText = first.slice(run.logFrom, run.logTo);
    const locs = [...stackLocations(ctx.src, app.workspace, logText), ...(e ? [e.handler] : [])].slice(0, 3);
    const crashed = !run.proofs.some((p) => !p.passed);
    for (const [reqId, obId] of Object.entries(job.obligations)) {
      const mine = run.proofs.filter((p) => p.requirementId === reqId);
      if (!crashed && mine.every((p) => p.passed)) continue;
      const ob = ctx.obligations.get(obId);
      const req = job.requirements.find((r) => r.id === reqId);
      const source = req ? `${req.source.kind}${req.source.path ? `, ${req.source.path}${req.source.line ? `:${req.source.line}` : ""}` : ""}` : "?";
      candidates.push({
        source: "probe",
        label: `${ob?.asset.label ?? `${action.method} ${action.path}`}: ${ob?.objective ?? req?.expectedBehavior ?? reqId}`,
        obligationIds: [obId],
        executionIds: execIds,
        reproduced: rerun ? (rerun.status === "failed" ? 2 : 1) : 1,
        of: rerun ? 2 : 1,
        reproduction: scenarioReproduction(job.scenario, run),
        probe: { request: `${action.method} ${action.path}${action.as ? ` (signed in as ${action.as})` : " (no credentials)"}`, status: null },
        context: [
          `Typed scenario against the running app (sandbox, no internet, synthetic configuration). Requirement (${source}): ${req?.expectedBehavior ?? reqId}`,
          `Steps and the assertions that did not hold:\n${scenarioReproduction(job.scenario, run)}`,
          ...mine.filter((p) => !p.passed && p.excerpt).map((p) => `Response read by ${p.assertionId}: ${p.excerpt}`),
          `Reproduced in a second fresh sandbox: ${rerun ? (rerun.status === "failed" ? "yes" : "no") : "not attempted"}.`,
          logText ? `Server log written during this scenario:\n${tail(logText, 2500)}` : "No server log lines were written during this scenario.",
          ...locs.map((l) => excerpt(ctx.src, l.path, l.line, 8, 30)).filter(Boolean),
          ...(e ? ["Code the handler calls:", ...codeUnderTest(ctx.src, e.handler.path, 10_000)] : []),
        ].join("\n\n"),
        locations: locs,
        workspace: app.workspace,
        forced: OFFLINE.test(logText) ? "environment_failure" : undefined,
      });
    }
  }
}
