import { describe, expect, it } from "vitest";
import type { AiApplicability, AiComponentInventory, AiEvaluationTarget, EntryPoint, ProjectDossier } from "@cybercheck/contracts";
import { buildSurface } from "../src/adversarial/surface.ts";
import { sourceFromFiles } from "../src/understanding/source.ts";

// AI Adversarial Step 6: the attack-surface graph. Every edge must cite evidence, and the graph must connect the
// attacker to the protected assets through the authentication, component, tool, memory and rendering boundaries.

const ev = (path: string, line = 1) => ({ path, line });
const route = (method: string, path: string, controlKind = "none"): EntryPoint =>
  ({ id: `${method} ${path}`, status: "verified", kind: "http", method, path, framework: "express", handler: ev("src/app.js", 10), control: { kind: controlKind, reason: controlKind === "none" ? "open" : "requires a signed-in caller", via: [], evidence: [ev("src/auth.js", 5)] }, requestSchema: null, inputs: { params: null, query: null, body: null, files: false }, mutates: method !== "GET", sideEffects: [] }) as unknown as EntryPoint;

const comp: AiComponentInventory = {
  id: "ai:1",
  name: "Agent Mart assistant",
  kind: "local_logic",
  provider: { name: null, family: "none", baseUrlEnv: [], apiKeyEnv: [], hardcodedHosts: [], model: null, interceptable: false, reason: null },
  files: ["src/agent.js"],
  systemPrompts: [ev("src/agent.js", 6)],
  tools: [
    { name: "get_order", evidence: ev("src/tools.js", 8), consequential: false, parameters: ["orderId"] },
    { name: "issue_refund", evidence: ev("src/tools.js", 15), consequential: true, parameters: ["orderId"] },
  ],
  retrieval: [ev("src/rag.js", 5)],
  messageTriggers: [
    { pattern: "read_file", sink: "file", evidence: ev("src/tools.js", 28) },
    { pattern: "fetch", sink: "network", evidence: ev("src/tools.js", 35) },
  ],
  endpoints: ["POST /api/assistant"],
  evidence: [ev("src/agent.js", 1)],
  limitations: [],
};
const target: AiEvaluationTarget = { componentId: "ai:1", transport: "http", method: "POST", path: "/api/assistant", requestTemplate: { message: "{{message}}" }, responseSelector: "reply", historyPath: "/api/assistant/memory" };
const applicability: AiApplicability = {
  status: "applicable",
  reason: "bound",
  components: [comp],
  candidates: [],
  targets: [{ target, boundBy: "single_route", auxiliary: { historyPath: "/api/assistant/memory", listPaths: [], approvalPaths: ["/api/orders/:id/approve-refund"] } }],
  unbound: [],
  unsupported: [],
  ownership: { ok: true, checked: 1, failed: [] },
};
const dossier = {
  entryPoints: [route("POST", "/api/assistant", "session_required"), route("GET", "/api/assistant/memory", "session_required"), route("POST", "/api/orders/:id/approve-refund", "session_required")],
} as unknown as ProjectDossier;
const src = sourceFromFiles({
  "src/store.js": `const users = [\n  { email: "ava@acme.test", password: "AvaPass123!", role: "customer", tenant: "acme" },\n  { email: "admin@acme.test", password: "AdminPass1!", role: "admin", tenant: "acme" },\n];`,
  "src/agent.js": `const SYSTEM_PROMPT = "secret";\nconst TOOLS = { x: { description: "desc" } };`,
  "public/app.html": `<script>const x = await (await fetch('/api/assistant')).json(); answer.innerHTML = x.reply;</script>`,
});

describe("AI Adversarial attack-surface graph", () => {
  const g = buildSurface({ applicability, dossier, src, target });
  const ids = new Set(g.nodes.map((n) => n.id));
  const kinds = new Set(g.nodes.map((n) => n.kind));

  it("connects the attacker through auth, component, tools, memory and rendering to assets", () => {
    expect(ids.has("attacker")).toBe(true);
    expect(ids.has("entry:POST /api/assistant")).toBe(true);
    expect(ids.has("auth")).toBe(true);
    expect([...ids].some((i) => i.startsWith("role:"))).toBe(true);
    expect(ids.has("tenant")).toBe(true);
    expect(ids.has("component:ai:1")).toBe(true);
    expect(ids.has("prompt")).toBe(true);
    expect(ids.has("retrieval")).toBe(true);
    expect(ids.has("memory")).toBe(true);
    expect(ids.has("tool:issue_refund")).toBe(true);
    expect(ids.has("mcp")).toBe(true);
    expect(ids.has("approval")).toBe(true);
    expect(ids.has("sink:file")).toBe(true);
    expect(ids.has("sink:network")).toBe(true);
    expect(ids.has("render")).toBe(true);
    expect(kinds.has("asset")).toBe(true);
  });

  it("maps the expected protected assets", () => {
    const assets = new Set(g.nodes.filter((n) => n.kind === "asset").map((n) => n.id));
    expect(assets).toEqual(new Set(["asset:system-prompt", "asset:other-user-data", "asset:consequential-action", "asset:files-outside-app", "asset:internal-service", "asset:browser-session"]));
  });

  it("every edge cites at least one piece of evidence", () => {
    expect(g.edges.length).toBeGreaterThan(8);
    for (const e of g.edges) expect(e.evidence.length, `${e.from} -> ${e.to}`).toBeGreaterThanOrEqual(1);
  });

  it("the consequential tool's approval edge points at the approval gate", () => {
    const approvalEdge = g.edges.find((e) => e.kind === "approval");
    expect(approvalEdge?.from).toBe("tool:issue_refund");
    expect(approvalEdge?.to).toBe("approval");
  });

  it("returns an empty graph when there is no bound component", () => {
    const empty = buildSurface({ applicability: { ...applicability, status: "not_applicable", components: [], targets: [] }, dossier, src, target: null });
    expect(empty.nodes).toEqual([]);
    expect(empty.edges).toEqual([]);
  });
});
