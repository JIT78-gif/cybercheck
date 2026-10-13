import { z } from "zod";
import { Evidence } from "./dossier.ts";

// The Testing check. A run is bound to one immutable snapshot and the ready dossier for it.
// Facts from the dossier become a Test Obligation Graph (what should be tested); deterministic
// workers execute checks in an isolated sandbox; AI agents only author extra probes and tests,
// and explain failures. Nothing counts as passed unless a sandbox execution proves it.

// ---------------------------------------------------------------- Obligations

/** Which part of the system an obligation exercises. */
export const TestLayer = z.enum([
  "environment", // install, build, typecheck, lint, boot
  "existing_suite", // the project's own tests
  "api", // HTTP behaviour of endpoints
  "unit", // generated tests of functions and state machines
  "data", // schema, constraints, migrations
  "job", // background jobs and schedules
  "integration", // external services
  "ui", // screens and journeys
  "accessibility", // WCAG checks of rendered screens
  "performance", // load and capacity (Devast)
  "reliability", // restart, dependency failure, graceful shutdown
  "deployment", // image build, readiness, configuration
]);
export type TestLayer = z.infer<typeof TestLayer>;

/**
 * planned: not started · passed: a sandbox execution proved the expected behaviour
 * failed: the expected behaviour was reproducibly violated · flaky: identical runs disagreed
 * blocked: a required environment, credential, service or earlier step is missing
 * unsupported: cybercheck has no safe worker for this yet · skipped: deliberately not run (reason given)
 * not_applicable: the project has no such capability · inconclusive: ran, but the evidence cannot support a verdict
 */
export const ObligationStatus = z.enum(["planned", "running", "passed", "failed", "flaky", "blocked", "unsupported", "skipped", "not_applicable", "inconclusive"]);
export type ObligationStatus = z.infer<typeof ObligationStatus>;
export const TERMINAL_OBLIGATION = ["passed", "failed", "flaky", "blocked", "unsupported", "skipped", "not_applicable", "inconclusive"] as const;

/** Where the expected behaviour comes from. AI guesses are never an oracle on their own. */
export const OracleSource = z.enum([
  "existing_assertion", // the project's own test asserts it
  "code_contract", // a validation schema, guard or explicit status code in the code
  "http_semantics", // a server must not answer with 5xx; unknown routes answer 404
  "declared_command", // the project declares the command; exit code 0 is success
  "state_machine", // transitions defined in code
  "policy", // a cybercheck policy, e.g. a suite must run at least one test
  "user_requirement",
]);
export type OracleSource = z.infer<typeof OracleSource>;

/**
 * What kind of proof a check gives. A 401 from a guard proves the guard, not the feature behind it,
 * so proof classes are reported separately and weigh differently in Testing Completeness.
 */
export const ProofClass = z.enum([
  "static", // build, typecheck, lint
  "guard", // authentication or authorization rejects the request
  "validation", // invalid input is rejected without a crash
  "availability", // answers without a server error, nothing more
  "business_behavior", // the intended behaviour was reached and asserted
  "state_change", // a write was confirmed by a later read
  "journey", // an end-to-end user journey in a browser
  "accessibility", // automated WCAG rules on a rendered screen
  "data_integrity", // database constraints and transactions
  "reliability",
  "capacity", // load and throughput
]);
export type ProofClass = z.infer<typeof ProofClass>;

/** strong: grounded expectation, target reached, state verified · moderate · weak: no-crash or guard-only evidence */
export const OracleStrength = z.enum(["strong", "moderate", "weak"]);
export type OracleStrength = z.infer<typeof OracleStrength>;

/** Why a blocked check could not run: a failed fixture, a failed earlier step, a missing approval, or no worker. */
export const BlockedBy = z.enum(["fixture", "prerequisite", "approval", "capability", "environment"]);
export type BlockedBy = z.infer<typeof BlockedBy>;

export const RISK_WEIGHT = { critical: 8, high: 5, medium: 3, low: 1 } as const;

