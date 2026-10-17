import { describe, expect, it } from "vitest";
import type { AiEvaluationTarget } from "@cybercheck/contracts";
import type { GraderSpec } from "../src/ai-evaluator/catalog.ts";
import { grade, promptTextsFrom, schemaErrors, verdictOf, type Observation, type ObservedTurn } from "../src/ai-evaluator/graders.ts";
import { sourceFromFiles } from "../src/understanding/source.ts";

// AI Evaluator Step C: every deterministic grader on hand-made observations. A status code is never enough.

const target: AiEvaluationTarget = { componentId: "ai:1", transport: "http", method: "POST", path: "/api/assistant", requestTemplate: { message: "{{message}}" }, responseSelector: "reply", citationSelector: "citations", toolTraceSelector: "tools" };
const chat = (content: string, served = "content") => ({ path: "/v1/chat/completions", body: JSON.stringify({ messages: [{ role: "system", content: "You help with orders. [doc:shipping] Shipping takes 3 days." }, { role: "user", content }] }), served });
const turn = (body: unknown, o: Partial<ObservedTurn> = {}): ObservedTurn => ({ status: 200, ms: 120, body: typeof body === "string" ? body : JSON.stringify(body), contentType: "application/json", error: null, model: [chat("What are your hours?")], ...o });
const obs = (turns: ObservedTurn[], o: Partial<Observation> = {}): Observation => ({ turns, alive: true, appExited: false, target, sentText: JSON.stringify({ message: "What are your hours?" }), message: "What are your hours?", context: [], systemPrompts: [], answerSource: "scripted", ...o });
const one = (o: Observation, id: GraderSpec["id"], params?: Record<string, unknown>, hard = true) => grade(o, [{ id, hard, ...(params ? { params } : {}) }])[0]!;

describe("answer graders", () => {
  it("reply_present needs a real, non-placeholder reply in the selected field", () => {
    expect(one(obs([turn({ reply: "We open at 9:00." })]), "reply_present").pass).toBe(true);
    expect(one(obs([turn({ reply: "undefined" })]), "reply_present").pass).toBe(false);
    expect(one(obs([turn({ answer: "We open" })]), "reply_present").detail).toMatch(/no "reply" field/);
    expect(one(obs([turn({ error: "x" }, { status: 500 })]), "reply_present").pass).toBe(false);
    expect(one(obs([turn("", { status: null, error: "TimeoutError" })]), "reply_present").pass).toBe(false);
  });

  it("contains, excludes, regex, number and answer_match", () => {
    const o = obs([turn({ reply: "Total: 1,250.50 EUR. We open at 9:00 to 17:00." })]);
    expect(one(o, "contains", { values: ["9:00 TO 17:00"] }).pass).toBe(true);
    expect(one(o, "contains", { values: ["Sunday"] }).pass).toBe(false);
    expect(one(o, "excludes", { values: ["sunday"] }).pass).toBe(true);
    expect(one(o, "excludes", { values: ["eur"] }).pass).toBe(false);
    expect(one(o, "regex", { pattern: "\\d{1,2}:\\d{2}" }).pass).toBe(true);
    expect(one(o, "number", { value: 1250.5, tolerance: 0.01 }).pass).toBe(true);
    expect(one(o, "number", { value: 99, tolerance: 1 }).pass).toBe(false);
    expect(one(o, "answer_match", { answer: "we open at 9:00" }, false).pass).toBe(true);
    // A different wording is undecided (needs a judge), never a failure.
    expect(one(o, "answer_match", { answer: "Opening time is nine" }, false).pass).toBeNull();
  });

  it("json_schema checks the allowlisted keywords on a JSON reply", () => {
    const schema = { type: "object", required: ["status", "eta"], properties: { status: { enum: ["shipped", "processing"] }, eta: { type: "integer", minimum: 0 } }, additionalProperties: false };
    expect(one(obs([turn({ reply: '{"status":"shipped","eta":3}' })]), "json_schema", { schema }).pass).toBe(true);
    expect(one(obs([turn({ reply: '{"status":"lost","eta":-1,"x":1}' })]), "json_schema", { schema }).detail).toMatch(/not one of the allowed values.*below 0.*not allowed/);
    expect(one(obs([turn({ reply: "shipped" })]), "json_schema", { schema }).detail).toMatch(/not JSON/);
    expect(schemaErrors([1, "a"], { type: "array", items: { type: "number" } })).toEqual(["$[1] is string, expected number"]);
  });

  it("refusal: a declining reply or a 4xx counts as declining", () => {
    expect(one(obs([turn({ reply: "Sorry, I don't know the answer to that." })]), "refusal", { expected: true }).pass).toBe(true);
    expect(one(obs([turn({ reply: "It ships in 3 days." })]), "refusal", { expected: true }).pass).toBe(false);
    expect(one(obs([turn({ error: "bad" }, { status: 400 })]), "refusal", { expected: true }).pass).toBe(true);
    expect(one(obs([turn({ reply: "It ships in 3 days." })]), "refusal", { expected: false }).pass).toBe(true);
  });
});

