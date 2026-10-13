import type { LoadThresholds, Measure, Obligation, ObligationStatus, ProjectDossier, TestExecution, TestFinding, TestingProfile, TestingReport, TestLayer } from "@cybercheck/contracts";
import { ObligationStatus as Statuses } from "@cybercheck/contracts";
import { OFFLINE } from "./agents.ts";
import { DECISION_LABEL, assessment, completeness as completenessOf, evidenceFactor, isApplicable, isDecisive, productHealth as healthOf, releaseDecision, testedFactor, testsForCapability, weightOf } from "./assurance.ts";
import { isAuthEntry } from "./plan.ts";

/**
 * The Testing report is built by code from the ledger, never written by a model, so every number
 * traces back to obligations and executions. The headline is rendered from the release decision and
 * atomic claims, and the audit at the end checks the report against the ledger.
 */

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Shortens at a word boundary, never mid-word. */
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, s.lastIndexOf(" ", n) > n / 2 ? s.lastIndexOf(" ", n) : n).replace(/[,;:\s]+$/, "")}...`);

/** The root cause of a check without a verdict, worded once per cause so the list groups by cause, not by instance. */
export function causeOf(o: Obligation, general = true): string {
  const r = o.reason ?? "no reason recorded";
  if (/^The check itself was wrong/.test(r)) return "cybercheck wrote a wrong expectation for this check (see testing-system problems)";
  if (/rate limiter answered 429/.test(r)) return "the app's rate limiter refused cybercheck's test traffic (429)";
  if (o.blockedBy === "approval" && /confirm whether/.test(r)) return "a lower role was let into an admin-style route whose code allows any signed-in user: is that intended?";
  if (o.blockedBy === "fixture" || /cybercheck's own setup step|Could not create the data this check needs|setup failed/.test(r)) return "cybercheck could not set up the sign-in or test data it needs (see testing-system problems)";
  if (/^cybercheck's scenario/.test(r)) return "a scenario cybercheck wrote could not be built, so it was not sent";
  if (/Postgres stand-in/.test(r)) return "the app stopped on cybercheck's local Postgres stand-in during the load";
  if (o.layer === "performance" && /no threshold/i.test(r)) return "measured only: no load threshold was set";
  if (/sent the browser to/.test(r)) return "the screen sent the browser elsewhere, so it was not shown";
  // Otherwise the reason's first sentence, with ids and numbers generalised so instances of one cause group together.
  const first = r.split(/(?<=[.;])\s/)[0]!.replace(/\bF\d+\b/g, "a finding");
  return clip((general ? first.replace(/\b\d+\b/g, "N") : first).replace(/[;:,\s]+$/, ""), 160);
}
const STEP_NAME: Record<string, string> = { install: "Install", build: "Build", typecheck: "Typecheck", lint: "Lint", boot: "Start" };
const LAYER_NAME: Record<TestLayer, string> = {
  environment: "Install, build and start",
  existing_suite: "The project's own tests",
  api: "API",
  unit: "Generated unit tests",
  data: "Database",
  job: "Background jobs",
  integration: "External integrations",
  ui: "Screens and journeys",
  accessibility: "Accessibility",
  performance: "Load and capacity",
  reliability: "Reliability",
  deployment: "Deployment",
};
/** Proof classes that only count when the code under test was really reached. */
const BEHAVIOUR = new Set(["business_behavior", "state_change", "journey"]);
/** Findings from deterministic tools are confirmed by one clean run (a compiler or axe gives the same answer twice). */
const DETERMINISTIC: Array<TestLayer | undefined> = ["environment", "accessibility", "data"];

type Claim = NonNullable<TestingReport["claims"]>[number];
export type FixtureSummary = NonNullable<TestingReport["fixtures"]>;

export function buildReport(input: {
  d: ProjectDossier;
  obligations: Obligation[];
  executions: TestExecution[];
  findings: TestFinding[];
  latencies: number[];
  providerName: string;
  image: string;
  suiteRuns: number;
  profile?: TestingProfile;
  thresholds?: LoadThresholds | null;
  /** The completeness the user aimed for (the profile default when not chosen). */
  targetCompleteness?: number;
  load?: TestingReport["load"];
  fixtures?: FixtureSummary | null;
  /** Extra limitations, e.g. how local services were provided. */
  extraLimitations?: string[];
  suiteSummaries: Array<{ workspace: string; framework: string; command: string; tests: { total: number; passed: number; failed: number; skipped: number }; cases: TestingReport["suites"][number]["cases"] }>;
}): TestingReport {
  const { obligations: obs, executions, findings } = input;
  const totals = Object.fromEntries(Statuses.options.map((s) => [s, 0])) as Record<ObligationStatus, number>;
  for (const o of obs) totals[o.status]++;

  const confirmed = findings.filter((f) => f.kind === "product_defect" && f.status === "confirmed");
  const suspected = findings.filter((f) => f.kind === "product_defect" && f.status === "suspected");
  const problems = findings.filter((f) => ["suite_integrity", "flaky", "configuration_gap", "tool_failure"].includes(f.kind) && f.status !== "rejected");
  const applicable = obs.filter(isApplicable);
  const decisive = obs.filter(isDecisive);
  const inconclusive = obs.filter((o) => o.status === "inconclusive");
  const notTested = obs.filter((o) => ["blocked", "unsupported", "skipped"].includes(o.status));

  // ---------------- measures, each with an explicit denominator
  const measure = (label: string, list: Obligation[], ok: (o: Obligation) => boolean, note: string | null = null): Measure => ({ label, numerator: list.filter(ok).length, denominator: list.length, note });
  const terminal = (o: Obligation) => o.status !== "planned" && o.status !== "running";
  const measures: Measure[] = [
    measure("Recorded result (of all planned checks)", obs, terminal, "Every planned check ends as passed, failed, flaky, blocked, unsupported, skipped, not applicable or inconclusive."),
    measure("Decisive verdict (of applicable checks)", applicable, isDecisive, "Passed, failed or flaky in a sandbox. Inconclusive, blocked and unsupported checks are not decisive."),
    measure("Passed (of decisive checks)", decisive, (o) => o.status === "passed"),
  ];
  const env = obs.filter((o) => o.layer === "environment");
  if (env.length) measures.push(measure("Install, build and start passed (of planned)", env, (o) => o.status === "passed"));
  const api = obs.filter((o) => o.layer === "api");
  if (api.length) measures.push(measure("API checks that reached their handler (of planned)", api, (o) => isDecisive(o) && o.reachedTarget !== false, `${new Set(api.map((o) => o.asset.ref)).size} endpoint(s). A 401 on a guard check counts as reaching the guard.`));
  const unit = obs.filter((o) => o.layer === "unit");
  if (unit.length) measures.push(measure("Generated unit tests with a verdict (of written)", unit, isDecisive, "Written by cybercheck for core logic and run outside your code. A failure counts only after review."));
  const suiteObs = obs.filter((o) => o.id.startsWith("suite:passes:"));
  const runsPerSuite = suiteObs.map((o) => executions.filter((e) => (e.kind === "suite" || e.kind === "suite_rerun") && e.workspace === o.id.slice("suite:passes:".length)).length);
  const runText = runsPerSuite.length && Math.min(...runsPerSuite) === Math.max(...runsPerSuite) ? `${runsPerSuite[0]}` : `${Math.min(...runsPerSuite)} to ${Math.max(...runsPerSuite)}`;
  if (suiteObs.length) measures.push(measure("Test suites passing consistently (of suites)", suiteObs, (o) => o.status === "passed", `Each suite ran ${runText} time(s) in separate clean sandboxes (more when a test kept failing).`));

  // ---------------- suites table
  const suites: TestingReport["suites"] = [];
  for (const o of suiteObs) {
    const ws = o.id.slice("suite:passes:".length);
    const runsOb = obs.find((x) => x.id === `suite:runs:${ws}`);
    const ex = executions.filter((e) => (e.kind === "suite" || e.kind === "suite_rerun") && e.workspace === ws);
    const verdict: TestingReport["suites"][number]["verdict"] =
      runsOb?.status === "blocked" || o.status === "blocked" ? "blocked" : ex.some((e) => e.timedOut) ? "timed_out" : runsOb?.status === "failed" && /0 tests/.test(runsOb.reason ?? "") ? "zero_tests" : o.status === "passed" ? "passed" : o.status === "flaky" ? "flaky" : o.status === "failed" ? "failed" : ex.length ? "failed" : "not_run";
    const sum = input.suiteSummaries.find((s) => s.workspace === ws);
    suites.push({ workspace: ws, framework: sum?.framework ?? o.asset.label.split(" ")[0] ?? "test", command: sum?.command ?? ex[0]?.command.replace(/^mkdir -p \S+ && cd \S+ && /, "") ?? "", verdict, tests: sum?.tests ?? { total: 0, passed: 0, failed: 0, skipped: 0 }, cases: sum?.cases ?? [], executionIds: ex.map((e) => e.id) });
  }

  // ---------------- untested scope grouped by reason
  const groups = new Map<string, string[]>();
  const noOwnTests = obs.filter((o) => o.id.startsWith("suite:runs:") && o.status === "not_applicable");
  for (const o of noOwnTests) groups.set(`No tests of its own (${o.asset.label.replace(/^Tests in /, "")}): ${o.reason ?? "no test suite is declared"}`, [o.id]);
  for (const o of inconclusive) {
    const key = `Ran without a verdict: ${causeOf(o)}`;
    groups.set(key, [...(groups.get(key) ?? []), o.id]);
  }
  for (const o of notTested) {
    const key = `${o.status === "unsupported" ? "Not supported yet" : o.status === "blocked" ? "Blocked" : "Skipped"}: ${causeOf(o)}`;
    groups.set(key, [...(groups.get(key) ?? []), o.id]);
  }
  // Who can close each gap: cybercheck (its own setup, sign-in or tests), you (configuration, environment), or not supported yet.
  const ownerOf = (ids: string[]): "cybercheck" | "you" | "not_supported" => {
    const o = obs.find((x) => x.id === ids[0]);
    if (!o) return "cybercheck";
    if (o.status === "unsupported" || o.blockedBy === "capability") return "not_supported";
    // cybercheck's own stand-ins and traffic are cybercheck's to fix, even when they look like the environment.
    if (/stand-in|rate limiter answered 429/i.test(o.reason ?? "")) return "cybercheck";
    // A missing threshold or a project without tests of its own is yours to add.
    if (o.id.startsWith("suite:runs:") || (o.layer === "performance" && /no threshold/i.test(o.reason ?? ""))) return "you";
    if (o.blockedBy === "environment" || o.blockedBy === "approval" || /not configured|configuration|asked a question|internet|third-party|credentials for third/i.test(o.reason ?? "")) return "you";
    return "cybercheck";
  };
  // A cause seen once is shown with its own numbers ("3 tables"), not the generalised "N tables".
  const shown = (reason: string, ids: string[]) => {
    const o = ids.length === 1 ? obs.find((x) => x.id === ids[0]) : undefined;
    return o ? reason.replace(causeOf(o), causeOf(o, false)) : reason;
  };
  const untested = [...groups].map(([reason, ids]) => ({ reason: shown(reason, ids), obligations: ids.slice(0, 50), count: ids.length, owner: ownerOf(ids) })).sort((a, b) => b.count - a.count);

  // ---------------- single-user probe latency (diagnostic only, never a load result)
  const sorted = [...input.latencies].sort((a, b) => a - b);
  const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : null);
  const performance = sorted.length ? { requests: sorted.length, p50Ms: pct(50), p95Ms: pct(95), note: "Single-user functional-probe latency (diagnostic only): one request at a time during the checks, not a load test." } : null;

  // ---------------- the three answers
  const completeness = completenessOf(obs, input.targetCompleteness ?? undefined);
  const productHealth = healthOf(obs);
  const claims = buildClaims(obs, findings, suites);
  const layers = buildLayers(obs);
  const capabilities = buildCapabilities(obs, input.suiteSummaries.flatMap((s) => s.cases));
  const nextActions = buildNextActions(obs, findings);

  const syntheticEnv = [...new Set(executions.filter((e) => e.kind === "probe" || e.kind === "browser").flatMap((e) => e.envNames))].filter((n) => !["CI", "npm_config_update_notifier", "npm_config_fund", "PIP_DISABLE_PIP_VERSION_CHECK", "NODE_OPTIONS", "FORCE_COLOR", "NO_COLOR", "CC_PATH"].includes(n));
  const runtime = executions.find((e) => e.kind === "prepare" && /v\d+\.\d+/.test(e.outputTail))?.outputTail.match(/v\d+\.\d+\.\d+/)?.[0] ?? null;
  const limitations = [
    "No internet access while the project runs: third-party services are never contacted, and code that needs them is reported as blocked, not passed.",
    "Configuration and credentials are synthetic test values, never your real secrets.",
    "Passing checks show the behaviour that was exercised, not the absence of all defects.",
    "Checks written by AI are hypotheses; a failure only becomes a confirmed defect after it reproduces and an independent model agrees.",
  ];
  limitations.push(...(input.extraLimitations ?? []));
  if (obs.some((o) => o.layer === "ui" && o.status === "unsupported")) limitations.push("Screens were not opened in a browser in this run.");
  if (input.load?.stages.length) limitations.push("Load tests ran against the app inside one 4 vCPU sandbox, with the load generator on the same machine: numbers compare runs, they are not production capacity.");
  if (input.d.stack.languages.some((l) => /python/i.test(l.name))) limitations.push("Extra unit tests are only written for JavaScript and TypeScript code; Python code was tested through its own tests, its HTTP API and the browser.");
  const networkBuild = executions.some((e) => e.kind === "command" && e.network);

  const report: TestingReport = {
    headline: "",
    verdict: confirmed.length ? "defects_found" : !decisive.length ? "could_not_test" : problems.length ? "problems_found" : notTested.length || inconclusive.length ? "partial" : "no_defects_found",
    totals,
    measures,
    suites,
    untested,
    environment: { provider: input.providerName, image: input.image, runtime, cpus: 4, memoryMb: 4096, network: `on only while installing dependencies${networkBuild ? " and to confirm a build that needed the internet" : ""}; off for builds, tests, probes and browsers`, syntheticEnv },
    performance,
    limitations,
    audit: [],
    schemaVersion: 2,
    profile: input.profile ?? "standard",
    completeness,
    productHealth,
    claims,
    nextActions,
    layers,
    capabilities,
    fixtures: input.fixtures ?? null,
    load: input.load ?? null,
  };
  // The audit runs first without the release gates (they depend on it), then the decision and headline.
  const first = audit(report, obs, executions, findings);
  const release = releaseDecision({ obs, findings, completeness, auditOk: first.every((c) => c.ok), thresholdsSet: Boolean(input.thresholds && (input.thresholds.p95Ms || input.thresholds.errorRatePct != null)) });
  report.release = release;
  report.assessment = assessment(release.decision, obs, findings);
  report.headline = headlineOf(report, suspected.length);
  report.audit = audit(report, obs, executions, findings);
  return report;
}

function headlineOf(r: TestingReport, suspected: number) {
  const c = r.completeness!;
  const h = r.productHealth!;
  const label = DECISION_LABEL[r.release!.decision];
  const scope = `Testing completeness ${c.percent}%${c.criticalTotal ? ` (${c.criticalDecisive} of ${c.criticalTotal} critical checks decisive)` : ""}; product health ${h.percent == null ? "unknown (nothing decisive)" : `${h.percent}% of decisive scope`}.`;
  const problems = (r.claims ?? []).filter((x) => x.kind === "problem").map((x) => x.text);
  const proved = (r.claims ?? []).filter((x) => x.kind === "proved").map((x) => x.text);
  const facts = [...problems.slice(0, 2), ...proved.slice(0, problems.length ? 1 : 2)];
  if (suspected) facts.push(`${plural(suspected, "suspected defect")} to review`);
  return `${label}. ${scope}${facts.length ? ` ${facts.join("; ")}.` : ""}`;
}

// ---------------------------------------------------------------- claims (atomic, typed facts)

function buildClaims(obs: Obligation[], findings: TestFinding[], suites: TestingReport["suites"]): Claim[] {
  const claims: Claim[] = [];
  const add = (kind: Claim["kind"], text: string, list: Obligation[]) => list.length && claims.push({ id: `C${claims.length + 1}`, kind, text, obligationIds: list.map((o) => o.id) });
  const ws = (list: Obligation[]) => [...new Set(list.map((o) => o.asset.label))].join(", ");

  // Each install, build, typecheck, lint and start step is its own fact, grouped by outcome.
  for (const step of ["install", "build", "typecheck", "lint", "boot"]) {
    const list = obs.filter((o) => o.id.startsWith(`env:${step}:`));
    const name = STEP_NAME[step]!;
    const passed = list.filter((o) => o.status === "passed");
    const needsNet = passed.filter((o) => o.findingIds.some((id) => findings.find((f) => f.id === id)?.kind === "configuration_gap"));
    add("proved", `${name} passed (${ws(passed)})${needsNet.length ? `, the build only with internet access` : ""}`, passed);
    add("problem", `${name} failed (${ws(list.filter((o) => o.status === "failed"))})`, list.filter((o) => o.status === "failed"));
    add("not_proved", `${name} gave no verdict (${ws(list.filter((o) => ["blocked", "inconclusive", "skipped"].includes(o.status)))})`, list.filter((o) => ["blocked", "inconclusive", "skipped"].includes(o.status)));
  }
  for (const s of suites) {
    const ob = obs.filter((o) => o.id === `suite:passes:${s.workspace}`);
    if (s.verdict === "passed") add("proved", `${plural(s.tests.total, "existing test")} passed in every clean run (${s.workspace === "." ? "project root" : s.workspace})`, ob);
    else if (s.verdict === "failed" || s.verdict === "flaky") add("problem", `The project's own tests ${s.verdict === "flaky" ? "are flaky" : "fail"} (${s.workspace === "." ? "project root" : s.workspace})`, ob.filter((o) => o.status === "failed" || o.status === "flaky"));
  }
  const passedBy = (cls: string) => obs.filter((o) => o.status === "passed" && o.proofClass === cls);
  const api = (list: Obligation[]) => list.filter((o) => o.layer === "api");
  add("proved", `${plural(api(passedBy("guard")).length, "guard check")} rejected requests without valid credentials`, api(passedBy("guard")));
  add("proved", `${plural(api(passedBy("validation")).length, "validation check")} rejected invalid input without a crash`, api(passedBy("validation")));
  // Behaviour claims say how much was really checked: a result read back or inspected, a status code only, or a
  // generated unit test of a helper function (which proves the function, not the route).
  const behaviour = obs.filter((o) => o.status === "passed" && (o.proofClass === "business_behavior" || o.proofClass === "state_change") && o.layer !== "existing_suite");
  const units = behaviour.filter((o) => o.layer === "unit");
  const checked = behaviour.filter((o) => o.layer !== "unit" && o.oracleStrength === "strong");
  const accepted = behaviour.filter((o) => o.layer !== "unit" && o.oracleStrength !== "strong");
  add("proved", `${plural(checked.length, "business behaviour")} verified with the result checked${checked.some((o) => o.stateVerified) ? ` (${checked.filter((o) => o.stateVerified).length} with the stored state read back)` : ""}`, checked);
  if (accepted.length) add("proved", `${plural(accepted.length, "more request")} accepted with the expected status code (the result was not read back)`, accepted);
  if (units.length) add("proved", `${plural(units.length, "generated unit test")} of helper functions passed`, units);
  const unreached = obs.filter((o) => o.layer === "api" && o.status !== "passed" && (o.reachedTarget === false || o.blockedBy === "fixture"));
  add("not_proved", `${plural(unreached.length, "API check")} could not reach the handler (sign-in or data setup did not work)`, unreached);
  const journeys = obs.filter((o) => o.proofClass === "journey");
  add("proved", `${plural(journeys.filter((o) => o.status === "passed").length, "user journey")} completed in a real browser`, journeys.filter((o) => o.status === "passed"));
  add("problem", `${plural(journeys.filter((o) => o.status === "failed").length, "user journey")} failed in a real browser`, journeys.filter((o) => o.status === "failed"));
  const screens = obs.filter((o) => o.layer === "ui" && o.proofClass !== "journey");
  add("proved", `${plural(screens.filter((o) => o.status === "passed").length, "screen check")} passed without errors`, screens.filter((o) => o.status === "passed"));
  const data = obs.filter((o) => o.layer === "data");
  add("proved", `${plural(data.filter((o) => o.status === "passed").length, "database check")} passed (constraints enforced, records stored and read back)`, data.filter((o) => o.status === "passed"));
  add("problem", `${plural(data.filter((o) => o.status === "failed").length, "database check")} failed`, data.filter((o) => o.status === "failed"));
  for (const layer of ["ui", "accessibility", "data", "job", "integration", "performance"] as const) {
    const list = obs.filter((o) => o.layer === layer && (o.status === "unsupported" || o.status === "blocked"));
    if (list.length && !obs.some((o) => o.layer === layer && isDecisive(o))) add("not_proved", `${LAYER_NAME[layer]}: not tested (${list[0]!.status === "unsupported" ? "not supported yet" : "blocked"})`, list);
  }
  const defects = findings.filter((f) => f.kind === "product_defect" && f.status === "confirmed");
  if (defects.length) add("problem", `${plural(defects.length, "confirmed product defect")}`, obs.filter((o) => defects.some((f) => f.obligationIds.includes(o.id)) && (o.status === "failed" || o.status === "flaky" || o.status === "passed" || o.status === "inconclusive")));
  return claims;
}