export const Obligation = z.object({
  /** Stable within the snapshot, e.g. "api:POST /transfers:malformed-body". */
  id: z.string(),
  layer: TestLayer,
  /** The dossier asset this obligation comes from. */
  asset: z.object({ kind: z.enum(["workspace", "suite", "endpoint", "module", "function", "state_machine", "entity", "job", "integration", "screen", "project"]), ref: z.string(), label: z.string() }),
  objective: z.string(),
  priority: z.enum(["critical", "high", "medium", "low"]),
  oracle: z.object({ source: OracleSource, expected: z.string(), evidence: z.array(Evidence) }),
  status: ObligationStatus,
  /** Why it has this status, in plain words. Required for every status except planned and passed. */
  reason: z.string().nullable(),
  /** Who planned it: rules from the dossier, or the authoring agent. */
  origin: z.enum(["dossier", "authored"]),
  executionIds: z.array(z.string()),
  findingIds: z.array(z.string()),
  // Assurance fields (engine v2; absent on older runs).
  riskWeight: z.number().optional(),
  proofClass: ProofClass.optional(),
  oracleStrength: OracleStrength.optional(),
  /** The request or test reached the code it targets (not stopped by a guard, validation or a made-up id). Null until run. */
  reachedTarget: z.boolean().nullable().optional(),
  /** A write was confirmed by reading the state back. */
  stateVerified: z.boolean().optional(),
  /** Obligations or fixtures that must succeed first. */
  dependsOn: z.array(z.string()).optional(),
  /** The product capability (user goal) it belongs to, e.g. "Orders". */
  capability: z.string().nullable().optional(),
  fixtureRefs: z.array(z.string()).optional(),
  blockedBy: BlockedBy.nullable().optional(),
  /** Set when a targeted rerun carried this result over from an earlier run. */
  carriedFrom: z.string().nullable().optional(),
});
export type Obligation = z.infer<typeof Obligation>;

// ---------------------------------------------------------------- Executions (supervisor evidence)

export const ExecutionKind = z.enum(["prepare", "command", "suite", "suite_rerun", "probe", "generated_tests", "fixture", "browser", "database", "load"]);

export const TestExecution = z.object({
  id: z.string(),
  kind: ExecutionKind,
  /** Short label, e.g. "Typecheck (.)" or "Vitest suite (.) rerun 1". */
  label: z.string(),
  workspace: z.string().nullable(),
  command: z.string(),
  network: z.boolean(),
  sandbox: z.object({ provider: z.string(), operationId: z.string().nullable(), imageId: z.string().nullable() }),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  /** From the sandbox platform, not from the project's output. */
  exitCode: z.number().nullable(),
  timedOut: z.boolean(),
  /** ok: exit 0 · failed: non-zero exit · timed_out · error: the sandbox could not run it */
  outcome: z.enum(["running", "ok", "failed", "timed_out", "error", "cancelled"]),
  /** Last lines of output (secrets redacted). Full logs are artifacts. */
  outputTail: z.string(),
  artifacts: z.array(z.object({ name: z.string(), key: z.string(), bytes: z.number(), sha256: z.string() })),
  envNames: z.array(z.string()),
  resources: z.object({ cpuSeconds: z.number().nullable(), maxRssKb: z.number().nullable() }),
  retryOf: z.string().nullable(),
});
export type TestExecution = z.infer<typeof TestExecution>;

/** One test case from a machine-readable report, or one probe step. */
export const TestCaseResult = z.object({
  name: z.string(),
  file: z.string().nullable(),
  status: z.enum(["passed", "failed", "skipped", "error"]),
  durationMs: z.number().nullable(),
  message: z.string().nullable(),
});
export type TestCaseResult = z.infer<typeof TestCaseResult>;

// ---------------------------------------------------------------- Findings

/**
 * Exactly one per finding:
 * product_defect: grounded expected behaviour was reproducibly violated (including build and type errors)
 * test_defect: a generated or existing test, fixture or oracle is wrong, not the product
 * tool_failure: a runner, parser, browser or cybercheck itself failed
 * environment_failure: the sandbox (no network, missing service, capacity) prevented evaluation
 * configuration_gap: the project lacks a non-interactive or required test configuration
 * flaky: identical controlled attempts disagree
 * suite_integrity: the project's test setup cannot be trusted (zero tests, hangs, focused tests)
 */
