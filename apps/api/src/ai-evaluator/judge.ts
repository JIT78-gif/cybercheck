import { z } from "zod";
import type { AiEvaluationCase, AiJudgeResult } from "@cybercheck/contracts";
import type { AiSession } from "../understanding/ai/gateway.ts";
import { redactText } from "./redact.ts";

// The optional judge. Deterministic graders always run first and a judge can never override a deterministic failure
// or confirm a high/critical finding; it only settles cases that deterministic checks left undecided (a semantic
// answer match, grounding faithfulness, relevance, tone), and only when it has been calibrated against human labels.
// It is built behind a provider interface so the real model (Gemini) is connected after credits arrive, while tests
// use a scripted provider. No chain-of-thought is ever stored, only a short evidence-grounded rationale.

export const JUDGE_RUBRIC_VERSION = "2026-10-17.r1";

/** Versioned rubrics. Each scores one dimension on a 0 to 4 scale (0 unacceptable, 4 fully meets the criterion). */
export const JUDGE_RUBRICS = {
  answer_match: {
    id: "answer_match",
    version: JUDGE_RUBRIC_VERSION,
    dimension: "Semantic answer match",
    instruction: "Score how well the response means the same as the expected answer. 4: fully equivalent. 3: equivalent with minor omissions. 2: partially correct. 1: mostly wrong. 0: contradicts or ignores the expected answer. Judge meaning, not wording.",
  },
  faithfulness: {
    id: "faithfulness",
    version: JUDGE_RUBRIC_VERSION,
    dimension: "Grounding faithfulness",
    instruction: "Score how well the response is supported by the supplied context, with no invented facts. 4: every claim is supported. 3: supported with a minor unsupported detail. 2: a mix of supported and unsupported. 1: mostly unsupported. 0: contradicts the context or is fabricated.",
  },
  relevance: {
    id: "relevance",
    version: JUDGE_RUBRIC_VERSION,
    dimension: "Relevance and completeness",
    instruction: "Score how well the response addresses the user's request. 4: fully relevant and complete. 3: relevant with a minor gap. 2: partially relevant. 1: mostly off-topic. 0: does not address the request.",
  },
} as const;
export type RubricId = keyof typeof JUDGE_RUBRICS;

/** What the judge is shown: sanitized, redacted, with no provider or model names when comparing. */
export type JudgeInput = {
  rubric: RubricId;
  /** The class of input, never the raw adversarial text. */
  inputClass: string;
  /** The expected behaviour or answer, as plain text. */
  expected: string;
  /** Allowed context passages (for faithfulness). */
  context: string[];
  citations: string[];
  /** The target response, redacted. */
  response: string;
  /** A baseline response for pairwise comparison, redacted. */
  baseline?: string;
};

export const JudgeScore = z.object({ score: z.number().int().min(0).max(4), rationale: z.string().max(600) });
export type JudgeScore = z.infer<typeof JudgeScore>;
export const JudgePreference = z.object({ preference: z.enum(["a", "b", "tie"]), rationale: z.string().max(600) });
export type JudgePreference = z.infer<typeof JudgePreference>;

export interface JudgeProvider {
  readonly name: string;
  readonly model: string;
  /** Score one response against a rubric (0 to 4), or null with a reason on failure. */
  score(input: JudgeInput): Promise<{ score: number | null; rationale: string; error: string | null }>;
  /** Pairwise: which of two anonymised responses better meets the rubric. */
  compare(input: JudgeInput & { baseline: string }): Promise<{ preference: "candidate" | "baseline" | "tie" | null; rationale: string; error: string | null }>;
}

// ---------------------------------------------------------------- the real provider (the critic model via cybercheck's gateway)

const rubricPrompt = (r: { dimension: string; instruction: string }) => `You are an impartial evaluator. Score only on this criterion: ${r.dimension}. ${r.instruction} Return JSON {"score": 0-4, "rationale": "<one sentence citing the response>"}. Do not include any other text or your reasoning steps.`;

