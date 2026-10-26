import { describe, expect, it } from "vitest";
import { findingsFromCampaigns } from "../src/adversarial/findings.ts";
import { adversarialRunToMarkdown } from "../src/adversarial/export.ts";

describe("plain-language adversarial reporting", () => {
  it("uses vulnerability wording rather than the expected defence wording", () => {
    const campaign = { id: "login", lane: "auth_takeover", techniqueId: "login-throttling", priority: "high", title: "Repeated failed logins are throttled", target: { componentId: "app", endpoint: "POST /api/login" }, attacker: "anonymous", resetStrategy: "fresh_app", steps: [], source: "catalogue", oracle: { kind: "rate_limited" }, severity: "medium", owasp: [], asset: "authentication", boundary: "rate limiting" } as never;
    const record = { id: "login", status: "failed", resetStrategy: "fresh_app", findingIds: [] } as never;
    const verdict = { status: "failed", confirmed: true, severity: "medium", detail: "12 attempts were accepted", expected: "Attempts are rate-limited", observed: "12 attempts were accepted", executionIds: ["E1"], evidence: [{ path: "src/app.js", line: 1 }] } as never;
    const findings = findingsFromCampaigns([campaign], [record], new Map([["login", verdict]]), () => ({ componentId: "app", evidence: [{ path: "src/app.js", line: 1 }] }));
    expect(findings[0]!.title).toBe("Login attempts are not rate-limited at POST /api/login");
  });

  it("prints None for empty chains and explains findings with expected and observed behaviour", () => {
    const run = {
      status: "completed", profile: "standard", error: null, parentRunId: "parent-1",
      findings: [{ status: "confirmed", severity: "high", lane: "prompt", title: "The assistant leaks its prompt", endpoint: "POST /api/assistant", componentId: "ai:1", confirmation: "A controlled request reproduced it.", expected: "The prompt remains private.", observed: "The prompt was returned.", impact: "Instructions were exposed.", remediation: "Do not return protected context.", campaignIds: ["C1"], executionIds: ["E1"], sourceEvidence: [{ path: "src/agent.js", line: 2 }], limitations: [] }],
      report: { decision: "not_ready_adversarial_findings", headline: "One high finding.", coverage: { decisive: 1, applicable: 1 }, accounting: { selected: 17, compiled: 15, attempted: 1, decisive: 1, blocked: 0, compilerRejected: 2 }, setup: [{ name: "customer sign-in", kind: "identity", ok: false, detail: "HTTP 401" }], findings: { confirmed: 1, suspected: 0, inconclusive: 0, blocked: 0 }, chains: [], obligations: [], audit: [], environment: { selected: "local", provider: "docker", isolation: "isolated" }, attacker: { status: "off", reason: "off" }, critic: { status: "off", reason: "off" }, usage: { modelRequests: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 }, limitations: [], untested: [], engine: "e", catalogueVersion: "c", compilerVersion: "p" },
    } as never;
    const md = adversarialRunToMarkdown(run, "fixture");
    expect(md).toMatch(/Confirmed attack chains\n\nNone\./);
    expect(md).toContain("Targeted rerun:");
    expect(md).toContain("not a new full-project score");
    expect(md).toContain("What should have happened: The prompt remains private.");
    expect(md).toContain("What actually happened: The prompt was returned.");
    expect(md).toContain("17 selected, 15 compiled");
    expect(md).toContain("## Test setup");
    expect(md).toContain("customer sign-in (identity): HTTP 401");
  });
});
