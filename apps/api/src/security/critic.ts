import { z } from "zod";
import type { SecurityFinding, SecurityReport } from "@cybercheck/contracts";
import type { AiSession } from "../understanding/ai/gateway.ts";

// Optional and non-authoritative: the critic sees only sanitized finding metadata and can only review an existing
// finding id. It cannot invent a target, payload, command or proof, and its answer never confirms a finding.
const Output = z.object({
  reviews: z.array(z.object({ findingId: z.string(), verdict: z.enum(["supported", "challenge"]), reason: z.string().max(1000) })).max(100),
  summary: z.string().max(2000),
});

export async function reviewSecurityEvidence(session: AiSession | null, enabled: "auto" | "off", findings: SecurityFinding[]): Promise<NonNullable<SecurityReport["critic"]>> {
  if (enabled === "off") return { ran: false, reason: "The optional AI critic was disabled.", proposals: 0, accepted: 0, model: null, reviews: [] };
  if (!session) return { ran: false, reason: "No AI provider is configured; deterministic evidence audits remain authoritative.", proposals: 0, accepted: 0, model: null, reviews: [] };
  if (!findings.length) return { ran: true, reason: "There were no findings for the critic to challenge.", proposals: 0, accepted: 0, model: session.opts.models.critic ?? null, reviews: [] };
  const known = new Set(findings.map((f) => f.id));
  const data = findings.map((f) => ({
    id: f.id,
    status: f.status,
    severity: f.severity,
    lane: f.lane,
    category: f.category,
    basis: f.basis ?? "static_only",
    expected: f.expected,
    observed: f.observed,
    confirmation: f.confirmation,
    sourceEvidence: f.evidence.length,
    executionEvidence: f.executionIds.length,
    proofEvidence: f.proofIds?.length ?? 0,
  }));
  try {
    const out = await session.json("critic", {
      purpose: "security evidence critic",
      system: "Review only the supplied finding ids and challenge claims whose summarized evidence does not establish their stated basis or impact. Do not invent evidence, commands, payloads, targets, identities, files or proof types. You cannot confirm a vulnerability or change a verdict.",
      user: `<project_data>${JSON.stringify(data)}</project_data>`,
      schema: Output,
      maxTokens: 3500,
    });
    const reviews = out.reviews.filter((r) => known.has(r.findingId));
    return { ran: true, reason: out.summary, proposals: out.reviews.length, accepted: reviews.length, model: session.opts.models.critic ?? null, reviews };
  } catch (error) {
    return { ran: false, reason: `The optional AI critic failed (${(error as Error).message}); deterministic evidence audits remain authoritative.`, proposals: 0, accepted: 0, model: session.opts.models.critic ?? null, reviews: [] };
  }
}
