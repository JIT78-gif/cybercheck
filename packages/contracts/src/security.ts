import { z } from "zod";
import { Evidence } from "./dossier.ts";
import { TestExecution, TestingEvent, TestingRunStatus, TestingUsage } from "./testing.ts";

// The Security check (Round 1: static foundation; Round 2: runtime proofs). It shares the run table, worker, fencing, events,
// review and audit with Testing, and has its own facts, obligations, findings, report and release decision.
// Nothing the analysed project says (README, comments, its own output) can change these rules.

// ---------------------------------------------------------------- facts from Analyze, re-checked

/** How a fact used by Security is known. Only code, configuration and sandbox results can make a fact observed. */
export const FactState = z.enum(["observed", "inferred", "user_supplied", "not_observed", "unresolved", "sandbox_verified"]);
export type FactState = z.infer<typeof FactState>;

/** The Security lanes; a contradiction blocks only the lanes that depend on it. */
export const SecurityLane = z.enum(["auth", "access_control", "injection", "secrets", "dependencies", "sast", "configuration", "infrastructure", "crypto", "privacy", "logging"]);
export type SecurityLane = z.infer<typeof SecurityLane>;

export const SecurityFact = z.object({
  /** Stable claim id, e.g. "endpoint:GET /api/users/:id" or "auth:model". */
  id: z.string(),
  snapshotId: z.string(),
  state: FactState,
  /** What the fact says, in plain words. */
  statement: z.string(),
  evidence: z.array(Evidence),
  /** The detector that produced it and its version, e.g. "analyze:routes@2026-10-10.v2.2". */
  detector: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  limitations: z.array(z.string()),
  /** Ids of facts or consistency rules that disagree with this one. */
  contradictions: z.array(z.string()),
  /** Check tabs this fact matters to. */
  tabs: z.array(z.enum(["testing", "security", "ai-evaluator", "adversarial"])),
});
export type SecurityFact = z.infer<typeof SecurityFact>;

/** Whether Analyze's output can be trusted enough to plan Security. */
export const ReadinessLevel = z.enum(["READY", "READY_WITH_WARNINGS", "PARTIALLY_READY", "BLOCKED"]);
export type ReadinessLevel = z.infer<typeof ReadinessLevel>;

export const AnalyzeReadiness = z.object({
  level: ReadinessLevel,
  issues: z.array(
    z.object({
      rule: z.string(),
      severity: z.enum(["error", "warning"]),
      message: z.string(),
      evidence: z.array(Evidence),
      /** The lanes this issue makes inconclusive; empty when it blocks nothing. */
      blocks: z.array(SecurityLane),
    }),
  ),
  /** Lanes that may run (all lanes not blocked by an issue). */
  runnableLanes: z.array(SecurityLane),
});
export type AnalyzeReadiness = z.infer<typeof AnalyzeReadiness>;

// ---------------------------------------------------------------- obligations

export const SecurityObligationStatus = z.enum(["planned", "running", "passed", "failed", "blocked", "unsupported", "not_applicable", "inconclusive"]);
export type SecurityObligationStatus = z.infer<typeof SecurityObligationStatus>;

/** How an obligation is proven: a scanner, a Cybercheck rule on code or facts, or a runtime proof (Round 2). */
export const ProofStrategy = z.enum(["secret_scan", "dependency_scan", "sast_rule", "config_rule", "iac_scan", "fact_rule", "runtime_proof", "browser_proof"]);
export type ProofStrategy = z.infer<typeof ProofStrategy>;

export const SecurityObligation = z.object({
  id: z.string(),
  lane: SecurityLane,
  /** e.g. "authorization", "injection", "secrets", "dependencies". */
  category: z.string(),
  asset: z.object({ kind: z.enum(["endpoint", "file", "dependency", "manifest", "config", "container", "workflow", "repository", "entity"]), ref: z.string(), label: z.string() }),
  requirement: z.string(),
  expectedControl: z.string(),
  /** Why the obligation applies to this project (code and configuration only). */
  applicabilityEvidence: z.array(Evidence),
  /** ASVS 5.0, OWASP API Top 10 and CWE ids, e.g. "ASVS-5.0:V8.2.1", "API1:2023", "CWE-639". */
  standards: z.array(z.string()),
  priority: z.enum(["critical", "high", "medium", "low"]),
  proofStrategy: ProofStrategy,
  /** Fact ids this obligation depends on; a contradicted fact makes it inconclusive. */
  dependencies: z.array(z.string()),
  status: SecurityObligationStatus,
  reason: z.string().nullable(),
  executionIds: z.array(z.string()),
  findingIds: z.array(z.string()),
});
export type SecurityObligation = z.infer<typeof SecurityObligation>;

