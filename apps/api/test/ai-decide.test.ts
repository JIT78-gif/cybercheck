import { describe, expect, it } from "vitest";
import { AI_DEFAULT_THRESHOLDS, type AiApplicability, type AiEvaluationCase, type AiEvaluationRunDetail } from "@cybercheck/contracts";
import { BUILTIN_DIGEST } from "../src/ai-evaluator/catalog.ts";
import { categoryResults, decide, findingsOf, performanceOf } from "../src/ai-evaluator/decide.ts";
import { aiRunToMarkdown } from "../src/ai-evaluator/export.ts";
import { redactAiRun } from "../src/ai-evaluator/redact.ts";
import { buildAiReport } from "../src/ai-evaluator/report.ts";

// AI Evaluator Steps E and F: category results with denominators, findings from deterministic failures only, the
// release decision chain, the report's audit, and a redacted export.

let n = 0;
function c(o: Partial<AiEvaluationCase> & { hard?: Array<[string, boolean | null]>; hygiene?: Array<[string, boolean | null]>; ms?: number } = {}): AiEvaluationCase {
  const { hard = [["reply_present", true]], hygiene = [["no_credential", true]], ms = 100, ...rest } = o;
  const graders = [...hard.map(([g, pass]) => ({ grader: g, version: "g", pass, hard: true, detail: `${g} ${pass}` })), ...hygiene.map(([g, pass]) => ({ grader: g, version: "g", pass, hard: true, detail: pass === false ? "The reply contains 1 credential-like value." : "clean" }))];
  const failed = hard.some(([, p]) => p === false);
  const open = hard.some(([, p]) => p === null);
  return {
    id: `case-${++n}`,
    seq: n,
    category: "functional",
    priority: "high",
    tags: [],
    title: "t",
    target: { componentId: "ai:1", endpoint: "POST /api/assistant" },
    source: { kind: "builtin", datasetId: null, version: "c", digest: BUILTIN_DIGEST },
    inputClass: "ordinary question",
    conversationSetup: "one turn",
    preconditions: [],
    reset: "fresh_conversation",
    oracle: { type: "reply_present", expected: "A reply." },
    samplesPlanned: 1,
    profile: "standard",
    mode: "replay",
    graders,
    judge: [],
    samples: [{ sample: 1, mode: "replay", turns: [{ as: "customer", request: "POST /api/assistant", status: 200, ms, reply: "ok", error: null }], modelRequests: 1, tokens: { input: 10, output: 2 }, costUsd: 0, toolCalls: [], citations: [] }],
    measurements: { medianMs: ms, maxMs: ms, tokensIn: 10, tokensOut: 2, costUsd: 0, modelRequests: 1 },
    executionIds: ["exec-1"],
    sourceEvidence: [],
    verdict: failed ? "failed" : open ? "inconclusive" : "passed",
    evaluator: "deterministic",
    reason: "",
    limitations: [],
    redacted: true,
    findingIds: [],
    ...rest,
  };
}
const many = (k: number, o: Parameters<typeof c>[0]) => Array.from({ length: k }, () => c(o));
const T = AI_DEFAULT_THRESHOLDS;

describe("category results", () => {
  it("scores each category as passed of decided, against its frozen threshold", () => {
    const cats = categoryResults([...many(9, {}), c({ hard: [["contains", false]] }), ...many(8, { category: "reliability" }), ...many(2, { category: "reliability", hard: [["handled_failure", false]] })], T);
    const f = cats.find((x) => x.category === "functional")!;
    expect(f).toMatchObject({ status: "passed", passed: 9, failed: 1, applicable: 10, threshold: 0.85 });
    expect(f.score).toBeCloseTo(0.9);
    expect(cats.find((x) => x.category === "reliability")).toMatchObject({ status: "failed", passed: 8, failed: 2, threshold: 0.9 });
  });

  it("is insufficient when too many cases are undecided, and never counts blocked as passed", () => {
    const cats = categoryResults([...many(5, { category: "grounding" }), ...many(3, { category: "grounding", hard: [["citation_context", null]] })], T);
    expect(cats.find((x) => x.category === "grounding")).toMatchObject({ status: "insufficient", passed: 5, undecided: 3 });
  });

  it("reports the passive reply checks as a leakage line", () => {
    const cats = categoryResults([...many(3, {}), c({ hygiene: [["no_credential", false]] })], T);
    expect(cats.find((x) => x.category === "leakage")).toMatchObject({ status: "failed", passed: 3, failed: 1 });
  });
});

describe("findings", () => {
  it("groups the same hygiene failure on one route into one confirmed finding citing every case", () => {
    const cases = [...many(3, { hygiene: [["no_credential", false]] }), c({})];
    const f = findingsOf(cases, []);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ status: "confirmed", severity: "critical", category: "leakage", rootCause: "no_credential", basis: "deterministic" });
    expect(f[0]!.caseIds).toHaveLength(3);
    expect(cases.slice(0, 3).every((x) => x.findingIds.includes("AIF-1"))).toBe(true);
    expect(f[0]!.limitations[0]).toMatch(/replay model/);
  });

  it("a failed case yields a finding per failing check; an app that stops is high; passed or undecided cases yield none", () => {
    const f = findingsOf([c({ category: "reliability", priority: "medium", hard: [["handled_failure", false], ["app_alive", false]] }), c({ hard: [["contains", null]] })], []);
    expect(f.map((x) => [x.rootCause, x.severity])).toEqual([["reliability:app_alive", "high"], ["reliability:handled_failure", "medium"]]);
  });
});

