import { describe, expect, it } from "vitest";
import type { Obligation, TestingRunDetail } from "@cybercheck/contracts";
import { testingRunToMarkdown } from "../src/testing/export.ts";
import { withInvalidSetup } from "../src/testing/report.ts";

const ob = (id: string, extra: Partial<Obligation> = {}): Obligation => ({ id, layer: "api", asset: { kind: "endpoint", ref: id, label: id }, objective: "x", priority: "high", oracle: { source: "policy", expected: "x", evidence: [] }, status: "planned", reason: null, origin: "dossier", executionIds: [], findingIds: [], ...extra });

describe("fixture reliability in the report", () => {
  // Round 45: one setup step ran and worked ("1 of 1") while the invalid sign-in blocked 61 checks.
  const ran = { digest: "abc", nodes: [{ id: "seed", label: "Seed the database", ok: true, detail: "worked" }] };
  const problems = [{ id: "alice", label: "Sign in as Alice", reason: "it uses the setting ALICE_PASSWORD, which the code, its tests and its seed scripts never define" }];
  const obs = [
    ob("api:GET /api/orders:own", { status: "blocked", blockedBy: "fixture", reason: 'Not sent: setup step "alice" did not work' }),
    ob("api:POST /api/orders:authored:1", { status: "inconclusive", fixtureRefs: ["alice"] }),
    ob("api:GET /health:availability", { status: "passed" }),
  ];

  it("lists invalid planned steps as failed with their reason, and counts the checks they blocked", () => {
    const out = withInvalidSetup(ran, problems, obs)!;
    expect(out.nodes).toEqual([ran.nodes[0], { id: "alice", label: "Sign in as Alice", ok: false, detail: expect.stringMatching(/^Not used: it uses the setting ALICE_PASSWORD/), invalid: true }]);
    expect(out.blockedChecks).toBe(2);
    // Reliability is now 1 of 2 planned steps, not 1 of 1.
    expect(out.nodes.filter((n) => n.ok === true).length / out.nodes.length).toBe(0.5);
  });

  it("reports invalid steps even when nothing ran, and nothing when there was no setup at all", () => {
    expect(withInvalidSetup(null, problems, obs)!.nodes).toHaveLength(1);
    expect(withInvalidSetup(null, [], obs)).toBeNull();
    expect(withInvalidSetup(ran, [], [])).toEqual({ ...ran, blockedChecks: 0 });
  });

  it("shows them in the Markdown export", () => {
    const fixtures = withInvalidSetup(ran, problems, obs)!;
    // A finished run's report with only the parts this section needs; the export skips sections that are absent.
    const run = { id: "r1", snapshotId: "s1", status: "succeeded", createdAt: "2026-10-14T10:00:00Z", startedAt: null, finishedAt: null, error: null, obligations: obs, executions: [], findings: [], usage: { aiCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, sandboxOperations: 0, sandboxCpuSeconds: 0 }, report: { verdict: "partial", headline: "Partly tested.", environment: { provider: "nebius", image: "node:22", runtime: null, network: "off", syntheticEnv: [] }, totals: { blocked: 1, inconclusive: 1, passed: 1 }, fixtures, layers: [], measures: [], limitations: [], nextActions: [], audit: [], untested: [], suites: [], claims: [] } } as unknown as TestingRunDetail;
    const md = testingRunToMarkdown(run, "Shop");
    expect(md).toContain("1 planned step(s) were invalid and never used. 2 check(s) could not run because of the setup.");
    expect(md).toMatch(/\| Sign in as Alice \| invalid, not used \|/);
  });
});
