import { z } from "zod";
import { Evidence } from "./dossier.ts";
import { TestExecution, TestingEvent, TestingRunStatus, TestingUsage } from "./testing.ts";
import { AiComponentInventory, AiEvaluationTarget } from "./ai-evaluator.ts";

// The AI Adversarial check: cybercheck's fourth engine. It attacks an isolated copy of an AI-enabled application and
// follows controlled attack chains across prompts, RAG, memory, tools/MCP, identities, browser output, APIs, database
// state, concurrency and resources. AI may propose attack plans, but only trusted deterministic code authorizes and
// executes typed operations; the target never receives platform credentials or unrestricted network access. It shares
// the run table, worker, fencing, events, executions and findings with the other checks; campaigns, steps and chains
// live in their own tables.

// ---------------------------------------------------------------- scope
/** Attacker vantage points an attack is launched from. */
export const AdversarialAttacker = z.enum(["anonymous", "user", "cross_user", "cross_tenant", "lower_role", "admin", "service", "agent"]);
export type AdversarialAttacker = z.infer<typeof AdversarialAttacker>;

/** The coverage lanes a release decision needs evidence for (frozen with the benchmark). */
export const AdversarialLane = z.enum(["prompt", "leakage", "rag_memory", "tools_approval", "identity_tenant", "mcp_agent", "output_handling", "resource_concurrency", "multi_stage"]);
export type AdversarialLane = z.infer<typeof AdversarialLane>;

// ---------------------------------------------------------------- policy and rules of engagement
export const AdversarialProfile = z.enum(["quick", "standard", "deep"]);
export type AdversarialProfile = z.infer<typeof AdversarialProfile>;

/** Fixed per-profile limits. Critical campaigns always run first; the rest stop when a limit is reached. */
export const AD_PROFILE_LIMITS: Record<
  AdversarialProfile,
  { campaigns: number; concurrency: number; stepsPerChain: number; replanRounds: number; mutationsPerSeed: number; requests: number; requestsPerTarget: number; authAttempts: number; timeoutSec: number; tokens: number; costUsd: number }
> = {
  quick: { campaigns: 8, concurrency: 2, stepsPerChain: 4, replanRounds: 1, mutationsPerSeed: 2, requests: 120, requestsPerTarget: 20, authAttempts: 10, timeoutSec: 600, tokens: 150_000, costUsd: 0.5 },
  standard: { campaigns: 24, concurrency: 4, stepsPerChain: 6, replanRounds: 3, mutationsPerSeed: 5, requests: 300, requestsPerTarget: 30, authAttempts: 20, timeoutSec: 1800, tokens: 600_000, costUsd: 3 },
  deep: { campaigns: 60, concurrency: 4, stepsPerChain: 8, replanRounds: 4, mutationsPerSeed: 8, requests: 800, requestsPerTarget: 60, authAttempts: 40, timeoutSec: 3600, tokens: 2_000_000, costUsd: 10 },
};

/** The typed operations a compiled campaign step may perform. Nothing else is executable, however a plan is phrased. */
export const AttackOperation = z.enum([
  "send_message",
  "send_indirect_content",
  "upload_synthetic_document",
  "retrieve_synthetic_document",
  "invoke_known_tool",
  "inspect_known_state",
  "compare_identity_response",
  "open_known_page",
  "observe_local_canary",
  "repeat_bounded",
  "run_parallel_bounded",
  "reset_state",
]);
export type AttackOperation = z.infer<typeof AttackOperation>;

