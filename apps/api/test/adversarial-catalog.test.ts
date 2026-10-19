import { describe, expect, it } from "vitest";
import type { AdversarialAttacker, AiComponentInventory, AiEvaluationTarget } from "@cybercheck/contracts";
import { buildCampaigns, type CatalogInput } from "../src/adversarial/catalog.ts";
import { validateCampaign, type CompileContext } from "../src/adversarial/compiler.ts";
import { defaultRulesOfEngagement } from "../src/adversarial/report.ts";

const ev = (path: string, line = 1) => ({ path, line });
const comp: AiComponentInventory = {
  id: "ai:1", name: "Agent", kind: "local_logic",
  provider: { name: null, family: "none", baseUrlEnv: [], apiKeyEnv: [], hardcodedHosts: [], model: null, interceptable: false, reason: null },
  files: ["src/agent.js"], systemPrompts: [ev("src/agent.js", 6)],
  tools: [{ name: "get_order", evidence: ev("src/tools.js", 8), consequential: false, parameters: [] }, { name: "issue_refund", evidence: ev("src/tools.js", 15), consequential: true, parameters: ["orderId"] }, { name: "read_file", evidence: ev("src/tools.js", 28), consequential: false, parameters: ["filePath"] }, { name: "fetch_url", evidence: ev("src/tools.js", 35), consequential: false, parameters: ["url"] }],
  retrieval: [ev("src/rag.js", 5)], messageTriggers: [{ pattern: "read_file", sink: "file", evidence: ev("src/tools.js", 28) }, { pattern: "fetch", sink: "network", evidence: ev("src/tools.js", 35) }],
  endpoints: ["POST /api/assistant"], evidence: [ev("src/agent.js", 1)], limitations: [],
};
const target: AiEvaluationTarget = { componentId: "ai:1", transport: "http", method: "POST", path: "/api/assistant", requestTemplate: { message: "{{message}}" }, responseSelector: "reply", historyPath: "/api/assistant/memory" };
const attackers: Record<AdversarialAttacker, string | null> = { anonymous: "anonymous", user: "user-a", cross_user: "user-b", cross_tenant: "user-b", lower_role: "user-a", admin: "admin", service: null, agent: null };
const endpoints = new Set(["POST /api/assistant", "POST /api/documents", "GET /api/assistant/memory", "GET /api/orders/{}", "GET /api/admin/summary"]);
const richInput: CatalogInput = { target, component: comp, attackers, surface: { hasRag: true, hasMemory: true, hasTools: true, hasMcp: true, rendersHtml: true, sinks: ["file", "network"] }, auxiliary: { historyPath: "/api/assistant/memory", approvalPaths: ["/api/orders/:id/approve-refund"], listPaths: [] }, endpoints, otherOrderId: "GLOBEX-2002", tenant: "acme" };
const ctx = (): CompileContext => ({ roe: { ...defaultRulesOfEngagement("standard"), allowedEndpoints: [...endpoints], allowedIdentities: ["anonymous", "user-a", "user-b", "admin"], allowedTools: ["get_order", "issue_refund", "read_file", "fetch_url"], allowedFiles: [] }, endpoints, identities: new Set(["anonymous", "user-a", "user-b", "admin"]), tools: new Set(["get_order", "issue_refund", "read_file", "fetch_url"]), files: new Set() });

describe("deterministic attack catalogue", () => {
  const campaigns = buildCampaigns(richInput);
  const techniques = new Set(campaigns.map((c) => c.techniqueId));

  it("covers the frozen Gauntlet chains across every lane", () => {
    for (const t of ["direct-prompt-injection", "indirect-rag-injection", "system-prompt-leak", "rag-tenant-filter-bypass", "cross-tenant-memory-leak", "citation-spoofing", "unauthorized-tool-invocation", "approval-bypass-consequential", "tool-path-escape", "tool-ssrf-local", "mcp-description-trust", "cross-tenant-order-read", "unsafe-output-rendering", "tool-loop-amplification", "memory-poison-to-privileged-action"]) {
      expect(techniques, t).toContain(t);
    }
    expect(new Set(campaigns.map((c) => c.lane)).size).toBe(9); // all 9 lanes
  });

  it("every catalogue campaign passes the rules-of-engagement compiler", () => {
    for (const c of campaigns) expect(validateCampaign(c, ctx()), `${c.id}: ${validateCampaign(c, ctx()).join("; ")}`).toEqual([]);
  });

  it("carries synthetic markers and reset strategies for mutating lanes", () => {
    const refund = campaigns.find((c) => c.techniqueId === "approval-bypass-consequential")!;
    expect(refund.resetStrategy).toBe("db_reseed");
    expect(refund.oracle).toMatchObject({ kind: "state_unchanged", terminal: "refunded" });
    const render = campaigns.find((c) => c.techniqueId === "unsafe-output-rendering")!;
    expect(render.resetStrategy).toBe("fresh_browser");
    expect(render.steps[0]!.operation).toBe("open_known_page");
  });

  it("drops surface-dependent campaigns when the surface is bare", () => {
    const bare = buildCampaigns({ ...richInput, surface: { hasRag: false, hasMemory: false, hasTools: false, hasMcp: false, rendersHtml: false, sinks: [] }, attackers: { ...attackers, cross_user: null, admin: null } });
    const t = new Set(bare.map((c) => c.techniqueId));
    expect(t.has("system-prompt-leak")).toBe(true); // always-on
    expect(t.has("direct-prompt-injection")).toBe(true);
    expect(t.has("unauthorized-tool-invocation")).toBe(false); // no tools
    expect(t.has("cross-tenant-memory-leak")).toBe(false); // no memory/second identity
    expect(t.has("unsafe-output-rendering")).toBe(false); // no render sink
  });
});
