import { z } from "zod";
import type { AdversarialFinding } from "@cybercheck/contracts";
import type { AiSession } from "../understanding/ai/gateway.ts";
import type { CatalogCampaign } from "./catalog.ts";
import { GENERAL_TECHNIQUES, type AttackHypothesis } from "./catalog-general.ts";

// Optional AI is deliberately advisory. It receives sanitized catalogue/finding/surface metadata, can only select
// existing campaign ids, propose a {technique, known endpoint, known identity} hypothesis, or challenge an existing
// claim. It never emits executable operations, payloads, URLs, ids, or files, and never confirms a vulnerability: a
// proposed hypothesis is turned into a typed campaign by deterministic code and must still pass the safety compiler.

const AttackerProposal = z.object({ campaignIds: z.array(z.string()).max(20), rationale: z.string().max(2000) });
export type AttackerReview = { status: "ran" | "off" | "unavailable"; model: string | null; campaignIds: string[]; reason: string };

export async function attackerReview(session: AiSession | null, enabled: "auto" | "off", campaigns: CatalogCampaign[]): Promise<AttackerReview> {
  if (enabled === "off") return { status: "off", model: null, campaignIds: [], reason: "The optional AI attacker was disabled." };
  if (!session) return { status: "unavailable", model: null, campaignIds: [], reason: "No AI provider is configured; deterministic campaigns continue." };
  const allowed = new Set(campaigns.map((c) => c.id));
  const data = campaigns.map((c) => ({ id: c.id, lane: c.lane, technique: c.techniqueId, priority: c.priority, boundary: c.boundary, asset: c.asset }));
  try {
    const out = await session.json("triage", { purpose: "adversarial attacker catalogue review", system: "You are an authorized sandbox red-team planner. Rank only the supplied deterministic campaign ids by likely value. Never invent commands, payloads, targets, identities, URLs, files, tools, or campaign ids.", user: `<project_data>${JSON.stringify(data)}</project_data>`, schema: AttackerProposal, maxTokens: 1800 });
    const ids = [...new Set(out.campaignIds)].filter((id) => allowed.has(id));
    return { status: "ran", model: session.opts.models.triage ?? null, campaignIds: ids, reason: out.rationale };
  } catch (error) {
    return { status: "unavailable", model: session.opts.models.triage ?? null, campaignIds: [], reason: `The optional attacker review failed (${(error as Error).message}); deterministic campaigns continue.` };
  }
}

// The AI attacker reverse-engineers the sanitized surface + Security facts and proposes project-specific hypotheses:
// a technique against a specific known endpoint as a specific known identity. Deterministic code compiles and gates it.
const HypothesisItem = z.object({
  technique: z.enum(GENERAL_TECHNIQUES),
  endpoint: z.string().max(200),
  asIdentity: z.string().max(60),
  crossIdentity: z.string().max(60).nullish(),
  rationale: z.string().max(600),
});
const HypothesisProposal = z.object({ hypotheses: z.array(HypothesisItem).max(16), rationale: z.string().max(2000) });
export type AttackerPlan = { status: "ran" | "off" | "unavailable"; model: string | null; hypotheses: AttackHypothesis[]; proposed: number; reason: string };

export type SanitizedSurface = {
  endpoints: string[];
  identities: Array<{ name: string; role: string | null }>;
  securityFindings: Array<{ lane: string; category: string; status: string; endpoint: string | null }>;
  assets: string[];
};

