import { buffer } from "node:stream/consumers";
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { FindingKind, TestingPolicyInput, canDefineOracle, type EntryPoint, type Obligation, type ProjectDossier, type TestFinding, type TestingReport, type TestRequirement } from "@cybercheck/contracts";
import { db } from "../db/client.ts";
import { sandboxImageCache, snapshot, testFinding, testingRun, testObligation, understandingRun } from "../db/schema.ts";
import { getSnapshotSource, type SnapshotSource } from "../understanding/source.ts";
import { APP_ROOT, OUT, planWorkspaces, slug, wsPath, type WorkspacePlan } from "./adapters.ts";
import { INTERACTIVE, NEEDS_NETWORK, OFFLINE, authorJourneys, authorProbes, authorUnitTests, authoringTargets, bootGraph, fixtureSteps, identityFor, wrongRoleIdentity, planBoot, scenarioToProbe, unitTargets, validEvidence, type FrontendApp } from "./agents.ts";
import { servedScreens } from "./served-pages.ts";
import { behaviourSections } from "./report-sections.ts";
import { capabilityOf, isDecisive, roleWords, withAssurance } from "./assurance.ts";
import { buildFrontend, judgeBrowser, type BrowserJourney, type BrowserPlan } from "./browser.ts";
import { judgeDatabase } from "./database.ts";
import { databaseStrategy, judgeInMemoryDatabase } from "./db-strategy.ts";
import { aliasPlaceholders, bindCredentialPlaceholders, inventedSettings, produces, recordNodes, settingSources, validateGraph, verifiedGraph, verifyTarget, withRecord } from "./fixtures.ts";
import { judgeGenerated, type Generated } from "./generated.ts";
import { judgeLoad } from "./load.ts";
import { appFor, buildObligations, buildProbes, isAuthEntry, obligation, type FixtureNode, type PlanOptions, type Probe } from "./plan.ts";
import { appEnv, judgeProbes, type ScenarioJob } from "./probes.ts";
import { ORACLE, authorScenarios, behaviourObligations, compileBehaviour, extractRequirements, templateFromWords } from "./behaviour.ts";
import { fillTemplate, isCore, schemaRequirements, slotContext, templateScenarios, touchedRoutes, type TemplateFill } from "./templates.ts";
import { authorInOrder, gapsFirst, type AuthoringStep } from "./authoring-order.ts";
import { routeKey } from "./scenarios.ts";
import { buildReport, withInvalidSetup, type FixtureSummary } from "./report.ts";
import { SERVICE_NOTES, detectServices, installServices } from "./services.ts";
import { consistentFailures, judgeSuite, runSuite } from "./suites.ts";
import { mergeDuplicates, reconcile, settle, type Candidate } from "./triage.ts";
import { BROWSER_DIR, CI_ENV, ENGINE_VERSION, K6, LEGACY_ENGINE, POLICY, PROFILES, TSX, addFinding, effectivePolicy, execute, setOb, sha, shq, tail, type Ctx, type Deps, type LoadStageName } from "./runtime.ts";
import { env } from "../env.ts";
import type { RunStore } from "./store.ts";

export { ENGINE_VERSION, POLICY, PROFILES };

/** Pinned tool versions installed into the prepared image (part of the image cache key). */
const TOOLS = { tsx: "4.19.2", pg: "8.13.1", playwright: "1.49.1", axe: "4.10.2", k6: "0.54.0" };

// ---------------------------------------------------------------- preparation (network on)

type Tools = { node: boolean; browser: boolean; k6: boolean; pg: boolean };

async function prepare(ctx: Ctx, workspaces: WorkspacePlan[], digest: string, archive: Buffer, tools: Tools): Promise<{ image: string | null; installOk: Map<string, boolean>; tools: Tools }> {
  const installOk = new Map<string, boolean>();
  const installs = workspaces.filter((w) => w.install);
  const key = sha(JSON.stringify({ digest, image: POLICY.image, engine: ENGINE_VERSION, services: ctx.services, installs: installs.map((w) => [w.dir, w.install!.command]), tools, versions: TOOLS }));
  const [cached] = await db.select().from(sandboxImageCache).where(eq(sandboxImageCache.key, key));
  if (cached && cached.provider === ctx.provider.name) {
    await ctx.store.event("prepare", "Reusing an image with this exact snapshot's dependencies installed; verifying it");
    // Evidence for this run: the cached image really has each workspace's dependencies and the tools.
    const checks = installs.map((w) => (w.ecosystem === "python" ? `test -x /work/venv-${slug(w.dir)}/bin/python` : `test -d ${shq(wsPath(w.dir))}/node_modules`));
    if (tools.node) checks.push(`test -f ${TSX}`);
    if (tools.browser) checks.push(`test -d ${BROWSER_DIR}/node_modules/playwright`);
    if (tools.k6) checks.push(`test -x ${K6}`);
    const v = await execute(ctx, { kind: "prepare", label: "Verify reused dependencies", workspace: null }, { image: cached.imageId, command: `${checks.join(" && ") || "true"} && echo dependencies present`, network: false, keep: false, timeoutSec: 120 });
    if (v.exec.outcome === "ok") {
      for (const w of installs) {
        installOk.set(w.dir, true);
        await setOb(ctx, `env:install:${w.dir}`, { status: "passed", reachedTarget: true, reason: "Installed earlier for identical content; that sandbox image was reused and verified.", executionIds: [v.exec.id] });
      }
      return { image: cached.imageId, installOk, tools };
    }
    await db.delete(sandboxImageCache).where(eq(sandboxImageCache.key, key));
    await ctx.store.event("prepare", "The reused image was incomplete; installing from scratch");
  }

  const base = await ctx.provider.image(POLICY.image);
  const fileId = await ctx.provider.upload(archive);
  await ctx.store.event("prepare", "Copying the snapshot into a fresh sandbox");
  const unpack = await execute(ctx, { kind: "prepare", label: "Unpack snapshot", workspace: null }, {
    image: base,
    command: `mkdir -p ${APP_ROOT} ${OUT} && tar xzf /in/snapshot.tgz -C ${APP_ROOT} --no-same-owner && find ${APP_ROOT} -name '*.sh' -exec chmod +x {} + ; node --version; python3 --version; ls ${APP_ROOT} | head -50`,
    network: false,
    keep: true,
    timeoutSec: 300,
    files: [{ path: "/in/snapshot.tgz", fileId }],
  });
  let image = unpack.result.resultImage;
  if (!image || unpack.exec.outcome !== "ok") throw new Error(`The snapshot could not be unpacked in the sandbox (${unpack.result.error ?? `exit ${unpack.result.exitCode}`}).`);

  let allOk = true;
  if (ctx.services.length) {
    await ctx.store.event("prepare", `Installing local ${ctx.services.join(" and ")} for the app and tests (test data only, never your real database)`);
    const svc = await execute(ctx, { kind: "prepare", label: `Install local ${ctx.services.join(", ")}`, workspace: null }, { image, command: installServices(ctx.services), network: true, keep: true, timeoutSec: 600 });
    if (svc.exec.outcome === "ok" && svc.result.resultImage) image = svc.result.resultImage;
    else {
      allOk = false;
      ctx.services = [];
    }
  }
  for (const w of installs) {
    await ctx.store.event("prepare", `Installing dependencies in ${w.dir === "." ? "the project root" : w.dir} (${w.install!.command})`);
    const r = await execute(ctx, { kind: "prepare", label: `Install (${w.dir})`, workspace: w.dir }, {
      image,
      command: `cd ${shq(wsPath(w.dir))} && ${w.install!.command} </dev/null`,
      network: true,
      keep: true,
      timeoutSec: POLICY.installTimeoutSec,
      env: CI_ENV,
    });
    const ok = r.exec.outcome === "ok";
    installOk.set(w.dir, ok);
    allOk &&= ok;
    if (r.result.resultImage) image = r.result.resultImage;
    await setOb(ctx, `env:install:${w.dir}`, {
      status: ok ? "passed" : r.exec.outcome === "timed_out" ? "inconclusive" : "failed",
      reachedTarget: true,
      reason: ok ? (w.install!.note ?? null) : r.exec.outcome === "timed_out" ? `Install did not finish within ${POLICY.installTimeoutSec}s.` : `Install exited with code ${r.exec.exitCode}.`,
      executionIds: [r.exec.id],
    });
    if (!ok) {
      const offline = OFFLINE.test(r.exec.outputTail) && !/ERESOLVE|peer dep|No matching version|notarget|404 Not Found/i.test(r.exec.outputTail);
      await addFinding(ctx, {
        kind: offline ? "environment_failure" : "product_defect",
        status: "confirmed",
        severity: "high",
        confidence: "high",
        title: `Dependencies don't install in ${w.dir === "." ? "the project root" : w.dir}`,
        expected: `${w.install!.command} succeeds`,
        actual: r.exec.outcome === "timed_out" ? `It did not finish within ${POLICY.installTimeoutSec}s.` : `It exited with code ${r.exec.exitCode}. Last output:\n${tail(r.exec.outputTail, 1200)}`,
        reproduction: `cd ${w.dir} && ${w.install!.command}`,
        rootCause: null,
        location: null,
        obligationIds: [`env:install:${w.dir}`],
        executionIds: [r.exec.id],
        validation: "Exit code reported by the sandbox platform.",
        limitation: "The sandbox uses Node 22 on Debian bookworm; a different runtime version may behave differently.",
        layer: "environment",
      });
    }
  }
  // cybercheck's own test tools, outside the project, at pinned versions.
  const toolSteps: Array<{ label: string; command: string; flag: keyof Tools }> = [];
  if (tools.node || tools.pg) toolSteps.push({ label: "Install cybercheck test tools", flag: "node", command: `mkdir -p /opt/cc-tools && cd /opt/cc-tools && echo '{"private":true}' > package.json && npm install tsx@${TOOLS.tsx}${tools.pg ? ` pg@${TOOLS.pg}` : ""} --no-audit --no-fund` });
  if (tools.browser) toolSteps.push({ label: "Install the test browser (Chromium, Playwright, axe-core)", flag: "browser", command: `mkdir -p ${BROWSER_DIR} && cd ${BROWSER_DIR} && echo '{"private":true}' > package.json && npm install playwright@${TOOLS.playwright} axe-core@${TOOLS.axe} --no-audit --no-fund && npx playwright install --with-deps chromium 2>&1 | tail -3` });
  if (tools.k6) toolSteps.push({ label: "Install the load generator (k6)", flag: "k6", command: `mkdir -p /opt/cc-k6 && cd /opt/cc-k6 && curl -fsSL -o k6.tgz https://github.com/grafana/k6/releases/download/v${TOOLS.k6}/k6-v${TOOLS.k6}-linux-amd64.tar.gz && curl -fsSL -o sums.txt https://github.com/grafana/k6/releases/download/v${TOOLS.k6}/k6-v${TOOLS.k6}-checksums.txt && grep linux-amd64.tar.gz sums.txt | cut -d' ' -f1 > want && sha256sum k6.tgz | cut -d' ' -f1 > got && cmp want got && tar xzf k6.tgz --strip-components=1 && ./k6 version` });
  const available = { ...tools };
  for (const t of toolSteps) {
    const r = await execute(ctx, { kind: "prepare", label: t.label, workspace: null }, { image, command: t.command, network: true, keep: true, timeoutSec: 600, env: CI_ENV });
    if (r.exec.outcome === "ok" && r.result.resultImage) image = r.result.resultImage;
    else {
      allOk = false;
      available[t.flag] = false;
      await ctx.store.event("prepare", `${t.label} failed; the checks that need it are reported as blocked`);
    }
  }
  if (allOk) await db.insert(sandboxImageCache).values({ key, provider: ctx.provider.name, imageId: image }).onConflictDoNothing();
  return { image, installOk, tools: available };
}