// ---------------------------------------------------------------- findings

/** Who produced the evidence; only the trusted supervisor records execution identity and artifacts. */
export const EvidenceTrust = z.enum(["workload_observation", "tool_observation", "source_evidence", "trusted_execution", "controlled_reproduction", "human_review"]);
export type EvidenceTrust = z.infer<typeof EvidenceTrust>;

/** accepted_risk is a human review decision, never a machine status. */
export const SecurityFindingStatus = z.enum(["suspected", "confirmed", "rejected", "inconclusive"]);
export type SecurityFindingStatus = z.infer<typeof SecurityFindingStatus>;

export const SecurityFinding = z.object({
  id: z.string(),
  status: SecurityFindingStatus,
  severity: z.enum(["critical", "high", "medium", "low", "info"]),
  lane: SecurityLane,
  category: z.string(),
  title: z.string(),
  cwe: z.array(z.string()),
  owasp: z.array(z.string()),
  /** What should hold, what was observed, and why it matters. */
  expected: z.string(),
  observed: z.string(),
  impact: z.string(),
  location: Evidence.nullable(),
  evidence: z.array(Evidence),
  trust: EvidenceTrust,
  /** The tool or Cybercheck rule that found it, with versions. */
  detector: z.object({ tool: z.string(), version: z.string(), rule: z.string().nullable() }),
  /** Secrets only: a redacted preview and a salted fingerprint; the value itself is never stored. */
  secret: z.object({ type: z.string(), preview: z.string(), fingerprint: z.string() }).nullable(),
  /** Why it is confirmed, or what would confirm it. */
  confirmation: z.string(),
  obligationIds: z.array(z.string()),
  executionIds: z.array(z.string()),
  remediation: z.string(),
  /** Root-cause key: findings with the same key are one problem. */
  rootCause: z.string(),
  // Round 2 (absent on Round 1 runs).
  /** Structured proofs from this run that support or settle the finding. */
  proofIds: z.array(z.string()).optional(),
  /** What the finding rests on, shown to the user. */
  basis: z.enum(["static_only", "component_present", "runtime_confirmed", "human_reviewed"]).optional(),
  /** Dependency advisories only: what was matched and how it reaches the app. */
  dependency: z
    .object({
      ecosystem: z.string(),
      package: z.string(),
      version: z.string(),
      lockfile: z.string(),
      direct: z.boolean().nullable(),
      scope: z.enum(["production", "development", "unknown"]),
      advisories: z.array(z.object({ id: z.string(), aliases: z.array(z.string()), withdrawn: z.boolean(), severitySource: z.string().nullable() })),
      affected: z.string().nullable(),
      fixedVersions: z.array(z.string()),
      nearestFix: z.string().nullable(),
      reachability: z.enum(["reachable", "not_observed", "unreachable", "unknown"]),
      usage: z.array(Evidence),
      databaseAt: z.string().nullable(),
      limitations: z.array(z.string()),
    })
    .optional(),
});
export type SecurityFinding = z.infer<typeof SecurityFinding>;

// ---------------------------------------------------------------- proofs (Round 2)

/** The fixed catalogue of runtime proofs. Nothing outside it can be compiled or run. */
export const SecurityProofType = z.enum([
  "authn_required",
  "authn_invalid_credential",
  "authz_object",
  "authz_function",
  "authz_property",
  "input_differential",
  "browser_script_canary",
  "file_containment",
  "outbound_request_canary",
  "redirect_target",
  "error_disclosure",
  "log_disclosure",
  "response_headers",
  "cors_response",
  "login_throttling",
  "csrf_origin",
  "webhook_signature",
  "upload_handling",
  "command_injection",
  "code_injection",
  "session_integrity",
  "account_enumeration",
]);
export type SecurityProofType = z.infer<typeof SecurityProofType>;

export const SecurityProofVerdict = z.enum(["passed", "failed", "blocked", "inconclusive"]);
export type SecurityProofVerdict = z.infer<typeof SecurityProofVerdict>;