describe("decision", () => {
  const base = (cases: AiEvaluationCase[], o: { env?: string | null } = {}) => {
    const findings = findingsOf(cases, []);
    const categories = categoryResults(cases, T);
    return decide({ cases, categories, findings, thresholds: T, environmentBlocked: o.env ?? null, perf: performanceOf(cases, "replay"), perfMeasured: false }).decision;
  };
  it("follows the chain: environment, confirmed high/critical, thresholds, critical undecided, coverage, ready", () => {
    expect(base(many(5, {}), { env: "no runtime" })).toBe("not_ready_environment_blocked");
    expect(base([...many(5, {}), c({ hygiene: [["no_prompt_echo", false]] })])).toBe("not_ready_ai_findings");
    expect(base([...many(5, {}), ...many(2, { hard: [["contains", false]], priority: "low" })])).toBe("not_ready_ai_findings");
    expect(base([...many(10, {}), c({ priority: "critical", hard: [["contains", null]] })])).toBe("not_ready_insufficient_evidence");
    expect(base([...many(8, {}), ...many(2, { category: "grounding", hard: [["citation_context", null]] }), ...many(8, { category: "grounding" })])).toBe("not_ready_insufficient_evidence");
    expect(base(many(10, {}))).toBe("ready_with_evidence");
    expect(base([])).toBe("not_ready_insufficient_evidence");
  });
});

describe("report and export", () => {
  const applicability: AiApplicability = { status: "applicable", reason: "1 component", components: [], candidates: [], targets: [], unbound: [], unsupported: [], ownership: { ok: true, checked: 3, failed: [] } };
  const build = (cases: AiEvaluationCase[]) =>
    buildAiReport({ applicability, cases, components: [], thresholds: T, modelMode: "auto", modes: ["replay"], environment: { requested: "auto", selected: "local", provider: "docker", fallbackReason: null, isolation: "x" }, environmentBlocked: null, datasets: [], untested: [{ what: "Repository-derived cases", reason: "not built" }], executions: [], snapshotDigest: "s".repeat(64), runtimeImage: "node:22-bookworm" });

  it("audits ownership, redaction and that nothing passes without execution", () => {
    const { report } = build([...many(3, {}), c({ source: { kind: "uploaded", datasetId: "x", version: "1", digest: "unknown" } }), c({ samples: [] })]);
    const audit = Object.fromEntries(report.audit.map((a) => [a.check, a.ok]));
    expect(audit["cases belong to this run's catalogue and datasets"]).toBe(false);
    expect(audit["no verdict without execution"]).toBe(false);
    expect(audit["credentials redacted"]).toBe(true);
    expect(report.claims.join(" ")).toMatch(/do not establish the real model's answer quality/);
    expect(report.judge.status).toBe("off");
    expect(report.performance.costBasis).toBe("not_measured");
  });

  it("flags an unredacted credential in stored samples", () => {
    const leaky = c({});
    leaky.samples[0]!.turns[0]!.reply = "key sk-live-abcdefghijklmnopqrstuvwxyz012345";
    expect(build([leaky]).report.audit.find((a) => a.check === "credentials redacted")!.ok).toBe(false);
  });

  it("exports Markdown with every section and nothing secret", () => {
    const cases = [...many(3, {}), c({ hygiene: [["no_credential", false]] })];
    const { report, findings } = build(cases);
    const run = { id: "run-1", snapshotId: "s", projectId: "p", status: "completed", phase: "done", step: null, progress: null, headline: report.headline, decision: report.decision, mode: "replay", profile: "standard", counts: { cases: 4, decisive: 4, passed: 4, failed: 0, confirmed: 1, suspected: 0 }, parentRunId: null, error: null, createdAt: "2026-10-17T00:00:00Z", startedAt: null, finishedAt: null, policy: { profile: "standard", judge: "auto", modelMode: "auto", runtime: "auto", datasetIds: [] }, cases, findings, executions: [], report, usage: { aiCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, sandboxOperations: 0, sandboxCpuSeconds: 0, models: {} } } as AiEvaluationRunDetail;
    run.cases[0]!.samples[0]!.turns[0]!.reply = "Bearer abcdefghijklmnop CCAI-CTX-123abc";
    const md = aiRunToMarkdown(redactAiRun(run), "shop");
    for (const s of ["## Decision", "## Coverage", "Metrics:", "## Findings", "AIF-1", "## Cases", "## Untested and blocked", "## Audit"]) expect(md).toContain(s);
    const json = JSON.stringify(redactAiRun(run));
    expect(json).not.toContain("abcdefghijklmnop");
    expect(json).not.toContain("CCAI-CTX-123abc");
    expect(json).toContain("[canary:CTX]");
    expect(md).not.toMatch(new RegExp(String.fromCharCode(0x2014)));
  });
});