/** The rules of engagement a run is bound to. Server limits always clamp these; they can only narrow, never widen. */
export const RulesOfEngagement = z.object({
  allowedEndpoints: z.array(z.string()),
  allowedIdentities: z.array(z.string()),
  allowedTools: z.array(z.string()),
  allowedFiles: z.array(z.string()),
  allowedDataClasses: z.array(z.string()),
  allowedMutationTypes: z.array(z.string()),
  canaries: z.array(z.string()),
  /** External network is off by default; only separately isolated trusted services are ever reachable. */
  externalNetwork: z.boolean().default(false),
  limits: z.object({
    requests: z.number(),
    requestsPerTarget: z.number(),
    authAttempts: z.number(),
    stepsPerChain: z.number(),
    toolCalls: z.number(),
    tokens: z.number(),
    timeoutSec: z.number(),
    costUsd: z.number(),
    concurrency: z.number(),
  }),
});
export type RulesOfEngagement = z.infer<typeof RulesOfEngagement>;

export const AdversarialRuntime = z.enum(["auto", "nebius", "local"]);
export type AdversarialRuntime = z.infer<typeof AdversarialRuntime>;

export const AdversarialPolicyInput = z.object({
  profile: AdversarialProfile.default("standard"),
  /** auto falls back to deterministic when no attacker model or credit is available; off guarantees zero attacker-model calls. */
  aiAttacker: z.enum(["auto", "off"]).default("auto"),
  aiCritic: z.enum(["auto", "off"]).default("auto"),
  runtime: AdversarialRuntime.default("auto"),
  /** The component to attack (its id), or null to bind the single unambiguous AI component. */
  targetComponentId: z.string().nullable().default(null),
  /** A finished run to compare this run against (regression). */
  baselineRunId: z.string().nullable().default(null),
  /** Rules-of-engagement overrides, clamped to server limits. Null uses the profile defaults. */
  rulesOfEngagement: RulesOfEngagement.partial().nullable().default(null),
  /** Immutable project-owned attack-pack ids to include. */
  attackPackIds: z.array(z.string()).default([]),
});
export type AdversarialPolicyInput = z.infer<typeof AdversarialPolicyInput>;

/** A rerun of a finished run: a scope of its campaigns re-run as a new linked run, never altering the original. */
export const RerunAdversarialInput = z.object({
  scope: z.enum(["blocked", "inconclusive", "failed", "campaigns"]).default("failed"),
  campaignIds: z.array(z.string()).default([]),
});
export type RerunAdversarialInput = z.infer<typeof RerunAdversarialInput>;

// ---------------------------------------------------------------- applicability and attack surface
export const AdversarialApplicability = z.object({
  /** applicable: an AI component with a reachable target · no_target: AI present but nothing reachable (insufficient evidence) · not_applicable: no AI component · unsupported: language or stack out of scope. */
  status: z.enum(["applicable", "no_target", "not_applicable", "unsupported"]),
  reason: z.string(),
  components: z.array(AiComponentInventory),
  targets: z.array(z.object({ target: AiEvaluationTarget, boundBy: z.enum(["user", "single_route"]), auxiliary: z.record(z.string(), z.unknown()).default({}) })),
  unbound: z.array(z.object({ componentId: z.string(), reason: z.string() })),
});
export type AdversarialApplicability = z.infer<typeof AdversarialApplicability>;

/** One edge of the attack-surface graph (attacker -> entry -> ... -> protected asset), each citing evidence. */
export const AttackSurfaceEdge = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum(["entry", "auth", "role", "tenant", "component", "prompt", "retrieval", "memory", "tool", "mcp", "agent", "approval", "sink", "asset"]),
  label: z.string(),
  evidence: z.array(Evidence),
});
export type AttackSurfaceEdge = z.infer<typeof AttackSurfaceEdge>;

export const AttackSurface = z.object({
  nodes: z.array(z.object({ id: z.string(), kind: z.string(), label: z.string() })),
  edges: z.array(AttackSurfaceEdge),
});
export type AttackSurface = z.infer<typeof AttackSurface>;

// ---------------------------------------------------------------- hypotheses, campaigns, steps, chains
export const AdversarialPriority = z.enum(["critical", "high", "medium", "low"]);
export type AdversarialPriority = z.infer<typeof AdversarialPriority>;

