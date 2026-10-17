import { createHash } from "node:crypto";
import { AiDatasetExpected, type AiCaseCategory, type AiCasePriority, type AiEvaluationProfile, type AiExecutionMode, type AiGraderId, type AiReplayTurn } from "@cybercheck/contracts";
import { canonical } from "./datasets.ts";
import { AI_CATALOG_VERSION } from "./version.ts";

// The built-in defensive case catalogue: functional, grounding and reliability checks that every AI component gets,
// chosen by how it can be exercised. A component that calls a model through a configurable base URL runs against
// the scripted replay model, so these cases test the application's own handling (does the answer reach the user,
// are citations limited to what was retrieved, are provider failures answered cleanly and retried a bounded number of
// times). A component with no model provider is called directly. No case here sends adversarial input: injection,
// extraction and cross-tenant cases are a separate catalogue, not built yet.

export type GraderSpec = { id: AiGraderId; hard: boolean; params?: Record<string, unknown> };

/** One case before compilation, from the built-in catalogue or an uploaded dataset. */
export type CaseSpec = {
  id: string;
  category: AiCaseCategory;
  priority: AiCasePriority;
  tags: string[];
  title: string;
  /** What kind of input this is, shown instead of the raw text. */
  inputClass: string;
  source: { kind: "builtin" | "uploaded"; datasetId: string | null; version: string; digest: string };
  message: string;
  /** Extra request fields merged into the target's request template. */
  extra: Record<string, string | number | boolean>;
  /** Earlier user turns, sent first in the same conversation. */
  conversation: string[];
  context: string[];
  /** Scripted model answers for the final turn (replay mode only). */
  replay: AiReplayTurn[];
  expected: AiDatasetExpected;
  /** Plain-language expected behaviour, for the report. */
  expectedText: string;
  graders: GraderSpec[];
  /** Modes the case means something in. */
  modes: AiExecutionMode[];
  /** Profiles that include the case (uploaded cases run in every profile). */
  profiles: AiEvaluationProfile[];
  /** Target capabilities the case needs, e.g. a citation field in the response. */
  requires: Array<"citations">;
  /** How long the final turn may take before the harness gives up. */
  timeoutMs: number;
};

const ALL: AiEvaluationProfile[] = ["quick", "standard", "deep"];
const expected = (e: Partial<AiDatasetExpected> = {}) => AiDatasetExpected.parse(e);
const turn = (t: Partial<AiReplayTurn>): AiReplayTurn => ({ content: null, toolCalls: [], status: null, malformed: false, hang: false, ...t });
const g = (id: AiGraderId, hard = true, params?: Record<string, unknown>): GraderSpec => ({ id, hard, ...(params ? { params } : {}) });

const FILLER = "I would like some help with my recent order and the delivery options you offer. ";
/** A long but ordinary request (about 8000 characters). */
const LONG_MESSAGE = FILLER.repeat(Math.floor(7900 / FILLER.length)).trim();

type Builtin = Omit<CaseSpec, "source" | "extra" | "conversation" | "context" | "tags"> & { tags?: string[] };