export const FINDING_KINDS = ["product_defect", "test_defect", "tool_failure", "environment_failure", "configuration_gap", "flaky", "suite_integrity"] as const;
const LEGACY_KIND: Record<string, string> = { build: "product_defect", environment: "environment_failure" };
/** Older runs stored "build" and "environment"; they are read as their v2 equivalents. */
export const FindingKind = z.preprocess((v) => (typeof v === "string" && LEGACY_KIND[v]) || v, z.enum(FINDING_KINDS));
export type FindingKind = (typeof FINDING_KINDS)[number];

export const TestFinding = z.object({
  id: z.string(),
  kind: FindingKind,
  /** confirmed: reproduced and passed review · suspected: needs a human look · rejected: dismissed with a reason */
  status: z.enum(["confirmed", "suspected", "rejected"]),
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  /** Strength of the evidence, not importance. */
  confidence: z.enum(["high", "medium", "low"]),
  title: z.string(),
  /** What the user sees: expected vs actual, in plain words. */
  expected: z.string(),
  actual: z.string(),
  /** How to reproduce: a command, a failing test name, or an HTTP request. */
  reproduction: z.string(),
  rootCause: z.string().nullable(),
  location: Evidence.nullable(),
  obligationIds: z.array(z.string()),
  executionIds: z.array(z.string()),
  /** How the verdict was reached, e.g. "failed twice in clean sandboxes; triage and critic agree". */
  validation: z.string(),
  /** What this test could not show, e.g. "external API replaced by an unreachable address". */
  limitation: z.string().nullable(),
  /** The layer the finding came from (engine v2), e.g. environment for a build error. */
  layer: TestLayer.optional(),
  /** The cheapest next step for the user, in one line. */
  nextAction: z.string().nullable().optional(),
  /** Set when a targeted rerun carried this finding over from an earlier run (its evidence lives there). */
  carriedFrom: z.string().nullable().optional(),
  /** One root cause seen through several workers (an API check and a browser screen): the evidence sources it groups. */
  groupedFrom: z.array(z.string()).optional(),
});
export type TestFinding = z.infer<typeof TestFinding>;

// ---------------------------------------------------------------- Run

export const TestingRunStatus = z.enum(["queued", "running", "completed", "partial", "blocked", "failed", "cancelled"]);
export type TestingRunStatus = z.infer<typeof TestingRunStatus>;

export const TestingPhase = z.enum(["admission", "planning", "preparing", "executing", "authoring", "triage", "auditing", "done"]);
export type TestingPhase = z.infer<typeof TestingPhase>;

/** fast: one run, fewer checks · standard: the release check · deep: more repeats, viewports and load stages. */
export const TestingProfile = z.enum(["fast", "standard", "deep"]);
export type TestingProfile = z.infer<typeof TestingProfile>;

export const LoadThresholds = z.object({ p95Ms: z.number().positive().max(600_000).optional(), errorRatePct: z.number().min(0).max(100).optional() });
export type LoadThresholds = z.infer<typeof LoadThresholds>;

/** The completeness each profile aims for by default: a planning and stop target, never a guarantee. */
export const PROFILE_TARGET: Record<z.infer<typeof TestingProfile>, number> = { fast: 50, standard: 70, deep: 90 };

/** What the user chose before a run. Every field has a profile default; none is required. */
export const RunOptions = z.object({
  /** Risk-weighted completeness to aim for (%). Defaults: Fast 50, Standard 70, Deep 90. */
  targetCompleteness: z.number().int().min(10).max(100).optional(),
  /** Most AI money this run may spend (USD); capped by the server's own limit. */
  budgetUsd: z.number().positive().max(50).optional(),
  /** Most sandbox time (minutes); after it no new sandbox step starts and the rest is reported as skipped. */
  maxSandboxMinutes: z.number().int().min(2).max(120).optional(),
  /** Open the screens in a real browser (render, phone width, accessibility, journeys). */
  browser: z.boolean().optional(),
  /** Load stages beyond a one-user smoke test (average, and stress and spike on Deep). */
  load: z.boolean().optional(),
  /** Exactly which load stages to run after the smoke test; overrides the profile's choice when load is on. */
  loadStages: z.array(z.enum(["average", "stress", "spike", "breakpoint"])).max(4).optional(),
  /** Let AI write supplemental unit tests and request scenarios. */
  generatedTests: z.boolean().optional(),
  /** Whether a reviewer may accept the risk of a confirmed high or critical problem (ready with accepted risk). */
  allowAcceptedRisk: z.boolean().optional(),
});
export type RunOptions = z.infer<typeof RunOptions>;

