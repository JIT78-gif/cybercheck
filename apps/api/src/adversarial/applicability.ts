import type { AdversarialApplicability, AdversarialTrack, AiApplicability, ProjectDossier } from "@cybercheck/contracts";
import { assessApplicability } from "../ai-evaluator/applicability.ts";
import type { SnapshotSource } from "../understanding/source.ts";

// AI Adversarial applies to any supported web or API app, with two attacker tracks: the general track (any app with
// reachable HTTP endpoints) and the AI track (apps that also contain an AI component). not_applicable only when neither
// track applies. The general track is the offensive chaining layer on top of the Security check; the AI track adds the
// AI-specific lanes.

const ATTACKABLE = (kind: string) => kind === "http" || kind === "webhook" || kind === "graphql";

export type AdvApplicability = {
  applicability: AdversarialApplicability;
  ai: AiApplicability;
  tracks: AdversarialTrack[];
  ownershipOk: boolean;
  entryPoints: number;
};

export function assessAdversarialApplicability(input: { dossier: ProjectDossier; src: SnapshotSource; contentDigest: string }): AdvApplicability {
  const { dossier, src, contentDigest } = input;
  const ai = assessApplicability({ dossier, src, contentDigest });
  // Ownership covers the whole dossier, not only the AI evidence: if the analysis was not made for this snapshot,
  // nothing (general or AI) can be trusted.
  const ownershipOk = dossier.meta.contentDigest === contentDigest;
  const attackable = dossier.entryPoints.filter((e) => ATTACKABLE(e.kind));
  const generalApplicable = ownershipOk && attackable.length > 0;
  const aiApplicable = ownershipOk && ai.status === "applicable";
  const tracks: AdversarialTrack[] = [...(generalApplicable ? (["general"] as const) : []), ...(aiApplicable ? (["ai"] as const) : [])];
  const status: AdversarialApplicability["status"] = tracks.length ? "applicable" : "not_applicable";
  const reason = !ownershipOk
    ? "The analysis does not belong to this snapshot, so nothing about it can be attacked."
    : tracks.length === 0
      ? "No reachable HTTP endpoint and no AI component were found, so there is nothing to attack."
      : `${tracks.join(" and ")} attacker track(s) apply: ${attackable.length} reachable endpoint(s)${aiApplicable ? ` and ${ai.components.length} AI component(s)` : ""}.`;
  const applicability: AdversarialApplicability = {
    status,
    reason,
    tracks,
    entryPoints: attackable.length,
    components: ai.components,
    targets: ai.targets.map((t) => ({ target: t.target, boundBy: t.boundBy, auxiliary: (t.auxiliary ?? {}) as Record<string, unknown> })),
    unbound: ai.unbound.map((u) => ({ componentId: u.componentId, reason: u.reason })),
  };
  return { applicability, ai, tracks, ownershipOk, entryPoints: attackable.length };
}
