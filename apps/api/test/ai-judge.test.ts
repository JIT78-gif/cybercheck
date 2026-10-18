import { describe, expect, it } from "vitest";
import type { AiEvaluationCase } from "@cybercheck/contracts";
import { calibrate, comparePairwise, judgeCase, rubricFor, scriptedJudge, type JudgeInput } from "../src/ai-evaluator/judge.ts";
import { JUDGE_CALIBRATION } from "../src/ai-evaluator/judge-calibration.ts";

// AI Evaluator step 6: the optional judge. Built behind a provider interface and tested with a scripted provider;
// the real model connects after credits. The judge only settles inconclusive cases, only when calibrated, and never
// confirms a finding.

// A judge that scores by keyword overlap between the expected text and the response.
const overlapJudge = (fail = false) =>
  scriptedJudge((i: JudgeInput) => {
    if (fail) return null;
    const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2));
    const exp = words(i.expected + " " + i.context.join(" "));
    const got = words(i.response);
    if (!exp.size) return 2;
    const share = [...exp].filter((w) => got.has(w)).length / exp.size;
    return share >= 0.5 ? 4 : share >= 0.25 ? 2 : 0;
  });

function caseRec(over: Partial<AiEvaluationCase> & { reply: string }): AiEvaluationCase {
  const { reply, ...rest } = over;
  return {
    id: "c1", seq: 1, category: "functional", priority: "medium", tags: [], title: "t", target: { componentId: "ai:1", endpoint: "POST /api/assistant" }, source: { kind: "uploaded", datasetId: "d", version: "1", digest: "x" }, inputClass: "a question", conversationSetup: "one turn", preconditions: [], reset: "fresh_conversation", oracle: { type: "answer_match", expected: "gives the expected answer" }, samplesPlanned: 1, profile: "standard", mode: "live", graders: [], judge: [],
    samples: [{ sample: 1, mode: "live", turns: [{ as: null, request: "POST /api/assistant", status: 200, ms: 20, reply, error: null }], modelRequests: 1, tokens: { input: 5, output: 5 }, costUsd: 0.001, toolCalls: [], citations: [] }],
    measurements: { medianMs: 20, maxMs: 20, tokensIn: 5, tokensOut: 5, costUsd: 0.001, modelRequests: 1 }, executionIds: ["e1"], sourceEvidence: [], verdict: "inconclusive", evaluator: "deterministic", reason: "no literal match", limitations: [], redacted: true, findingIds: [], ...rest,
  };
}

describe("judge rubric selection", () => {
  it("chooses faithfulness for grounded cases, answer match for answer cases, relevance for functional", () => {
    expect(rubricFor(caseRec({ reply: "x", category: "grounding" }), true)).toBe("faithfulness");
    expect(rubricFor(caseRec({ reply: "x", oracle: { type: "answer_match", expected: "gives the expected answer" } }), false)).toBe("answer_match");
    expect(rubricFor(caseRec({ reply: "x", category: "functional", oracle: { type: "", expected: "" } }), false)).toBe("relevance");
  });
});

describe("judging a case", () => {
  it("scores several samples and passes when the median is at least 3", async () => {
    const out = await judgeCase({ case: caseRec({ reply: "We are open 9 to 5 on weekdays." }), expected: "Open 9 to 5 on weekdays", context: [], samples: 3 }, overlapJudge(), true);
    expect(out.results).toHaveLength(3);
    expect(out.medianScore).toBe(4);
    expect(out.judgePass).toBe(true);
    expect(out.results[0]!.calibrated).toBe(true);
    expect(out.results[0]!.rationale).not.toContain("\n");
  });

  it("fails a response that does not match", async () => {
    const out = await judgeCase({ case: caseRec({ reply: "Here is a poem about the sea." }), expected: "Open 9 to 5 on weekdays", context: [], samples: 3 }, overlapJudge(), true);
    expect(out.judgePass).toBe(false);
  });

  it("is undecided when the judge fails to score", async () => {
    const out = await judgeCase({ case: caseRec({ reply: "x" }), expected: "Open 9 to 5", context: [], samples: 3 }, overlapJudge(true), true);
    expect(out.judgePass).toBeNull();
    expect(out.results.every((r) => r.error)).toBe(true);
  });
});

describe("pairwise regression", () => {
  // A judge that prefers the longer, more detailed answer.
  const lengthJudge = scriptedJudge((i) => Math.min(4, Math.floor(i.response.length / 20)));
  it("maps the preference back to current vs baseline regardless of the random display order", async () => {
    const current = caseRec({ reply: "This is a long and detailed answer with plenty of helpful specifics for the user." });
    const baseline = new Map([[current.id, { reply: "Short." }]]);
    for (const rand of [() => 0.9, () => 0.1]) {
      const out = await comparePairwise([current], baseline, lengthJudge, { expectedOf: () => "", contextOf: () => [], rand });
      expect(out.summary).toMatchObject({ better: 1, worse: 0, compared: 1 });
      expect(out.byCase.get(current.id)!.preference).toBe("candidate");
    }
  });
  it("counts a worse answer and skips cases missing in either run", async () => {
    const current = caseRec({ reply: "Short." });
    const baseline = new Map([[current.id, { reply: "A much longer and more complete baseline answer with detail." }]]);
    const out = await comparePairwise([current, caseRec({ id: "c2", reply: "x" })], baseline, lengthJudge, { expectedOf: () => "", contextOf: () => [], rand: () => 0.9 });
    expect(out.summary).toMatchObject({ better: 0, worse: 1, compared: 1 });
    expect(out.byCase.get(current.id)!.preference).toBe("baseline");
  });
});

describe("calibration", () => {
  // A judge whose scores match the human labels (found by the response text), to test the gate passes.
  const labelOf = (resp: string) => JUDGE_CALIBRATION.examples.find((e) => e.response === resp)?.label;
  const perfect = scriptedJudge((i) => (labelOf(i.response) === "acceptable" ? 4 : labelOf(i.response) === "unacceptable" ? 0 : 2));

  it("passes the gate for a judge that agrees with the labels", async () => {
    const good = await calibrate(perfect, JUDGE_CALIBRATION);
    expect(good.datasetVersion).toBe(JUDGE_CALIBRATION.version);
    expect(good.balancedAccuracy).toBe(1);
    expect(good.f1ByClass).toMatchObject({ acceptable: 1, unacceptable: 1 });
    expect(good.passed).toBe(true);
  });

  it("fails the gate for a judge that cannot tell the classes apart", async () => {
    // Always "acceptable": it never catches a bad answer, so the unacceptable class has no recall.
    const biased = await calibrate(scriptedJudge(() => 4), JUDGE_CALIBRATION);
    expect(biased.passed).toBe(false);
    expect(biased.f1ByClass.unacceptable).toBeLessThan(0.8);
    expect(biased.balancedAccuracy).toBe(0.5);
  });
});
