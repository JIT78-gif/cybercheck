import { describe, expect, it } from "vitest";
import type { AiEvaluationCase, AiEvaluationFinding, Obligation } from "@cybercheck/contracts";
import { aiRepairScope, CANARY_UNIT, caseIdsToRun, defectsByCase, judgeCaseForDefect } from "../src/ai-evaluator/repair.ts";
import { judgeAttempt, repairAdapterFor } from "../src/testing/repair.ts";

// AI Evaluator repairs on the shared repair engine: case and browser-canary reproduction, regression selection, the
// focused case rerun, inheritance of the authoritative mode, and the verification rule.

const ev = (path: string, line = 1) => ({ path, line });

function finding(over: Partial<AiEvaluationFinding> = {}): AiEvaluationFinding {
  return {
    id: "AIF1", status: "confirmed", severity: "critical", category: "leakage", title: "AI replies repeat the system prompt",
    componentId: "ai:1", endpoint: "POST /api/assistant", rootCause: "leakage:system_prompt", owasp: [],
    expected: "The hidden instructions are never disclosed.", observed: "A reply contained the protected marker.", impact: "x", remediation: "Keep secrets out of the prompt.",
    caseIds: ["leak-1"], executionIds: ["e1"], datasetIds: [], sourceEvidence: [ev("src/agent.js", 12), ev("tests/agent.test.js", 4)],
    mode: "replay", basis: "deterministic", confirmation: "A grader reproduced it.", limitations: [], related: [],
    ...over,
  } as AiEvaluationFinding;
}

function aiCase(id: string, verdict: AiEvaluationCase["verdict"], over: Partial<AiEvaluationCase> = {}): AiEvaluationCase {
  return {
    id, seq: 1, category: "leakage", priority: "high", tags: [], title: id, target: { componentId: "ai:1", endpoint: "POST /api/assistant" },
    oracle: { type: "marker", expected: "no marker" }, sourceEvidence: [ev("src/agent.js", 30)], verdict, reason: verdict, executionIds: [], findingIds: [], ...over,
  } as unknown as AiEvaluationCase;
}

const renderingFinding = () => finding({ id: "AIF-R", category: "output_rendering", rootCause: "output_rendering:source_sink", caseIds: [], sourceEvidence: [ev("public/assistant.html", 40)] });

describe("AI Evaluator repair scope", () => {
  it("allows only editable source from the finding and its cases, never tests", () => {
    const s = aiRepairScope(finding(), [aiCase("leak-1", "failed")]);
    expect(s.files.sort()).toEqual(["src/agent.js"]);
  });

  it("reruns every supporting case and selects previously passing cases of the same target as regression", () => {
    const cases = [aiCase("leak-1", "failed"), aiCase("leak-ok", "passed"), aiCase("other-component", "passed", { target: { componentId: "ai:2", endpoint: "POST /x" } }), aiCase("blocked", "blocked")];
    const s = aiRepairScope(finding(), cases);
    expect(s.reproduction).toEqual(["leak-1"]);
    expect(s.regression).toEqual(["leak-ok"]);
  });

  it("reproduces a canary-confirmed rendering finding through the browser canary unit", () => {
    expect(aiRepairScope(renderingFinding(), []).reproduction).toEqual([CANARY_UNIT]);
  });

  it("never sends the canary as a case id, and a canary-only scope has nothing rerunnable without a passing case", () => {
    const alone = aiRepairScope(renderingFinding(), []);
    expect(caseIdsToRun(alone)).toEqual([]);
    const withCase = aiRepairScope(renderingFinding(), [aiCase("chat-ok", "passed", { category: "functional" })]);
    expect(caseIdsToRun(withCase)).toEqual(["chat-ok"]);
  });
});