export const AdversarialSeverity = z.enum(["critical", "high", "medium", "low", "info"]);
export type AdversarialSeverity = z.infer<typeof AdversarialSeverity>;

/** A proposed attack, from the deterministic catalogue or (later) the attacker model. It is never executed directly. */
export const AttackHypothesis = z.object({
  id: z.string(),
  attacker: AdversarialAttacker,
  lane: AdversarialLane,
  entryPoint: z.string(),
  boundary: z.string(),
  asset: z.string(),
  preconditions: z.array(z.string()),
  /** The proposed chain as typed catalogue operations only. */
  proposedChain: z.array(AttackOperation),
  impact: z.string(),
  /** What evidence would confirm it (the required oracle). */
  requiredOracle: z.string(),
  source: z.enum(["catalogue", "attacker_model", "attack_pack"]),
});
export type AttackHypothesis = z.infer<typeof AttackHypothesis>;

export const AdversarialStepResult = z.enum(["crossed", "held", "inconclusive", "blocked", "error"]);
export type AdversarialStepResult = z.infer<typeof AdversarialStepResult>;

export const AdversarialStep = z.object({
  seq: z.number(),
  operation: AttackOperation,
  /** The synthetic input, as a class label, never the raw adversarial text. */
  inputClass: z.string(),
  asIdentity: z.string().nullable(),
  target: z.string(),
  expected: z.string(),
  executionId: z.string().nullable(),
  /** The redacted observation of what happened. */
  observed: z.string(),
  result: AdversarialStepResult,
  redacted: z.boolean().default(true),
});
export type AdversarialStep = z.infer<typeof AdversarialStep>;

export const AdversarialCampaignStatus = z.enum(["planned", "running", "passed", "failed", "inconclusive", "blocked"]);
export type AdversarialCampaignStatus = z.infer<typeof AdversarialCampaignStatus>;

export const AdversarialCampaign = z.object({
  id: z.string(),
  seq: z.number(),
  lane: AdversarialLane,
  /** A stable campaign id, frozen with the catalogue, so reruns and baselines line up. */
  techniqueId: z.string(),
  priority: AdversarialPriority,
  title: z.string(),
  target: z.object({ componentId: z.string(), endpoint: z.string() }),
  attacker: AdversarialAttacker,
  resetStrategy: z.enum(["none", "db_rollback", "db_reseed", "new_conversation", "memory_cleanup", "file_overlay", "fresh_app", "fresh_browser"]),
  steps: z.array(AdversarialStep),
  status: AdversarialCampaignStatus,
  reason: z.string(),
  executionIds: z.array(z.string()),
  findingIds: z.array(z.string()),
  limitations: z.array(z.string()),
  source: z.enum(["catalogue", "attacker_model", "attack_pack"]),
});
export type AdversarialCampaign = z.infer<typeof AdversarialCampaign>;

export const AttackChainVerdict = z.enum(["confirmed", "inconclusive", "rejected"]);
export type AttackChainVerdict = z.infer<typeof AttackChainVerdict>;

/** A multi-stage chain correlating several campaigns: it confirms only when every required link has trusted evidence. */
export const AttackChain = z.object({
  id: z.string(),
  seq: z.number(),
  title: z.string(),
  campaignIds: z.array(z.string()),
  findingIds: z.array(z.string()),
  /** Ordered human-readable links: entry obtained -> boundary crossed -> privilege increased -> asset reached -> impact. */
  links: z.array(z.object({ label: z.string(), crossed: z.boolean(), campaignId: z.string().nullable(), evidence: z.array(Evidence) })),
  crossedBoundaries: z.array(z.string()),
  reachedAsset: z.string().nullable(),
  reproducedImpact: z.string().nullable(),
  rootCauses: z.array(z.string()),
  verdict: AttackChainVerdict,
  reason: z.string(),
});
export type AttackChain = z.infer<typeof AttackChain>;

