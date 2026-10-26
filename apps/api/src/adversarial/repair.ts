import { eq } from "drizzle-orm";
import type { AdversarialCampaign, AdversarialFinding, Obligation, TestingRepair } from "@cybercheck/contracts";
import { db } from "../db/client.ts";
import { adversarialCampaign } from "../db/schema.ts";
import { DEFAULT_ATTEMPTS, editableSourceFiles, registerRepairAdapter, repairEstimate, type RepairAdapter, type RepairFindingInput } from "../testing/repair.ts";

// AI Adversarial repairs reuse the shared human-review + sandbox-repair engine. The reproduction unit is a confirmed
// attack campaign (not an obligation), so this adapter maps an adversarial finding to the shared prompt input, reads a
// run's campaigns as the before/after the judge compares, and focuses the validation run on the campaign ids. The
// validation run reruns the exact confirming campaigns against the patched overlay with the same identities, fixtures,
// canaries and safety rules; a repair is verified only when those campaigns go from crossed to held and no previously
// held campaign on the same endpoint, lane or component regresses.

/** The campaign's verdict plus each step it took (route, identity, outcome), so a repair model sees the whole attack: a
 *  multi-step attack can cross a boundary on a route other than the one the finding names. Step text is already redacted. */
function campaignReason(c: AdversarialCampaign): string | null {
  const steps = c.steps.slice(0, 6).map((s) => `step ${s.seq}: ${s.target}${s.asIdentity ? ` as ${s.asIdentity}` : ""}${s.inputClass ? ` (${s.inputClass})` : ""}: ${s.result}${s.observed ? `, ${s.observed}` : ""}`);
  return [c.reason, ...steps].filter(Boolean).join(" | ") || null;
}

/** One campaign as the shared Obligation shape the repair judge compares (status "passed" = the attack was resisted). */
function campaignAsObligation(c: AdversarialCampaign): Obligation {
  const endpoint = c.target.endpoint;
  return {
    id: c.id,
    layer: "api",
    asset: { kind: "endpoint", ref: endpoint, label: endpoint },
    objective: c.title,
    priority: c.priority,
    oracle: { source: "policy", expected: "The attack is resisted.", evidence: [] },
    status: c.status,
    reason: campaignReason(c),
    origin: "dossier",
    executionIds: c.executionIds,
    findingIds: c.findingIds,
    // A campaign that reached a decisive verdict proved it ran against the target; blocked/inconclusive did not.
    reachedTarget: c.status === "passed" || c.status === "failed",
  };
}

function findingForRepair(f: AdversarialFinding): RepairFindingInput {
  const where = f.sourceEvidence[0] ?? null;
  return {
    title: f.title,
    expected: f.expected,
    actual: f.observed,
    rootCause: f.rootCause,
    location: where ? { path: where.path, line: where.line } : null,
    reproduction: `${f.confirmation}\nObserved: ${f.observed}\nBoundary crossed: ${f.boundaryCrossed}\nProtected asset reached: ${f.assetReached}\nRecommended control: ${f.remediation}`,
    obligationIds: f.campaignIds,
  };
}

/** Which source files a repair of this finding may change, and the campaigns the validation run must rerun. */
export function adversarialRepairScope(finding: AdversarialFinding, campaigns: AdversarialCampaign[], maxAttempts = DEFAULT_ATTEMPTS): TestingRepair["scope"] {
  const files = editableSourceFiles(finding.sourceEvidence.map((e) => e.path));
  // Regression: campaigns that already held on the same endpoint, lane or component must keep holding after the patch.
  const regression = campaigns
    .filter((c) => !finding.campaignIds.includes(c.id) && c.status === "passed" && (c.target.endpoint === finding.endpoint || c.lane === finding.lane || c.target.componentId === finding.componentId))
    .map((c) => c.id)
    .slice(0, 80);
  return { files, reproduction: finding.campaignIds, regression, maxAttempts, estimate: repairEstimate(maxAttempts) };
}

const adversarialAdapter: RepairAdapter = {
  finding: (d) => findingForRepair(d as AdversarialFinding),
  results: async (runId) => {
    const rows = await db.select().from(adversarialCampaign).where(eq(adversarialCampaign.runId, runId));
    return new Map(rows.map((r) => [r.id, campaignAsObligation(r.data as AdversarialCampaign)] as const));
  },
  rerun: (scope, parentRunId) => ({ parentRunId, campaignIds: [...scope.reproduction, ...scope.regression] }),
  // Validate deterministically: the confirming campaigns are replayed as-is; no attacker/critic model is needed.
  extraPolicy: () => ({ aiAttacker: "off", aiCritic: "off" }),
};

registerRepairAdapter("adversarial", adversarialAdapter);