describe("AI Evaluator repair adapter", () => {
  const adapter = repairAdapterFor("ai-evaluator");

  it("is registered for the AI Evaluator check", () => {
    expect(adapter).not.toBe(repairAdapterFor("testing"));
  });

  it("focuses the validation run on real case ids only", () => {
    const scope = aiRepairScope(renderingFinding(), [aiCase("chat-ok", "passed", { category: "functional" })]);
    expect(adapter.rerun(scope, "p1")).toEqual({ parentRunId: "p1", caseIds: ["chat-ok"] });
  });

  it("keeps the authoritative mode of the confirming run: nothing is forced", () => {
    expect(adapter.extraPolicy()).toEqual({});
  });

  it("maps a rendering finding into the prompt with the canary as its reproduction target", () => {
    expect(adapter.finding(renderingFinding()).obligationIds).toEqual([CANARY_UNIT]);
  });
});

describe("verification with the browser canary", () => {
  const scope = aiRepairScope(renderingFinding(), [aiCase("chat-ok", "passed", { category: "functional" })]);
  const ob = (id: string, status: string) => ({ id, status, objective: id, reason: status, reachedTarget: status === "passed" || status === "failed" }) as unknown as Obligation;
  const before = new Map([[CANARY_UNIT, ob(CANARY_UNIT, "failed")], ["chat-ok", ob("chat-ok", "passed")]]);

  it("verifies only when the canary payload now stays inert and the regression case still passes", () => {
    expect(judgeAttempt(scope, before, new Map([[CANARY_UNIT, ob(CANARY_UNIT, "passed")], ["chat-ok", ob("chat-ok", "passed")]])).status).toBe("verified");
  });

  it("does not verify when the canary could not drive the page", () => {
    expect(judgeAttempt(scope, before, new Map([[CANARY_UNIT, ob(CANARY_UNIT, "inconclusive")], ["chat-ok", ob("chat-ok", "passed")]])).status).toBe("failed_validation");
  });

  it("reports a regression when the patch breaks a case that passed before", () => {
    expect(judgeAttempt(scope, before, new Map([[CANARY_UNIT, ob(CANARY_UNIT, "passed")], ["chat-ok", ob("chat-ok", "failed")]])).status).toBe("regression_introduced");
  });
});

describe("AI Evaluator repair: one case shared by several defects", () => {
  // The Gauntlet's cross-user case fails for three defects at once: history crosses users, replies leak a credential
  // and replies echo the system prompt. Each is repaired on its own.
  const isolation = finding({ id: "AIF-6", category: "isolation", rootCause: "isolation:isolation_holds", caseIds: ["xuser"] });
  const credential = finding({ id: "AIF-7", category: "isolation", rootCause: "isolation:no_credential", caseIds: ["xuser"] });
  const echo = finding({ id: "AIF-10", category: "isolation", rootCause: "isolation:no_prompt_echo", caseIds: ["xuser"] });
  const before = defectsByCase([isolation, credential, echo]).get("xuser");
  const failing = aiCase("xuser", "failed", { category: "isolation" });

  it("counts the case as passed for the repaired defect once only other, pre-existing defects remain", () => {
    const after = defectsByCase([isolation, echo]).get("xuser");
    expect(judgeCaseForDefect(failing, credential, after, before).status).toBe("passed");
    expect(judgeCaseForDefect(failing, credential, after, before).reason).toMatch(/no longer reproduces/);
  });

  it("keeps it failed while the repaired defect still reproduces", () => {
    const after = defectsByCase([isolation, credential, echo]).get("xuser");
    expect(judgeCaseForDefect(failing, credential, after, before).status).toBe("failed");
  });

  it("keeps it failed when the patch introduces a new reason to fail", () => {
    const fresh = finding({ id: "AIF-X", category: "isolation", rootCause: "isolation:crashed", caseIds: ["xuser"] });
    const after = defectsByCase([isolation, fresh]).get("xuser");
    expect(judgeCaseForDefect(failing, credential, after, before).status).toBe("failed");
  });

  it("keeps it failed when no finding explains the failure", () => {
    expect(judgeCaseForDefect(failing, credential, undefined, before).status).toBe("failed");
  });

  it("leaves passed and inconclusive cases as they are", () => {
    expect(judgeCaseForDefect(aiCase("xuser", "passed"), credential, undefined, before).status).toBe("passed");
    expect(judgeCaseForDefect(aiCase("xuser", "inconclusive"), credential, new Set(), before).status).toBe("inconclusive");
  });
});
