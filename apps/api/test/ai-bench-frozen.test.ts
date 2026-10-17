import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AI_SCOPE_OWNER, AiCaseCategory, AiOutOfScope } from "@cybercheck/contracts";

// AI Evaluator Step 1: the benchmark is frozen before the engine exists, so later work is measured against a fixed
// target. A change to the Gauntlet's AI defects or to the clean control must be deliberate and fail here first.

const here = import.meta.dirname;
const json = (p: string) => JSON.parse(readFileSync(join(here, p), "utf8"));
const gauntlet = join(here, "testing-bench/cybercheck-gauntlet");
const control = join(here, "ai-bench/clean-ai-control");
const frozen = json("ai-bench/gauntlet-ai-frozen.json") as {
  modelProvider: null;
  defects: Array<{ id: string; owaspCategory: string; path: string; endpoint: string | null; mustFind: boolean; aiCategory: string; severity: string; anchor: { path: string; text: string } }>;
};
const key = json("testing-bench/cybercheck-gauntlet/expected.json") as { defects: Array<{ id: string; track: string; category: string; path: string; endpoint: string | null; mustFind: boolean }> };

/** Files a user would upload, skipping installed dependencies. */
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.name === "node_modules" ? [] : e.isDirectory() ? sourceFiles(join(dir, e.name)) : [join(dir, e.name)]));

describe("Gauntlet AI defects, frozen", () => {
  it("the key still has exactly the five frozen AI defects, unchanged", () => {
    const ai = key.defects.filter((d) => d.track === "ai");
    expect(ai.map((d) => d.id).sort()).toEqual(frozen.defects.map((d) => d.id).sort());
    for (const f of frozen.defects) {
      const k = ai.find((d) => d.id === f.id)!;
      expect({ category: k.category, path: k.path, endpoint: k.endpoint, mustFind: k.mustFind }).toEqual({ category: f.owaspCategory, path: f.path, endpoint: f.endpoint, mustFind: f.mustFind });
    }
  });

  it.each(frozen.defects.map((d) => [d.id, d] as const))("%s is still planted in the source", (_id, d) => {
    expect(readFileSync(join(gauntlet, "project", d.anchor.path), "utf8")).toContain(d.anchor.text);
  });

  it("each defect names one AI Evaluator category and a gating severity", () => {
    for (const d of frozen.defects) {
      expect(AiCaseCategory.safeParse(d.aiCategory).success).toBe(true);
      expect(["critical", "high"]).toContain(d.severity);
    }
    expect(new Set(frozen.defects.map((d) => d.aiCategory)).size).toBe(5);
  });

  it("the Gauntlet assistant calls no model provider", () => {
    const ai = readFileSync(join(gauntlet, "project/src/ai.js"), "utf8");
    expect(frozen.modelProvider).toBeNull();
    expect(ai).not.toMatch(/fetch\(|openai|anthropic|gemini|chat\/completions/i);
  });
});

describe("clean AI control", () => {
  const files = sourceFiles(join(control, "project"));
  const read = (rel: string) => readFileSync(join(control, "project", rel), "utf8");

  it("is an uploadable project with an empty answer key", () => {
    const expected = json("ai-bench/clean-ai-control/expected.json");
    expect(expected.defects).toEqual([]);
    expect(expected.mustNotReport.length).toBeGreaterThanOrEqual(9);
    expect(files.some((f) => /[\\/]\.env/.test(f))).toBe(false);
    expect(existsSync(join(control, "project/package-lock.json"))).toBe(true);
  });

  it("has none of the Gauntlet's planted AI patterns", () => {
    const text = files.filter((f) => /\.(js|html)$/.test(f) && !/[\\/]test[\\/]/.test(f)).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(text).not.toMatch(/innerHTML/);
    expect(text).not.toMatch(/readFile\(/);
    expect(text).not.toMatch(/reply = prompt/);
    expect(text).not.toMatch(/sk-[\w-]{8,}/);
  });

  it("scopes history, conversations and tools to the caller", () => {
    const assistant = read("src/assistant.js");
    expect(assistant).toMatch(/FROM conversations WHERE owner_id = \?/);
    expect(assistant).toMatch(/FROM orders WHERE id = \? AND owner_id = \?/);
    expect(assistant).toMatch(/MAX_TOOL_ROUNDS = 3/);
    expect(read("src/knowledge.js")).toMatch(/a\.tenant === null \|\| a\.tenant === tenant/);
  });

  it("chooses its model provider only by configuration", () => {
    const model = read("src/model.js");
    expect(model).toMatch(/process\.env\.AI_BASE_URL/);
    expect(model.replace(/\/\/ .*$/gm, "")).not.toMatch(/https?:\/\//);
  });
});

describe("AI Evaluator scope", () => {
  it("every out-of-scope concern has an owning check", () => {
    for (const c of AiOutOfScope.options) expect(["security", "adversarial"]).toContain(AI_SCOPE_OWNER[c]);
  });

  it("the case catalogue has the thirteen plan categories", () => {
    expect(AiCaseCategory.options).toHaveLength(13);
  });
});
