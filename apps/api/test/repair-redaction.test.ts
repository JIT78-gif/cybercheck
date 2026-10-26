import { describe, expect, it } from "vitest";
import type { AiSession } from "../src/understanding/ai/gateway.ts";
import { proposePatch, redactForModel } from "../src/testing/repair.ts";

// Everything a repair sends to a model is redacted first, for every check owner (Testing, Security, AI Evaluator,
// AI Adversarial): credentials, tokens, JWTs, secret-looking literals and every synthetic canary value.

const SECRETS = {
  bearer: "Bearer abcdef0123456789abcdef",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl",
  aiCanary: "CCAI-SYSPROMPT-7f3a9c",
  advCanary: "CCADVMARK-91bd77",
  fixtureKey: "sk-agentmart-FIXTURE-DO-NOT-USE",
  promptMarker: "CC_SYS_PROMPT_alpha",
  approval: "cc-approval-valid-1234",
  xss: "CCXSS0123abcd",
};

describe("redactForModel", () => {
  it("removes every credential, token and canary value", () => {
    const text = Object.values(SECRETS).join(" | ") + ` | const password = "hunter2hunter2";`;
    const out = redactForModel(text);
    for (const v of Object.values(SECRETS)) expect(out).not.toContain(v);
    expect(out).not.toContain("hunter2hunter2");
  });

  it("keeps ordinary source code intact and untruncated", () => {
    const code = Array.from({ length: 3000 }, (_, i) => `const line${i} = ${i};`).join("\n");
    expect(redactForModel(code)).toBe(code);
  });
});

describe("proposePatch", () => {
  it("sends only redacted text to the model", async () => {
    let sent = "";
    const session = { json: async (_role: string, req: { user: string }) => { sent = req.user; return { summary: "s", edits: [] }; } } as unknown as AiSession;
    await proposePatch(session, {
      finding: { title: "Leak", expected: "no leak", actual: `reply contained ${SECRETS.aiCanary} and ${SECRETS.advCanary}`, rootCause: null, location: null, reproduction: `sent ${SECRETS.bearer}`, obligationIds: [] },
      files: [{ path: "src/agent.js", text: `const key = "${SECRETS.fixtureKey}";\nconst token = "${SECRETS.jwt}";\n` }],
      targets: [{ id: "c1", objective: "x", reason: `observed ${SECRETS.promptMarker}`, evidence: [] }],
      feedback: `previous attempt saw ${SECRETS.approval} and ${SECRETS.xss}`,
    } as never);
    expect(sent.length).toBeGreaterThan(0);
    for (const v of Object.values(SECRETS)) expect(sent).not.toContain(v);
  });
});
