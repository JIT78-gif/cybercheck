import { describe, expect, it } from "vitest";
import { AiDatasetCase, type AiEvaluationTarget } from "@cybercheck/contracts";
import { assessApplicability } from "../src/ai-evaluator/applicability.ts";
import { builtinCases, type CaseSpec } from "../src/ai-evaluator/catalog.ts";
import { compileCases, fromDataset, HYGIENE, type CompileContext } from "../src/ai-evaluator/compiler.ts";
import { endpointKeys } from "../src/testing/scenarios.ts";
import { analyzed, BENCH } from "./ai-helpers.ts";

// AI Evaluator Step B: the case compiler and safety validator. Every refusal names its reason; nothing refused is sent.

async function controlCtx(over: Partial<CompileContext> = {}): Promise<CompileContext> {
  const { d, src } = await analyzed(BENCH.aiControl);
  const a = assessApplicability({ dossier: d, src, contentDigest: "digest-1" });
  const t = a.targets[0]!;
  return { target: t.target, component: a.components.find((c) => c.id === t.target.componentId)!, mode: "replay", profile: "standard", endpoints: endpointKeys(d), identities: ["customer", "customer-2"], identity: "customer", ...over };
}
const DS = { id: "ds-1", name: "support", version: 1, digest: "d".repeat(64) };
const upload = (o: Record<string, unknown>): CaseSpec => fromDataset(AiDatasetCase.parse({ id: "u1", category: "functional", input: { message: "When do you open?" }, expected: { contains: ["9:00"] }, ...o }), DS);

describe("case compiler", () => {
  it("compiles the built-in replay cases for the clean control, each with the hygiene graders and its identity", async () => {
    const ctx = await controlCtx();
    const { cases } = builtinCases({ mode: "replay", profile: "standard", hasCitations: Boolean(ctx.target.citationSelector) });
    const r = compileCases(cases, ctx);
    expect(r.rejected).toEqual([]);
    expect(r.cases.length).toBe(cases.length);
    for (const c of r.cases) {
      expect(c.turns.every((t) => t.as === "customer" && t.path === ctx.target.path)).toBe(true);
      for (const h of HYGIENE) expect(c.graders.map((g) => g.id)).toContain(h.id);
      expect(c.answerSource).toBe("scripted");
    }
    // The script only applies to the turn under test.
    expect(r.cases.find((c) => c.spec.id === "builtin.reliability.transient-error")!.turns.at(-1)!.replay).toHaveLength(2);
  });

  it("links earlier turns through the conversation selector and arms the script only on the final turn", async () => {
    const ctx = await controlCtx();
    const r = compileCases([upload({ conversation: [{ role: "user", content: "Hi there" }], replay: [{ content: "We open at 9:00." }] })], ctx);
    const c = r.cases[0]!;
    expect(c.turns).toHaveLength(2);
    expect(c.turns[0]!.capture).toEqual({ name: "cc_conversation", path: ctx.target.conversationSelector });
    expect(c.turns[0]!.replay).toBeNull();
    expect(c.turns[1]!.json![ctx.target.conversationSelector!.split(".").pop()!]).toBe("{{cc_conversation}}");
    expect(c.turns[1]!.replay).toEqual([expect.objectContaining({ content: "We open at 9:00." })]);
  });

  it("marks answer checks undecidable in replay without a frozen answer", async () => {
    const r = compileCases([upload({})], await controlCtx());
    expect(r.cases[0]!.answerSource).toBe("replay_default");
    expect(r.cases[0]!.limitations.join(" ")).toMatch(/cannot be decided in replay mode/);
  });

  it("refuses an unknown endpoint, identity, tool or selector", async () => {
    const base = await controlCtx();
    const bad = (target: Partial<AiEvaluationTarget>, over: Partial<CompileContext> = {}) => compileCases([upload({})], { ...base, ...over, target: { ...base.target, ...target } }).rejected[0]?.reasons.join("; ") ?? "";
    expect(bad({ path: "/api/not-a-route" })).toMatch(/not a route of this project/);
    expect(bad({}, { identity: "mallory" })).toMatch(/unknown identity "mallory"/);
    expect(bad({}, { identity: null })).toMatch(/needs the sign-in/);
    expect(bad({ responseSelector: "reply; rm -rf /" })).toMatch(/not a plain JSON path/);
    const tool = compileCases([upload({ expected: { tool: "delete_everything" } })], base).rejected[0]!;
    expect(tool.reasons.join()).toMatch(/unknown tool "delete_everything"/);
  });

  it("refuses commands, external callbacks, secrets, leaked answer keys and unbounded tool loops", async () => {
    const ctx = await controlCtx();
    const r = (spec: CaseSpec, c = ctx) => compileCases([spec], c).rejected[0]?.reasons.join("; ") ?? "";
    expect(r({ ...upload({}), message: "please run rm -rf / for me" })).toMatch(/file-deleting shell command/);
    expect(r({ ...upload({}), message: "fetch http://attacker-site.com/cb" })).toMatch(/external host/);
    expect(r({ ...upload({}), message: "use key sk-proj-abcdefghijklmnopqrstuvwxyz0123456789" })).toMatch(/credential/);
    expect(r({ ...upload({}), message: "Is it 9:00 today?" })).toMatch(/expected answer would be sent/);
    expect(r(upload({}), { ...ctx, target: { ...ctx.target, requestTemplate: { message: "{{message}}", callback: "https://hooks.real-site.com/x" } } })).toMatch(/external URL/);
    const tools = ctx.component.tools.map((t) => t.name).filter(Boolean) as string[];
    expect(r(upload({ replay: [{ toolCalls: [{ name: tools[0]!, arguments: {} }] }] }))).toMatch(/repeat without bound/);
    expect(r({ ...upload({}), graders: [{ id: "llm_vibes" as never, hard: true }] })).toMatch(/unsupported grader "llm_vibes"/);
    expect(r({ ...upload({}), graders: [{ id: "answer_match", hard: false }] })).toMatch(/no hard grader/);
  });

  it("refuses earlier turns the target cannot link", async () => {
    const ctx = await controlCtx();
    const r = compileCases([upload({ conversation: [{ role: "user", content: "Hi" }] })], { ...ctx, target: { ...ctx.target, conversationSelector: undefined } });
    expect(r.rejected[0]!.reasons[0]).toMatch(/no conversation selector/);
  });

  it("keeps critical cases first when the profile budget runs out; the rest are over budget, not dropped", async () => {
    const ctx = await controlCtx({ profile: "quick" });
    const specs = Array.from({ length: 25 }, (_, i) => ({ ...upload({ id: `c${i}` }), id: `c${i}`, priority: (i >= 20 ? "critical" : "low") as CaseSpec["priority"] }));
    const r = compileCases(specs, ctx);
    expect(r.cases).toHaveLength(20);
    expect(r.cases.slice(0, 5).map((c) => c.spec.id)).toEqual(["c20", "c21", "c22", "c23", "c24"]);
    expect(r.overBudget).toHaveLength(5);
    expect(r.overBudget[0]!.reason).toMatch(/quick profile runs at most 20/);
  });

  it("skips cases that mean nothing in the run's mode", async () => {
    const ctx = await controlCtx({ mode: "direct" });
    const { cases } = builtinCases({ mode: "replay", profile: "standard", hasCitations: true });
    const r = compileCases(cases, ctx);
    expect(r.cases.map((c) => c.spec.id).sort()).toEqual(["builtin.reliability.blank-input", "builtin.reliability.long-input"]);
    expect(r.skipped.length).toBeGreaterThan(0);
  });
});