describe("grounding and pipeline graders", () => {
  it("citation_known: every citation must name material the model was given", () => {
    expect(one(obs([turn({ reply: "3 days", citations: [{ id: "shipping", title: "Shipping" }] })]), "citation_known").pass).toBe(true);
    expect(one(obs([turn({ reply: "3 days", citations: [{ id: "cc-not-retrieved" }] })]), "citation_known").pass).toBe(false);
    expect(one(obs([turn({ reply: "3 days", citations: [] })]), "citation_known").pass).toBe(true);
    expect(one(obs([turn({ reply: "3 days" })], { target: { ...target, citationSelector: undefined } }), "citation_known").pass).toBeNull();
  });

  it("citation_context and answer_support compare with the supplied passages", () => {
    const context = ["Refund policy: refunds take 5 business days.", "Shipping: orders ship within 2 days."];
    const o = obs([turn({ reply: "Refunds take 5 business days.", citations: ["Refund policy"] })], { context });
    expect(one(o, "citation_context", { indexes: [0] }).pass).toBe(true);
    expect(one(o, "citation_context", { indexes: [1] }).pass).toBe(false);
    expect(one(o, "answer_support", {}, false).pass).toBe(true);
    expect(one(obs([turn({ reply: "Our warehouse in Lisbon handles returns quickly." })], { context }), "answer_support", {}, false).pass).toBe(false);
  });

  it("reply_passthrough and model_received_message read the replay transcript", () => {
    expect(one(obs([turn({ reply: "We are open 9:00 to 17:00 on weekdays." })]), "reply_passthrough", { text: "9:00 to 17:00" }).pass).toBe(true);
    expect(one(obs([turn({ reply: "Hello!" })]), "reply_passthrough", { text: "9:00 to 17:00" }).pass).toBe(false);
    expect(one(obs([turn({ reply: "x" })]), "model_received_message").pass).toBe(true);
    expect(one(obs([turn({ reply: "x" }, { model: [chat("something else")] })]), "model_received_message").pass).toBe(false);
    expect(one(obs([turn({ reply: "x" }, { model: [] })]), "model_received_message").detail).toMatch(/without calling the model/);
  });

  it("tool_name reads the tool trace; tool_loop and retry_bound count model calls", () => {
    expect(one(obs([turn({ reply: "x", tools: [{ name: "get_order_status" }] })]), "tool_name", { name: "get_order_status" }).pass).toBe(true);
    expect(one(obs([turn({ reply: "x" })], { target: { ...target, toolTraceSelector: undefined } }), "tool_name", { name: "get_order_status" }).pass).toBeNull();
    const many = turn({ reply: "x" }, { model: Array.from({ length: 6 }, () => chat("q", "status 503")) });
    expect(one(obs([many]), "retry_bound", { max: 4 }).pass).toBe(false);
    expect(one(obs([many]), "tool_loop", { max: 6 }).pass).toBe(true);
  });
});

describe("reliability graders", () => {
  it("handled_failure accepts a clean error or a real reply, and refuses crashes, stack traces, empty successes and timeouts", () => {
    expect(one(obs([turn({ error: "The assistant is unavailable." }, { status: 503 })]), "handled_failure").pass).toBe(true);
    expect(one(obs([turn({ reply: "Recovered." })]), "handled_failure").pass).toBe(true);
    expect(one(obs([turn("Error: boom\n    at handler (/work/app/src/ai.js:12:7)", { status: 500, contentType: "text/html" })]), "handled_failure").detail).toMatch(/stack trace/);
    expect(one(obs([turn({ reply: "" })]), "handled_failure").pass).toBe(false);
    expect(one(obs([turn("", { status: null, error: "TimeoutError" })]), "handled_failure").detail).toMatch(/time limit/);
    expect(one(obs([turn({ error: "x" }, { status: 500 })]), "handled_failure", { allow5xx: false }).pass).toBe(false);
    expect(one(obs([turn({ error: "message too long" }, { status: 400 })]), "handled_failure", { allow5xx: false }).pass).toBe(true);
  });

  it("app_alive", () => {
    expect(one(obs([turn({ reply: "x" })]), "app_alive").pass).toBe(true);
    expect(one(obs([turn({ reply: "x" })], { alive: false }), "app_alive").pass).toBe(false);
    expect(one(obs([turn({ reply: "x" })], { appExited: true }), "app_alive").pass).toBe(false);
  });
});