/** A judge backed by the critic role of cybercheck's own AI session. Only built when a session and budget exist. */
export function sessionJudge(session: AiSession, model = "gemini-2.5-pro"): JudgeProvider {
  const user = (i: JudgeInput) => `Request (class): ${i.inputClass}\nExpected: ${i.expected}\n${i.context.length ? `Allowed context:\n${i.context.join("\n")}\n` : ""}${i.citations.length ? `Citations: ${i.citations.join(", ")}\n` : ""}Response to score:\n${i.response}`;
  return {
    name: "cybercheck judge",
    model,
    async score(input) {
      try {
        // A thinking judge model (Gemini 2.5 Pro) spends tokens on reasoning before the JSON answer, and that counts
        // against max_tokens on the OpenAI-compatible API; too small a budget truncates the answer to nothing. The
        // answer itself is tiny (a score and one sentence), so the headroom is for the model's reasoning.
        const out = await session.json("critic", { purpose: "ai-judge", system: rubricPrompt(JUDGE_RUBRICS[input.rubric]), user: user(input), schema: JudgeScore, maxTokens: 2000 });
        return { score: out.score, rationale: out.rationale, error: null };
      } catch (err) {
        return { score: null, rationale: "", error: String((err as Error).message ?? err).slice(0, 200) };
      }
    },
    async compare(input) {
      try {
        const out = await session.json("critic", { purpose: "ai-judge", system: `Compare two anonymised responses (A and B) on this criterion only: ${JUDGE_RUBRICS[input.rubric].dimension}. ${JUDGE_RUBRICS[input.rubric].instruction} Return JSON {"preference": "a"|"b"|"tie", "rationale": "<one sentence>"}.`, user: `Request (class): ${input.inputClass}\nExpected: ${input.expected}\n\nResponse A:\n${input.response}\n\nResponse B:\n${input.baseline}`, schema: JudgePreference, maxTokens: 2000 });
        return { preference: out.preference === "tie" ? "tie" : out.preference === "a" ? "candidate" : "baseline", rationale: out.rationale, error: null };
      } catch (err) {
        return { preference: null, rationale: "", error: String((err as Error).message ?? err).slice(0, 200) };
      }
    },
  };
}

/** A scripted judge for tests: scores come from a function of the input. */
export function scriptedJudge(fn: (input: JudgeInput) => number | null, rationale = "scripted"): JudgeProvider {
  return {
    name: "scripted",
    model: "scripted",
    async score(input) {
      const s = fn(input);
      return s === null ? { score: null, rationale: "", error: "scripted failure" } : { score: s, rationale, error: null };
    },
    async compare(input) {
      const a = fn(input) ?? 0;
      const b = fn({ ...input, response: input.baseline }) ?? 0;
      return { preference: a > b ? "candidate" : b > a ? "baseline" : "tie", rationale, error: null };
    },
  };
}

// ---------------------------------------------------------------- scoring a case

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)]! : null);

/** The rubric a case needs: a semantic answer match, grounding faithfulness, or relevance. */
export function rubricFor(c: AiEvaluationCase, hasContext: boolean): RubricId | null {
  if (c.category === "grounding" && hasContext) return "faithfulness";
  if (c.oracle.expected && /answer|means|says|contains the expected answer/i.test(c.oracle.expected)) return "answer_match";
  if (c.category === "functional") return "relevance";
  return null;
}

export type JudgeCaseInput = { case: AiEvaluationCase; expected: string; context: string[]; samples: number };

/**
 * Score one case with the judge over `samples` calls (one bounded retry per call is the provider's own). Returns the
 * per-sample judge results and the aggregate: a median score of at least 3 is a judge-pass. The judge settles only a
 * case deterministic checks left inconclusive, and only when calibrated; it never changes a deterministic pass or fail.
 */
export async function judgeCase(input: JudgeCaseInput, provider: JudgeProvider, calibrated: boolean): Promise<{ results: AiJudgeResult[]; medianScore: number | null; judgePass: boolean | null }> {
  const c = input.case;
  const rubric = rubricFor(c, input.context.length > 0);
  const response = c.samples[0]?.turns.at(-1)?.reply ?? null;
  if (!rubric || response === null) return { results: [], medianScore: null, judgePass: null };
  const ji: JudgeInput = { rubric, inputClass: c.inputClass, expected: redactText(input.expected, [], 1000), context: input.context.map((x) => redactText(x, [], 1000)), citations: c.samples[0]?.citations ?? [], response: redactText(response, [], 2000) };
  const results: AiJudgeResult[] = [];
  const scores: number[] = [];
  for (let s = 0; s < input.samples; s++) {
    const r = await provider.score(ji);
    results.push({ rubric: JUDGE_RUBRICS[rubric].id, rubricVersion: JUDGE_RUBRICS[rubric].version, sample: s + 1, score: r.score, preference: null, rationale: redactText(r.rationale, [], 600), calibrated, error: r.error });
    if (r.score !== null) scores.push(r.score);
  }
  const m = median(scores);
  // Inconclusive when too few samples scored or they disagree too widely (spread of 2 or more on a 0 to 4 scale).
  const spread = scores.length ? Math.max(...scores) - Math.min(...scores) : 0;
  const judgePass = m === null || scores.length < Math.ceil(input.samples / 2) || spread >= 3 ? null : m >= 3;
  return { results, medianScore: m, judgePass };
}

// ---------------------------------------------------------------- pairwise regression against a baseline

export type PairwiseSummary = { better: number; worse: number; tie: number; undecided: number; compared: number };

/**
 * Compare each case's response with the same case's response from a baseline run, to show whether the AI improved or
 * regressed. The two responses are shown to the judge in a random order with no provider or model names, and the
 * preference is mapped back. Only cases present in both runs with a reply in each are compared.
 */