// ---------------------------------------------------------------- layer matrix and capabilities

function buildLayers(obs: Obligation[]): NonNullable<TestingReport["layers"]> {
  const order: TestLayer[] = ["environment", "existing_suite", "unit", "api", "data", "ui", "accessibility", "job", "integration", "performance", "reliability", "deployment"];
  const out: NonNullable<TestingReport["layers"]> = [];
  for (const layer of order) {
    const list = obs.filter((o) => o.layer === layer && isApplicable(o));
    if (!list.length) continue;
    const n = (s: string) => list.filter((o) => o.status === s).length;
    const weight = list.reduce((s, o) => s + weightOf(o), 0);
    const earned = list.reduce((s, o) => s + weightOf(o) * testedFactor(o) * evidenceFactor(o), 0);
    const pct = weight ? Math.round((earned / weight) * 1000) / 10 : null;
    const open = list.filter((o) => !isDecisive(o));
    const reasons = new Map<string, number>();
    for (const o of open) {
      const r = o.reason ? causeOf(o) : o.status;
      reasons.set(r, (reasons.get(r) ?? 0) + 1);
    }
    const top = [...reasons].sort((a, b) => b[1] - a[1])[0];
    // From the main root cause, worded like the top-level next actions: a rerun is offered only where it can help.
    const cause = top?.[0] ?? "";
    const nextAction = !open.length
      ? null
      : open.every((o) => o.status === "unsupported")
        ? "Not supported by cybercheck yet"
        : /wrong expectation/.test(cause)
          ? "cybercheck wrote wrong expectations here; they need rewriting, a plain rerun will not change them"
          : /no load threshold/.test(cause)
            ? "Set a load threshold when starting a run"
            : /stand-in/.test(cause)
              ? "cybercheck's local Postgres stand-in cannot carry this; not fixable by a rerun"
              : /could not set up|could not be built/.test(cause)
                ? "cybercheck's own setup or scenarios failed here: a rerun plans them again"
                : /sent the browser elsewhere/.test(cause)
                  ? "These screens need a session or real records cybercheck did not create"
                  : open.some((o) => o.blockedBy === "environment")
                    ? "Run with the service or network it needs"
                    : `See the main reason: ${cause}`;
    out.push({
      layer,
      planned: list.length,
      decisive: list.filter(isDecisive).length,
      passed: n("passed"),
      failed: n("failed"),
      flaky: n("flaky"),
      inconclusive: n("inconclusive"),
      blocked: n("blocked"),
      unsupported: n("unsupported"),
      completeness: pct,
      confidence: pct == null || pct === 0 ? "none" : pct >= 80 ? "strong" : pct >= 40 ? "partial" : "weak",
      gap: top ? `${top[1]} ${top[1] === 1 ? "check" : "checks"}: ${top[0]}` : null,
      nextAction,
    });
  }
  return out;
}