/**
 * One runtime proof: what was compared, as whom, and what came back. "failed" means the control did not hold
 * (a vulnerability was reproduced); "passed" means it held for this exact target only.
 */
export const SecurityProof = z.object({
  id: z.string(),
  type: SecurityProofType,
  target: z.object({ kind: z.enum(["endpoint", "screen", "app"]), ref: z.string() }),
  obligationIds: z.array(z.string()),
  /** Synthetic identity names, e.g. "anonymous", "customer", "customer-2", "admin". */
  identities: z.array(z.string()),
  preconditions: z.array(z.object({ what: z.string(), met: z.boolean() })),
  reset: z.enum(["none_needed", "fresh_app", "rollback", "not_possible"]),
  /** The class of input used, never the raw value, e.g. "foreign object id", "extra role property". */
  payloadClass: z.string(),
  expected: z.string(),
  observed: z.string(),
  /** Short, redacted excerpts of what was compared. */
  evidence: z.array(z.object({ kind: z.enum(["http", "browser", "database", "canary", "source"]), label: z.string(), excerpt: z.string() })),
  source: z.array(Evidence),
  executionIds: z.array(z.string()),
  artifacts: z.array(z.string()),
  verdict: SecurityProofVerdict,
  reason: z.string(),
  limitations: z.array(z.string()),
  redacted: z.boolean(),
  requests: z.number(),
});
export type SecurityProof = z.infer<typeof SecurityProof>;

// ---------------------------------------------------------------- the run

export const SecurityPhase = z.enum(["admission", "readiness", "planning", "preparing", "scanning", "app_preparing", "fixtures", "proving", "browser_proving", "critic", "validating", "reporting", "done"]);
export type SecurityPhase = z.infer<typeof SecurityPhase>;

export const SecurityReleaseDecision = z.enum(["ready_with_evidence", "ready_with_accepted_risk", "not_ready_security_findings", "not_ready_insufficient_evidence", "not_ready_environment_blocked"]);
export type SecurityReleaseDecision = z.infer<typeof SecurityReleaseDecision>;

/**
 * The run's settings, recorded on the run and part of the idempotency hash. Deterministic checks always run; the AI
 * critic runs only when asked ("auto") and a provider is configured, and can never confirm anything.
 */
export const SecurityPolicyInput = z.object({
  engine: z.string().optional(),
  aiCritic: z.enum(["auto", "off"]).default("auto"),
  /** Which runtime executes the proofs: auto picks Nebius, else local Docker, else an analysis-only report. */
  runtime: z.enum(["auto", "nebius", "local", "static"]).default("auto"),
});
export type SecurityPolicyInput = z.infer<typeof SecurityPolicyInput>;

/** A targeted rerun of a finished Security run: re-check only the obligations that were left undecided ("missing"),
 * or a specific set of obligation ids. The original run is untouched; the rerun is a new, focused record. */
export const RerunSecurityInput = z.object({
  scope: z.enum(["missing", "obligations"]),
  /** Required when scope is "obligations": the obligation ids to re-check. Ignored when scope is "missing". */
  obligationIds: z.array(z.string()).optional(),
});
export type RerunSecurityInput = z.infer<typeof RerunSecurityInput>;

/** Where the check executed and how the runtime was chosen. Present from schema version 3. */
export const SecurityEnvironment = z.object({
  /** What the run asked for (auto picks Nebius, else local Docker, else analysis only). */
  requested: z.enum(["auto", "nebius", "local", "static"]),
  /** What actually ran the scans and proofs. "static" means analysis only; nothing was executed. */
  selected: z.enum(["nebius", "local", "static"]),
  /** The sandbox provider's name, or null when nothing executed. */
  provider: z.string().nullable(),
  /** Why the selected runtime differs from the preferred one (e.g. Nebius billing unavailable, HTTP 402). */
  fallbackReason: z.string().nullable(),
  /** The preferred runtime's health at selection time. */
  health: z.object({ ok: z.boolean(), status: z.string(), detail: z.string().nullable() }),
  /** One line describing the isolation the run had. */
  isolation: z.string(),
});
export type SecurityEnvironment = z.infer<typeof SecurityEnvironment>;