export const TestingPolicyInput = z
  .object({
    profile: TestingProfile.default("standard"),
    thresholds: LoadThresholds.optional(),
    /** A targeted rerun: carry decisive results over from the parent run and execute only these obligations. */
    rerun: z.object({ parentRunId: z.string(), obligationIds: z.array(z.string()).max(2000) }).optional(),
  })
  .merge(RunOptions);
export type TestingPolicyInput = z.infer<typeof TestingPolicyInput>;

/** Body of POST /v1/snapshots/:id/checks/testing (all optional). force: run even when an identical finished run exists. */
export const StartTestingInput = z.object({ profile: TestingProfile.optional(), thresholds: LoadThresholds.optional(), force: z.boolean().optional() }).merge(RunOptions);
export type StartTestingInput = z.infer<typeof StartTestingInput>;

/** Body of POST /v1/testing-runs/:runId/targeted-runs: rerun these checks, or the checks behind these findings. */
export const TargetedRunInput = z.union([z.object({ obligationIds: z.array(z.string()).min(1).max(2000) }), z.object({ findingIds: z.array(z.string()).min(1).max(500) })]);
export type TargetedRunInput = z.infer<typeof TargetedRunInput>;

/** Body of POST /v1/testing-runs/:runId/rerun. missing: every check without a decisive verdict. */
export const RerunTestingInput = z.object({ scope: z.union([z.literal("missing"), z.array(z.string()).min(1).max(2000)]) });
export type RerunTestingInput = z.infer<typeof RerunTestingInput>;

/** Is the project ready to release? Separate from the workflow status (the run finished) and from product health. */
export const ReleaseDecision = z.enum(["ready", "ready_with_accepted_risk", "not_ready_product_failures", "not_ready_insufficient_evidence", "not_ready_environment_blocked"]);
export type ReleaseDecision = z.infer<typeof ReleaseDecision>;

export const AssessmentVerdict = z.enum(["ready_with_evidence", "defects_found", "testing_system_problem", "insufficient_evidence", "could_not_test"]);
export type AssessmentVerdict = z.infer<typeof AssessmentVerdict>;

export const Confidence = z.enum(["strong", "partial", "weak", "none"]);

export const LoadPoint = z.object({ t: z.number(), rps: z.number(), p50Ms: z.number().nullable(), p95Ms: z.number().nullable(), errorRatePct: z.number(), vus: z.number().nullable() });
export type LoadPoint = z.infer<typeof LoadPoint>;

export const LoadStage = z.object({
  name: z.string(),
  vus: z.number(),
  durationSec: z.number(),
  requests: z.number(),
  rps: z.number(),
  errorRatePct: z.number(),
  p50Ms: z.number().nullable(),
  p95Ms: z.number().nullable(),
  maxMs: z.number().nullable(),
  /** measured: no threshold was set, so this is a measurement, not a verdict. invalid: the app stopped during the stage, so its numbers measure nothing. */
  verdict: z.enum(["passed", "failed", "measured", "invalid"]),
  /** Second by second: requests per second, latency, server errors and active virtual users (at most 300 points). */
  series: z.array(LoadPoint).max(300).optional(),
  /** Breakpoint stage: the highest request rate the app handled while still healthy (errors under 5%, p95 under 2 s). */
  limitRps: z.number().nullable().optional(),
  /** Breakpoint stage: what gave way first. generator: the load generator itself reached its limit before the app did. */
  brokeBy: z.enum(["errors", "latency", "crash", "generator"]).nullable().optional(),
  /** File name of k6's own HTML report of this stage, an artifact of the load execution. */
  reportName: z.string().nullable().optional(),
});
export type LoadStage = z.infer<typeof LoadStage>;

export const Measure = z.object({ label: z.string(), numerator: z.number(), denominator: z.number(), note: z.string().nullable() });
export type Measure = z.infer<typeof Measure>;