// ---------------------------------------------------------------- findings
export const AdversarialFindingStatus = z.enum(["confirmed", "suspected", "rejected", "inconclusive", "blocked"]);
export type AdversarialFindingStatus = z.infer<typeof AdversarialFindingStatus>;

export const AdversarialFinding = z.object({
  id: z.string(),
  status: AdversarialFindingStatus,
  severity: AdversarialSeverity,
  lane: AdversarialLane,
  title: z.string(),
  componentId: z.string(),
  endpoint: z.string().nullable(),
  /** Findings with the same component, endpoint and root cause are one problem. */
  rootCause: z.string(),
  owasp: z.array(z.string()),
  attacker: AdversarialAttacker,
  boundaryCrossed: z.string(),
  assetReached: z.string(),
  expected: z.string(),
  observed: z.string(),
  impact: z.string(),
  remediation: z.string(),
  campaignIds: z.array(z.string()),
  chainIds: z.array(z.string()),
  executionIds: z.array(z.string()),
  sourceEvidence: z.array(Evidence),
  /** execution: a trusted runtime step reproduced it · source: code only (suspected) · critic: lowered by the critic. */
  basis: z.enum(["execution", "source", "critic"]),
  confirmation: z.string(),
  /** Before/after synthetic state for a mutating finding, where applicable. */
  stateChange: z.object({ before: z.string(), after: z.string() }).nullable().default(null),
  resetResult: z.string().nullable().default(null),
  limitations: z.array(z.string()),
  related: z.array(z.object({ check: z.enum(["security", "ai-evaluator", "testing"]), note: z.string() })),
});
export type AdversarialFinding = z.infer<typeof AdversarialFinding>;

// ---------------------------------------------------------------- report
export const AdversarialDecision = z.enum(["not_applicable", "ready_with_evidence", "not_ready_adversarial_findings", "not_ready_insufficient_evidence", "not_ready_environment_blocked"]);
export type AdversarialDecision = z.infer<typeof AdversarialDecision>;

export const AdversarialPhase = z.enum([
  "admission",
  "readiness",
  "surface_mapping",
  "planning",
  "compiling",
  "preparing",
  "fixtures",
  "campaigning",
  "browser_campaigning",
  "critic",
  "validating",
  "reporting",
  "done",
]);
export type AdversarialPhase = z.infer<typeof AdversarialPhase>;

/** One required lane's obligation and what the run established. A required lane with no decisive evidence is never a pass. */
export const AdversarialLaneObligation = z.object({
  lane: AdversarialLane,
  label: z.string(),
  required: z.boolean(),
  critical: z.boolean(),
  why: z.string(),
  status: z.enum(["passed", "failed", "inconclusive", "blocked", "unsupported", "not_applicable"]),
  reason: z.string(),
  campaigns: z.number(),
  decided: z.number(),
  campaignIds: z.array(z.string()),
});
export type AdversarialLaneObligation = z.infer<typeof AdversarialLaneObligation>;

