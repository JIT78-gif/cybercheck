import { z } from "zod";
import type { AdversarialFinding } from "@cybercheck/contracts";
import type { AiSession } from "../understanding/ai/gateway.ts";
import type { CatalogCampaign } from "./catalog.ts";

// Optional AI is deliberately advisory. It receives sanitized catalogue/finding metadata, can only select existing
// campaign ids or challenge an existing claim, and never emits executable operations or confirms a vulnerability.

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