export const TestingReport = z.object({
  /** Never says "everything passed" when anything is blocked, unsupported or inconclusive. */
  headline: z.string(),
  /** problems_found: no product defect, but the build, the test suite or a test is broken or flaky. */
  verdict: z.enum(["defects_found", "problems_found", "no_defects_found", "could_not_test", "partial"]),
  totals: z.record(ObligationStatus, z.number()),
  measures: z.array(Measure),
  suites: z.array(
    z.object({
      workspace: z.string(),
      framework: z.string(),
      command: z.string(),
      verdict: z.enum(["passed", "failed", "flaky", "zero_tests", "timed_out", "blocked", "not_run"]),
      tests: z.object({ total: z.number(), passed: z.number(), failed: z.number(), skipped: z.number() }),
      cases: z.array(TestCaseResult),
      executionIds: z.array(z.string()),
    }),
  ),
  /** Untested scope, grouped by reason. */
  /** Who can close each gap: cybercheck (its own setup or tests), you (configuration, environment, approval), or nobody yet (not supported). */
  untested: z.array(z.object({ reason: z.string(), obligations: z.array(z.string()), count: z.number(), owner: z.enum(["cybercheck", "you", "not_supported"]).optional() })),
  environment: z.object({
    provider: z.string(),
    image: z.string(),
    runtime: z.string().nullable(),
    cpus: z.number().nullable(),
    memoryMb: z.number().nullable(),
    network: z.string(),
    syntheticEnv: z.array(z.string()),
  }),
  performance: z.object({ requests: z.number(), p50Ms: z.number().nullable(), p95Ms: z.number().nullable(), note: z.string() }).nullable(),
  limitations: z.array(z.string()),
  /** Mechanical checks of the report itself (every percentage has a denominator, evidence exists, ...). */
  audit: z.array(z.object({ check: z.string(), ok: z.boolean(), detail: z.string() })),

  // Engine v2: three separate answers (testing completeness, product health, release decision) and the evidence behind them.
  schemaVersion: z.number().optional(),
  profile: TestingProfile.optional(),
  assessment: AssessmentVerdict.optional(),
  release: z
    .object({
      decision: ReleaseDecision,
      /** Each gate of the release policy. ok null: does not apply to this project or profile. */
      gates: z.array(z.object({ id: z.string(), label: z.string(), ok: z.boolean().nullable(), detail: z.string() })),
      reasons: z.array(z.string()),
    })
    .optional(),
  completeness: z
    .object({
      /** Risk-weighted share of applicable obligations with decisive, strong evidence (0 to 100). */
      percent: z.number(),
      earnedWeight: z.number(),
      applicableWeight: z.number(),
      criticalDecisive: z.number(),
      criticalTotal: z.number(),
      threshold: z.number(),
    })
    .optional(),
  productHealth: z
    .object({
      /** Passed risk weight over decisive (passed, failed, flaky) risk weight; null when nothing was decisive. */
      percent: z.number().nullable(),
      passedWeight: z.number(),
      decisiveWeight: z.number(),
      excluded: z.object({ inconclusive: z.number(), blocked: z.number(), unsupported: z.number(), skipped: z.number() }),
    })
    .optional(),
  /** Atomic facts the headline is built from; each cites the obligations it summarises. */
  claims: z.array(z.object({ id: z.string(), kind: z.enum(["proved", "not_proved", "problem"]), text: z.string(), obligationIds: z.array(z.string()) })).optional(),
  nextActions: z.array(z.object({ label: z.string(), kind: z.enum(["rerun", "configure", "fix", "review"]), obligationIds: z.array(z.string()) })).optional(),
  layers: z
    .array(
      z.object({
        layer: TestLayer,
        planned: z.number(),
        decisive: z.number(),
        passed: z.number(),
        failed: z.number(),
        flaky: z.number(),
        inconclusive: z.number(),
        blocked: z.number(),
        unsupported: z.number(),
        completeness: z.number().nullable(),
        confidence: Confidence,
        gap: z.string().nullable(),
        nextAction: z.string().nullable(),
      }),
    )
    .optional(),
  capabilities: z
    .array(
      z.object({
        name: z.string(),
        obligations: z.number(),
        decisive: z.number(),
        passed: z.number(),
        failed: z.number(),
        proofClasses: z.array(ProofClass),
        /** Existing test cases mapped to this capability by file or test name. */
        existingTests: z.number(),
        missing: z.string().nullable(),
      }),
    )
    .optional(),
  fixtures: z.object({ digest: z.string(), nodes: z.array(z.object({ id: z.string(), label: z.string(), ok: z.boolean().nullable(), detail: z.string() })) }).nullable().optional(),
  /** Devast load results. Without user thresholds these are measurements, not pass or fail. */
  load: z.object({ note: z.string(), stages: z.array(LoadStage), thresholds: LoadThresholds.nullable(), executionId: z.string().nullable().optional() }).nullable().optional(),
});
export type TestingReport = z.infer<typeof TestingReport>;