function buildCapabilities(obs: Obligation[], cases: Array<{ name: string; file: string | null }>): NonNullable<TestingReport["capabilities"]> {
  const by = new Map<string, Obligation[]>();
  for (const o of obs) if (o.capability) by.set(o.capability, [...(by.get(o.capability) ?? []), o]);
  return [...by]
    .map(([name, list]) => {
      const classes = [...new Set(list.filter((o) => o.status === "passed" && o.proofClass).map((o) => o.proofClass!))];
      const strong = classes.some((c) => BEHAVIOUR.has(c));
      const hasUi = list.some((o) => o.layer === "ui" && o.status === "passed");
      const missing = !strong ? "No successful business flow was proven (only guards, validation or availability)" : !hasUi && list.some((o) => o.layer === "ui") ? "No browser evidence" : null;
      return { name, obligations: list.length, decisive: list.filter(isDecisive).length, passed: list.filter((o) => o.status === "passed").length, failed: list.filter((o) => o.status === "failed").length, proofClasses: classes, existingTests: testsForCapability(name, cases), missing };
    })
    .sort((a, b) => b.obligations - a.obligations);
}

function buildNextActions(obs: Obligation[], findings: TestFinding[]): NonNullable<TestingReport["nextActions"]> {
  const out: NonNullable<TestingReport["nextActions"]> = [];
  const confirmed = findings.filter((f) => f.kind === "product_defect" && f.status === "confirmed");
  if (confirmed.length) out.push({ label: `Fix ${plural(confirmed.length, "confirmed defect")}, then rerun the affected checks`, kind: "fix", obligationIds: [...new Set(confirmed.flatMap((f) => f.obligationIds))].filter((id) => obs.find((o) => o.id === id)?.status === "failed") });
  for (const f of findings.filter((x) => x.kind === "configuration_gap" && x.status !== "rejected")) out.push({ label: f.nextAction ?? f.title, kind: "configure", obligationIds: f.obligationIds });
  const fixture = obs.filter((o) => o.blockedBy === "fixture" || (o.layer === "api" && o.reachedTarget === false && !isDecisive(o)));
  if (fixture.length) out.push({ label: `${plural(fixture.length, "check")} never reached the code because cybercheck's own setup of sign-in or test data failed: a rerun plans that setup again (nothing for you to do unless accounts can only be created outside the app's API)`, kind: "rerun", obligationIds: fixture.map((o) => o.id) });
  const suspected = findings.filter((f) => f.kind === "product_defect" && f.status === "suspected");
  if (suspected.length) out.push({ label: `Review ${plural(suspected.length, "suspected defect")}`, kind: "review", obligationIds: suspected.flatMap((f) => f.obligationIds) });
  const tool = findings.filter((f) => (f.kind === "tool_failure" || (f.kind === "test_defect" && f.status === "confirmed")) && f.status !== "rejected");
  if (tool.length) out.push({ label: `${plural(tool.length, "testing-system problem")}: rerun the affected checks after cybercheck repairs them`, kind: "rerun", obligationIds: tool.flatMap((f) => f.obligationIds) });
  // Grouped by cause: a rerun only helps where the cause can change on a second try.
  const rest = obs.filter((o) => o.status === "inconclusive" && !fixture.includes(o));
  const wrongOracle = rest.filter((o) => /^The check itself was wrong/.test(o.reason ?? ""));
  const noThreshold = rest.filter((o) => o.layer === "performance" && /no threshold/i.test(o.reason ?? ""));
  const policy = rest.filter((o) => o.blockedBy === "approval" && /confirm whether/.test(o.reason ?? ""));
  if (policy.length) out.push({ label: `Decide whether lower roles may use ${plural(policy.length, "admin-style route")} that their code opens to any signed-in user (the evidence lists them)`, kind: "review", obligationIds: policy.map((o) => o.id) });
  const standIn = rest.filter((o) => /stand-in/i.test(o.reason ?? ""));
  if (standIn.length) out.push({ label: `${plural(standIn.length, "load check")} could not be measured: cybercheck's local Postgres stand-in cannot carry this load (cybercheck's limitation; a rerun gives the same result)`, kind: "review", obligationIds: standIn.map((o) => o.id) });
  const retry = rest.filter((o) => !wrongOracle.includes(o) && !noThreshold.includes(o) && !standIn.includes(o) && !policy.includes(o));
  if (wrongOracle.length) out.push({ label: `${plural(wrongOracle.length, "check")} cybercheck wrote had a wrong expectation: they give no verdict and do not count against your code; cybercheck needs to rewrite them, so a plain rerun will not change them`, kind: "review", obligationIds: wrongOracle.map((o) => o.id) });
  if (noThreshold.length) out.push({ label: "Set a p95 latency or error-rate threshold when starting a run to turn the load measurements into pass or fail", kind: "configure", obligationIds: noThreshold.map((o) => o.id) });
  if (retry.length) out.push({ label: `Rerun ${plural(retry.length, "check")} without a verdict`, kind: "rerun", obligationIds: retry.map((o) => o.id) });
  // Each check under one action only (the first, most specific one), and a rerun never lists a check that already
  // has a verdict (for example one decided by the clean repeat).
  const byId = new Map(obs.map((o) => [o.id, o]));
  const taken = new Set<string>();
  return out
    .map((a) => {
      const ids = a.obligationIds.filter((id) => !taken.has(id) && (a.kind === "fix" || a.kind === "configure" || !isDecisive(byId.get(id) ?? ({ status: "inconclusive" } as Obligation))));
      ids.forEach((id) => taken.add(id));
      return { ...a, obligationIds: ids };
    })
    .filter((a) => a.obligationIds.length > 0 || a.kind === "configure");
}

