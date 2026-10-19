import { describe, expect, it } from "vitest";
import type { AdversarialFinding } from "@cybercheck/contracts";
import type { AiSession } from "../src/understanding/ai/gateway.ts";
import type { CatalogCampaign } from "../src/adversarial/catalog.ts";
import { attackerReview, criticReview } from "../src/adversarial/ai.ts";

const campaign = { id: "adv-known", lane: "prompt", techniqueId: "direct-prompt-injection", priority: "high", title: "Known", target: { componentId: "ai:1", endpoint: "POST /ai" }, attacker: "user", resetStrategy: "new_conversation", steps: [], source: "catalogue", oracle: { kind: "leak_marker", marker: "hidden" }, severity: "high", owasp: [], asset: "assistant", boundary: "instruction" } as CatalogCampaign;
const finding = { id: "A1", status: "confirmed", severity: "high", lane: "prompt", title: "Prompt boundary", componentId: "ai:1", endpoint: "POST /ai", rootCause: "direct-prompt-injection", owasp: [], attacker: "user", boundaryCrossed: "instruction", assetReached: "assistant", expected: "held", observed: "crossed", impact: "controlled", remediation: "separate policy", campaignIds: [campaign.id], chainIds: [], executionIds: ["E1"], sourceEvidence: [{ path: "src/ai.ts", line: 1 }], basis: "execution", confirmation: "controlled", stateChange: null, resetResult: null, limitations: [], related: [] } satisfies AdversarialFinding;

const fake = (json: (role: string) => unknown): AiSession => ({
  opts: { models: { triage: "gemini-attacker", critic: "gemini-critic" } },
  json: async (role: string) => json(role),
} as unknown as AiSession);

describe("optional adversarial AI", () => {
  it("accepts only catalogue-owned campaign ids from the attacker", async () => {
    const out = await attackerReview(fake(() => ({ campaignIds: [campaign.id, "invented-shell"], rationale: "ranked" })), "auto", [campaign]);
    expect(out.status).toBe("ran");
    expect(out.campaignIds).toEqual([campaign.id]);
  });

  it("lets the critic challenge but never create or confirm a finding", async () => {
    const copy = structuredClone(finding);
    const out = await criticReview(fake(() => ({ reviews: [{ findingId: "A1", verdict: "challenge", reason: "needs another differential" }, { findingId: "invented", verdict: "supported", reason: "ignore" }], summary: "one challenge" })), "auto", [copy]);
    expect(out.challenged).toEqual(["A1"]);
    expect(copy.status).toBe("confirmed");
    expect(copy.limitations[0]).toMatch(/critic challenge/i);
  });

  it("falls back cleanly when the provider returns 402", async () => {
    const unavailable = fake(() => { throw new Error("Model call failed (HTTP 402): credits exhausted"); });
    expect((await attackerReview(unavailable, "auto", [campaign])).status).toBe("unavailable");
    expect((await criticReview(unavailable, "auto", [structuredClone(finding)])).status).toBe("unavailable");
  });
});