export const TestingUsage = z.object({
  aiCalls: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
  sandboxOperations: z.number(),
  sandboxCpuSeconds: z.number(),
  models: z.record(z.string(), z.string()),
  /** generated: planned by AI in this run · cache: reused from an earlier run for identical content · none: no AI */
  planSource: z.enum(["generated", "cache", "none"]).optional(),
  planSourceRunId: z.string().nullable().optional(),
  /** AI spend by stage (planning, fixtures, authoring, triage, critic, reconcile). */
  byStage: z.record(z.string(), z.object({ calls: z.number(), inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number() })).optional(),
  /** What the reused plan cost when it was first generated. */
  savedByCacheUsd: z.number().optional(),
});
export type TestingUsage = z.infer<typeof TestingUsage>;

export const TestingPreview = z.object({
  profile: TestingProfile,
  obligations: z.number(),
  byLayer: z.array(z.object({ layer: TestLayer, planned: z.number(), unsupported: z.number() })),
  unsupported: z.array(z.string()),
  estimate: z.object({ minutes: z.tuple([z.number(), z.number()]), costUsd: z.tuple([z.number(), z.number()]), basis: z.string() }),
  /** A finished run with identical content, engine and policy: a rerun would add no new evidence. */
  identicalRun: z.object({ id: z.string(), finishedAt: z.string().nullable() }).nullable(),
});
export type TestingPreview = z.infer<typeof TestingPreview>;

export const TestingRunSummary = z.object({
  id: z.string(),
  snapshotId: z.string(),
  projectId: z.string(),
  /** check: a normal run · rerun: only some checks again · repair: the validation of a sandbox repair attempt. */
  purpose: z.enum(["check", "rerun", "repair"]).optional(),
  status: TestingRunStatus,
  phase: TestingPhase,
  /** Live step text while running. */
  step: z.string().nullable(),
  progress: z.number().nullable(),
  headline: z.string().nullable(),
  counts: z.object({ obligations: z.number(), terminal: z.number(), failed: z.number(), confirmedDefects: z.number() }),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type TestingRunSummary = z.infer<typeof TestingRunSummary>;

/** Testing state of one project for the project list: its latest full check and a few earlier ones. */
export const TestingProjectStatus = z.object({
  projectId: z.string(),
  /** The latest normal check (reruns and repair validations excluded). */
  latest: TestingRunSummary.nullable(),
  /** The release decision of that check when it finished with a report. */
  decision: ReleaseDecision.nullable(),
  /** Whether a run of this project (any purpose) is going now. */
  active: z.boolean(),
  /** Confirmed product problems of recent finished checks, oldest first, for a trend line. */
  history: z.array(z.object({ runId: z.string(), createdAt: z.string(), problems: z.number() })),
});
export type TestingProjectStatus = z.infer<typeof TestingProjectStatus>;

export const TestingRunDetail = TestingRunSummary.extend({
  obligations: z.array(Obligation),
  executions: z.array(TestExecution),
  findings: z.array(TestFinding),
  report: TestingReport.nullable(),
  usage: TestingUsage,
  profile: TestingProfile.optional(),
  parentRunId: z.string().nullable().optional(),
  /** All Testing AI spend for this project so far. */
  projectSpendUsd: z.number().optional(),
});
export type TestingRunDetail = z.infer<typeof TestingRunDetail>;

/**
 * One action cybercheck took inside the sandbox, streamed while the run is going for the live view:
 * a request sent, a screen opened, a journey step, a load stage. Never carries bodies or secrets.
 */
export const LiveAction = z.discriminatedUnion("k", [
  z.object({ k: z.literal("req"), method: z.string(), path: z.string(), status: z.number().nullable(), ms: z.number().nullable(), ok: z.boolean(), as: z.string().nullable(), check: z.string().nullable() }),
  z.object({ k: z.literal("screen"), url: z.string(), path: z.string(), vp: z.number(), status: z.number().nullable(), axe: z.number().nullable(), overflow: z.number().nullable(), as: z.string().nullable(), shot: z.string().nullable(), exec: z.string().optional(), marks: z.array(z.object({ rule: z.string(), help: z.string(), impact: z.string().nullable(), box: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }) })).optional() }),
  z.object({ k: z.literal("step"), journey: z.string(), title: z.string(), n: z.number(), of: z.number(), action: z.string(), target: z.string().nullable(), ok: z.boolean(), shot: z.string().nullable(), exec: z.string().optional() }),
  z.object({ k: z.literal("load"), stage: z.string(), vus: z.number(), state: z.enum(["start", "end"]), rps: z.number().nullable(), p95: z.number().nullable(), errors: z.number().nullable() }),
  z.object({ k: z.literal("note"), text: z.string() }),
]);
export type LiveAction = z.infer<typeof LiveAction>;

