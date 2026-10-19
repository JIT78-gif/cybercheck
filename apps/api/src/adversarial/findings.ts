import type { AdversarialCampaign, AdversarialFinding, AiComponentInventory } from "@cybercheck/contracts";
import type { CatalogCampaign } from "./catalog.ts";
import type { CampaignVerdict } from "./oracle.ts";

const remediation: Record<string, string> = {
  "direct-prompt-injection": "Separate instructions from user content, minimize privileged context, and enforce tool/data policy outside the model.",
  "indirect-rag-injection": "Treat retrieved content as untrusted data, sanitize it, and enforce instruction hierarchy outside the model.",
  "system-prompt-leak": "Do not place secrets in prompts; minimize prompt contents and filter protected synthetic markers from output.",
  "rag-tenant-filter-bypass": "Apply tenant filters in the retrieval query using the authenticated server-side tenant.",
  "cross-tenant-memory-leak": "Partition memory by authenticated user and tenant and enforce ownership on every read and write.",
  "unauthorized-tool-invocation": "Authorize every tool call server-side using the current identity, resource ownership, and role.",
  "approval-bypass-consequential": "Require a server-validated, single-use approval bound to the actor, operation, arguments, and expiry.",
  "tool-path-escape": "Resolve paths inside a fixed root and reject any path that escapes after normalization.",
  "tool-ssrf-local": "Allow-list tool destinations and block loopback, link-local, private, and metadata addresses after DNS resolution.",
  "mcp-description-trust": "Treat tool and MCP descriptions as untrusted metadata; never let descriptions define authorization policy.",
  "cross-tenant-order-read": "Filter resource reads by authenticated owner and tenant before returning the record.",
  "unsafe-output-rendering": "Render model output as text or sanitize it with a strict allowlist before inserting it into the DOM.",
  "tool-loop-amplification": "Set hard per-turn tool-call, token, time, and recursion limits enforced outside the model.",
  "memory-poison-to-privileged-action": "Never execute privileged actions from memory or retrieved text without fresh authorization and approval.",
};

export function findingsFromCampaigns(catalogue: CatalogCampaign[], records: AdversarialCampaign[], verdicts: Map<string, CampaignVerdict>, component: AiComponentInventory): AdversarialFinding[] {
  const byId = new Map(catalogue.map((c) => [c.id, c]));
  const findings: AdversarialFinding[] = [];
  for (const record of records) {
    if (record.status === "passed") continue;
    const c = byId.get(record.id);
    const v = verdicts.get(record.id);
    if (!c || !v) continue;
    const status: AdversarialFinding["status"] = record.status === "failed" ? "confirmed" : record.status === "blocked" ? "blocked" : "inconclusive";
    findings.push({
      id: `A${findings.length + 1}`,
      status,
      severity: status === "confirmed" ? c.severity : "info",
      lane: c.lane,
      title: status === "confirmed" ? c.title.replace(/ is refused$| does not .*$| cannot .*$| stays .*$| needs .*$/, "") : `${c.title}: ${status}`,
      componentId: component.id,
      endpoint: c.target.endpoint,
      rootCause: c.techniqueId,
      owasp: c.owasp,
      attacker: c.attacker,
      boundaryCrossed: status === "confirmed" ? c.boundary : "not established",
      assetReached: status === "confirmed" ? c.asset : "not established",
      expected: v.expected,
      observed: v.observed,
      impact: status === "confirmed" ? `A controlled attacker crossed the ${c.boundary} boundary and reached ${c.asset}.` : "The campaign did not produce enough evidence to claim impact.",
      remediation: remediation[c.techniqueId] ?? "Enforce the boundary outside the AI model and add a regression test for this campaign.",
      campaignIds: [c.id],
      chainIds: [],
      executionIds: v.executionIds,
      sourceEvidence: component.evidence.slice(0, 4),
      basis: "execution",
      confirmation: status === "confirmed" ? `Controlled runtime reproduction: ${v.detail}` : v.detail,
      stateChange: c.oracle.kind === "state_unchanged" || c.oracle.kind === "no_privileged_action" ? { before: "synthetic fixture in its safe state", after: v.observed } : null,
      resetResult: record.resetStrategy === "none" ? null : "The campaign ran in a disposable application instance; later campaigns started from the prepared clean image.",
      limitations: record.limitations,
      related: [],
    });
    record.findingIds = [findings.at(-1)!.id];
  }
  return findings;
}
