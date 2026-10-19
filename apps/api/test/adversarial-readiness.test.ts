import { describe, expect, it } from "vitest";
import type { AiApplicability, AiComponentInventory, AiEvaluationTarget } from "@cybercheck/contracts";
import { assessReadiness } from "../src/adversarial/readiness.ts";
import { sourceFromFiles } from "../src/understanding/source.ts";

// AI Adversarial Step 5: the readiness gate. It reuses the shared applicability and decides, per lane, whether there is
// enough surface and fixtures to attack. A missing surface blocks only the dependent lane; independent lanes run.

const ev = (path: string, line = 1) => ({ path, line });
function comp(over: Partial<AiComponentInventory> = {}): AiComponentInventory {
  return {
    id: "ai:1",
    name: "Agent",
    kind: "local_logic",
    provider: { name: null, family: "none", baseUrlEnv: [], apiKeyEnv: [], hardcodedHosts: [], model: null, interceptable: false, reason: null },
    files: ["src/agent.js"],
    systemPrompts: [ev("src/agent.js", 2)],
    tools: [],
    retrieval: [],
    messageTriggers: [],
    endpoints: ["POST /api/assistant"],
    evidence: [ev("src/agent.js", 1)],
    limitations: [],
    ...over,
  };
}
const target = (over: Partial<AiEvaluationTarget> = {}): AiEvaluationTarget => ({ componentId: "ai:1", transport: "http", method: "POST", path: "/api/assistant", requestTemplate: { message: "{{message}}" }, responseSelector: "reply", ...over });
function applicable(c: AiComponentInventory, t: AiEvaluationTarget): AiApplicability {
  return { status: "applicable", reason: "bound", components: [c], candidates: [], targets: [{ target: t, boundBy: "single_route", auxiliary: { historyPath: t.historyPath ?? null, listPaths: [], approvalPaths: [] } }], unbound: [], unsupported: [], ownership: { ok: true, checked: 1, failed: [] } };
}

const RICH_FILES = {
  "src/store.js": `const users = [\n  { email: "ava@acme.test", password: "AvaPass123!", role: "customer", tenant: "acme" },\n  { email: "bo@globex.test", password: "BoPass123!", role: "customer", tenant: "globex" },\n];`,
  "src/agent.js": `// tools with a description, memory recall\nconst TOOLS = { issue_refund: { description: "refund", consequential: true } };\nfunction recall(){ return memory; }`,
  "public/app.html": `<script>const x = await (await fetch('/api/assistant')).json(); answer.innerHTML = x.reply;</script>`,
};
const BARE_FILES = { "src/store.js": `const user = { email: "solo@x.test", password: "SoloPass1!" };`, "src/agent.js": `function answer(m){ return "ok"; }` };
const richSrc = sourceFromFiles(RICH_FILES);
const bareSrc = sourceFromFiles(BARE_FILES);
const richComp = comp({ tools: [{ name: "issue_refund", evidence: ev("src/agent.js", 2), consequential: true, parameters: ["orderId"] }], retrieval: [ev("src/agent.js", 3)], messageTriggers: [{ pattern: "read_file", sink: "file", evidence: ev("src/agent.js", 2) }, { pattern: "fetch", sink: "network", evidence: ev("src/agent.js", 2) }] });
const richTarget = target({ historyPath: "/api/assistant/memory" });
const lane = (r: ReturnType<typeof assessReadiness>, l: string) => r.lanes.find((x) => x.lane === l)!;
const ready = { runtimeAvailable: true, appStartable: true } as const;