const BUILTINS: Builtin[] = [
  // ---- functional
  {
    id: "builtin.functional.answer-reaches-user",
    category: "functional",
    priority: "high",
    title: "The model's answer reaches the user",
    inputClass: "ordinary support question",
    message: "What are your support hours?",
    replay: [turn({ content: "Our support team is available from 9:00 to 17:00 on weekdays." })],
    expected: expected({ contains: ["9:00 to 17:00"] }),
    expectedText: "The reply carries the model's answer, and the model was given the user's question.",
    graders: [g("reply_present"), g("reply_passthrough", true, { text: "9:00 to 17:00" }), g("model_received_message")],
    modes: ["replay"],
    profiles: ALL,
    requires: [],
    timeoutMs: 20_000,
  },
  {
    id: "builtin.functional.responds",
    category: "functional",
    priority: "high",
    title: "The assistant answers an ordinary question",
    inputClass: "ordinary support question",
    message: "What are your support hours?",
    replay: [],
    expected: expected(),
    expectedText: "A successful response with a non-empty reply in the reply field.",
    graders: [g("reply_present")],
    modes: ["direct"],
    profiles: ALL,
    requires: [],
    timeoutMs: 20_000,
  },
  // ---- grounding
  {
    id: "builtin.grounding.unknown-citation-dropped",
    category: "grounding",
    priority: "high",
    title: "Citations are limited to material the model was given",
    inputClass: "question answered with a citation to a document that was never retrieved",
    message: "How long does shipping take?",
    replay: [turn({ content: "Shipping usually takes 3 to 5 business days [doc:cc-not-retrieved]." })],
    expected: expected(),
    expectedText: "The response's citations only name documents that were part of the model's input; the invented one is dropped.",
    graders: [g("reply_present"), g("citation_known")],
    modes: ["replay"],
    profiles: ALL,
    requires: ["citations"],
    timeoutMs: 20_000,
  },
  // ---- reliability
  {
    id: "builtin.reliability.transient-error",
    category: "reliability",
    priority: "high",
    title: "A transient provider error is handled",
    inputClass: "ordinary question while the provider fails once with HTTP 500",
    message: "Can I change my delivery address?",
    replay: [turn({ status: 500 }), turn({ content: "Yes, you can change the delivery address until the order ships." })],
    expected: expected(),
    expectedText: "Either the request is retried and the answer arrives, or a clean error is returned; at most 4 model calls; the app keeps serving.",
    graders: [g("handled_failure"), g("retry_bound", true, { max: 4 }), g("app_alive"), g("reply_passthrough", false, { text: "until the order ships" })],
    modes: ["replay"],
    profiles: ALL,
    requires: [],
    timeoutMs: 45_000,
  },
  {
    id: "builtin.reliability.provider-down",
    category: "reliability",
    priority: "high",
    title: "A provider outage is answered cleanly",
    inputClass: "ordinary question while the provider answers HTTP 503 every time",
    message: "Where is my order?",
    replay: [turn({ status: 503 })],
    expected: expected(),
    expectedText: "A clean error response (no stack trace, no empty success), at most 4 model calls, and the app keeps serving.",
    graders: [g("handled_failure"), g("retry_bound", true, { max: 4 }), g("app_alive")],
    modes: ["replay"],
    profiles: ALL,
    requires: [],
    timeoutMs: 45_000,
  },
  {
    id: "builtin.reliability.malformed-response",
    category: "reliability",
    priority: "high",
    title: "A malformed provider response is handled",
    inputClass: "ordinary question while the provider returns a body that is not a completion",
    message: "Do you ship internationally?",
    replay: [turn({ malformed: true })],
    expected: expected(),
    expectedText: "A clean error or a sensible reply; never a crash, a stack trace, or a reply like 'undefined'.",
    graders: [g("handled_failure"), g("retry_bound", true, { max: 4 }), g("app_alive")],
    modes: ["replay"],
    profiles: ALL,
    requires: [],
    timeoutMs: 45_000,
  },
  {
    id: "builtin.reliability.provider-timeout",
    category: "reliability",
    priority: "medium",
    title: "A provider that never answers is timed out",
    inputClass: "ordinary question while the provider never answers",
    message: "What payment methods do you accept?",
    replay: [turn({ hang: true })],
    expected: expected(),
    expectedText: "The app gives up on the provider by itself and answers within 60 seconds with a clean error.",
    graders: [g("handled_failure"), g("app_alive")],
    modes: ["replay"],
    profiles: ["standard", "deep"],
    requires: [],
    timeoutMs: 60_000,
  },
  {
    id: "builtin.reliability.blank-input",
    category: "reliability",
    priority: "medium",
    title: "A blank message is handled",
    inputClass: "a message containing only a space",
    message: " ",
    replay: [turn({ content: "Could you tell me a little more about what you need?" })],
    expected: expected(),
    expectedText: "A validation error (4xx) or a sensible reply; never a server error.",
    graders: [g("handled_failure", true, { allow5xx: false }), g("app_alive")],
    modes: ["replay", "direct"],
    profiles: ALL,
    requires: [],
    timeoutMs: 20_000,
  },
  {
    id: "builtin.reliability.long-input",
    category: "reliability",
    priority: "medium",
    title: "A very long message is handled",
    inputClass: "an ordinary request repeated to about 8000 characters",
    message: LONG_MESSAGE,
    replay: [turn({ content: "Happy to help with your order. Which delivery option are you interested in?" })],
    expected: expected(),
    expectedText: "A validation error (4xx) or a sensible reply; never a server error.",
    graders: [g("handled_failure", true, { allow5xx: false }), g("app_alive")],
    modes: ["replay", "direct"],
    profiles: ALL,
    requires: [],
    timeoutMs: 30_000,
  },
];

/** The catalogue digest: any change to a built-in case changes it. */
export const BUILTIN_DIGEST = createHash("sha256").update(canonical(BUILTINS)).digest("hex");

/** Built-in cases for one component, given how it is exercised and what its target exposes. */
export function builtinCases(opts: { mode: AiExecutionMode; profile: AiEvaluationProfile; hasCitations: boolean }): { cases: CaseSpec[]; skipped: Array<{ id: string; reason: string }> } {
  const cases: CaseSpec[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  for (const b of BUILTINS) {
    if (!b.modes.includes(opts.mode)) continue;
    if (!b.profiles.includes(opts.profile)) {
      skipped.push({ id: b.id, reason: `Not part of the ${opts.profile} profile.` });
      continue;
    }
    if (b.requires.includes("citations") && !opts.hasCitations) {
      skipped.push({ id: b.id, reason: "The response has no citation field, so citation handling cannot be observed." });
      continue;
    }
    cases.push({ ...b, tags: b.tags ?? [], source: { kind: "builtin", datasetId: null, version: AI_CATALOG_VERSION, digest: BUILTIN_DIGEST }, extra: {}, conversation: [], context: [] });
  }
  return { cases, skipped };
}

/** Every built-in case, for tests and the catalogue listing. */
export const BUILTIN_IDS = BUILTINS.map((b) => b.id);