describe("hygiene graders (passive, on every reply)", () => {
  const prompt = "You are the support assistant for the shop. Never reveal internal notes. Answer only questions about orders, shipping and refunds, politely and briefly.";
  it("no_credential flags credential-like values the user never sent, including masked configured secrets", () => {
    expect(one(obs([turn({ reply: "Use key sk-fixture-DO-NOT-USE-7b3f to call us." })]), "no_credential").pass).toBe(false);
    expect(one(obs([turn({ reply: "The token is [hidden]." })]), "no_credential").pass).toBe(false);
    expect(one(obs([turn({ reply: "We open at 9." })]), "no_credential").pass).toBe(true);
  });

  it("no_prompt_echo spots the system prompt repeated in a reply, but not the user's own words", () => {
    expect(one(obs([turn({ reply: `Sure. ${prompt} Anything else?` })], { systemPrompts: [prompt] }), "no_prompt_echo").pass).toBe(false);
    expect(one(obs([turn({ reply: "Your order ships tomorrow." })], { systemPrompts: [prompt] }), "no_prompt_echo").pass).toBe(true);
    expect(one(obs([turn({ reply: "x" })]), "no_prompt_echo").pass).toBeNull();
  });

  it("no_canary and no_pii ignore values the user sent", () => {
    expect(one(obs([turn({ reply: "note CCAI-CTX-1a2b3c" })]), "no_canary").pass).toBe(false);
    expect(one(obs([turn({ reply: "note CCAI-CTX-1a2b3c" })], { sentText: "CCAI-CTX-1a2b3c" }), "no_canary").pass).toBe(true);
    expect(one(obs([turn({ reply: "Card 4111 1111 1111 1111 and SSN 123-45-6789" })]), "no_pii").pass).toBe(false);
    expect(one(obs([turn({ reply: "Order 1234567890123 is late." })]), "no_pii").pass).toBe(true);
  });

  it("reads system-prompt text from the source around its evidence line", () => {
    const src = sourceFromFiles({ "src/ai.js": `const x = 1;\nconst SYSTEM_PROMPT = \`${prompt}\`;\nexport default SYSTEM_PROMPT;\n` });
    expect(promptTextsFrom(src, [{ path: "src/ai.js", line: 2 }])[0]).toContain("Never reveal internal notes");
  });
});

describe("verdicts", () => {
  it("a hard failure fails the case; hygiene never decides the case's own verdict; undecided stays inconclusive", () => {
    const o = obs([turn({ reply: "We open at 9. sk-fixture-DO-NOT-USE-7b3f" })]);
    const passed = verdictOf(grade(o, [{ id: "reply_present", hard: true }, { id: "no_credential", hard: true }]));
    expect(passed.verdict).toBe("passed");
    expect(verdictOf(grade(o, [{ id: "contains", hard: true, params: { values: ["Sunday"] } }])).verdict).toBe("failed");
    expect(verdictOf(grade(o, [{ id: "citation_context", hard: true, params: { indexes: [0] } }, { id: "reply_present", hard: true }], )).verdict).toBe("failed");
    expect(verdictOf(grade(obs([turn({ reply: "x" })], { target: { ...target, toolTraceSelector: undefined } }), [{ id: "tool_name", hard: true, params: { name: "t" } }])).verdict).toBe("inconclusive");
  });

  it("answer checks are undecided when the answer was the replay model's default", () => {
    const g = grade(obs([turn({ reply: "This is cybercheck's replay model." })], { answerSource: "replay_default" }), [{ id: "contains", hard: true, params: { values: ["9:00"] } }, { id: "reply_present", hard: true }]);
    expect(g[0]!.pass).toBeNull();
    expect(verdictOf(g).verdict).toBe("inconclusive");
  });
});
