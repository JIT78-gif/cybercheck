import type { AdversarialCampaign, AdversarialFinding, Evidence } from "@cybercheck/contracts";
import type { CatalogCampaign } from "./catalog.ts";
import type { CampaignVerdict } from "./oracle.ts";

/** Where a finding's component id and snapshot source evidence come from: an AI component for the AI track, or the
 *  attacked route's handler (and any cited Security finding) for the general track. */
export type FindingSource = (c: CatalogCampaign) => { componentId: string; evidence: Evidence[] };

const remediation: Record<string, string> = {
  "function-authz": "Enforce role and function authorization on the server for every privileged route, not only in the UI.",
  "object-authz": "Authorize every record read and write against the authenticated owner and tenant, never a client-supplied id alone.",
  "mass-assignment": "Bind only an explicit allow-list of fields from the request; never let the caller set role, owner or tenant.",
  "token-forgery": "Verify the session token's signature and claims on the server; reject tampered or unsigned tokens.",
  "login-throttling": "Rate-limit and lock out repeated failed authentication by account and source.",
  "invalid-quantity": "Validate quantity, amount and price bounds on the server before changing money or inventory state.",
  "duplicate-action": "Make consequential actions idempotent with a server-tracked key so a replay cannot apply twice.",
  "race-condition": "Serialize or transactionally guard balance and inventory updates so concurrent requests cannot double-spend.",
  "injection-differential": "Use parameterised queries and reject or escape untrusted input before it reaches the query.",
  "unbounded-requests": "Bound and rate-limit expensive endpoints per caller.",
  "escalate-to-admin-action": "Require fresh server-side authorization on every privileged state change, independent of how the caller arrived.",
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

/** Finding titles describe the vulnerability that was observed, not the defence the campaign expected.  Keeping this
 * explicit avoids truncated titles ("A non-admin") and inverted claims ("requests are throttled") in customer
 * reports. */
function confirmedTitle(c: CatalogCampaign): string {
  const endpoint = c.target.endpoint || "the affected endpoint";
  const titles: Record<string, string> = {
    "function-authz": `Normal users can access an administrator-only function at ${endpoint}`,
    "object-authz": `A user can access another user's record at ${endpoint}`,
    "mass-assignment": `A caller can set privileged fields through ${endpoint}`,
    "token-forgery": `A forged or unsigned token grants access to ${endpoint}`,
    "login-throttling": `Login attempts are not rate-limited at ${endpoint}`,
    "invalid-quantity": `Invalid business values are accepted by ${endpoint}`,
    "duplicate-action": `A consequential action can be replayed at ${endpoint}`,
    "race-condition": `Concurrent requests violate a protected state invariant at ${endpoint}`,
    "injection-differential": `Untrusted input changes query behaviour at ${endpoint}`,
    "unbounded-requests": `Expensive requests are not bounded at ${endpoint}`,
    "escalate-to-admin-action": `A lower-privilege user can perform an administrator action at ${endpoint}`,
    "direct-prompt-injection": "Direct prompt injection changes protected assistant behaviour",
    "indirect-rag-injection": "Instructions in retrieved content override protected assistant behaviour",
    "system-prompt-leak": "The assistant discloses its protected system prompt or secret",
    "rag-tenant-filter-bypass": "Retrieval returns another tenant's confidential content",
    "cross-tenant-memory-leak": "One user can read another user's private assistant memory",
    "unauthorized-tool-invocation": "The assistant invokes a consequential tool without authorization",
    "approval-bypass-consequential": "A consequential tool runs without required approval",
    "tool-path-escape": "An assistant file tool reads outside its allowed directory",
    "tool-ssrf-local": "An assistant network tool reaches a protected internal service",
    "mcp-description-trust": "Untrusted tool metadata changes protected assistant behaviour",
    "cross-tenant-order-read": "A user can read another tenant's record",
    "unsafe-output-rendering": "Model output executes as active content in the browser",
    "tool-loop-amplification": "Assistant tool calls are not bounded",
    "memory-poison-to-privileged-action": "Poisoned assistant memory triggers a privileged action",
    "citation-spoofing": "The assistant cites a document that was not retrieved",
  };
  return titles[c.techniqueId] ?? `A controlled attack crossed the ${c.boundary} boundary`;
}

export function findingsFromCampaigns(catalogue: CatalogCampaign[], records: AdversarialCampaign[], verdicts: Map<string, CampaignVerdict>, source: FindingSource): AdversarialFinding[] {
  const byId = new Map(catalogue.map((c) => [c.id, c]));
  const findings: AdversarialFinding[] = [];
  for (const record of records) {
    if (record.status === "passed") continue;
    const c = byId.get(record.id);
    const v = verdicts.get(record.id);
    if (!c || !v) continue;
    const src = source(c);
    const status: AdversarialFinding["status"] = record.status === "failed" ? "confirmed" : record.status === "blocked" ? "blocked" : "inconclusive";
    findings.push({
      id: `A${findings.length + 1}`,
      status,
      severity: status === "confirmed" ? c.severity : "info",
      lane: c.lane,
      title: status === "confirmed" ? confirmedTitle(c) : `${c.title}: ${status}`,
      componentId: src.componentId,
      endpoint: c.target.endpoint,
      rootCause: c.techniqueId,
      owasp: c.owasp,
      attacker: c.attacker,
      boundaryCrossed: status === "confirmed" ? c.boundary : "not established",
      assetReached: status === "confirmed" ? c.asset : "not established",
      expected: v.expected,
      observed: v.observed,
      impact: status === "confirmed" ? `A controlled attacker crossed the ${c.boundary} boundary and reached ${c.asset}.` : "The campaign did not produce enough evidence to claim impact.",
      remediation: remediation[c.techniqueId] ?? "Enforce the boundary with a server-side check and add a regression test for this campaign.",
      campaignIds: [c.id],
      chainIds: [],
      executionIds: v.executionIds,
      sourceEvidence: src.evidence.slice(0, 4),
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