export const TestingEvent = z.object({ seq: z.number(), type: z.string(), message: z.string(), at: z.string(), data: LiveAction.optional() });
export type TestingEvent = z.infer<typeof TestingEvent>;

// ---------------------------------------------------------------- human review of findings

/** confirmed: real problem · rejected: not a product problem · unsure: needs more evidence · accepted_risk: real, not fixed now. */
export const FindingReviewDecision = z.enum(["confirmed", "rejected", "unsure", "accepted_risk"]);
export type FindingReviewDecision = z.infer<typeof FindingReviewDecision>;

/** One human review of one finding. Append-only: a later review supersedes, never overwrites, an earlier one. */
export const FindingHumanReview = z.object({
  id: z.string(),
  findingId: z.string(),
  runId: z.string(),
  projectId: z.string(),
  snapshotId: z.string(),
  reviewerUserId: z.string(),
  reviewerName: z.string().nullable().optional(),
  reviewerRole: z.enum(["owner", "admin", "member", "authorized_reviewer"]),
  decision: FindingReviewDecision,
  reason: z.string().nullable(),
  createdAt: z.string(),
  supersedesReviewId: z.string().nullable(),
});
export type FindingHumanReview = z.infer<typeof FindingHumanReview>;

/** Body of POST /v1/testing-runs/:runId/findings/:findingId/reviews. */
export const ReviewFindingInput = z.object({ decision: FindingReviewDecision, reason: z.string().trim().max(2000).nullable().optional() });
export type ReviewFindingInput = z.infer<typeof ReviewFindingInput>;

/**
 * Among machine product-defect findings a human reviewed: how many were confirmed rather than rejected.
 * Unsure, accepted-risk and unreviewed findings are not in the denominator. Below five reviewed, no percentage.
 */
export const ReviewPrecision = z.object({
  confirmed: z.number(),
  rejected: z.number(),
  reviewed: z.number(),
  /** null when fewer than `minSample` findings were confirmed or rejected. */
  percent: z.number().nullable(),
  minSample: z.number(),
  text: z.string(),
});
export type ReviewPrecision = z.infer<typeof ReviewPrecision>;

/**
 * The run after human review: a new version that references the immutable machine report, never a change to it.
 * Completeness does not rise through review (nothing more was tested); a rejected check stays without a verdict.
 */
