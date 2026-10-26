import type { AdversarialRunDetail } from "@cybercheck/contracts";

// A crafted, mixed-outcome AI Adversarial run (vulnerability found, protected, unclear, could not test) shared by the
// results-page and repair e2e specs. SECRET_TAIL is a synthetic secret-looking value that must never reach the UI.

export const SECRET_TAIL = "sk-FORBIDDEN-CANARY-DEADBEEF01";

const step = (seq: number, as: string, target: string, observed: string) => ({ seq, operation: "send_request", inputClass: "synthetic attack request", asIdentity: as, target, expected: "resisted", observed, result: "crossed", executionId: "e1", redacted: true });

export function adversarialRun(): AdversarialRunDetail {
  const campaigns = [
    { id: "adv-f1", seq: 1, lane: "broken_access", techniqueId: "function-authz", priority: "critical", title: "A non-admin cannot call GET /api/admin/overview", target: { componentId: "app", endpoint: "GET /api/admin/overview" }, attacker: "user", resetStrategy: "none", steps: [step(1, "customer", "GET /api/admin/overview", "A 200 response returned administrator data to a normal customer.")], status: "failed", reason: "A 200 response granted access that should have been denied.", executionIds: ["e1"], findingIds: ["A1"], limitations: [], source: "catalogue" },
    { id: "adv-p1", seq: 2, lane: "injection_pivot", techniqueId: "injection-differential", priority: "high", title: "GET /api/rooms/search parameterises query input", target: { componentId: "app", endpoint: "GET /api/rooms/search" }, attacker: "user", resetStrategy: "none", steps: [step(1, "customer", "GET /api/rooms/search?q=...", "Both probes returned the same result.")], status: "passed", reason: "The true-clause and false-clause probes returned the same control result.", executionIds: ["e2"], findingIds: [], limitations: [], source: "catalogue" },
    { id: "adv-u1", seq: 3, lane: "resource_abuse", techniqueId: "unbounded-requests", priority: "medium", title: "GET /api/reports/revenue bounds repeated expensive requests", target: { componentId: "app", endpoint: "GET /api/reports/revenue" }, attacker: "user", resetStrategy: "none", steps: [step(1, "customer", "GET /api/reports/revenue", "Too few attempts were decisive.")], status: "inconclusive", reason: "Too few attempts were sent to decide throttling.", executionIds: ["e3"], findingIds: [], limitations: ["Campaigns ran but none was decided."], source: "catalogue" },
    { id: "adv-b1", seq: 4, lane: "broken_access", techniqueId: "object-authz", priority: "critical", title: "customer cannot read customer-2's record via GET /api/bookings/:id", target: { componentId: "app", endpoint: "GET /api/bookings/:id" }, attacker: "cross_user", resetStrategy: "db_reseed", steps: [step(1, "customer", "GET /api/bookings/{{victim}}", "The attack was not sent.")], status: "blocked", reason: "The campaign did not run.", executionIds: ["e4"], findingIds: [], limitations: ["The campaign did not run."], source: "catalogue" },
  ];
  const findings = [
    { id: "A1", status: "confirmed", severity: "high", lane: "broken_access", title: "A non-admin can call GET /api/admin/overview", componentId: "app", endpoint: "GET /api/admin/overview", rootCause: "function-authz", owasp: ["API5:2023 BFLA"], attacker: "user", boundaryCrossed: "function authorization", assetReached: "an administrator-only function", expected: "The route refuses callers who are not authorized.", observed: "A 200 response granted access that should have been denied.", impact: "A controlled attacker crossed the function authorization boundary and reached an administrator-only function.", remediation: "Enforce role and function authorization on the server for every privileged route, not only in the UI.", campaignIds: ["adv-f1"], chainIds: ["chain-authz-to-money"], executionIds: ["e1"], sourceEvidence: [{ path: "src/app.js", line: 34 }], basis: "execution", confirmation: "Controlled runtime reproduction.", stateChange: null, resetResult: null, limitations: [], related: [] },
  ];
  const chains = [
    { id: "chain-authz-to-money", seq: 1, title: "Function authorization to business-logic abuse", campaignIds: ["adv-f1"], findingIds: ["A1"], links: [{ label: "A non-admin cannot call GET /api/admin/overview", crossed: true, campaignId: "adv-f1", evidence: [{ path: "src/app.js", line: 34 }] }, { label: "GET /api/payments rejects a negative or oversized amount", crossed: false, campaignId: null, evidence: [] }], crossedBoundaries: [], reachedAsset: null, reproducedImpact: null, rootCauses: ["function-authz"], verdict: "inconclusive", reason: "Not every link is proven: GET /api/payments rejects a negative or oversized amount." },
  ];
  return {
    id: "adv-1", snapshotId: "snap-1", projectId: "proj-1", parentRunId: null, status: "completed", phase: "done", decision: "not_ready_adversarial_findings",
    headline: "1 confirmed high or critical finding(s).", error: null,
    createdAt: new Date(Date.now() - 200_000).toISOString(), startedAt: new Date(Date.now() - 180_000).toISOString(), finishedAt: new Date().toISOString(),
    policy: { profile: "standard", aiAttacker: "auto", aiCritic: "off", runtime: "nebius", attackPackIds: [] },
    campaigns, chains, findings,
    executions: [{ id: "e1", kind: "adversarial_campaign", label: "Adversarial campaign", workspace: ".", command: "node harness", network: false, sandbox: { provider: "nebius-sandboxes", operationId: "op-1", imageId: "img" }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 2000, exitCode: 0, timedOut: false, outcome: "ok", outputTail: "ok", artifacts: [], envNames: [], resources: { cpuSeconds: 2, maxRssKb: 1000 }, retryOf: null }],
    usage: { aiCalls: 2, inputTokens: 1200, outputTokens: 300, costUsd: 0.06, sandboxOperations: 5, sandboxCpuSeconds: 20, models: {} },
    report: {
      schemaVersion: 2, engine: "2026-10-19.a2", catalogueVersion: "ac1", compilerVersion: "acc1",
      decision: "not_ready_adversarial_findings", headline: "1 confirmed high or critical finding(s).",
      claims: [],
      applicability: { status: "applicable", reason: "general track applies", tracks: ["general"], entryPoints: 9, components: [], targets: [], unbound: [] },
      surface: { nodes: [{ id: "attacker", kind: "attacker", label: "Attacker" }], edges: [] },
      rulesOfEngagement: { allowedEndpoints: ["GET /api/admin/overview"], allowedIdentities: ["anonymous", "customer", "customer-2", "admin"], allowedTools: [], allowedFiles: [], allowedDataClasses: [], allowedMutationTypes: [], canaries: [], externalNetwork: false, limits: { requests: 300, requestsPerTarget: 30, authAttempts: 20, stepsPerChain: 6, toolCalls: 30, tokens: 600000, timeoutSec: 1800, costUsd: 3, concurrency: 4 } },
      environment: { requested: "nebius", selected: "nebius", provider: "nebius-sandboxes", fallbackReason: null, isolation: "Disposable sandbox, network disabled, synthetic data only." },
      obligations: [], obligationCoverage: { decisive: 3, required: 4, criticalDecisive: 1, criticalRequired: 2 },
      coverage: { decisive: 2, applicable: 4 },
      chains,
      findings: { confirmed: 1, suspected: 0, rejected: 0, inconclusive: 1, blocked: 1, confirmedCriticalHigh: 1 },
      rejectedHypotheses: [],
      reusedSecurity: { securityRunId: null, confirmed: 0, suspected: 0, citedFindingIds: [], note: "No completed Security run was found for this snapshot, so the attacker chained only from its own reconnaissance." },
      setup: [{ name: "customer", kind: "identity", ok: true, detail: "signed in" }, { name: "customer-2", kind: "identity", ok: false, detail: `sign-in answered 500; no session cookie or token came back ${SECRET_TAIL}` }],
      untested: [],
      attacker: { status: "ran", provider: "configured AI gateway", model: "gemini-attacker", hypotheses: 3, uniqueFindings: 1, reason: "Proposed attacks from the reused weaknesses." },
      critic: { status: "off", provider: null, model: null, lowered: 0, reason: "The optional AI critic was disabled." },
      usage: { modelRequests: 2, tokensIn: 1200, tokensOut: 300, costUsd: 0.06, durationMs: 180_000 },
      audit: [{ check: "confirmed evidence owned", ok: true, detail: "Every confirmed finding cites an execution owned by this run." }],
      versions: { engine: "2026-10-19.a2", catalogue: "ac1", compiler: "acc1", snapshotDigest: "abcdef0123456789", attackPackDigests: [], runtimeImage: null, provider: "nebius-sandboxes", model: "gemini-attacker" },
      limitations: [],
    },
  } as unknown as AdversarialRunDetail;
}
