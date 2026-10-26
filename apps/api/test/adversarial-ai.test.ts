import { describe, expect, it } from "vitest";
import type { AdversarialFinding } from "@cybercheck/contracts";
import type { AiSession } from "../src/understanding/ai/gateway.ts";
import type { CatalogCampaign } from "../src/adversarial/catalog.ts";
import { attackerReview, criticReview, proposeAttackHypotheses, type SanitizedSurface } from "../src/adversarial/ai.ts";

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

describe("Phase 2 AI attacker hypotheses", () => {
  const surface: SanitizedSurface = {
    endpoints: ["GET /api/admin/users", "GET /api/notes/:id", "POST /api/orders"],
    identities: [{ name: "customer", role: "user" }, { name: "customer-2", role: "user" }, { name: "admin", role: "admin" }],
    securityFindings: [{ lane: "broken_access", category: "idor", status: "confirmed", endpoint: "/api/notes/:id" }],
    assets: ["other users' and tenants' records"],
  };

  it("makes zero model calls and returns off when disabled", async () => {
    let called = 0;
    const s = fake(() => { called++; return {}; });
    const out = await proposeAttackHypotheses(s, "off", surface);
    expect(out.status).toBe("off");
    expect(called).toBe(0);
  });

  it("keeps only hypotheses that name a known endpoint and a known identity", async () => {
    const s = fake(() => ({
      hypotheses: [
        { technique: "function-authz", endpoint: "GET /api/admin/users", asIdentity: "customer", rationale: "member hits admin" },
        { technique: "object-authz", endpoint: "GET /api/notes/:id", asIdentity: "customer", crossIdentity: "customer-2", rationale: "idor" },
        { technique: "injection-differential", endpoint: "GET /not/a/route", asIdentity: "customer", rationale: "invented endpoint" },
        { technique: "function-authz", endpoint: "GET /api/admin/users", asIdentity: "intruder", rationale: "invented identity" },
        { technique: "function-authz", endpoint: "GET /api/admin/users", asIdentity: "customer", rationale: "duplicate" },
      ],
      rationale: "ranked by reused weakness",
    }));
    const out = await proposeAttackHypotheses(s, "auto", surface);
    expect(out.status).toBe("ran");
    expect(out.proposed).toBe(5);
    expect(out.hypotheses).toHaveLength(2); // invented endpoint, invented identity, and the duplicate are dropped
    expect(out.hypotheses.map((h) => h.technique)).toEqual(["function-authz", "object-authz"]);
  });

  it("falls back to no hypotheses when the provider is unavailable", async () => {
    const s = fake(() => { throw new Error("Model call failed (HTTP 402): credits exhausted"); });
    const out = await proposeAttackHypotheses(s, "auto", surface);
    expect(out.status).toBe("unavailable");
    expect(out.hypotheses).toHaveLength(0);
  });
});