describe("AI Adversarial readiness gate", () => {
  it("is not_applicable when no AI component was found", () => {
    const r = assessReadiness({ applicability: { status: "not_applicable", reason: "no AI", components: [], candidates: [], targets: [], unbound: [], unsupported: [], ownership: { ok: true, checked: 1, failed: [] } }, src: bareSrc, ...ready });
    expect(r.status).toBe("not_applicable");
    expect(r.lanes).toHaveLength(0);
  });

  it("is no_target (insufficient evidence) when AI is present but no route binds", () => {
    const r = assessReadiness({ applicability: { status: "no_target", reason: "AI found, no route", components: [comp()], candidates: [], targets: [], unbound: [{ componentId: "ai:1", reason: "no route", candidates: [] }], unsupported: [], ownership: { ok: true, checked: 1, failed: [] } }, src: bareSrc, ...ready });
    expect(r.status).toBe("no_target");
    expect(r.notes.join(" ")).toMatch(/not enough evidence/i);
  });

  it("reports ownership_failed", () => {
    const r = assessReadiness({ applicability: { status: "ownership_failed", reason: "evidence not in snapshot", components: [], candidates: [], targets: [], unbound: [], unsupported: [], ownership: { ok: false, checked: 2, failed: ["x:1 not in snapshot"] } }, src: bareSrc, ...ready });
    expect(r.status).toBe("ownership_failed");
  });

  it("opens every lane for a rich surface (tools, RAG, memory, MCP, two tenants, render sink)", () => {
    const r = assessReadiness({ applicability: applicable(richComp, richTarget), src: richSrc, target: richTarget, ...ready });
    expect(r.status).toBe("ready");
    expect(r.surface).toMatchObject({ hasTools: true, hasRag: true, hasMemory: true, hasMcp: true, rendersHtml: true, multiTenant: true });
    expect(r.surface.identities).toBe(2);
    for (const l of ["prompt", "leakage", "rag_memory", "tools_approval", "identity_tenant", "mcp_agent", "output_handling", "resource_concurrency", "multi_stage"]) expect(lane(r, l).available, l).toBe(true);
    expect(r.surface.sinks).toEqual(expect.arrayContaining(["file", "network"]));
  });

  it("blocks only the dependent lanes for a bare surface", () => {
    const r = assessReadiness({ applicability: applicable(comp(), target()), src: bareSrc, target: target(), ...ready });
    expect(r.status).toBe("ready");
    // Independent lanes still run.
    expect(lane(r, "prompt").available).toBe(true);
    expect(lane(r, "leakage").available).toBe(true);
    expect(lane(r, "output_handling").available).toBe(true);
    expect(lane(r, "resource_concurrency").available).toBe(true);
    // Surface-dependent lanes are blocked, each with a reason.
    expect(lane(r, "tools_approval").available).toBe(false);
    expect(lane(r, "rag_memory").available).toBe(false);
    expect(lane(r, "identity_tenant").available).toBe(false);
    expect(lane(r, "mcp_agent").available).toBe(false);
    // With fewer than two single-stage weaknesses, no chain can be attempted.
    expect(lane(r, "multi_stage").available).toBe(false);
  });

  it("blocks every lane when no runtime or app is available, without changing applicability", () => {
    const noRuntime = assessReadiness({ applicability: applicable(richComp, richTarget), src: richSrc, target: richTarget, runtimeAvailable: false, appStartable: true });
    expect(noRuntime.status).toBe("ready");
    expect(noRuntime.lanes.every((l) => !l.available)).toBe(true);
    expect(lane(noRuntime, "tools_approval").reason).toMatch(/runtime/i);
    const noApp = assessReadiness({ applicability: applicable(richComp, richTarget), src: richSrc, target: richTarget, runtimeAvailable: true, appStartable: false });
    expect(noApp.lanes.every((l) => !l.available)).toBe(true);
  });

  it("a contradiction blocks only the named lane", () => {
    const r = assessReadiness({ applicability: applicable(richComp, richTarget), src: richSrc, target: richTarget, ...ready, contradictions: { tools_approval: "Security already confirmed this is unreachable" } });
    expect(lane(r, "tools_approval").available).toBe(false);
    expect(lane(r, "tools_approval").reason).toMatch(/contradiction/i);
    expect(lane(r, "rag_memory").available).toBe(true); // independent lane continues
  });
});
