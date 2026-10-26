import { describe, expect, it } from "vitest";
import { assessApplicability, bodyFields, importBindings } from "../src/ai-evaluator/applicability.ts";
import { analyzed, BENCH } from "./ai-helpers.ts";

// AI Evaluator Step 3: applicability, evidence ownership and target binding, before any sandbox or model is used.

describe("applicability", () => {
  it("a project with no AI component is not applicable", async () => {
    const { d, src } = await analyzed(BENCH.noAi);
    const a = assessApplicability({ dossier: d, src, contentDigest: "digest-1" });
    expect(a.status).toBe("not_applicable");
    expect(a.components).toEqual([]);
    expect(a.ownership.ok).toBe(true);
  });

  it("the Gauntlet's prompt-built assistant is an AI component with no provider, bound to its chat route", async () => {
    const { d, src } = await analyzed(BENCH.gauntlet);
    const a = assessApplicability({ dossier: d, src, contentDigest: "digest-1" });
    expect(a.status).toBe("applicable");
    expect(a.components).toHaveLength(1);
    const c = a.components[0]!;
    expect(c.kind).toBe("local_logic");
    expect(c.provider.family).toBe("none");
    expect(c.provider.interceptable).toBe(false);
    expect(c.endpoints).toEqual(expect.arrayContaining(["POST /api/assistant", "GET /api/assistant/history"]));
    expect(c.retrieval).toEqual([expect.objectContaining({ path: "src/ai.js", line: 7 })]);
    expect(c.messageTriggers).toEqual([expect.objectContaining({ sink: "file", evidence: { path: "src/ai.js", line: 17 } })]);
    const t = a.targets[0]!;
    expect(t.boundBy).toBe("single_route");
    expect(t.target).toMatchObject({ method: "POST", path: "/api/assistant", requestTemplate: { message: "{{message}}" }, responseSelector: "reply", authFixture: "user-a" });
    expect(t.auxiliary.historyPath).toBe("/api/assistant/history");
  });

  it("the clean control's configured OpenAI-compatible client can be routed through the gateway", async () => {
    const { d, src } = await analyzed(BENCH.aiControl);
    const a = assessApplicability({ dossier: d, src, contentDigest: "digest-1" });
    expect(a.status).toBe("applicable");
    const c = a.components[0]!;
    expect(c.kind).toBe("provider_http");
    expect(c.provider).toMatchObject({ family: "openai_compatible", interceptable: true, hardcodedHosts: [] });
    expect(c.provider.baseUrlEnv).toContain("AI_BASE_URL");
    expect(c.provider.apiKeyEnv).toContain("AI_API_KEY");
    expect(c.tools.map((t) => [t.name, t.consequential, t.parameters])).toEqual([
      ["get_order_status", false, ["orderId"]],
      ["cancel_order", true, ["orderId"]],
    ]);
    expect(a.targets[0]!.target).toMatchObject({ path: "/api/assistant", responseSelector: "reply", conversationSelector: "conversationId", citationSelector: "citations", historyPath: "/api/assistant/history" });
    expect(a.targets[0]!.auxiliary.approvalPaths).toEqual(["/api/assistant/approvals/:id/confirm"]);
    expect(a.targets[0]!.auxiliary.listPaths).toEqual(["/api/orders"]);
  });

  it("evidence from another snapshot fails ownership instead of being trusted", async () => {
    const { d, src } = await analyzed(BENCH.gauntlet);
    expect(assessApplicability({ dossier: d, src, contentDigest: "another-digest" }).status).toBe("ownership_failed");
    const moved = { ...d, aiComponents: [{ ...d.aiComponents[0]!, systemPrompts: [{ evidence: { path: "src/missing.js", line: 3 }, preview: "x" }] }] };
    const a = assessApplicability({ dossier: moved, src, contentDigest: "digest-1" });
    expect(a.status).toBe("ownership_failed");
    expect(a.ownership.failed[0]).toMatch(/src\/missing\.js:3/);
  });

  it("a declared target must be a real route; an unknown one is refused, never guessed", async () => {
    const { d, src } = await analyzed(BENCH.gauntlet);
    const ok = assessApplicability({ dossier: d, src, contentDigest: "digest-1", target: { componentId: "ai:1", transport: "http", method: "POST", path: "/api/assistant", requestTemplate: { message: "{{message}}" }, responseSelector: "reply" } });
    expect(ok.targets[0]!.boundBy).toBe("user");
    const bad = assessApplicability({ dossier: d, src, contentDigest: "digest-1", target: { componentId: "ai:1", transport: "http", method: "POST", path: "/api/chat", requestTemplate: { message: "{{message}}" }, responseSelector: "reply" } });
    expect(bad.status).toBe("no_target");
    expect(bad.unbound[0]!.reason).toMatch(/not a route/);
  });

  it("two candidate routes are ambiguous and are not bound", async () => {
    const { d, src } = await analyzed(BENCH.gauntlet);
    const twin = { ...d, entryPoints: [...d.entryPoints, { ...d.entryPoints.find((e) => e.path === "/api/assistant")!, id: "endpoint:POST /api/assistant2", path: "/api/assistant2" }] };
    const a = assessApplicability({ dossier: twin, src, contentDigest: "digest-1" });
    expect(a.status).toBe("no_target");
    expect(a.unbound[0]!.reason).toMatch(/2 routes/);
  });
});

describe("handler reading", () => {
  it("reads body fields from member access and destructuring", () => {
    expect(bodyFields("const { message, conversationId } = req.body ?? {};")).toEqual(["message", "conversationId"]);
    expect(bodyFields('res.json(await a.answer({ message: String(req.body.message ?? "") }))')).toEqual(["message"]);
    expect(bodyFields("const q = req.query.q;")).toEqual([]);
    expect(bodyFields('question = request.json["question"]')).toEqual(["question"]);
  });

  it("reads require and import bindings", () => {
    expect(importBindings("a.js", 'const assistant = require("./ai");\nconst { x, y: z } = require("./b");')).toEqual([
      { spec: "./ai", ns: "assistant", names: [] },
      { spec: "./b", ns: null, names: ["x", "z"] },
    ]);
    expect(importBindings("a.ts", 'import chat, { ask as askIt } from "./chat";\nimport * as llm from "../llm";')).toEqual([
      { spec: "./chat", ns: "chat", names: ["askIt"] },
      { spec: "../llm", ns: "llm", names: [] },
    ]);
    expect(importBindings("a.py", "from .assistant import answer, history\nimport app.llm as llm")).toEqual([
      { spec: ".assistant", ns: null, names: ["answer", "history"] },
      { spec: "app.llm", ns: "llm", names: [] },
    ]);
  });
});