// ---------------------------------------------------------------- the audit

/** Mechanical checks of the ledger and the report (the Coverage and Evidence Auditor). */
export function audit(report: TestingReport, obs: Obligation[], executions: TestExecution[], findings: TestFinding[]): TestingReport["audit"] {
  const execIds = new Set(executions.map((e) => e.id));
  const checks: TestingReport["audit"] = [];
  const add = (check: string, ok: boolean, detail: string) => checks.push({ check, ok, detail });
  const byId = new Map(obs.map((o) => [o.id, o]));
  const open = obs.filter((o) => o.status === "planned" || o.status === "running");
  add("Every obligation has a final status", open.length === 0, open.length ? `${open.length} still open` : `${obs.length} of ${obs.length}`);
  const noReason = obs.filter((o) => !["planned", "passed", "running"].includes(o.status) && !o.reason);
  add("Every non-passing status has a reason", noReason.length === 0, noReason.length ? noReason.slice(0, 5).map((o) => o.id).join(", ") : "all have reasons");
  const passNoExec = obs.filter((o) => o.status === "passed" && !o.carriedFrom && !o.executionIds.some((id) => execIds.has(id)));
  add("Every pass is backed by a sandbox execution", passNoExec.length === 0, passNoExec.length ? passNoExec.slice(0, 5).map((o) => o.id).join(", ") : "all passes cite an execution");
  const findNoExec = findings.filter((f) => f.status === "confirmed" && !f.carriedFrom && f.kind !== "test_defect" && !f.executionIds.some((id) => execIds.has(id)));
  add("Every confirmed finding has execution evidence", findNoExec.length === 0, findNoExec.length ? findNoExec.map((f) => f.id).join(", ") : "all confirmed findings cite executions");
  const confirmedNoRepro = findings.filter((f) => f.kind === "product_defect" && f.status === "confirmed" && f.executionIds.length < 2 && !f.carriedFrom && !DETERMINISTIC.includes(f.layer) && !/^(Deterministic|Measured)/.test(f.validation ?? ""));
  add("Confirmed runtime defects were reproduced", confirmedNoRepro.length === 0, confirmedNoRepro.length ? confirmedNoRepro.map((f) => f.id).join(", ") : "each was seen in at least two clean runs (compiler, database, accessibility and layout results are deterministic)");
  const badMeasure = report.measures.filter((m) => m.numerator > m.denominator || m.denominator < 0 || !/\(of [^)]+\)/.test(m.label));
  add("Every percentage has a labelled, valid denominator", badMeasure.length === 0, badMeasure.length ? badMeasure.map((m) => m.label).join(", ") : `${report.measures.length} measures`);
  const claimsAllPassed = /all (checks|tests) passed|everything passed/i.test(report.headline);
  const gaps = report.totals.blocked + report.totals.unsupported + report.totals.inconclusive + report.totals.skipped;
  add("Headline does not overstate", !(claimsAllPassed && gaps > 0), gaps ? `${gaps} obligation(s) not fully tested are disclosed` : "no gaps");
  // Each claim must agree with every obligation it cites; the headline is built only from claims.
  const wrong = (report.claims ?? []).filter((c) =>
    c.obligationIds.some((id) => {
      const o = byId.get(id);
      if (!o) return true;
      if (c.kind === "proved") return o.status !== "passed";
      if (c.kind === "not_proved") return o.status === "passed";
      return o.status === "passed" && !o.findingIds.length;
    }),
  );
  add("Every claim agrees with the checks it cites", wrong.length === 0, wrong.length ? wrong.map((c) => `"${c.text}"`).slice(0, 3).join("; ") : `${report.claims?.length ?? 0} claims`);
  if (report.release) add("The headline states the release decision", report.headline.startsWith(DECISION_LABEL[report.release.decision]), report.release.decision);
  const offlineDefects = findings.filter((f) => f.kind === "product_defect" && f.status === "confirmed" && OFFLINE.test(`${f.actual} ${f.rootCause ?? ""}`));
  add("No offline, configuration or tool failure reported as a product defect", offlineDefects.length === 0, offlineDefects.length ? offlineDefects.map((f) => f.id).join(", ") : "none");
  // Checked from what happened, not only from the flag: a non-guard pass whose last answer was 401/403 was
  // decided by the sign-in or role check, not by the code it claims to test.
  const lastStatus = (o: Obligation) => Number([...(o.reason ?? "").matchAll(/answered (\d{3})/g)].at(-1)?.[1] ?? 0);
  const unreachedPass = obs.filter((o) => o.status === "passed" && ((o.proofClass && BEHAVIOUR.has(o.proofClass) && o.reachedTarget === false) || (o.proofClass !== "guard" && [401, 403].includes(lastStatus(o)) && !/:(unauthenticated|wrong-role|public)$/.test(o.id) && !isAuthEntry({ method: o.asset.label.split(" ")[0] ?? "", path: o.asset.label.split(" ")[1] ?? "" }))));
  add("Behaviour passes reached the code they test", unreachedPass.length === 0, unreachedPass.length ? unreachedPass.slice(0, 5).map((o) => o.id).join(", ") : "none stopped at a guard or a made-up id");
  const placeholders = obs.filter((o) => o.status === "passed" && /\{\{\w+\}\}|\$\{ENV:/.test(o.reason ?? ""));
  add("No unresolved placeholder was sent", placeholders.length === 0, placeholders.length ? placeholders.slice(0, 5).map((o) => o.id).join(", ") : "every value was filled in before sending");
  const failedNodes = new Set((report.fixtures?.nodes ?? []).filter((n) => n.ok === false).map((n) => n.id));
  const badDeps = obs.filter((o) => isDecisive(o) && (o.fixtureRefs ?? []).some((r) => failedNodes.has(r)));
  add("Checks ran only after their test data was set up", badDeps.length === 0, badDeps.length ? badDeps.slice(0, 5).map((o) => o.id).join(", ") : failedNodes.size ? `${failedNodes.size} failed setup step(s); their dependent checks were not sent` : "all setup steps succeeded");
  const zeroAsPass = report.suites.filter((s) => s.verdict === "passed" && obs.find((o) => o.id === `suite:runs:${s.workspace}`)?.status !== "passed");
  add("No zero-test or unreadable suite shown as passed", zeroAsPass.length === 0, zeroAsPass.length ? zeroAsPass.map((s) => s.workspace).join(", ") : "none");
  return checks;
}
