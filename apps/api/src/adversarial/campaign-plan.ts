import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import type { AdversarialAttacker } from "@cybercheck/contracts";
import type { ObjectStore } from "../storage/object-store.ts";
import type { CatalogCampaign, OracleSpec } from "./catalog.ts";
import { AD_CATALOGUE_VERSION, AD_COMPILER_VERSION, AD_ENGINE_VERSION } from "./version.ts";

/** JSON with deterministic object-key order, used for semantic ids and immutable plan digests. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function normalizedEndpoint(endpoint: string): string {
  const [method, ...rest] = endpoint.trim().split(/\s+/);
  const path = rest.join(" ").replace(/\?.*$/, "").replace(/\/[0-9a-f-]{8,}(?=\/|$)/gi, "/:id").replace(/\/\d+(?=\/|$)/g, "/:id");
  return `${(method || "GET").toUpperCase()} ${path || "/"}`;
}

/** Stable across catalogue ordering; changing the route, role, technique, or oracle produces a different id. */
export function semanticCampaignId(prefix: "gen" | "ai" | "adv", technique: string, endpoint: string, attacker: AdversarialAttacker, oracle: OracleSpec): string {
  const key = canonicalJson({ technique, endpoint: normalizedEndpoint(endpoint), attacker, oracle });
  return `${prefix}-${technique}-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

export type FrozenCampaignPlan = {
  schemaVersion: 1;
  snapshotDigest: string;
  versions: { engine: string; catalogue: string; compiler: string };
  campaigns: CatalogCampaign[];
};

export type FrozenCampaignPlanRef = { key: string; digest: string; campaignIds: string[] };

const digestOf = (body: Buffer | string) => createHash("sha256").update(body).digest("hex");

export async function freezeCampaignPlan(objects: ObjectStore, runId: string, snapshotDigest: string, campaigns: CatalogCampaign[]): Promise<FrozenCampaignPlanRef> {
  const plan: FrozenCampaignPlan = {
    schemaVersion: 1,
    snapshotDigest,
    versions: { engine: AD_ENGINE_VERSION, catalogue: AD_CATALOGUE_VERSION, compiler: AD_COMPILER_VERSION },
    campaigns,
  };
  const body = Buffer.from(canonicalJson(plan));
  const key = `adversarial/${runId}/campaign-plan.json`;
  await objects.put(key, Readable.from([body]));
  return { key, digest: digestOf(body), campaignIds: campaigns.map((c) => c.id) };
}

/** Load only a server-created private plan and verify its digest, snapshot, shape, and unique ids before use. */
export async function loadCampaignPlan(objects: ObjectStore, ref: Pick<FrozenCampaignPlanRef, "key" | "digest">, snapshotDigest: string): Promise<FrozenCampaignPlan> {
  if (!/^adversarial\/[a-z0-9-]+\/campaign-plan\.json$/.test(ref.key)) throw new Error("The frozen campaign-plan key is invalid.");
  const body = await buffer(objects.get(ref.key));
  if (digestOf(body) !== ref.digest) throw new Error("The frozen campaign plan no longer matches its recorded digest.");
  const parsed = JSON.parse(body.toString("utf8")) as Partial<FrozenCampaignPlan>;
  if (parsed.schemaVersion !== 1 || parsed.snapshotDigest !== snapshotDigest || !Array.isArray(parsed.campaigns)) throw new Error("The frozen campaign plan does not belong to this snapshot.");
  const campaigns = parsed.campaigns as CatalogCampaign[];
  if (campaigns.some((c) => !c || typeof c.id !== "string" || typeof c.techniqueId !== "string" || !Array.isArray(c.steps) || !c.oracle)) throw new Error("The frozen campaign plan is malformed.");
  if (new Set(campaigns.map((c) => c.id)).size !== campaigns.length) throw new Error("The frozen campaign plan contains duplicate ids.");
  return parsed as FrozenCampaignPlan;
}