/** What happened between compiling runtime proofs and receiving their evidence. */
export const SecurityProofRuntime = z.object({
  stage: z.enum(["not_attempted", "no_startable_app", "no_compiled_proofs", "preparation_failed", "boot_failed", "completed", "error"]),
  attempted: z.boolean(),
  appBooted: z.boolean(),
  compiled: z.number(),
  rejected: z.number(),
  executed: z.number(),
  identities: z.number(),
  reason: z.string(),
  executionIds: z.array(z.string()),
});
export type SecurityProofRuntime = z.infer<typeof SecurityProofRuntime>;

export const SecurityReport = z.object({
  /** 1: Round 1 (static only). 2: Round 2 (runtime proofs). 3: adds execution-environment diagnostics. All are read. */
  schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  engine: z.string(),
  decision: SecurityReleaseDecision,
  headline: z.string(),
  readiness: AnalyzeReadiness,
  /** "N of M applicable obligations produced decisive evidence": always with both numbers. */
  coverage: z.object({ decisive: z.number(), applicable: z.number(), criticalDecisive: z.number(), criticalApplicable: z.number() }),
  totals: z.record(SecurityObligationStatus, z.number()),
  findings: z.object({ confirmed: z.number(), suspected: z.number(), confirmedCriticalHigh: z.number() }),
  /** Every tool that ran, with what makes its result reproducible. */
  tools: z.array(z.object({ name: z.string(), version: z.string(), rulePack: z.string().nullable(), databaseAt: z.string().nullable(), image: z.string().nullable(), command: z.string(), exitCode: z.number().nullable(), truncated: z.boolean(), executionId: z.string().nullable() })),
  /** Capabilities that did not run, e.g. AI threat modelling without an AI provider. */
  skipped: z.array(z.object({ capability: z.string(), reason: z.string() })),
  limitations: z.array(z.string()),
  audit: z.array(z.object({ check: z.string(), ok: z.boolean(), detail: z.string() })),
  // Version 2 only.
  proofs: z.object({ total: z.number(), byVerdict: z.record(SecurityProofVerdict, z.number()), requests: z.number() }).optional(),
  /** Who could do what: one row per endpoint, one column per identity, from runtime proofs. */
  authorizationMatrix: z
    .object({
      identities: z.array(z.string()),
      rows: z.array(z.object({ endpoint: z.string(), cells: z.record(z.string(), z.object({ outcome: z.enum(["allowed", "denied", "not_tested", "inconclusive"]), expected: z.enum(["allowed", "denied", "unknown"]), proofId: z.string().nullable() })) })),
    })
    .optional(),
  critic: z.object({
    ran: z.boolean(),
    reason: z.string(),
    proposals: z.number(),
    accepted: z.number(),
    model: z.string().nullable().optional(),
    reviews: z.array(z.object({ findingId: z.string(), verdict: z.enum(["supported", "challenge"]), reason: z.string() })).optional(),
  }).optional(),
  // Version 3 only.
  environment: SecurityEnvironment.optional(),
  /** Preparation/boot diagnostics exist even when zero proofs could run. */
  proofRuntime: SecurityProofRuntime.optional(),
});
export type SecurityReport = z.infer<typeof SecurityReport>;

export const SecurityRunSummary = z.object({
  id: z.string(),
  snapshotId: z.string(),
  projectId: z.string(),
  status: TestingRunStatus,
  phase: SecurityPhase,
  step: z.string().nullable(),
  progress: z.number().nullable(),
  headline: z.string().nullable(),
  decision: SecurityReleaseDecision.nullable(),
  counts: z.object({ obligations: z.number(), terminal: z.number(), confirmed: z.number(), suspected: z.number() }),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type SecurityRunSummary = z.infer<typeof SecurityRunSummary>;

export const SecurityRunDetail = SecurityRunSummary.extend({
  obligations: z.array(SecurityObligation),
  executions: z.array(TestExecution),
  findings: z.array(SecurityFinding),
  /** Round 2 runtime proofs; empty on Round 1 runs. */
  proofs: z.array(SecurityProof).default([]),
  report: SecurityReport.nullable(),
  usage: TestingUsage,
});
export type SecurityRunDetail = z.infer<typeof SecurityRunDetail>;

/** Security state of one project for the project list. */
export const SecurityProjectStatus = z.object({ projectId: z.string(), latest: SecurityRunSummary.nullable(), active: z.boolean() });
export type SecurityProjectStatus = z.infer<typeof SecurityProjectStatus>;

export const SecurityEvent = TestingEvent;
export type SecurityEvent = z.infer<typeof SecurityEvent>;
