import { describe, expect, it } from "vitest";
import { AI_DEFAULT_THRESHOLDS, type AiApplicability, type AiEvaluationCase, type AiEvaluationRunDetail } from "@cybercheck/contracts";
import { BUILTIN_DIGEST } from "../src/ai-evaluator/catalog.ts";
import type { AiComponentInventory, AiEvaluationTarget } from "@cybercheck/contracts";
import { categoryResults, decide, findingsOf, laneObligations, obligationCoverageOf, performanceOf, type LaneContext } from "../src/ai-evaluator/decide.ts";
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
  const base = (cases: AiEvaluationCase[], o: { env?: string | null; obligations?: Parameters<typeof decide>[0]["obligations"] } = {}) => {
    const findings = findingsOf(cases, []);
    const categories = categoryResults(cases, T);
    return decide({ cases, categories, findings, obligations: o.obligations ?? [], thresholds: T, environmentBlocked: o.env ?? null, perf: performanceOf(cases, "replay"), perfMeasured: false }).decision;
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

  it("a required critical lane with no decisive evidence blocks readiness, before case coverage is even checked", () => {
    const ok = (over: Record<string, unknown>) => ({ lane: "prompt_injection" as const, label: "x", required: true, critical: false, why: "", status: "passed" as const, reason: "", cases: 1, decided: 1, caseIds: [], ...over });
    // All lanes decisive: ready.
    expect(base(many(10, {}), { obligations: [ok({}), ok({ lane: "functional" })] })).toBe("ready_with_evidence");
    // A critical lane left unsupported (no case yet): not ready, even though every case passed.
    expect(base(many(10, {}), { obligations: [ok({ critical: true, status: "unsupported" })] })).toBe("not_ready_insufficient_evidence");
    // A required (non-critical) lane undecided drops lane coverage below 100%: not ready.
    expect(base(many(10, {}), { obligations: [ok({}), ok({ lane: "output_rendering", status: "inconclusive" })] })).toBe("not_ready_insufficient_evidence");
  });
});

describe("lane obligations", () => {
  const component = (over: Partial<AiComponentInventory> = {}): AiComponentInventory => ({ id: "ai:1", name: "assistant", kind: "provider_http", provider: { name: "openai", family: "openai_compatible", baseUrlEnv: ["AI_BASE_URL"], apiKeyEnv: ["AI_API_KEY"], hardcodedHosts: [], model: null, interceptable: true, reason: null }, files: [], systemPrompts: [], tools: [], retrieval: [], messageTriggers: [], endpoints: ["POST /api/assistant"], evidence: [], limitations: [], ...over });
  const target = (over: Partial<AiEvaluationTarget> = {}): AiEvaluationTarget => ({ componentId: "ai:1", transport: "http", method: "POST", path: "/api/assistant", requestTemplate: { message: "{{message}}" }, responseSelector: "reply", ...over });
  const ctx = (over: Partial<LaneContext> = {}): LaneContext => ({ component: component(), target: target(), identityCount: 1, ...over });
  const lane = (obs: ReturnType<typeof laneObligations>, name: string) => obs.find((o) => o.lane === name)!;

  it("requires functional, leakage, prompt-injection and reliability for every component", () => {
    const obs = laneObligations([...many(3, {}), ...many(2, { category: "reliability" })], ctx(), T);
    for (const l of ["functional", "leakage", "prompt_injection", "reliability"]) expect(lane(obs, l).required, l).toBe(true);
    expect(lane(obs, "prompt_injection").critical).toBe(true);
    expect(lane(obs, "functional").critical).toBe(false);
  });

  it("requires output rendering only when a page injects the reply as HTML", () => {
    expect(lane(laneObligations(many(2, {}), ctx({ rendersHtml: false }), T), "output_rendering")).toMatchObject({ required: false, status: "not_applicable" });
    expect(lane(laneObligations(many(2, {}), ctx({ rendersHtml: true }), T), "output_rendering")).toMatchObject({ required: true, critical: true });
  });

  it("marks a required safety lane with no case as unsupported, not passed", () => {
    const obs = laneObligations(many(3, {}), ctx(), T);
    expect(lane(obs, "prompt_injection")).toMatchObject({ status: "unsupported", required: true, critical: true });
    // Leakage is carried by the passive reply checks even with no dedicated case.
    expect(lane(obs, "leakage").status).toBe("passed");
    expect(lane(obs, "leakage").reason).toMatch(/passive/i);
  });

  it("requires isolation, tools and grounding only when the component has them", () => {
    const bare = laneObligations(many(2, {}), ctx({ component: component(), target: target() }), T);
    expect(lane(bare, "isolation").required).toBe(false);
    expect(lane(bare, "tools").required).toBe(false);
    expect(lane(bare, "grounding").required).toBe(false);
    const rich = laneObligations(many(2, {}), ctx({ component: component({ tools: [{ name: "cancel_order", evidence: { path: "a", line: 1 }, consequential: true, parameters: [] }] }), target: target({ historyPath: "/api/history", citationSelector: "citations" }), identityCount: 2 }), T);
    expect(lane(rich, "isolation")).toMatchObject({ required: true, critical: true });
    expect(lane(rich, "tools")).toMatchObject({ required: true, critical: true });
    expect(lane(rich, "grounding").required).toBe(true);
  });

  it("treats a message-triggered side effect as a tool obligation", () => {
    const triggered = component({ messageTriggers: [{ pattern: "write file", sink: "file", evidence: { path: "src/ai.js", line: 17 } }] });
    expect(lane(laneObligations(many(2, {}), ctx({ component: triggered }), T), "tools")).toMatchObject({ required: true, critical: true, status: "unsupported" });
  });

  it("settles a lane from its cases and counts required-lane coverage", () => {
    const obs = laneObligations([...many(3, { category: "reliability" }), c({ category: "reliability", hard: [["handled_failure", false]] })], ctx(), T);
    expect(lane(obs, "reliability")).toMatchObject({ status: "failed", cases: 4, decided: 4 });
    const cov = obligationCoverageOf(obs);
    expect(cov.required).toBeGreaterThan(0);
    expect(cov.criticalRequired).toBeGreaterThanOrEqual(2);
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

  it("reports multiple component execution modes explicitly", () => {
    const { report } = buildAiReport({ applicability, cases: [c({ mode: "replay" }), c({ id: "c2", mode: "direct" })], components: [], thresholds: T, modelMode: "auto", modes: ["replay", "direct"], environment: { requested: "auto", selected: "local", provider: "docker", fallbackReason: null, isolation: "x" }, environmentBlocked: null, datasets: [], untested: [], executions: [], snapshotDigest: "s".repeat(64), runtimeImage: "node:22-bookworm" });
    expect(report.mode).toMatchObject({ used: "mixed", reason: expect.stringMatching(/replay, direct/) });
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
