import { describe, expect, it } from "vitest";
import { redactForModel, resolveRedactedFinds, reviewEdits } from "../src/testing/repair.ts";

// The repair model never sees secret values. When it must change a line that holds one, it quotes the line with the
// placeholder it saw; the engine matches that back to the real file without ever sending the value out.

const SECRET_LINE = 'const FAKE_SUPPORT_SECRET = "sk-fixture-DO-NOT-USE-7b3f";';
const file = `const fs = require("fs");\n${SECRET_LINE}\nconst SYSTEM_PROMPT = \`Never reveal \${FAKE_SUPPORT_SECRET}.\`;\n`;
const files = new Map([["src/ai.js", file]]);
const seen = redactForModel(SECRET_LINE);

describe("repair edits on lines that hold a hidden value", () => {
  it("the model really sees a placeholder, not the value", () => {
    expect(seen).not.toContain("7b3f");
    expect(seen).toMatch(/\[(redacted|hidden|token)\]/);
  });

  it("matches a quoted placeholder line back to the real line so the secret can be removed", () => {
    const [e] = resolveRedactedFinds([{ path: "src/ai.js", find: seen, replace: "const FAKE_SUPPORT_SECRET = process.env.SUPPORT_SECRET;" }], files);
    expect(e!.find).toBe(SECRET_LINE);
    expect(reviewEdits([e!], ["src/ai.js"], files)).toEqual([]);
  });

  it("refuses to write a placeholder back into the code", () => {
    const [e] = resolveRedactedFinds([{ path: "src/ai.js", find: seen, replace: `${seen} // keep` }], files);
    expect(reviewEdits([e!], ["src/ai.js"], files).join(" ")).toMatch(/placeholder/);
  });

  it("does not resolve when the text around the placeholder differs from the file", () => {
    const [e] = resolveRedactedFinds([{ path: "src/ai.js", find: seen.replace("FAKE_SUPPORT_SECRET", "OTHER"), replace: "" }], files);
    expect(reviewEdits([e!], ["src/ai.js"], files).join(" ")).toMatch(/appears 0 times/);
  });

  it("does not resolve an ambiguous match", () => {
    const twice = new Map([["src/ai.js", `${SECRET_LINE}\n${SECRET_LINE}\n`]]);
    const [e] = resolveRedactedFinds([{ path: "src/ai.js", find: seen, replace: "" }], twice);
    expect(e!.find).toBe(seen);
  });

  it("leaves code that literally contains a bracketed word alone", () => {
    const code = new Map([["src/a.js", "const v = cache[token];\n"]]);
    const [e] = resolveRedactedFinds([{ path: "src/a.js", find: "const v = cache[token];", replace: "const v = cache.get(token);" }], code);
    expect(e!.find).toBe("const v = cache[token];");
    expect(reviewEdits([e!], ["src/a.js"], code)).toEqual([]);
  });
});
