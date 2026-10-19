import { AD_PROFILE_LIMITS, type AdversarialApplicability, type AdversarialCampaign, type AdversarialDecision, type AdversarialFinding, type AdversarialProfile, type AdversarialReport, type AttackChain, type AttackSurface, type RulesOfEngagement } from "@cybercheck/contracts";
import { AD_CATALOGUE_VERSION, AD_COMPILER_VERSION, AD_ENGINE_VERSION } from "./version.ts";
import type { CatalogCampaign } from "./catalog.ts";
import type { CampaignVerdict } from "./oracle.ts";
import type { LaneReadiness } from "./readiness.ts";
import { decideAdversarial } from "./decide.ts";
import type { AttackerReview, CriticReview } from "./ai.ts";

// A complete, mostly-empty AdversarialReport. Terminal gate decisions (not_applicable, insufficient evidence,
// environment blocked) use it directly; the full campaign report (plan step 13) builds on the same shape.

/** A profile's rules of engagement with empty allow-lists: the defaults before the compiler narrows them (step 7). */
export function defaultRulesOfEngagement(profile: AdversarialProfile): RulesOfEngagement {
  const l = AD_PROFILE_LIMITS[profile];
  return {
    allowedEndpoints: [],
    allowedIdentities: [],
    allowedTools: [],
    allowedFiles: [],
    allowedDataClasses: [],
    allowedMutationTypes: [],
    canaries: [],
    externalNetwork: false,
    limits: { requests: l.requests, requestsPerTarget: l.requestsPerTarget, authAttempts: l.authAttempts, stepsPerChain: l.stepsPerChain, toolCalls: l.requestsPerTarget, tokens: l.tokens, timeoutSec: l.timeoutSec, costUsd: l.costUsd, concurrency: l.concurrency },
  };
}

export function baseReport(input: {
  decision: AdversarialDecision;
  headline: string;
  applicability: AdversarialApplicability;
  profile: AdversarialProfile;
  snapshotDigest: string;
  environment?: AdversarialReport["environment"];
  claims?: string[];
  limitations?: string[];
  untested?: Array<{ what: string; reason: string }>;
  audit?: Array<{ check: string; ok: boolean; detail: string }>;
}): AdversarialReport {
  return {
    schemaVersion: 2,
    engine: AD_ENGINE_VERSION,
    catalogueVersion: AD_CATALOGUE_VERSION,
    compilerVersion: AD_COMPILER_VERSION,
    decision: input.decision,
    headline: input.headline,
    claims: input.claims ?? [],
    applicability: input.applicability,
    surface: { nodes: [], edges: [] },
    rulesOfEngagement: defaultRulesOfEngagement(input.profile),
    environment: input.environment ?? { requested: "auto", selected: "none", provider: null, fallbackReason: null, isolation: "Nothing was executed." },
    obligations: [],
    obligationCoverage: { decisive: 0, required: 0, criticalDecisive: 0, criticalRequired: 0 },
    coverage: { decisive: 0, applicable: 0 },
    chains: [],
    findings: { confirmed: 0, suspected: 0, rejected: 0, inconclusive: 0, blocked: 0, confirmedCriticalHigh: 0 },
    rejectedHypotheses: [],
    untested: input.untested ?? [],
    attacker: { status: "off", provider: null, model: null, hypotheses: 0, uniqueFindings: 0, reason: "The attacker model is not used in this decision." },
    critic: { status: "off", provider: null, model: null, lowered: 0, reason: "The critic is not used in this decision." },
    usage: { modelRequests: 0, tokensIn: 0, tokensOut: 0, costUsd: null, durationMs: null },
    audit: input.audit ?? [],
    versions: { engine: AD_ENGINE_VERSION, catalogue: AD_CATALOGUE_VERSION, compiler: AD_COMPILER_VERSION, snapshotDigest: input.snapshotDigest, attackPackDigests: [], runtimeImage: null, provider: null, model: null },
    limitations: input.limitations ?? [],
  };
}

