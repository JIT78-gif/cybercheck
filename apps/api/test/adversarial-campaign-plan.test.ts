import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { ObjectStore } from "../src/storage/object-store.ts";
import type { CatalogCampaign } from "../src/adversarial/catalog.ts";
import { freezeCampaignPlan, loadCampaignPlan, semanticCampaignId } from "../src/adversarial/campaign-plan.ts";
import { campaignFixtureDependencies } from "../src/adversarial/run.ts";

class MemoryObjects implements ObjectStore {
  readonly values = new Map<string, Buffer>();
  async exists(key: string) { return this.values.has(key); }
  async put(key: string, body: Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    this.values.set(key, Buffer.concat(chunks));
  }
  get(key: string) { return Readable.from([this.values.get(key) ?? Buffer.alloc(0)]); }
}

const campaign = (n: number): CatalogCampaign => {
  const endpoint = `GET /api/records-${n}/:id`;
  const oracle = { kind: "access_denied" as const };
  return {
    id: semanticCampaignId("gen", "object-authz", endpoint, "cross_user", oracle),
    lane: "broken_access",
    techniqueId: "object-authz",
    priority: "high",
    title: `Record ${n} stays private`,
    target: { componentId: "app", endpoint },
    attacker: "cross_user",
    resetStrategy: "fresh_app",
    steps: [{ operation: "send_request", asIdentity: "customer", target: endpoint, inputClass: "synthetic control" }],
    source: "catalogue",
    oracle,
    severity: "high",
    owasp: [],
    asset: "another user's record",
    boundary: "object authorization",
  };
};

describe("stable and frozen adversarial campaign plans", () => {
  it("keeps semantic ids stable across route ordering and changes them when the endpoint changes", () => {
    const a = semanticCampaignId("gen", "object-authz", "GET /api/orders/:id", "cross_user", { kind: "access_denied" });
    const reordered = ["POST /login", "GET /api/orders/:id"].reverse();
    const b = semanticCampaignId("gen", "object-authz", reordered.find((x) => x.startsWith("GET"))!, "cross_user", { kind: "access_denied" });
    const changed = semanticCampaignId("gen", "object-authz", "GET /api/bookings/:id", "cross_user", { kind: "access_denied" });
    expect(b).toBe(a);
    expect(changed).not.toBe(a);
  });

  it("round-trips exactly 17 selected definitions with identical targets, steps, and oracles", async () => {
    const objects = new MemoryObjects();
    const selected = Array.from({ length: 17 }, (_, i) => campaign(i + 1));
    const ref = await freezeCampaignPlan(objects, "00000000-0000-4000-8000-000000000001", "snapshot-digest", selected);
    const frozen = await loadCampaignPlan(objects, ref, "snapshot-digest");
    expect(ref.campaignIds).toHaveLength(17);
    expect(frozen.campaigns).toHaveLength(17);
    expect(frozen.campaigns.map(({ techniqueId, target, steps, oracle }) => ({ techniqueId, target, steps, oracle })))
      .toEqual(selected.map(({ techniqueId, target, steps, oracle }) => ({ techniqueId, target, steps, oracle })));
  });

  it("refuses a changed digest or snapshot", async () => {
    const objects = new MemoryObjects();
    const ref = await freezeCampaignPlan(objects, "00000000-0000-4000-8000-000000000002", "snapshot-digest", [campaign(1)]);
    await expect(loadCampaignPlan(objects, { ...ref, digest: "0".repeat(64) }, "snapshot-digest")).rejects.toThrow(/digest/i);
    await expect(loadCampaignPlan(objects, ref, "different-snapshot")).rejects.toThrow(/snapshot/i);
  });

  it("derives only external setup dependencies and ignores values captured inside the campaign", () => {
    const c = campaign(1);
    c.steps = [
      { operation: "capture", asIdentity: "customer-2", target: "GET /api/orders", inputClass: "capture", capture: { name: "victim", path: "0.id" } },
      { operation: "send_request", asIdentity: "customer", target: "GET /api/orders/{{victim}}?table={{table_id}}", inputClass: "attack", body: { owner: "{{customer-2.id}}" } },
    ];
    expect(campaignFixtureDependencies(c).sort()).toEqual(["customer", "customer-2", "table_id"]);
  });
});