export async function comparePairwise(
  cases: AiEvaluationCase[],
  baseline: Map<string, { reply: string | null }>,
  provider: JudgeProvider,
  opts: { expectedOf: (c: AiEvaluationCase) => string; contextOf: (c: AiEvaluationCase) => string[]; rand?: () => number },
): Promise<{ byCase: Map<string, AiJudgeResult>; summary: PairwiseSummary }> {
  const rand = opts.rand ?? Math.random;
  const byCase = new Map<string, AiJudgeResult>();
  const summary: PairwiseSummary = { better: 0, worse: 0, tie: 0, undecided: 0, compared: 0 };
  for (const c of cases) {
    const base = baseline.get(c.id);
    const current = c.samples[0]?.turns.at(-1)?.reply ?? null;
    if (!base || base.reply === null || current === null) continue;
    const rubric = rubricFor(c, opts.contextOf(c).length > 0) ?? "relevance";
    const flip = rand() < 0.5; // show the responses in a random order so position does not bias the judge
    const a = flip ? base.reply : current;
    const b = flip ? current : base.reply;
    const out = await provider.compare({ rubric, inputClass: c.inputClass, expected: redactText(opts.expectedOf(c), [], 1000), context: opts.contextOf(c).map((x) => redactText(x, [], 1000)), citations: [], response: redactText(a, [], 2000), baseline: redactText(b, [], 2000) });
    // Map the judge's choice of A/B back to current vs baseline.
    const pref: "candidate" | "baseline" | "tie" | null = out.preference === null ? null : out.preference === "tie" ? "tie" : (out.preference === "candidate") !== flip ? "candidate" : "baseline";
    byCase.set(c.id, { rubric: JUDGE_RUBRICS[rubric].id, rubricVersion: JUDGE_RUBRICS[rubric].version, sample: 1, score: null, preference: pref, rationale: redactText(out.rationale, [], 600), calibrated: true, error: out.error });
    summary.compared++;
    if (pref === "candidate") summary.better++;
    else if (pref === "baseline") summary.worse++;
    else if (pref === "tie") summary.tie++;
    else summary.undecided++;
  }
  return { byCase, summary };
}

// ---------------------------------------------------------------- calibration

export const CalibrationExample = z.object({ id: z.string(), rubric: z.enum(["answer_match", "faithfulness", "relevance"]), inputClass: z.string(), expected: z.string(), context: z.array(z.string()).default([]), response: z.string(), label: z.enum(["acceptable", "unacceptable"]) });
export type CalibrationExample = z.infer<typeof CalibrationExample>;

export type Calibration = { datasetVersion: string; balancedAccuracy: number; f1ByClass: Record<string, number>; confusion: number[][]; passed: boolean };

/** Thresholds a judge/rubric version must clear before its results may affect a release decision. */
export const CALIBRATION_GATE = { balancedAccuracy: 0.85, f1: 0.8 };

/**
 * Calibrate a judge against a frozen human-labelled set: the judge scores each example, a score of at least 3 is the
 * judge calling it acceptable, and that is compared with the human label. The judge may gate decisions only when the
 * balanced accuracy and every per-class F1 clear the gate.
 */
export async function calibrate(provider: JudgeProvider, dataset: { version: string; examples: CalibrationExample[] }): Promise<Calibration> {
  // confusion[actual][predicted], index 0 = acceptable, 1 = unacceptable.
  const confusion = [[0, 0], [0, 0]];
  for (const ex of dataset.examples) {
    const r = await provider.score({ rubric: ex.rubric, inputClass: ex.inputClass, expected: ex.expected, context: ex.context, citations: [], response: ex.response });
    const predicted = r.score !== null && r.score >= 3 ? 0 : 1;
    const actual = ex.label === "acceptable" ? 0 : 1;
    confusion[actual]![predicted]!++;
  }
  const recall = (k: number) => {
    const tp = confusion[k]![k]!;
    const total = confusion[k]![0]! + confusion[k]![1]!;
    return total ? tp / total : 0;
  };
  const f1 = (k: number) => {
    const tp = confusion[k]![k]!;
    const fp = confusion[1 - k]![k]!;
    const fn = confusion[k]![1 - k]!;
    const prec = tp + fp ? tp / (tp + fp) : 0;
    const rec = tp + fn ? tp / (tp + fn) : 0;
    return prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
  };
  const balancedAccuracy = (recall(0) + recall(1)) / 2;
  const f1ByClass = { acceptable: f1(0), unacceptable: f1(1) };
  const passed = balancedAccuracy >= CALIBRATION_GATE.balancedAccuracy && Math.min(f1ByClass.acceptable, f1ByClass.unacceptable) >= CALIBRATION_GATE.f1;
  return { datasetVersion: dataset.version, balancedAccuracy, f1ByClass, confusion, passed };
}