// ---------------------------------------------------------------- build, typecheck, lint

/** Where the build reached for the internet (shown in the finding). */
const networkTarget = (out: string) => out.match(/fonts\.(googleapis|gstatic)\.com|registry\.npmjs\.org|pypi\.org|github\.com/)?.[0] ?? "the internet";

type PendingFinding = Parameters<typeof addFinding>[1] & { kindOfStep: string };

async function runSteps(ctx: Ctx, image: string, w: WorkspacePlan) {
  const queued: PendingFinding[] = [];
  const where = w.dir === "." ? "project root" : w.dir;
  await Promise.all(
    w.steps.filter((s) => pending(ctx, `env:${s.kind}:${w.dir}`)).map(async (s) => {
      const label = `${s.kind[0]!.toUpperCase()}${s.kind.slice(1)} (${w.dir})`;
      const Kind = `${s.kind[0]!.toUpperCase()}${s.kind.slice(1)}`;
      // stdin is closed so a setup wizard cannot wait for an answer; silence for stepIdleSec means a prompt or a hang.
      const run = (network: boolean, retryOf: string | null) => execute(ctx, { kind: "command", label: network ? `${label} with internet access` : label, workspace: w.dir, retryOf, idleSec: POLICY.stepIdleSec }, { image, command: `cd ${shq(wsPath(w.dir))} && ${s.command} </dev/null`, network, keep: false, timeoutSec: POLICY.commandTimeoutSec, env: CI_ENV });
      const r = await run(false, null);
      const id = `env:${s.kind}:${w.dir}`;
      const out = r.exec.outputTail;
      if (r.exec.outcome === "ok") return setOb(ctx, id, { status: "passed", reachedTarget: true, reason: null, executionIds: [r.exec.id] });
      // A question instead of a result: the project lacks a non-interactive configuration. Not a code defect.
      if (INTERACTIVE.test(out)) {
        const f = await addFinding(ctx, {
          kind: "configuration_gap",
          status: "confirmed",
          severity: "low",
          confidence: "high",
          title: `${Kind} is not configured for non-interactive runs (${where})`,
          expected: `${s.declared} runs without asking questions (as in CI)`,
          actual: `It stopped to ask: "${out.split("\n").find((l) => INTERACTIVE.test(l))?.trim().slice(0, 160)}". No ${s.kind} result was produced.`,
          reproduction: `cd ${w.dir} && CI=true ${s.command} < /dev/null`,
          rootCause: s.kind === "lint" && /ESLint/i.test(out) ? "No ESLint configuration is committed, so the linter starts its setup wizard." : "The command needs an answer on the keyboard.",
          location: null,
          obligationIds: [id],
          executionIds: [r.exec.id],
          validation: "The command printed a prompt instead of results; the sandbox closes stdin like a CI runner.",
          limitation: null,
          layer: "environment",
          nextAction: s.kind === "lint" ? "Commit an ESLint configuration (for Next.js, eslint.config.mjs) so lint runs without questions." : `Make "${s.declared}" run without prompts.`,
        });
        return setOb(ctx, id, { status: "blocked", blockedBy: "prerequisite", reason: `It asked a question instead of running (not configured for CI); see ${f.id}.`, executionIds: [r.exec.id], findingIds: [f.id] });
      }
      if (r.exec.outcome === "timed_out") return setOb(ctx, id, { status: "inconclusive", reason: `No output for ${POLICY.stepIdleSec}s, or longer than ${POLICY.commandTimeoutSec}s: a prompt or a hang.`, executionIds: [r.exec.id] });
      if (r.exec.outcome === "error") return setOb(ctx, id, { status: "blocked", blockedBy: "environment", reason: `The sandbox could not run it: ${r.result.error}`, executionIds: [r.exec.id] });
      // It tried to download something offline: confirm with one networked run before blaming the code.
      let failed = r;
      if (NEEDS_NETWORK.test(out)) {
        const host = networkTarget(out);
        await ctx.store.event("executing", `${label} failed fetching ${host} offline; running it once with internet access to tell a network need from a code error`);
        const online = await run(true, r.exec.id);
        if (online.exec.outcome === "ok") {
          const f = await addFinding(ctx, {
            kind: "configuration_gap",
            status: "confirmed",
            severity: "low",
            confidence: "high",
            title: `The ${s.kind} needs internet access (${host}) (${where})`,
            expected: `${s.declared} works offline, so builds are reproducible`,
            actual: `Offline it failed (${out.split("\n").find((l) => NEEDS_NETWORK.test(l))?.trim().slice(0, 200) ?? "a download failed"}); with internet access it passed.`,
            reproduction: `cd ${w.dir} && ${s.command} (with the network disabled)`,
            rootCause: /fonts\.(googleapis|gstatic)|next\/font/.test(out) ? "next/font/google downloads the fonts at build time." : `The ${s.kind} downloads files from ${host}.`,
            location: null,
            obligationIds: [id],
            executionIds: [r.exec.id, online.exec.id],
            validation: "Failed offline, passed in a second clean sandbox with internet access.",
            limitation: null,
            layer: "environment",
            nextAction: /fonts/.test(host) ? "Self-host the fonts (next/font/local) or accept that builds need internet access." : `Vendor the files the ${s.kind} downloads, or accept that it needs internet access.`,
          });
          return setOb(ctx, id, { status: "passed", reachedTarget: true, reason: `Passed with internet access; offline it cannot reach ${host} (see ${f.id}).`, executionIds: [r.exec.id, online.exec.id], findingIds: [f.id] });
        }
        failed = online;
      }
      await setOb(ctx, id, { status: "failed", reachedTarget: true, reason: `Exited with code ${failed.exec.exitCode}${failed !== r ? " (also with internet access)" : ""}.`, executionIds: [...new Set([r.exec.id, failed.exec.id])] });
      const fout = failed.exec.outputTail;
      const errors = fout.split("\n").filter((l) => /error|ERR!|failed|✖/i.test(l)).slice(0, 12).join("\n");
      const loc = fout.match(/([\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|vue|py))[(:](\d+)/);
      const location = loc ? (validEvidence(ctx.src, [{ path: w.dir === "." ? loc[1]! : `${w.dir}/${loc[1]!}`.replace(/^(.+?)\/\1\//, "$1/"), line: Number(loc[2]) }])[0] ?? validEvidence(ctx.src, [{ path: loc[1]!, line: Number(loc[2]) }])[0] ?? null) : null;
      queued.push({
        kindOfStep: s.kind,
        kind: "product_defect",
        status: "confirmed",
        severity: s.kind === "lint" ? "low" : s.kind === "typecheck" ? "medium" : "high",
        confidence: "high",
        title: s.kind === "build" ? `The build fails (${where})` : s.kind === "typecheck" ? `Type errors (${where})` : `Lint errors (${where})`,
        expected: `${s.declared} exits with code 0`,
        actual: `Exit code ${failed.exec.exitCode}.${errors ? `\n${errors}` : ""}`,
        reproduction: `cd ${w.dir} && ${s.command}`,
        // The compiler or linter's own first error message names the cause.
        rootCause: errors.split("\n").find((l) => /error/i.test(l))?.trim().slice(0, 300) ?? null,
        location,
        obligationIds: [id],
        executionIds: [...new Set([r.exec.id, failed.exec.id])],
        validation: failed !== r ? "Failed offline and again with internet access; exit codes reported by the sandbox platform." : "Exit code reported by the sandbox platform; the command is the project's own.",
        limitation: s.source === "inferred" ? "The project has no typecheck script; cybercheck ran tsc --noEmit because a tsconfig.json and TypeScript are present." : null,
        layer: "environment",
        nextAction: s.kind === "lint" ? "Fix the lint errors listed." : "Fix the first error the compiler reports, then rerun.",
      });
    }),
  );
  // One cause, one finding: a type error that breaks both typecheck and build is reported once.
  const groups = new Map<string, PendingFinding[]>();
  for (const f of queued) {
    const key = f.location ? `${f.location.path}:${f.location.line}` : `${f.kindOfStep}:${f.reproduction}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  for (const group of groups.values()) {
    const [first, ...rest] = group.sort((a, b) => (a.kindOfStep === "typecheck" ? -1 : b.kindOfStep === "typecheck" ? 1 : 0));
    const { kindOfStep: _k, ...f } = first!;
    const steps = group.map((g) => g.kindOfStep);
    await addFinding(ctx, {
      ...f,
      title: steps.length > 1 ? `${steps.includes("typecheck") ? "A type error" : "An error"} breaks the ${steps.filter((x) => x !== "typecheck").join(" and ") || "build"} (${where})` : f.title,
      severity: group.some((g) => g.severity === "high") ? "high" : f.severity,
      expected: group.map((g) => g.expected).join("; "),
      actual: group.length > 1 ? group.map((g) => `${g.kindOfStep}: ${g.actual}`).join("\n") : f.actual,
      reproduction: group.map((g) => g.reproduction).join("\n"),
      obligationIds: group.flatMap((g) => g.obligationIds),
      executionIds: group.flatMap((g) => g.executionIds),
      validation: rest.length ? "Both commands fail on the same error; exit codes reported by the sandbox platform." : f.validation,
    });
  }
}

// ---------------------------------------------------------------- the run

type CachedPlan = {
  boot: Awaited<ReturnType<typeof planBoot>>;
  authored: Awaited<ReturnType<typeof authorProbes>>;
  units: Awaited<ReturnType<typeof authorUnitTests>>;
  journeys: Awaited<ReturnType<typeof authorJourneys>> | null;
  /** Documented requirements and the scenario proposals written for them (compiled again each run). */
  behaviour?: { requirements: TestRequirement[]; proposals: unknown[]; fills?: TemplateFill[] };
  /** Which authoring steps ran, were cut short or were skipped (disclosed again when the plan is reused). */
  authoring?: AuthoringStep[];
  /** Setup graphs that worked after a repair, per app: the next run of the same code starts from them. */
  graphs?: Record<string, FixtureNode[]>;
  costUsd?: number;
  runId?: string;
};

/** Where the AI plan for identical content is cached (the preview uses it to say planning will cost nothing). */
export const planCacheKey = (digest: string, d: ProjectDossier, browser: boolean) => `testing-plans/${sha(JSON.stringify({ digest, engine: ENGINE_VERSION, analyzer: d.meta.analyzerVersion, ai: d.ai?.status ?? null, browser }))}.json`;

/** Whether a frontend workspace can serve the screens, and whether the database engine can be probed. */
export function capabilities(d: ProjectDossier, workspaces: WorkspacePlan[], services: string[]) {
  const frontendWs = workspaces.some((w) => w.ecosystem === "node" && d.screens.some((s) => w.dir === "." || s.file.startsWith(`${w.dir}/`)));
  const dbs = d.integrations.filter((i) => i.category === "database").map((i) => i.name.toLowerCase());
  const sqlite = dbs.some((n) => /sqlite/.test(n)) || d.dataModel.sources.some((s) => /sqlite/i.test(s));
  return { frontendWs, database: sqlite || services.includes("postgres") };
}

export async function runTesting(store: RunStore, deps: Deps, onProgress: (step: string) => void) {
  const [run] = await db.select().from(testingRun).where(eq(testingRun.id, store.runId));
  if (!run) throw new Error("run not found");
  const policy = TestingPolicyInput.safeParse(run.policy ?? {});
  const profile = policy.success ? policy.data.profile : "standard";
  const thresholds = policy.success ? (policy.data.thresholds ?? null) : null;
  // The user's choices applied to the profile: completeness target, AI budget, time limit, which lanes run.
  const ep = effectivePolicy(policy.success ? policy.data : {}, env.TESTING_RUN_BUDGET_USD);
  deps.session?.limitBudget(ep.budgetUsd);
  // Shares of the run's AI budget (the 9+/10 plan): start-up planning, setup repair and requirements 20%, writing
  // scenarios, probes, journeys and unit tests 30%, triage and review
  // 35%, reconciliation 10%; the last 5% is a reserve only triage may use, so critical failures are still analysed.
  if (!LEGACY_ENGINE) deps.session?.setStageBudget(budgetGroup, { planning: 0.2 * ep.budgetUsd, authoring: 0.3 * ep.budgetUsd, triage: 0.35 * ep.budgetUsd, reconcile: 0.1 * ep.budgetUsd }, { usd: 0.05 * ep.budgetUsd, groups: ["triage"] });
  const deadline = ep.maxSandboxMinutes ? Date.now() + ep.maxSandboxMinutes * 60_000 : null;
  const ctx: Ctx = { ...deps, store, runId: run.id, d: null as unknown as ProjectDossier, src: null as unknown as SnapshotSource, obligations: new Map(), executions: [], findings: [], sandboxOps: 0, sandboxCpu: 0, suiteSummaries: [], services: [], profile, thresholds };
  ctx.deadline = deadline;
  const step = async (phase: Parameters<RunStore["phase"]>[0], text: string) => {
    onProgress(text);
    await store.phase(phase, text);
  };
  // Usage so far, every 10 s, for the live view (stops by itself once the run is no longer running).
  const usageTimer = setInterval(() => {
    store.liveUsage(usageOf(ctx)).catch(() => clearInterval(usageTimer));
  }, 10_000);
  usageTimer.unref?.();

  // ---------------- wave 0: admission
  await step("admission", "Checking the snapshot and its analysis");
  const [snap] = await db.select().from(snapshot).where(eq(snapshot.id, run.snapshotId));
  const [ur] = run.understandingRunId ? await db.select().from(understandingRun).where(eq(understandingRun.id, run.understandingRunId)) : [];
  const d = ur?.dossier as ProjectDossier | null;
  if (!snap?.archiveObjectKey || !snap.contentDigest || snap.status !== "BASELINED") return finishBlocked(ctx, "The snapshot is not baselined.");
  if (!d || ur?.status !== "ready" || d.ai?.status === "running") return finishBlocked(ctx, "The project analysis is not ready. Wait until the project shows Ready.");
  if (d.meta.contentDigest !== snap.contentDigest) return finishBlocked(ctx, "The analysis belongs to different content than this snapshot.");
  ctx.d = d;
  ctx.src = await getSnapshotSource(deps.objects, snap.archiveObjectKey);
  // Pages the backend serves itself (a static folder, res.sendFile, templates) are the screens when no frontend router
  // was found: the browser opens them on the app, with no frontend build.
  const served = LEGACY_ENGINE || d.screens.length ? null : servedScreens(ctx.src, d);
  if (served?.screens.length) {
    d.screens = served.screens;
    ctx.screensFound = served.found;
    await store.event("planning", `Found ${served.screens.length} page(s) the backend serves itself (${served.screens.map((s) => s.route).slice(0, 6).join(", ")}); the browser opens them on the app`);
  }
  const errors = d.consistency.filter((c) => c.severity === "error");
  if (errors.length) await store.event("admission", `The analysis reported ${errors.length} consistency error(s); results that depend on them are marked`);

  // ---------------- planning: the obligation graph (rules), with proof classes and capabilities
  await step("planning", `Building the test obligation graph from the project dossier (${profile} profile)`);
  const workspaces = planWorkspaces(d, ctx.src);
  ctx.services = detectServices(d, ctx.src);
  // "python", "pip" and project binaries resolve to the project's own environment, whatever a planned command calls them.
  ctx.pathPrepend = workspaces.map((w) => (w.ecosystem === "python" ? `/work/venv-${slug(w.dir)}/bin` : `${wsPath(w.dir)}/node_modules/.bin`));
  const caps = capabilities(d, workspaces, ctx.services);
  const prof = PROFILES[profile];
  // A file database or Postgres is opened directly; an in-memory one is judged from its schema and through the app.
  const dbStrategy = LEGACY_ENGINE ? (caps.database ? (ctx.services.includes("postgres") ? "direct_postgres" : "direct_sqlite_file") : "none") : databaseStrategy(d, ctx.src, ctx.services);
  ctx.databaseStrategy = dbStrategy;
  const opts: PlanOptions = { browser: ep.browser && prof.browser && caps.frontendWs && d.screens.length > 0, database: prof.database && (caps.database || dbStrategy !== "none"), load: ep.loadStages, viewports: prof.viewports };
  const roles = roleWords(d);
  const known: string[] = [];
  const add = (o: Obligation) => {
    const cap = capabilityOf(o, d, known, roles);
    if (cap && !known.includes(cap) && o.asset.kind !== "entity") known.push(cap);
    ctx.obligations.set(o.id, withAssurance(o, cap));
  };
  const planned = buildObligations(d, workspaces, opts);
  // Routes and screens first, so entities and logic files join the capability names they define.
  for (const o of planned.filter((x) => x.asset.kind === "endpoint" || x.asset.kind === "screen")) add(o);
  for (const o of planned.filter((x) => x.asset.kind !== "endpoint" && x.asset.kind !== "screen")) add(o);
  if (prof.database && !caps.database) {
    for (const o of ctx.obligations.values()) if (o.layer === "data" && o.status === "unsupported" && o.id !== "data:migrations:upgrade") Object.assign(o, { blockedBy: "capability", reason: "Direct database probes support SQLite and Postgres; this project's database is not one of them." });
  }
  if (!workspaces.length) {
    add(obligation({ id: "env:project:runnable", layer: "environment", asset: { kind: "project", ref: ".", label: "project" }, objective: "The project can be installed and run", priority: "critical", oracle: { source: "policy", expected: "a supported ecosystem (Node.js or Python)", evidence: [] }, status: "unsupported", reason: `No Node.js package.json or Python requirements were found. Languages: ${d.stack.languages.map((l) => l.name).join(", ") || "none"}.` }));
  }
  await store.putObligations([...ctx.obligations.values()]);
  await store.event("planning", `Planned ${ctx.obligations.size} obligations: ${workspaces.length} workspace(s), ${d.entryPoints.filter((e) => e.kind !== "page").length} endpoint(s), ${d.screens.length} screen(s), ${d.dataModel.entities.length} table(s), ${workspaces.reduce((n, w) => n + w.suites.length, 0)} test suite(s)`);

  const archive = await buffer(deps.objects.get(snap.archiveObjectKey));
  // A repair validation run: the patched files go over the project in every sandbox of this run, and nowhere else.
  const repairPolicy = (run.policy as { repair?: { files?: Array<{ path: string; key: string }> } } | null)?.repair;
  if (repairPolicy?.files?.length && deps.provider) {
    ctx.overlay = [];
    for (const f of repairPolicy.files) ctx.overlay.push({ path: `${APP_ROOT}/${f.path}`, fileId: await deps.provider.upload(await buffer(deps.objects.get(f.key))) });
    await store.event("planning", `Repair check: ${repairPolicy.files.length} patched file(s) are mounted over the project in these sandboxes only`);
  }
  const candidates: Candidate[] = [];
  let latencies: number[] = [];
  let fixtures: FixtureSummary | null = null;
  let load: TestingReport["load"] = null;
  let planInfo: PlanInfo = { source: deps.session ? "generated" : "none", runId: null, savedUsd: 0 };

  if (workspaces.length) {
    // ---------------- wave 1: install (sandbox, network on) while the AI plans start-up, setup, checks and journeys
    await step("preparing", "Installing dependencies in an isolated sandbox and planning how to start the app and set up test data");
    const tested = new Set(d.entryPoints.filter((e) => [...ctx.src.files.entries()].some(([p, f]) => /(\.|\/)(test|spec)\.|__tests__\//.test(p) && f.text.includes(e.path))).map((e) => e.path));
    const nodeDirs = workspaces.filter((w) => w.ecosystem === "node").map((w) => w.dir);
    const unitPlan = unitTargets(d, ctx.src).flatMap((path) => {
      const ws = [...nodeDirs].sort((a, b) => b.length - a.length).find((dir) => dir === "." || path.startsWith(`${dir}/`));
      return ws == null ? [] : [{ path, workspace: ws, importPath: `../${ws === "." ? path : path.slice(ws.length + 1)}` }];
    });
    // Plans are cached per content, engine and analysis version: rerunning identical code costs no planning tokens.
    // A targeted rerun or a repair check reuses its parent's exact plan, so its AI-written checks keep the same ids
    // (authored:10 is the same scenario); otherwise a newer engine would re-plan and the checks would not match.
    const parentPlanKey = policy.success && policy.data.rerun ? ((await db.select({ plan: testingRun.plan }).from(testingRun).where(eq(testingRun.id, policy.data.rerun.parentRunId)))[0]?.plan as { planKey?: string } | null)?.planKey : undefined;
    const planKey = parentPlanKey && (await deps.objects.exists(parentPlanKey)) ? parentPlanKey : planCacheKey(snap.contentDigest, d, opts.browser);
    const cached: CachedPlan | null = (deps.session || parentPlanKey) && (await deps.objects.exists(planKey)) ? JSON.parse((await buffer(deps.objects.get(planKey))).toString("utf8")) : null;
    if (cached) {
      planInfo = { source: "cache", runId: cached.runId ?? null, savedUsd: cached.costUsd ?? 0 };
      await store.event("planning", `Reusing the start-up plan, setup steps and AI-written checks from an earlier run of this exact snapshot (saved about $${(cached.costUsd ?? 0).toFixed(3)})`);
    }
    const noUnits: Awaited<ReturnType<typeof authorUnitTests>> = { files: [], dropped: 0, rejected: [] };
    const planning = cached ? Promise.resolve({ boot: cached.boot, authored: cached.authored, journeys: cached.journeys, journeyError: null as string | null, behaviour: { requirements: cached.behaviour?.requirements ?? ([] as TestRequirement[]), proposals: cached.behaviour?.proposals ?? ([] as unknown[]), fills: cached.behaviour?.fills ?? ([] as TemplateFill[]) }, units: cached.units ?? noUnits, authoring: cached.authoring ?? [] }) : (async () => {
      const boot = await planBoot(deps.session, d, ctx.src, workspaces);
      await store.event("planning", boot.source === "ai" ? `Start-up plan: ${boot.apps.map((a) => `${a.workspace}: ${a.start} on port ${a.port}${a.setup.length ? `, setup: ${a.setup.map((s) => s.id).join(", ")}` : ""}${a.identities.length ? `, sign-in: ${a.identities.map((i) => i.name).join(", ")}` : ""}`).join("; ") || "no HTTP app"}${boot.frontends.length ? `; frontend: ${boot.frontends.map((f) => `${f.workspace} on port ${f.port}`).join(", ")}` : ""}` : `Start-up plan from rules${boot.error ? ` (AI planner unavailable: ${boot.error.slice(0, 120)})` : ""}`);
      const out = {
        authored: { scenarios: [], fixtures: [], dropped: 0 } as Awaited<ReturnType<typeof authorProbes>>,
        journeys: null as Awaited<ReturnType<typeof authorJourneys>> | null,
        journeyError: null as string | null,
        behaviour: { requirements: [] as TestRequirement[], proposals: [] as unknown[], fills: [] as TemplateFill[] },
        units: noUnits,
        authoring: [] as AuthoringStep[],
      };
      if (deps.session) {
        const session = deps.session;
        const http = boot.apps.length > 0;
        const targets = authoringTargets(d, tested).filter((e) => boot.apps.some((a) => appFor(e, [a.workspace])));
        const ids = boot.apps.flatMap((a) => a.identities.map((i) => i.name));
        const identities = boot.apps.flatMap((a) => a.identities.map((i) => ({ name: i.name, login: i.request ?? { kind: i.kind } })));
        const setup = boot.apps.flatMap((a) => a.setup.map((s) => ({ id: s.id, label: s.label, captures: [...s.exports, ...(s.steps ?? []).flatMap((st) => (st.capture ? [st.capture.name] : []))] })));
        const setupInfo = boot.apps.flatMap((a) => [...a.setup.map((x) => ({ id: x.id, captures: [...x.exports, ...(x.steps ?? []).flatMap((st) => (st.capture ? [st.capture.name] : []))], requests: (x.steps ?? []).map((st) => `${st.method} ${st.path}`) })), ...a.identities.map((i) => ({ id: i.name, captures: ["token"], requests: [] as string[] }))]);
        // Behaviour first: what the docs and tests say the product must do (planning share), then checks for it.
        if (http && ep.generatedTests && !LEGACY_ENGINE) {
          await step("authoring", "Reading what the docs and tests say the product must do");
          // A failed extraction is disclosed (report limitations), never an empty list that looks like "no requirements".
          const documented = await extractRequirements(session, d, ctx.src).catch((err: Error) => {
            out.authoring.push({ name: "requirements from the docs and tests", status: "skipped", reason: `reading them failed (${err.message.slice(0, 160)})` });
            return [] as TestRequirement[];
          });
          // Declared foreign keys are SQL's own rule: checked whatever the docs say, unless a documented one covers the same delete.
          const fromSchema = schemaRequirements(d, ctx.src).filter((r) => !documented.some((x) => x.template === "referential_integrity" && x.affectedAssets.some((a) => r.affectedAssets.includes(a))));
          out.behaviour.requirements = [...documented, ...fromSchema];
        }
        const provable = (r: TestRequirement) => canDefineOracle(r) && ["response", "state", "integrity"].includes(r.requiredProof);
        const urgent = (r: TestRequirement) => r.priority === "critical" || r.priority === "high";
        // Core templates are built by the engine; the AI only names their requests. Everything else is written freely.
        const core = out.behaviour.requirements.filter((r) => provable(r) && isCore(r.template));
        const free = out.behaviour.requirements.filter((r) => !core.includes(r));
        const [coreFirst, coreRest] = [core.filter(urgent), core.filter((r) => !urgent(r))];
        const [critical, rest] = [free.filter(urgent), free.filter((r) => !urgent(r))];
        const scenariosFor = (reqs: TestRequirement[]) => async () => {
          out.behaviour.proposals.push(...(await authorScenarios(session, d, ctx.src, reqs, ids, setupInfo)));
        };
        const fillsFor = (reqs: TestRequirement[]) => async () => {
          out.behaviour.fills.push(...(await Promise.all(reqs.map((r) => fillTemplate(session, d, ctx.src, r, ids)))));
        };
        await step("authoring", "Writing checks, most important first: critical requirements and browser journeys, then the rest");
        // In order, each tier after the one before: one step can no longer use up what a more important one needs.
        out.authoring = [...out.authoring, ...(await authorInOrder({ shareUsd: LEGACY_ENGINE ? Infinity : 0.3 * ep.budgetUsd, spent: () => session.stageSpent("authoring"), refused: () => session.refusedCalls("authoring") }, [
          [
            ...(coreFirst.length ? [{ name: `template checks for ${coreFirst.length} critical and high requirement(s)`, run: fillsFor(coreFirst) }] : []),
            ...(critical.length ? [{ name: `scenarios for ${critical.length} critical and high requirement(s)`, run: scenariosFor(critical) }] : []),
            ...(http && opts.browser && (boot.frontends.length || served?.screens.length)
              ? [
                  {
                    name: "browser journeys",
                    run: async () => {
                      out.journeys = await authorJourneys(session, d, ctx.src, identities, setup, PROFILES.deep.maxJourneys).catch((err: Error) => {
                        out.journeyError = err.message.slice(0, 200);
                        return null;
                      });
                    },
                  },
                ]
              : []),
          ],
          [...(coreRest.length ? [{ name: `template checks for ${coreRest.length} other requirement(s)`, run: fillsFor(coreRest) }] : []), ...(rest.length ? [{ name: `scenarios for ${rest.length} other requirement(s)`, run: scenariosFor(rest) }] : [])],
          http && ep.generatedTests
            ? [
                {
                  name: "request probes",
                  run: async () => {
                    out.authored = await authorProbes(session, d, ctx.src, gapsFirst(targets, [...out.behaviour.proposals, ...touchedRoutes(out.behaviour.fills)]), ids, (n, t) => onProgress(`Writing request scenarios (${n} of ${t})`), boot.apps.flatMap((a) => a.setup.map((x) => ({ id: x.id, requests: (x.steps ?? []).map((st) => `${st.method} ${st.path}${st.json !== undefined ? ` ${JSON.stringify(st.json).slice(0, 200)}` : ""}`), captures: [...x.exports, ...(x.steps ?? []).flatMap((st) => (st.capture ? [st.capture.name] : []))] }))));
                  },
                },
              ]
            : [],
          unitPlan.length && ep.generatedTests
            ? [
                {
                  name: "unit tests",
                  run: async () => {
                    out.units = await authorUnitTests(session, d, ctx.src, unitPlan);
                  },
                },
              ]
            : [],
        ]))];
        if (out.behaviour.requirements.length) await store.event("authoring", `Found ${out.behaviour.requirements.length} documented requirement(s) (${out.behaviour.requirements.filter((r) => r.source.kind !== "implementation").length} with a cited source) and wrote ${out.behaviour.proposals.length} behaviour scenario(s)`);
        if (http) await store.event("authoring", `Authored ${out.authored.scenarios.length} request scenario(s)${out.authored.dropped ? ` (dropped ${out.authored.dropped} without valid citations)` : ""}${out.journeys ? `, ${out.journeys.journeys.length} browser journey(s)${out.journeys.dropped.length ? ` (dropped ${out.journeys.dropped.length}: ${out.journeys.dropped.slice(0, 2).map((x) => x.reason).join("; ")})` : ""}` : ""}`);
      }
      return { boot, ...out };
    })();
    const tools: Tools = { node: nodeDirs.length > 0, browser: opts.browser, k6: opts.load.length > 0 && d.entryPoints.some((e) => e.kind === "http"), pg: ctx.services.includes("postgres") };
    const [prep, plannedAi] = await Promise.all([prepare(ctx, workspaces, snap.contentDigest, archive, tools), planning]);
    const units = plannedAi.units;
    // Authoring steps skipped or cut short are said every run, also when the plan is reused: their checks are missing.
    const authoringGaps = plannedAi.authoring.filter((s) => s.status !== "done");
    for (const s of authoringGaps) await store.event("authoring", `${s.status === "skipped" ? "Skipped" : "Cut short"}: ${s.name}, because ${s.reason}`);
    ctx.authoringGaps = authoringGaps.map((s) => `${s.status === "skipped" ? "Not written" : "Only partly written"}: ${s.name}, because ${s.reason}. The checks it would have added are missing from this run.`);
    if (!cached && deps.session && plannedAi.boot.source === "ai") {
      const costUsd = deps.session.usage.reduce((s, x) => s + x.costUsd, 0);
      await deps.objects.put(planKey, Readable.from([JSON.stringify({ boot: plannedAi.boot, authored: plannedAi.authored, units, journeys: plannedAi.journeys, behaviour: plannedAi.behaviour, authoring: plannedAi.authoring, costUsd, runId: run.id } satisfies CachedPlan)])).catch(() => undefined);
    }

    // Generated unit tests: one obligation per case; files that did not compile are testing-system problems, not product results.
    const generated: Generated[] = [];
    (ep.generatedTests ? units.files : []).forEach((f, n) => {
      const target = unitPlan.find((t) => t.path === f.target)!;
      const ext = /.m?ts$/.test(f.target) ? "ts" : "mjs";
      let g = generated.find((x) => x.workspace === target.workspace);
      if (!g) generated.push((g = { workspace: target.workspace, files: [] }));
      const obligationIds = f.cases.map((c, i) => {
        const id = `unit:${f.target}:${i + 1}`;
        add(obligation({ id, layer: "unit", asset: { kind: "function", ref: f.target, label: f.target }, objective: c.name, priority: c.priority, oracle: { source: "code_contract", expected: c.rule, evidence: c.evidence }, origin: "authored" }));
        return id;
      });
      g.files.push({ ...f, obligationIds, overlayPath: `${wsPath(target.workspace)}/.cybercheck-tests/gen-${n + 1}.test.${ext}` });
    });
    for (const { file, error } of units.rejected ?? []) {
      const ids = file.cases.map((c, i) => {
        const id = `unit:${file.target}:${i + 1}`;
        add(obligation({ id, layer: "unit", asset: { kind: "function", ref: file.target, label: file.target }, objective: c.name, priority: c.priority, oracle: { source: "code_contract", expected: c.rule, evidence: c.evidence }, origin: "authored", status: "inconclusive", reason: "cybercheck's generated test did not compile even after one repair, so it was never run." }));
        return id;
      });
      await addFinding(ctx, { kind: "test_defect", status: "confirmed", severity: "low", confidence: "high", title: `A unit test file cybercheck wrote for ${file.target} did not compile`, expected: "Generated tests compile before they are run", actual: error, reproduction: "Internal to cybercheck (the file is generated, not part of your project).", rootCause: "The test author produced invalid code; one automatic repair did not fix it.", location: null, obligationIds: ids, executionIds: [], validation: "Checked with a TypeScript/JavaScript parser before any sandbox time was spent.", limitation: null, layer: "unit", nextAction: "Rerun: cybercheck writes these tests again." });
    }
    if (units.files.length || units.dropped) await store.event("authoring", `Wrote ${units.files.reduce((n, f) => n + f.cases.length, 0)} unit test(s) for ${units.files.length} logic file(s)${units.dropped ? `; dropped ${units.dropped} without a valid citation` : ""}${units.rejected?.length ? `; ${units.rejected.length} file(s) did not compile` : ""}`);

    // ---------------- the fixture graph: setup, sign-in (verified) and records, validated before any sandbox cost
    const apps = plannedAi.boot.apps;
    const appDirs = apps.map((a) => a.workspace);
    const graphs = new Map<string, FixtureNode[]>();
    const graphProblems: Array<{ id: string; label: string; reason: string }> = [];
    for (const a of apps) {
      add(obligation({ id: `env:boot:${a.workspace}`, layer: "environment", asset: { kind: "workspace", ref: a.workspace, label: a.workspace === "." ? "project root" : a.workspace }, objective: `The app starts (${a.start}) and answers HTTP on port ${a.port}`, priority: "critical", oracle: { source: "declared_command", expected: "the port answers within the boot time limit", evidence: [] } }));
      const ids = new Set(a.identities.map((i) => i.name));
      const ownRecords = (plannedAi.authored.fixtures ?? []).filter((f) => {
        const ep = d.entryPoints.find((e) => f.steps.some((s) => s.method.toUpperCase() === e.method && s.path.split("?")[0] === e.path));
        return !ep || appFor(ep, appDirs) === a.workspace;
      });
      const learned = cached?.graphs?.[a.workspace];
      const raw = learned?.length ? learned : [...bootGraph(a, (applies) => verifyTarget(d, applies)), ...recordNodes(ownRecords, ids, fixtureSteps)];
      if (learned?.length) await store.event("planning", `Using the setup that worked after a repair in an earlier run of this code (${learned.length} step(s))`);
      const { nodes, problems } = validateGraph(raw, d, ctx.src);
      graphs.set(a.workspace, nodes);
      graphProblems.push(...problems);
    }
    let invalidSetup: TestFinding | null = null;
    if (graphProblems.length) {
      invalidSetup = await addFinding(ctx, { kind: "test_defect", status: "confirmed", severity: "low", confidence: "high", title: `${graphProblems.length} planned setup step(s) were invalid and not used`, expected: "Every setup step uses real endpoints, real settings and values an earlier step produces", actual: graphProblems.slice(0, 8).map((p) => `${p.label}: ${p.reason}`).join("\n"), reproduction: "Internal to cybercheck (checked before anything ran).", rootCause: "The setup planner proposed steps that do not match the code.", location: null, obligationIds: [], executionIds: [], validation: "Static validation of the fixture graph.", limitation: null, layer: "api", nextAction: "Checks that needed these steps are listed as blocked; rerun to plan them again." });
    }

    // Behaviour scenarios: compiled against the app that owns their action (one repair round), then obligations.
    // Templates follow the requirement's own words every run, also for requirements cached by an earlier run.
    ctx.requirements = plannedAi.behaviour.requirements.map((r) => { const t = templateFromWords(`${r.expectedBehavior} ${r.source.quote ?? ""}`) ?? r.template; return t ? { ...r, template: t } : r; });
    const behaviourJobs = new Map<string, ScenarioJob[]>();
    if (ep.generatedTests && plannedAi.behaviour.proposals.length) {
      const byApp = new Map<string, unknown[]>();
      for (const p of plannedAi.behaviour.proposals) {
        const action = ((p as { requests?: Array<{ role?: string; method?: string; path?: string }> }).requests ?? []).find((r) => r.role === "action");
        const e = action ? d.entryPoints.find((x) => routeKey(x.method, x.path) === routeKey(String(action.method), String(action.path))) : undefined;
        const app = (e && appFor(e, appDirs)) ?? apps[0]?.workspace;
        if (app) byApp.set(app, [...(byApp.get(app) ?? []), p]);
      }
      const refused: Array<{ id: string; problems: string[] }> = [];
      let compiled = 0;
      for (const [app, proposals] of byApp) {
        const b = await compileBehaviour(deps.session, proposals, ctx.requirements, d, graphs.get(app) ?? [], Object.keys(appEnv(ctx, apps.find((a) => a.workspace === app)!)));
        const { obligations: obs, jobs } = behaviourObligations(b, d);
        for (const ob of obs) add(ob);
        behaviourJobs.set(app, jobs);
        refused.push(...b.refused);
        compiled += b.scenarios.length;
      }
      await store.event("authoring", `${compiled} behaviour scenario(s) compiled${refused.length ? `; ${refused.length} refused by the compiler (${refused.slice(0, 2).map((r) => `${r.id}: ${r.problems[0]}`).join("; ")})` : ""}`);
      if (refused.length) await addFinding(ctx, { kind: "test_defect", status: "confirmed", severity: "low", confidence: "high", title: `${refused.length} behaviour scenario(s) cybercheck wrote did not compile and were not sent`, expected: "Every scenario uses real endpoints and setup values, discriminating values, and enough assertions to prove its requirement", actual: refused.slice(0, 8).map((r) => `${r.id}: ${r.problems.slice(0, 2).join("; ")}`).join("\n"), reproduction: "Internal to cybercheck (checked before anything ran).", rootCause: "The scenario author proposed scenarios the compiler refused, and one repair round did not fix them.", location: null, obligationIds: [], executionIds: [], validation: "Static compilation of each scenario against the project.", limitation: null, layer: "api", nextAction: "Rerun the checks without a verdict; cybercheck writes these scenarios again." });
    }

    // Core templates: the engine builds each scenario from the requests the AI named, compiled like any other (no
    // repair: a template that does not compile is a gap to fix in cybercheck). A requirement whose template could not
    // be built still gets its check, inconclusive with the reason, so it never drops out of the count.
    const fills = ep.generatedTests ? (plannedAi.behaviour.fills ?? []) : [];
    if (fills.length) {
      const tpl = templateScenarios(fills, ctx.requirements, slotContext(d, ctx.src, apps.flatMap((a) => a.identities.map((i) => i.name))));
      const unfilled = [...tpl.unfilled];
      const byApp = new Map<string, unknown[]>();
      for (const { proposal } of tpl.proposals) {
        const action = (proposal.requests as Array<{ role: string; method: string; path: string }>).find((r) => r.role === "action")!;
        const e = d.entryPoints.find((x) => routeKey(x.method, x.path) === routeKey(action.method, action.path));
        const app = (e && appFor(e, appDirs)) ?? apps[0]?.workspace;
        if (app) byApp.set(app, [...(byApp.get(app) ?? []), proposal]);
      }
      let built = 0;
      for (const [app, proposals] of byApp) {
        const b = await compileBehaviour(null, proposals, ctx.requirements, d, graphs.get(app) ?? [], Object.keys(appEnv(ctx, apps.find((a) => a.workspace === app)!)));
        const { obligations: obs, jobs } = behaviourObligations(b, d);
        for (const ob of obs) add(ob);
        behaviourJobs.set(app, [...(behaviourJobs.get(app) ?? []), ...jobs]);
        built += b.scenarios.length;
        for (const r of b.refused) unfilled.push({ requirementId: r.id.replace(/^tpl:/, ""), reason: `the built scenario did not compile (${r.problems.slice(0, 2).join("; ")})` });
      }
      for (const u of unfilled) {
        const r = ctx.requirements.find((x) => x.id === u.requirementId);
        if (!r) continue;
        const [m, p] = (r.affectedAssets[0] ?? "").split(/\s+/);
        const e = m && p ? d.entryPoints.find((x) => routeKey(x.method, x.path) === routeKey(m, p)) : undefined;
        add(obligation({ id: `req:${r.id}:template`, layer: r.requiredProof === "integrity" ? "data" : "api", asset: { kind: "endpoint", ref: e?.id ?? r.affectedAssets[0] ?? r.id, label: r.affectedAssets[0] ?? r.capability }, objective: r.expectedBehavior, priority: r.priority, oracle: { source: ORACLE[r.source.kind], expected: r.expectedBehavior, evidence: r.source.path && r.source.line ? [{ path: r.source.path, line: r.source.line }] : [] }, origin: "authored", status: "inconclusive", blockedBy: "prerequisite", reason: `cybercheck could not build its ${r.template?.replace(/_/g, " ")} check: ${u.reason}. This is cybercheck's gap, not a result about your app.`, requirementIds: [r.id], capability: r.capability }));
      }
      await store.event("authoring", `${built} template check(s) built by the engine${unfilled.length ? `; ${unfilled.length} could not be built (${unfilled.slice(0, 2).map((u) => `${u.requirementId}: ${u.reason.slice(0, 140)}`).join("; ")})` : ""}`);
    }

    // Authored request scenarios and browser journeys become obligations.
    const authoredEvidence = new Map<string, string>();
    const authoredProbes: Probe[] = [];
    (ep.generatedTests ? plannedAi.authored.scenarios : []).forEach((s, i) => {
      const ep = d.entryPoints.find((e) => `${e.method} ${e.path}` === s.endpoint.trim())!;
      const app = appFor(ep, appDirs);
      if (!app) return;
      const id = `api:${s.endpoint}:authored:${i + 1}`;
      add(obligation({ id, layer: "api", asset: { kind: "endpoint", ref: ep.id, label: s.endpoint }, objective: s.title, priority: s.priority, oracle: { source: "code_contract", expected: s.oracle, evidence: s.evidence }, origin: "authored" }));
      authoredEvidence.set(id, `${s.oracle} (cited: ${s.evidence.map((e) => `${e.path}:${e.line}`).join(", ")})`);
      const probe = scenarioToProbe(s, i + 1, app, id);
      // Unless the scenario deliberately checks rejection (it expects 401/403), send the app's credentials:
      // the analysis may have missed a guard, and a request stopped at the door tests nothing.
      const expectsRejection =
        probe.steps.some((st) => st.expect.status?.some((c) => c === 401 || c === 403)) ||
        (/unauth|without (a |any )?(session|token|credential|login|key|auth)|not (signed|logged) in|no (session|token|credentials)|anonymous/i.test(s.title) && probe.steps.some((st) => st.expect.statusClass?.includes("4xx")));
      const bootApp = apps.find((a) => a.workspace === app);
      if (!probe.identity && !expectsRejection && ep.control.kind !== "public_intentional") probe.identity = identityFor(bootApp, ep.control.kind, ep.path);
      authoredProbes.push(probe);
    });
    // Backend-served pages: the first app is the "frontend", already running, with nothing to build.
    const frontend: FrontendApp | undefined = plannedAi.boot.frontends[0] ?? (served?.screens.length && apps[0] ? { workspace: apps[0].workspace, build: [], start: apps[0].start, port: apps[0].port, readyPath: "/", config: [], served: true } : undefined);
    const journeys: BrowserJourney[] = [];
    if (opts.browser && frontend && plannedAi.journeys) {
      plannedAi.journeys.journeys.slice(0, prof.maxJourneys).forEach((j, i) => {
        const id = `ui:journey:${i + 1}`;
        const first = j.steps.find((s) => s.action === "goto")?.path ?? "/";
        add(obligation({ id, layer: "ui", asset: { kind: "screen", ref: first, label: j.title }, objective: j.title, priority: j.priority, oracle: { source: "code_contract", expected: j.oracle, evidence: j.evidence }, origin: "authored", proofClass: "journey", oracleStrength: "strong" }));
        journeys.push({ ...j, id: `journey-${i + 1}`, obligationId: id });
      });
    }
    // No journey at all is disclosed, never silent: the journeys gate fails, and this says why and whose it is.
    if (opts.browser && frontend && !journeys.length) {
      const dropped = plannedAi.journeys?.dropped.length ?? 0;
      const why = plannedAi.journeyError ? `writing them failed (${plannedAi.journeyError})` : dropped ? `all ${dropped} it wrote referred to screens, labels or results not found in the code and were dropped` : "none was written for these screens";
      add(obligation({ id: "ui:journeys", layer: "ui", asset: { kind: "screen", ref: "/", label: "user journeys" }, objective: "The main user flows work end to end in a browser", priority: "high", oracle: { source: "policy", expected: "at least one main flow per role completes", evidence: [] }, origin: "authored", status: "blocked", blockedBy: "prerequisite", reason: `No browser journey ran: ${why}. This is cybercheck's gap, not a result about your app.` }));
    }
    // Screens without a frontend that can be built and served cannot be opened.
    if (opts.browser && !frontend) {
      for (const o of ctx.obligations.values()) if ((o.layer === "ui" || o.layer === "accessibility") && o.status === "planned") Object.assign(o, { status: "unsupported", blockedBy: "capability", reason: "No way to build and serve the frontend was found, so screens were not opened." });
    }
    for (const o of ctx.obligations.values()) {
      if (o.layer !== "api" || o.status !== "planned") continue;
      const e = d.entryPoints.find((x) => x.id === o.asset.ref);
      if (e && !appFor(e, appDirs)) Object.assign(o, { status: "blocked", blockedBy: "prerequisite", reason: apps.length ? "Its app was not started (only the planned HTTP apps are probed)." : "No way to start an HTTP server was found for this project." });
    }
    if (!apps.length) {
      for (const o of ctx.obligations.values()) if (["data", "performance", "reliability", "ui", "accessibility"].includes(o.layer) && o.status === "planned") Object.assign(o, { status: "blocked", blockedBy: "prerequisite", reason: "No way to start the app was found, so nothing that needs it could run." });
    }
    // A targeted rerun carries every result outside its scope over from the parent run and executes only the rest.
    const rerun = policy.success ? policy.data.rerun : undefined;
    if (rerun) {
      const carried = await carryOver(ctx, rerun.parentRunId, new Set(rerun.obligationIds));
      await store.event("planning", `Targeted rerun of ${rerun.obligationIds.length} check(s); ${carried} result(s) carried over from run ${rerun.parentRunId.slice(0, 8)}`);
    }
    await store.setPlan({ engine: ENGINE_VERSION, planKey, profile, thresholds, rerun: rerun ? { parentRunId: rerun.parentRunId, obligations: rerun.obligationIds.length } : null, policy: { ...POLICY, ...prof }, workspaces: workspaces.map((w) => ({ dir: w.dir, ecosystem: w.ecosystem, install: w.install?.command ?? null, steps: w.steps.map((s) => s.command), suites: w.suites.map((s) => s.command), start: w.start })), boot: plannedAi.boot, graphs: Object.fromEntries(graphs), journeys: journeys.map((j) => ({ id: j.id, title: j.title, identity: j.identity })), planSource: planInfo });
    await store.putObligations([...ctx.obligations.values()]);

    if (!prep.image) throw new Error("No sandbox image was prepared.");
    const image = prep.image;
    // Work that needs a workspace whose install failed is blocked, not attempted.
    const blockedWs = new Set([...prep.installOk].filter(([, ok]) => !ok).map(([dir]) => dir));
    const dependsOnFailed = (dir: string) => [...blockedWs].some((b) => b === "." || b === dir || dir.startsWith(`${b}/`));
    for (const o of ctx.obligations.values()) {
      const ws = o.asset.kind === "workspace" || o.asset.kind === "suite" ? (o.id.split(":").slice(2).join(":") || o.asset.ref) : null;
      if (o.status === "planned" && ws != null && dependsOnFailed(ws) && !o.id.startsWith("env:install")) Object.assign(o, { status: "blocked", blockedBy: "prerequisite", reason: "Dependencies failed to install for this workspace." });
    }
    if (!prep.tools.browser && opts.browser) for (const o of ctx.obligations.values()) if ((o.layer === "ui" || o.layer === "accessibility") && o.status === "planned") Object.assign(o, { status: "blocked", blockedBy: "environment", reason: "The test browser could not be installed in the sandbox." });
    if (!prep.tools.k6 && opts.load.length) for (const o of ctx.obligations.values()) if ((o.layer === "performance" || o.id === "reliability:recovery-after-load") && o.status === "planned") Object.assign(o, { status: "blocked", blockedBy: "environment", reason: "The load generator could not be installed in the sandbox." });
    await store.putObligations([...ctx.obligations.values()]);

    // ---------------- waves 2 to 5, each as soon as its prerequisites hold
    await step("executing", "Running build checks, the project's tests and the HTTP checks in parallel sandboxes; browser, database and load checks follow once the app starts");
    const tasks: Promise<unknown>[] = [];
    for (const w of workspaces) {
      if (dependsOnFailed(w.dir)) continue;
      tasks.push(runSteps(ctx, image, w));
      for (const s of w.suites) {
        if (!pending(ctx, `suite:passes:${s.workspace}`) && !pending(ctx, `suite:runs:${s.workspace}`)) continue;
        tasks.push(
          runSuite(ctx, image, s).then(async ({ runs }) => {
            // A test that failed in every run gets more runs before it is called a consistent failure.
            if (consistentFailures(runs).length) {
              await ctx.store.event("executing", `Some tests failed in all ${runs.length} run(s); running the suite ${POLICY.confirmRuns} more times to separate real failures from flaky ones`);
              runs = runs.concat((await runSuite(ctx, image, s, POLICY.confirmRuns, runs.length)).runs);
            }
            return judgeSuite(ctx, s, runs, candidates);
          }),
        );
      }
    }
    for (const all of generated) {
      const g = { ...all, files: all.files.filter((f) => f.obligationIds.some((id) => pending(ctx, id))) };
      if (!g.files.length) continue;
      if (dependsOnFailed(g.workspace)) {
        for (const f of g.files) for (const id of f.obligationIds) await setOb(ctx, id, { status: "blocked", blockedBy: "prerequisite", reason: "Dependencies failed to install." });
        continue;
      }
      tasks.push(judgeGenerated(ctx, image, g, candidates));
    }
    // The frontend build (network on) starts right away; the browser waits for it and for the backend's setup.
    const browserPlanned = Boolean(opts.browser && frontend && prep.tools.browser && !dependsOnFailed(frontend.workspace) && apps.length > 0);
    const frontendBuild = browserPlanned && frontend ? (frontend.served ? Promise.resolve({ image: image as string | null, exec: null, reason: null }) : buildFrontend(ctx, image, { frontend, apps, graph: [], logins: [], journeys: [] })) : null;
    const appDependent = (o: Obligation) => ["data", "performance", "ui", "accessibility"].includes(o.layer) || o.id === "reliability:recovery-after-load";
    apps.forEach((app, appIndex) => {
      const unsupported = app.needsServices.filter((n) => !/sqlite|none|^$/i.test(n) && !ctx.services.some((s) => n.toLowerCase().includes(s === "postgres" ? "postg" : s)));
      const graph = graphs.get(app.workspace) ?? [];
      if (dependsOnFailed(app.workspace) || unsupported.length) {
        const reason = unsupported.length ? `The app needs ${unsupported.join(", ")}, which the sandbox does not provide yet.` : "Dependencies failed to install.";
        const by = unsupported.length ? ("environment" as const) : ("prerequisite" as const);
        tasks.push((async () => {
          await setOb(ctx, `env:boot:${app.workspace}`, { status: "blocked", blockedBy: by, reason });
          for (const o of [...ctx.obligations.values()]) {
            if (o.status !== "planned") continue;
            const e = o.layer === "api" ? d.entryPoints.find((x) => x.id === o.asset.ref) : null;
            if ((e && appFor(e, appDirs) === app.workspace) || (appIndex === 0 && (appDependent(o) || o.id === "reliability:graceful-shutdown"))) await setOb(ctx, o.id, { status: "blocked", blockedBy: by, reason });
          }
        })());
        return;
      }
      const probes = [
        ...buildProbes(d, [...ctx.obligations.values()], (e) => (appFor(e, appDirs) === app.workspace ? app.workspace : null), (e) => identityFor(app, e.control.kind, e.path), (path) => withRecord(path, graph), (e) => /uuid|isUUID|format:\s*["']uuid/i.test(ctx.src.files.get(e.handler.path)?.text ?? ""), (e) => wrongRoleIdentity(app, e.path)),
        ...authoredProbes.filter((p) => p.app === app.workspace && pending(ctx, p.obligationId)),
        // Malformed ids last of all (after the authored scenarios too): one may stop the app.
      ].sort((a, b) => Number(a.obligationId.endsWith(":invalid-id")) - Number(b.obligationId.endsWith(":invalid-id")));
      // A malformed id on a write must reach the id handling, not stop at body validation: send a body an authored
      // scenario for the same endpoint used successfully (one with no values captured at run time).
      for (const p of probes.filter((x) => x.obligationId.endsWith(":invalid-id") && x.steps[0]?.json !== undefined)) {
        const ref = ctx.obligations.get(p.obligationId)?.asset.ref;
        const good = authoredProbes
          .filter((a) => ctx.obligations.get(a.obligationId)?.asset.ref === ref)
          .flatMap((a) => a.steps)
          .find((st) => st.method === p.steps[0]!.method && st.json && typeof st.json === "object" && !/\{\{/.test(JSON.stringify(st.json)) && (st.expect.statusClass?.includes("2xx") || st.expect.status?.every((c) => c < 300)));
        if (good) p.steps[0]!.json = structuredClone(good.json);
      }
      // In a targeted rerun the app is started only when something in scope needs it.
      const needed = pending(ctx, `env:boot:${app.workspace}`) || probes.length > 0 || (appIndex === 0 && [...ctx.obligations.values()].some((o) => o.status === "planned" && (appDependent(o) || o.layer === "reliability")));
      if (!needed) return;
      // Probes for protected endpoints with no way to sign in can't test the handler; nor can ones whose sign-in was invalid.
      const runnable: Probe[] = [];
      const allowedSetting = settingSources(d, ctx.src, graph);
      const unusable: Array<{ id: string; why: string }> = [];
      const pre: Array<Promise<unknown>> = [];
      for (const p of probes) {
        const ob = ctx.obligations.get(p.obligationId)!;
        if (p.optionalIdentity && p.identity && !graph.some((n) => n.id === p.identity)) p.identity = null;
        const e = d.entryPoints.find((x) => x.id === ob.asset.ref);
        // A scenario written to be refused without credentials (every step expects 401/403/4xx) needs no sign-in.
        const meantAnonymous = ob.origin === "authored" && !p.identity && p.steps.every((st) => !st.as && (st.expect.status?.every((c) => c === 401 || c === 403) || (st.expect.statusClass?.length && st.expect.statusClass.every((c) => c === "4xx"))));
        const needsAuth = e && ["session_required", "role_required", "service_token", "handler_check"].includes(e.control.kind) && ob.id.split(":").at(-1) !== "unauthenticated" && !meantAnonymous && !isAuthEntry(e);
        if (needsAuth && !p.identity && ob.id.endsWith(":wrong-role")) pre.push(setOb(ctx, p.obligationId, { status: "blocked", blockedBy: "fixture", reachedTarget: false, reason: `Needs a second account with fewer rights than "${identityFor(app, "role_required", e!.path) ?? "the signed-in role"}"; the setup did not create one.` }));
        else if (needsAuth && !p.identity) pre.push(setOb(ctx, p.obligationId, { status: "blocked", blockedBy: "fixture", reachedTarget: false, reason: `No way to sign in was found for "${e!.control.kind.replace(/_/g, " ")}" endpoints, so only the unauthenticated check ran.` }));
        else if (p.identity && !graph.some((n) => n.id === p.identity)) pre.push(setOb(ctx, p.obligationId, { status: "blocked", blockedBy: "fixture", reachedTarget: false, reason: `The sign-in "${p.identity}" was invalid and not used (see the testing-system problems).`, fixtureRefs: [p.identity] }));
        else {
          // A value no setup step and no earlier step of the scenario produces can never be filled in: not sent, no sandbox time spent.
          const made = new Set(graph.flatMap(produces));
          // "Authorization: Bearer {{admin_token}}" with nothing producing admin_token means: run as the admin sign-in.
          if (ob.origin === "authored") {
            const known = new Set([...made, ...p.steps.flatMap((st) => (st.capture ? [st.capture.name] : []))]);
            bindCredentialPlaceholders(p.steps, graph, known);
            // {{orderId}} where the setup captured order_id: the same value under another spelling.
            p.steps = aliasPlaceholders(p.steps, known);
          }
          const own = new Set<string>();
          let missing: string | null = null;
          for (const st of p.steps) {
            const used = [...JSON.stringify([st.path, st.json ?? null, st.headers ?? null]).matchAll(/\{\{(\$?\w+)\}\}/g)].map((m) => m[1]!).find((v) => v !== "$uid" && !own.has(v) && !made.has(v));
            if (used) {
              missing = used;
              break;
            }
            if (st.capture) own.add(st.capture.name);
          }
          const badActor = p.steps.find((st) => st.as && !graph.some((n) => n.id === st.as))?.as;
          // A setting nothing defines (ALICE_PASSWORD) would be sent as literal text: refused before the sandbox.
          const invented = inventedSettings(p.steps.map((st) => [st.path, st.json ?? null, st.form ?? null, st.headers ?? null, st.raw ?? null]), allowedSetting)[0];
          if (ob.origin === "authored" && (missing || badActor || invented)) {
            const why = missing ? `uses {{${missing}}}, which neither the setup nor an earlier step produces` : badActor ? `acts as "${badActor}", which is not a working sign-in` : `uses the setting ${invented}, which the code, its tests and its seed scripts never define (an invented value)`;
            unusable.push({ id: p.obligationId, why });
            pre.push(setOb(ctx, p.obligationId, { status: "inconclusive", reachedTarget: false, reason: `cybercheck's scenario ${why}; it was not sent.` }));
          } else runnable.push(p);
        }
      }
      if (unusable.length) {
        pre.push(addFinding(ctx, { kind: "test_defect", status: "confirmed", severity: "low", confidence: "high", title: `${unusable.length} request scenario(s) cybercheck wrote could not be built and were not sent`, expected: "Every value a scenario uses is produced by the setup or an earlier step", actual: unusable.slice(0, 6).map((u) => `${u.id}: ${u.why}`).join("\n"), reproduction: "Internal to cybercheck (checked before anything ran).", rootCause: "The scenario author referred to values that nothing creates.", location: null, obligationIds: unusable.map((u) => u.id), executionIds: [], validation: "Static check of the scenario against the setup graph.", limitation: null, layer: "api", nextAction: "Rerun the checks without a verdict; cybercheck writes these scenarios again." }));
      }
      tasks.push(
        Promise.all(pre)
          .then(() => judgeProbes(ctx, image, app, graph, runnable, candidates, authoredEvidence, (behaviourJobs.get(app.workspace) ?? []).filter((j) => Object.values(j.obligations).some((id) => ctx.obligations.get(id)?.status === "planned"))))
          .then(async (r) => {
            latencies = latencies.concat(r.latencies);
            if (appIndex !== 0) return;
            fixtures = r.fixtures;
            // Learned setup: a repair is kept for the next run of this exact code only once it is verified, i.e. every
            // repaired step worked in the sandbox. Steps that failed (and the ones depending on them) are not kept.
            const verified = verifiedGraph(r.graph, r.fixtures.nodes);
            if (deps.session && verified && r.graph !== (graphs.get(app.workspace) ?? [])) {
              const current: CachedPlan | null = (await deps.objects.exists(planKey)) ? JSON.parse((await buffer(deps.objects.get(planKey))).toString("utf8")) : null;
              if (current) await deps.objects.put(planKey, Readable.from([JSON.stringify({ ...current, graphs: { ...(current.graphs ?? {}), [app.workspace]: verified } } satisfies CachedPlan)])).catch(() => undefined);
            }
            if (ctx.obligations.get(`env:boot:${app.workspace}`)?.status !== "passed") {
              for (const o of [...ctx.obligations.values()]) if (appDependent(o) && o.status === "planned") await setOb(ctx, o.id, { status: "blocked", blockedBy: "prerequisite", reason: "Not run: the app did not start." });
              return;
            }
            // Database and load only once the app is proven to start; load only after the functional checks.
            const after: Array<Promise<unknown>> = [];
            if (opts.database) after.push(dbStrategy === "api_level" ? judgeInMemoryDatabase(ctx) : judgeDatabase(ctx, image, app));
            if (opts.load.length && prep.tools.k6) after.push(judgeLoad(ctx, image, app, r.graph, appDirs, opts.load as LoadStageName[]).then((l) => (load = l)));
            if (frontendBuild && frontend) {
              after.push(
                frontendBuild.then(async (fb) => {
                  if (!fb.image) {
                    for (const o of [...ctx.obligations.values()]) if ((o.layer === "ui" || o.layer === "accessibility") && o.status === "planned") await setOb(ctx, o.id, { status: "blocked", blockedBy: "prerequisite", reason: `The frontend could not be built for the browser: ${fb.reason?.slice(0, 300)}`, executionIds: fb.exec ? [fb.exec.id] : [] });
                    return;
                  }
                  const plan: BrowserPlan = { frontend, apps, graph: r.graph, logins: plannedAi.journeys?.logins ?? [], journeys };
                  await judgeBrowser(ctx, fb.image, plan, candidates);
                }),
              );
            }
            await Promise.all(after);
          }),
      );
    });
    await Promise.all(tasks);
    // The invalid setup steps are linked to the checks they kept from running, with a severity that matches.
    if (invalidSetup) {
      const bad = new Set(graphProblems.map((p) => p.id));
      const lost = [...ctx.obligations.values()].filter((o) => !isDecisive(o) && ((o.fixtureRefs ?? []).some((r) => bad.has(r)) || [...bad].some((b) => (o.reason ?? "").includes(`"${b}"`))));
      if (lost.length) {
        invalidSetup.obligationIds = lost.map((o) => o.id);
        invalidSetup.severity = lost.length >= 15 ? "high" : lost.length >= 5 ? "medium" : "low";
        invalidSetup.title = `${invalidSetup.title} (${lost.length} check(s) could not run)`;
        await ctx.store.putFinding(invalidSetup);
        for (const o of lost) await setOb(ctx, o.id, { findingIds: [invalidSetup.id] });
      }
    }
    fixtures = withInvalidSetup(fixtures as FixtureSummary | null, graphProblems, [...ctx.obligations.values()]);
  }

  // ---------------- triage, merging and contradiction checks
  if (candidates.length) {
    await step("triage", `Explaining ${candidates.length} failure group(s) and reviewing them independently`);
    await settle(ctx, candidates);
    await mergeDuplicates(ctx);
  }
  await reconcile(ctx);

  // ---------------- wave 6: audit, release policy and report (deterministic; no model decides)
  await step("auditing", "Checking every obligation has a disposition and every claim has evidence");
  for (const o of ctx.obligations.values()) {
    if (o.status === "planned" || o.status === "running") Object.assign(o, { status: "skipped", reason: o.reason ?? "Not reached in this run." });
  }
  await store.putObligations([...ctx.obligations.values()]);
  // Checks the time limit kept from starting: reported as skipped, with that reason, never silently missing.
  if (deadline && Date.now() > deadline) {
    for (const o of ctx.obligations.values()) if (o.status === "planned") await setOb(ctx, o.id, { status: "skipped", reason: `The run reached its sandbox time limit (${ep.maxSandboxMinutes} min) before this check could start.` });
  }
  // Tenant isolation cybercheck cannot check itself is credited to the project's own tests when they cover it and
  // passed in every clean run (named for isolation between tenants), and cited as the evidence.
  for (const o of ctx.obligations.values()) {
    if (!o.id.startsWith("api:tenancy:") || o.status !== "unsupported") continue;
    const tenant = o.id.split(":")[2]!.replace(/_?id$/i, "");
    const covering = ctx.suiteSummaries.flatMap((s) => s.cases.filter((c) => c.status === "passed" && new RegExp(`isolat|cross.?${tenant}|${tenant}.?a.*${tenant}.?b|other.?${tenant}|tenant`, "i").test(`${c.file ?? ""} ${c.name}`)).map((c) => `${c.file ? `${c.file}: ` : ""}${c.name}`));
    const suiteRuns = [...ctx.obligations.values()].filter((x) => x.id.startsWith("suite:passes:") && x.status === "passed").flatMap((x) => x.executionIds);
    if (covering.length && suiteRuns.length) await setOb(ctx, o.id, { status: "passed", proofClass: "business_behavior", oracleStrength: "moderate", reachedTarget: true, executionIds: suiteRuns, reason: `Not checked by cybercheck, but covered by your own test(s), which passed in every clean run: ${covering.slice(0, 3).join("; ")}.` });
  }
  const built: TestingReport = buildReport({ d, obligations: [...ctx.obligations.values()], executions: ctx.executions, findings: ctx.findings, latencies, providerName: deps.provider.name, image: POLICY.image, suiteRuns: prof.suiteRuns, profile, thresholds, targetCompleteness: ep.targetCompleteness, load, fixtures, suiteSummaries: ctx.suiteSummaries, extraLimitations: [...(ctx.authoringGaps ?? []), ...ctx.services.map((s) => SERVICE_NOTES[s])], engine: ENGINE_VERSION });
  // Behaviour-first sections: requirements and sources, what was discovered versus executed, proof strength, targets.
  const report: TestingReport = { ...built, ...behaviourSections({ d, obligations: [...ctx.obligations.values()], requirements: ctx.requirements, screensFound: ctx.screensFound, databaseStrategy: ctx.databaseStrategy }) };
  const usage = usageOf(ctx, planInfo);
  const status = report.assessment === "could_not_test" ? "partial" : "completed";
  clearInterval(usageTimer);
  await store.finish(status, { report, usage });
  onProgress("Done");
  return { status, report };
}

type PlanInfo = { source: "generated" | "cache" | "none"; runId: string | null; savedUsd: number };

/**
 * Copies the parent run's results for every obligation outside the rerun's scope (with their findings),
 * marked as carried over: their evidence stays in the parent run. Returns how many were carried.
 */
async function carryOver(ctx: Ctx, parentRunId: string, scope: Set<string>) {
  const [parentObs, parentFindings] = await Promise.all([db.select().from(testObligation).where(eq(testObligation.runId, parentRunId)), db.select().from(testFinding).where(eq(testFinding.runId, parentRunId))]);
  const carried = new Set<string>();
  for (const row of parentObs) {
    const p = row.data as Obligation;
    const o = ctx.obligations.get(p.id);
    if (!o || scope.has(p.id)) continue;
    Object.assign(o, { status: p.status, reason: p.reason, executionIds: p.executionIds, findingIds: [], reachedTarget: p.reachedTarget ?? null, stateVerified: p.stateVerified ?? false, proofClass: p.proofClass ?? o.proofClass, oracleStrength: p.oracleStrength ?? o.oracleStrength, blockedBy: p.blockedBy ?? null, fixtureRefs: p.fixtureRefs ?? [], carriedFrom: parentRunId });
    carried.add(p.id);
  }
  for (const row of parentFindings) {
    const f = row.data as TestFinding;
    if (!f.obligationIds.length || !f.obligationIds.every((id) => carried.has(id))) continue;
    const copy: TestFinding = { ...f, kind: FindingKind.parse(f.kind), carriedFrom: parentRunId };
    ctx.findings.push(copy);
    await ctx.store.putFinding(copy);
    for (const id of f.obligationIds) ctx.obligations.get(id)!.findingIds.push(f.id);
  }
  await ctx.store.putObligations([...ctx.obligations.values()]);
  return carried.size;
}

/** True when an obligation still has to run in this run (not carried over, not already decided). */
/** Still to run, and the run's time limit not reached (after it, nothing new starts). */
export const pending = (ctx: Ctx, id: string) => ctx.obligations.get(id)?.status === "planned" && !(ctx.deadline && Date.now() > ctx.deadline);

/** AI spend grouped by stage, from the purpose of each call. */
/** The budget share a call draws on: planning, setup repair and requirements; authoring; triage with its review; reconciliation. */
export function budgetGroup(purpose: string) {
  const s = stageOf(purpose);
  return s === "planning" || s === "fixtures" || s === "requirements" ? "planning" : s === "critic" ? "triage" : s;
}

export function stageOf(purpose: string) {
  if (/boot plan/.test(purpose)) return "planning";
  if (/requirements/.test(purpose)) return "requirements";
  if (/fixture/.test(purpose)) return "fixtures";
  if (/probe scenarios|template slots|unit test|journeys/.test(purpose)) return "authoring";
  if (/contradiction/.test(purpose)) return "reconcile";
  if (/review/.test(purpose)) return "critic";
  return "triage";
}

function usageOf(ctx: Ctx, plan: PlanInfo = { source: ctx.session ? "generated" : "none", runId: null, savedUsd: 0 }) {
  const u = ctx.session?.usage ?? [];
  const byStage: Record<string, { calls: number; inputTokens: number; outputTokens: number; costUsd: number }> = {};
  for (const x of u) {
    const s = (byStage[stageOf(x.purpose)] ??= { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    s.calls++;
    s.inputTokens += x.inputTokens;
    s.outputTokens += x.outputTokens;
    s.costUsd = Math.round((s.costUsd + x.costUsd) * 10000) / 10000;
  }
  return {
    aiCalls: u.length,
    inputTokens: u.reduce((s, x) => s + x.inputTokens, 0),
    outputTokens: u.reduce((s, x) => s + x.outputTokens, 0),
    costUsd: Math.round(u.reduce((s, x) => s + x.costUsd, 0) * 10000) / 10000,
    sandboxOperations: ctx.sandboxOps,
    sandboxCpuSeconds: Math.round(ctx.sandboxCpu),
    models: Object.fromEntries(Object.entries(ctx.session?.opts.models ?? {})),
    planSource: plan.source,
    planSourceRunId: plan.runId,
    byStage,
    savedByCacheUsd: Math.round(plan.savedUsd * 10000) / 10000,
  };
}

async function finishBlocked(ctx: Ctx, reason: string) {
  await ctx.store.event("admission", reason);
  await ctx.store.finish("blocked", { error: reason, usage: usageOf(ctx) });
  return { status: "blocked" as const, report: null };
}

export type { EntryPoint };