export function buildAdversarialReport(input: {
  applicability: AdversarialApplicability;
  surface: AttackSurface;
  rules: RulesOfEngagement;
  lanes: LaneReadiness[];
  catalogue: CatalogCampaign[];
  campaigns: AdversarialCampaign[];
  verdicts: Map<string, CampaignVerdict>;
  chains: AttackChain[];
  findings: AdversarialFinding[];
  profile: AdversarialProfile;
  snapshotDigest: string;
  environment: AdversarialReport["environment"];
  executionIds: string[];
  aiAttacker: "auto" | "off";
  aiCritic: "auto" | "off";
  attackerReview?: AttackerReview;
  criticReview?: CriticReview;
  aiUsage?: { modelRequests: number; tokensIn: number; tokensOut: number; costUsd: number };
  limitations?: string[];
  untested?: Array<{ what: string; reason: string }>;
  durationMs?: number | null;
}): AdversarialReport {
  const decision = decideAdversarial({ lanes: input.lanes, campaigns: input.catalogue, verdicts: input.verdicts, environmentBlocked: input.environment.selected === "none" || input.environment.selected === "static" ? input.environment.fallbackReason ?? "No runtime was available." : null });
  const confirmed = input.findings.filter((f) => f.status === "confirmed");
  const knownExecutions = new Set(input.executionIds);
  const owned = confirmed.every((f) => f.executionIds.length > 0 && f.executionIds.every((id) => knownExecutions.has(id)));
  const evidenced = confirmed.every((f) => f.sourceEvidence.length > 0 && f.campaignIds.length > 0);
  const causal = input.chains.filter((c) => c.verdict === "confirmed").every((c) => c.links.length > 0 && c.links.every((l) => l.crossed && l.campaignId && l.evidence.length > 0));
  const ids = input.campaigns.map((c) => c.id);
  const unique = new Set(ids).size === ids.length;
  const raw = JSON.stringify({ campaigns: input.campaigns, findings: input.findings, chains: input.chains });
  const redacted = !/sk-agentmart-FIXTURE-DO-NOT-USE|CCADVMARK-|CC_SYS_PROMPT_|cc-approval-(valid|expired|replayed)/.test(raw);
  const audit = [
    { check: "campaign ids unique", ok: unique, detail: unique ? "Every persisted campaign id is unique in this run." : "Duplicate campaign ids were persisted." },
    { check: "confirmed evidence owned", ok: owned, detail: owned ? "Every confirmed finding cites an execution owned by this run." : "A confirmed finding cites missing or foreign execution evidence." },
    { check: "confirmed source and campaign evidence", ok: evidenced, detail: evidenced ? "Every confirmed finding cites its campaign and snapshot source evidence." : "A confirmed finding lacks campaign or source evidence." },
    { check: "confirmed chains causal", ok: causal, detail: causal ? "Every confirmed chain link carries trusted causal evidence." : "A confirmed chain has an unproven or evidence-free link." },
    { check: "sensitive markers redacted", ok: redacted, detail: redacted ? "No raw credential or canary marker appears in persisted report records." : "A raw synthetic secret or canary appears in persisted records." },
  ];
  const cleanAudit = audit.every((a) => a.ok);
  const finalDecision = cleanAudit ? decision.decision : "not_ready_insufficient_evidence";
  const headline = cleanAudit ? decision.headline : `The evidence audit failed: ${audit.filter((a) => !a.ok).map((a) => a.check).join(", ")}.`;
  const count = (status: AdversarialFinding["status"]) => input.findings.filter((f) => f.status === status).length;
  return {
    schemaVersion: 2,
    engine: AD_ENGINE_VERSION,
    catalogueVersion: AD_CATALOGUE_VERSION,
    compilerVersion: AD_COMPILER_VERSION,
    decision: finalDecision,
    headline,
    claims: ["Only the uploaded snapshot, synthetic identities and sandbox-local canaries were attacked.", "A passed campaign established its runtime prerequisites and deterministic oracle; blocked attempts are not passes.", "Optional AI can suggest or challenge hypotheses but cannot confirm a finding."],
    applicability: input.applicability,
    surface: input.surface,
    rulesOfEngagement: input.rules,
    environment: input.environment,
    obligations: decision.obligations,
    obligationCoverage: decision.obligationCoverage,
    coverage: decision.coverage,
    chains: input.chains,
    findings: { confirmed: count("confirmed"), suspected: count("suspected"), rejected: count("rejected"), inconclusive: count("inconclusive"), blocked: count("blocked"), confirmedCriticalHigh: confirmed.filter((f) => f.severity === "critical" || f.severity === "high").length },
    rejectedHypotheses: input.campaigns.filter((c) => c.status === "passed").map((c) => ({ id: c.id, lane: c.lane, title: c.title, reason: c.reason })),
    untested: input.untested ?? [],
    attacker: input.attackerReview ? { status: input.attackerReview.status === "ran" ? "ran" : input.attackerReview.status, provider: input.attackerReview.status === "ran" ? "configured AI gateway" : null, model: input.attackerReview.model, hypotheses: input.attackerReview.campaignIds.length, uniqueFindings: 0, reason: input.attackerReview.reason } : input.aiAttacker === "off" ? { status: "off", provider: null, model: null, hypotheses: 0, uniqueFindings: 0, reason: "The optional AI attacker was disabled; deterministic campaigns still ran." } : { status: "deterministic_only", provider: null, model: null, hypotheses: 0, uniqueFindings: 0, reason: "No attacker-model execution was needed for the deterministic catalogue." },
    critic: input.criticReview ? { status: input.criticReview.status, provider: input.criticReview.status === "ran" ? "configured AI gateway" : null, model: input.criticReview.model, lowered: input.criticReview.challenged.length, reason: input.criticReview.reason } : input.aiCritic === "off" ? { status: "off", provider: null, model: null, lowered: 0, reason: "The optional AI critic was disabled; deterministic evidence audits still ran." } : { status: "unavailable", provider: null, model: null, lowered: 0, reason: "The optional AI critic was unavailable; it did not block deterministic results." },
    usage: { modelRequests: input.aiUsage?.modelRequests ?? 0, tokensIn: input.aiUsage?.tokensIn ?? 0, tokensOut: input.aiUsage?.tokensOut ?? 0, costUsd: input.aiUsage?.costUsd ?? 0, durationMs: input.durationMs ?? null },
    audit,
    versions: { engine: AD_ENGINE_VERSION, catalogue: AD_CATALOGUE_VERSION, compiler: AD_COMPILER_VERSION, snapshotDigest: input.snapshotDigest, attackPackDigests: [], runtimeImage: null, provider: input.environment.provider, model: input.criticReview?.model ?? input.attackerReview?.model ?? null },
    limitations: input.limitations ?? [],
  };
}