export async function proposeAttackHypotheses(session: AiSession | null, enabled: "auto" | "off", surface: SanitizedSurface): Promise<AttackerPlan> {
  if (enabled === "off") return { status: "off", model: null, hypotheses: [], proposed: 0, reason: "The optional AI attacker was disabled; only the deterministic catalogue ran." };
  if (!session) return { status: "unavailable", model: null, hypotheses: [], proposed: 0, reason: "No AI provider is configured; the deterministic catalogue still ran." };
  if (!surface.endpoints.length || !surface.identities.length) return { status: "ran", model: session.opts.models.triage ?? null, hypotheses: [], proposed: 0, reason: "No reachable endpoint and identity pair for the attacker to target." };
  const endpoints = new Set(surface.endpoints);
  const identities = new Set(["anonymous", ...surface.identities.map((i) => i.name)]);
  const base = (name: string) => name.replace(/#(forged|tampered)$/, "");
  try {
    const out = await session.json("triage", {
      purpose: "adversarial attacker hypotheses",
      system: "You are an authorized sandbox red-team planner. Reverse-engineer the supplied surface and reused Security weaknesses, then propose attacks a hacker would chain. Each hypothesis MUST use one of the given techniques, an endpoint copied verbatim from the endpoints list, and an identity copied verbatim from the identities list (or \"anonymous\"). Never invent an endpoint, identity, payload, URL, command, file, or id. Prefer endpoints tied to a reused Security weakness and endpoints that reach money, admin, or other users' data.",
      user: `<surface>${JSON.stringify(surface)}</surface>`,
      schema: HypothesisProposal,
      maxTokens: 2400,
    });
    const seen = new Set<string>();
    const hypotheses: AttackHypothesis[] = [];
    for (const h of out.hypotheses) {
      if (!endpoints.has(h.endpoint) || !identities.has(base(h.asIdentity))) continue;
      if (h.crossIdentity && !identities.has(base(h.crossIdentity))) continue;
      const key = `${h.technique} ${h.endpoint} ${h.asIdentity}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hypotheses.push({ technique: h.technique, endpoint: h.endpoint, asIdentity: h.asIdentity, crossIdentity: h.crossIdentity ?? null });
    }
    return { status: "ran", model: session.opts.models.triage ?? null, hypotheses, proposed: out.hypotheses.length, reason: out.rationale };
  } catch (error) {
    return { status: "unavailable", model: session.opts.models.triage ?? null, hypotheses: [], proposed: 0, reason: `The optional attacker planning failed (${(error as Error).message}); the deterministic catalogue still ran.` };
  }
}

const CriticProposal = z.object({ reviews: z.array(z.object({ findingId: z.string(), verdict: z.enum(["supported", "challenge"]), reason: z.string().max(1000) })).max(100), summary: z.string().max(2000) });
export type CriticReview = { status: "ran" | "off" | "unavailable"; model: string | null; challenged: string[]; reason: string };

export async function criticReview(session: AiSession | null, enabled: "auto" | "off", findings: AdversarialFinding[]): Promise<CriticReview> {
  if (enabled === "off") return { status: "off", model: null, challenged: [], reason: "The optional AI critic was disabled." };
  if (!session) return { status: "unavailable", model: null, challenged: [], reason: "No AI provider is configured; deterministic evidence audits remain authoritative." };
  if (!findings.length) return { status: "ran", model: session.opts.models.critic ?? null, challenged: [], reason: "There were no active findings for the critic to challenge." };
  const known = new Set(findings.map((f) => f.id));
  const data = findings.map((f) => ({ id: f.id, status: f.status, severity: f.severity, lane: f.lane, technique: f.rootCause, expected: f.expected, observed: f.observed, executions: f.executionIds.length, sourceEvidence: f.sourceEvidence.length, stateChange: f.stateChange, resetResult: f.resetResult }));
  try {
    const out = await session.json("critic", { purpose: "adversarial evidence critic", system: "Challenge whether each supplied claim is established by its summarized evidence. You may support or challenge an existing finding. You cannot confirm a finding, invent evidence, request arbitrary execution, or change targets.", user: `<project_data>${JSON.stringify(data)}</project_data>`, schema: CriticProposal, maxTokens: 3000 });
    const challenged = [...new Set(out.reviews.filter((x) => x.verdict === "challenge" && known.has(x.findingId)).map((x) => x.findingId))];
    for (const review of out.reviews) {
      if (review.verdict !== "challenge" || !known.has(review.findingId)) continue;
      const finding = findings.find((f) => f.id === review.findingId)!;
      finding.limitations.push(`Optional AI critic challenge: ${review.reason}`);
    }
    return { status: "ran", model: session.opts.models.critic ?? null, challenged, reason: out.summary };
  } catch (error) {
    return { status: "unavailable", model: session.opts.models.critic ?? null, challenged: [], reason: `The optional critic failed (${(error as Error).message}); deterministic evidence audits remain authoritative.` };
  }
}