export const ReviewedReport = z.object({
  runId: z.string(),
  basedOnReportOf: z.string(),
  reviewIds: z.array(z.string()),
  machine: z.object({ decision: ReleaseDecision, completeness: z.number(), productHealth: z.number().nullable(), openDefects: z.number() }),
  reviewed: z.object({
    decision: ReleaseDecision,
    reasons: z.array(z.string()),
    completeness: z.number(),
    productHealth: z.number().nullable(),
    openDefects: z.number(),
    acceptedRisks: z.number(),
    unsure: z.number(),
    awaitingReview: z.number(),
  }),
  findings: z.array(
    z.object({
      findingId: z.string(),
      /** The latest review, or null when nobody reviewed it yet. */
      review: FindingHumanReview.nullable(),
      history: z.number(),
      queue: z.enum(["awaiting", "confirmed", "rejected", "accepted_or_unsure"]),
      /** Repair in a sandbox: only for a human-confirmed product problem. */
      repairEligible: z.boolean(),
    }),
  ),
  precision: z.object({ run: ReviewPrecision, project: ReviewPrecision }),
  /** Whether the current user may review (a workspace role listed in REVIEW_ROLES). */
  canReview: z.boolean(),
  allowAcceptedRisk: z.boolean(),
});
export type ReviewedReport = z.infer<typeof ReviewedReport>;

// ---------------------------------------------------------------- sandbox repair of a confirmed finding

/**
 * awaiting_approval: scope and cost shown, nothing runs until a reviewer approves · running · verified: the
 * reproduction passes and no regression · failed_validation: the problem remains (or no safe patch was found) ·
 * regression_introduced: the patch broke something that passed before · budget_exhausted · cancelled.
 */
export const RepairStatus = z.enum(["awaiting_approval", "running", "verified", "failed_validation", "regression_introduced", "budget_exhausted", "cancelled"]);
export type RepairStatus = z.infer<typeof RepairStatus>;

/** One exact, unique text replacement in one project file (the patch format the repair model must use). */
export const RepairEdit = z.object({ path: z.string(), find: z.string().min(1).max(20_000), replace: z.string().max(20_000) });
export type RepairEdit = z.infer<typeof RepairEdit>;

export const RepairAttempt = z.object({
  n: z.number(),
  status: z.enum(["running", "verified", "failed_validation", "regression_introduced", "rejected_patch", "budget_exhausted", "cancelled"]),
  summary: z.string().nullable(),
  /** The patch as a unified diff, its digest, and the files it changed (only inside the sandbox overlay). */
  diff: z.string().nullable(),
  patchDigest: z.string().nullable(),
  filesChanged: z.array(z.string()),
  /** Why a proposed patch was refused before running (it edited a test, weakened a check, and so on). */
  rejectedBecause: z.array(z.string()),
  /** The validation run: the same checks on the patched code in fresh sandboxes. */
  validationRunId: z.string().nullable(),
  /** Each check that decides the attempt, before (the original run) and after (the validation run). */
  checks: z.array(
    z.object({
      obligationId: z.string(),
      label: z.string(),
      role: z.enum(["reproduction", "regression"]),
      before: z.string(),
      after: z.string(),
      /** A page-level check may still fail for another finding after this finding's exact rule is gone. */
      targetResolved: z.boolean().optional(),
    }),
  ),
  regressions: z.array(z.string()),
  costUsd: z.number(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type RepairAttempt = z.infer<typeof RepairAttempt>;

export const TestingRepair = z.object({
  id: z.string(),
  runId: z.string(),
  findingId: z.string(),
  projectId: z.string(),
  snapshotId: z.string(),
  status: RepairStatus,
  requestedBy: z.string(),
  approvedBy: z.string().nullable(),
  /** What may change and what is rerun, shown before approval. */
  scope: z.object({
    files: z.array(z.string()),
    reproduction: z.array(z.string()),
    regression: z.array(z.string()),
    /** For a grouped deterministic finding, the exact failure marker that must disappear from every reproduction. */
    targetFailure: z.object({ marker: z.string(), label: z.string() }).optional(),
    maxAttempts: z.number(),
    estimate: z.object({ minutes: z.tuple([z.number(), z.number()]), costUsd: z.tuple([z.number(), z.number()]) }),
  }),
  attempts: z.array(RepairAttempt),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TestingRepair = z.infer<typeof TestingRepair>;

/** Body of POST /v1/testing-runs/:runId/findings/:findingId/repair-approvals: approve a requested repair. */
export const ApproveRepairInput = z.object({ repairId: z.string(), maxAttempts: z.number().int().min(1).max(3).optional() });
export type ApproveRepairInput = z.infer<typeof ApproveRepairInput>;