export const AdversarialReport = z.object({
  /** Version 2 adds the proof-grade campaign, chain, audit, and optional critic fields. Version 1 remains readable. */
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  engine: z.string(),
  catalogueVersion: z.string(),
  compilerVersion: z.string(),
  decision: AdversarialDecision,
  headline: z.string(),
  /** What the decision covers and what it does not. Never claims everything was tested or a percentage secure. */
  claims: z.array(z.string()),
  applicability: AdversarialApplicability,
  surface: AttackSurface,
  rulesOfEngagement: RulesOfEngagement,
  environment: z.object({ requested: z.string(), selected: z.enum(["nebius", "local", "static", "none"]), provider: z.string().nullable(), fallbackReason: z.string().nullable(), isolation: z.string() }),
  obligations: z.array(AdversarialLaneObligation),
  obligationCoverage: z.object({ decisive: z.number(), required: z.number(), criticalDecisive: z.number(), criticalRequired: z.number() }),
  coverage: z.object({ decisive: z.number(), applicable: z.number() }),
  chains: z.array(AttackChain),
  findings: z.object({ confirmed: z.number(), suspected: z.number(), rejected: z.number(), inconclusive: z.number(), blocked: z.number(), confirmedCriticalHigh: z.number() }),
  /** Hypotheses the run disproved, kept in the audit trail but never shown as active risks. */
  rejectedHypotheses: z.array(z.object({ id: z.string(), lane: AdversarialLane, title: z.string(), reason: z.string() })),
  untested: z.array(z.object({ what: z.string(), reason: z.string() })),
  attacker: z.object({ status: z.enum(["ran", "off", "unavailable", "deterministic_only"]), provider: z.string().nullable(), model: z.string().nullable(), hypotheses: z.number(), uniqueFindings: z.number(), reason: z.string() }),
  critic: z.object({ status: z.enum(["ran", "off", "unavailable"]), provider: z.string().nullable(), model: z.string().nullable(), lowered: z.number(), reason: z.string() }),
  usage: z.object({ modelRequests: z.number(), tokensIn: z.number(), tokensOut: z.number(), costUsd: z.number().nullable(), durationMs: z.number().nullable() }),
  audit: z.array(z.object({ check: z.string(), ok: z.boolean(), detail: z.string() })),
  versions: z.object({ engine: z.string(), catalogue: z.string(), compiler: z.string(), snapshotDigest: z.string(), attackPackDigests: z.array(z.string()), runtimeImage: z.string().nullable(), provider: z.string().nullable(), model: z.string().nullable() }),
  limitations: z.array(z.string()),
});
export type AdversarialReport = z.infer<typeof AdversarialReport>;

// ---------------------------------------------------------------- attack packs (optional, project-owned)
export const AD_ATTACK_PACK_LIMITS = { maxBytes: 5 * 1024 * 1024, maxCases: 2000, schemaVersion: 1 } as const;

export const AdversarialAttackPackSummary = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  version: z.number(),
  digest: z.string(),
  schemaVersion: z.number(),
  categories: z.record(z.string(), z.number()),
  caseCount: z.number(),
  createdBy: z.string(),
  createdAt: z.string(),
});
export type AdversarialAttackPackSummary = z.infer<typeof AdversarialAttackPackSummary>;

// ---------------------------------------------------------------- run summary and detail
export const AdversarialRunSummary = z.object({
  id: z.string(),
  snapshotId: z.string(),
  projectId: z.string(),
  status: TestingRunStatus,
  phase: AdversarialPhase,
  step: z.string().nullable(),
  progress: z.number().nullable(),
  headline: z.string().nullable(),
  decision: AdversarialDecision.nullable(),
  profile: AdversarialProfile,
  counts: z.object({ campaigns: z.number(), decisive: z.number(), chains: z.number(), confirmed: z.number(), suspected: z.number(), blocked: z.number() }),
  parentRunId: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type AdversarialRunSummary = z.infer<typeof AdversarialRunSummary>;

export const AdversarialRunDetail = AdversarialRunSummary.extend({
  policy: AdversarialPolicyInput,
  campaigns: z.array(AdversarialCampaign),
  chains: z.array(AttackChain),
  findings: z.array(AdversarialFinding),
  executions: z.array(TestExecution),
  report: AdversarialReport.nullable(),
  usage: TestingUsage,
});
export type AdversarialRunDetail = z.infer<typeof AdversarialRunDetail>;

export const AdversarialProjectStatus = z.object({ projectId: z.string(), latest: AdversarialRunSummary.nullable(), active: z.boolean() });
export type AdversarialProjectStatus = z.infer<typeof AdversarialProjectStatus>;

export const AdversarialEvent = TestingEvent;
export type AdversarialEvent = z.infer<typeof AdversarialEvent>;
