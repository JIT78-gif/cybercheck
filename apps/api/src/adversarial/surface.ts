import type { AiApplicability, AiEvaluationTarget, AttackSurface, AttackSurfaceEdge, Evidence, ProjectDossier } from "@cybercheck/contracts";
import { seededAccounts } from "../testing/fixtures.ts";
import type { SnapshotSource } from "../understanding/source.ts";
import { detectRenderSinks } from "../ai-evaluator/rendering.ts";

// The attack-surface graph (plan step 6): attacker -> entry -> auth -> role/tenant -> component -> prompt ->
// retrieval/memory -> tool/MCP/agent -> approval -> sink -> protected asset. It merges facts the other checks already
// verified (the AI Evaluator's component and target binding, the dossier's routes and controls, the seeded accounts)
// and every edge cites snapshot-owned evidence. The graph is descriptive: it tells the planner where boundaries and
// assets are; it never authorizes anything by itself.

type Node = { id: string; kind: string; label: string };
const CTRL_AUTH = new Set(["session_required", "role_required", "handler_check", "service_token", "jwt", "bearer_token", "custom_token"]);

export function buildSurface(input: { applicability: AiApplicability; dossier: ProjectDossier; src: SnapshotSource; target: AiEvaluationTarget | null }): AttackSurface {
  const { applicability: a, dossier: d, src } = input;
  const bound = input.target ?? a.targets[0]?.target ?? null;
  const comp = a.components.find((c) => c.id === bound?.componentId) ?? a.components[0] ?? null;
  const nodes = new Map<string, Node>();
  const edges: AttackSurfaceEdge[] = [];
  const node = (id: string, kind: string, label: string) => {
    if (!nodes.has(id)) nodes.set(id, { id, kind, label });
    return id;
  };
  const edge = (from: string, to: string, kind: AttackSurfaceEdge["kind"], label: string, evidence: Evidence[]) => edges.push({ from, to, kind, label, evidence: evidence.slice(0, 4) });
  if (!comp || !bound) return { nodes: [], edges: [] };

  const compEvidence = comp.evidence.length ? comp.evidence : comp.systemPrompts;
  const attacker = node("attacker", "attacker", "Attacker");
  const method = bound.method ?? "POST";
  const route = d.entryPoints.find((e) => e.path === bound.path && e.method === method) ?? d.entryPoints.find((e) => e.path === bound.path);
  const entry = node(`entry:${method} ${bound.path}`, "entry", `${method} ${bound.path}`);
  edge(attacker, entry, "entry", "The attacker reaches the assistant through this route.", route ? [route.handler] : compEvidence);

  // Authentication and the identities behind it.
  let gate = entry;
  if (route && CTRL_AUTH.has(route.control.kind)) {
    const auth = node("auth", "auth", `Authentication (${route.control.kind})`);
    edge(entry, auth, "auth", route.control.reason || "The route requires a signed-in caller.", route.control.evidence.length ? route.control.evidence : [route.handler]);
    gate = auth;
    const accounts = seededAccounts(src);
    for (const role of [...new Set(accounts.map((x) => x.role).filter((r): r is string => Boolean(r)))].slice(0, 4)) {
      const acc = accounts.find((x) => x.role === role)!;
      edge(auth, node(`role:${role}`, "role", `Role: ${role}`), "role", "A seeded identity with this role can sign in.", [acc.at]);
    }
    const tenantLine = [...src.files].find(([p, f]) => !p.includes("node_modules/") && /\.(c|m)?[jt]sx?$|\.py$|\.json$/.test(p) && /\btenant\b|\borg(ani[sz]ation)?Id\b/i.test(f.text));
    if (tenantLine) {
      const [p, f] = tenantLine;
      const line = f.text.split("\n").findIndex((l) => /\btenant\b|\borg(ani[sz]ation)?Id\b/i.test(l)) + 1;
      edge(auth, node("tenant", "tenant", "Tenant boundary"), "tenant", "Records are separated by tenant.", [{ path: p, line: Math.max(1, line) }]);
    }
  }

  // The AI component itself.
  const component = node(`component:${comp.id}`, "component", comp.name);
  edge(gate, component, "component", "The route reaches the AI component.", compEvidence);

  if (comp.systemPrompts.length) edge(component, node("prompt", "prompt", "System prompt and secrets"), "prompt", "A system prompt (and any embedded secret) is assembled for the model.", comp.systemPrompts);
  if (comp.retrieval.length) edge(component, node("retrieval", "retrieval", "Retrieval / knowledge base"), "retrieval", "The component pulls documents into the prompt.", comp.retrieval);
  const historyPath = bound.historyPath ?? (a.targets[0]?.auxiliary as { historyPath?: string | null } | undefined)?.historyPath ?? null;
  if (historyPath || comp.files.some((fp) => /\b(memory|remember|recall)\b/i.test(src.files.get(fp)?.text ?? ""))) {
    const histRoute = historyPath ? d.entryPoints.find((e) => e.path === historyPath) : null;
    edge(component, node("memory", "memory", "Conversation / long-term memory"), "memory", "The component keeps per-caller memory or history.", histRoute ? [histRoute.handler] : compEvidence);
  }

  // Tools, their MCP-style descriptions, approval gates and the sinks they can reach.
  let hasConsequentialTool = false;
  for (const t of comp.tools) {
    const name = t.name ?? "tool";
    const toolNode = node(`tool:${name}`, "tool", `Tool: ${name}${t.consequential ? " (consequential)" : ""}`);
    edge(component, toolNode, "tool", t.consequential ? "A consequential tool the assistant can call." : "A tool the assistant can call.", [t.evidence]);
    if (t.consequential) hasConsequentialTool = true;
  }
  const descFile = comp.files.find((fp) => /description\s*[:=]/i.test(src.files.get(fp)?.text ?? ""));
  if (comp.tools.length && descFile) {
    const text = src.files.get(descFile)!.text;
    const line = text.split("\n").findIndex((l) => /description\s*[:=]/i.test(l)) + 1;
    edge(component, node("mcp", "mcp", "Self-describing tools (MCP-style)"), "mcp", "Tool descriptions are placed in the prompt and may be trusted as policy.", [{ path: descFile, line: Math.max(1, line) }]);
  }
  const agentFile = comp.files.find((fp) => /\b(delegat|sub-?agent|agent\.run|inter-?agent|handoff)\b/i.test(src.files.get(fp)?.text ?? ""));
  if (agentFile) {
    const text = src.files.get(agentFile)!.text;
    const line = text.split("\n").findIndex((l) => /\b(delegat|sub-?agent|agent\.run|inter-?agent|handoff)\b/i.test(l)) + 1;
    edge(component, node("agent", "agent", "Agent delegation"), "agent", "The component delegates to other agents.", [{ path: agentFile, line: Math.max(1, line) }]);
  }
  const approvalPaths = (a.targets[0]?.auxiliary as { approvalPaths?: string[] } | undefined)?.approvalPaths ?? [];
  if (hasConsequentialTool) {
    const approvalRoute = approvalPaths.length ? d.entryPoints.find((e) => approvalPaths.includes(e.path)) : null;
    const approval = node("approval", "approval", "Approval gate");
    const consequential = comp.tools.find((t) => t.consequential)!;
    edge(`tool:${consequential.name ?? "tool"}`, approval, "approval", approvalRoute ? "A consequential action should pass through this approval route." : "No approval route was found for the consequential tool.", approvalRoute ? [approvalRoute.handler] : [consequential.evidence]);
  }
  for (const trig of comp.messageTriggers) {
    const sinkNode = node(`sink:${trig.sink}`, "sink", `${trig.sink} sink`);
    edge(component, sinkNode, "sink", `Message text can drive a ${trig.sink} operation.`, [trig.evidence]);
  }

  // Protected assets the chains aim at, wired from the surface that reaches them.
  const asset = (id: string, label: string) => node(`asset:${id}`, "asset", label);
  if (nodes.has("prompt")) edge("prompt", asset("system-prompt", "The system prompt and embedded secrets"), "asset", "Leaking the prompt exposes instructions and secrets.", comp.systemPrompts);
  if (nodes.has("memory") || nodes.has("retrieval") || nodes.has("tenant")) edge(nodes.has("memory") ? "memory" : nodes.has("retrieval") ? "retrieval" : "tenant", asset("other-user-data", "Another user's or tenant's data"), "asset", "Crossing the memory, retrieval or tenant boundary exposes data that is not the caller's.", compEvidence);
  if (hasConsequentialTool) edge("approval", asset("consequential-action", "A consequential action without approval"), "asset", "A consequential tool reached without approval changes state the caller should not.", compEvidence);
  if (nodes.has("sink:file")) edge("sink:file", asset("files-outside-app", "Files outside the app directory"), "asset", "A file sink driven by the message can read beyond the app.", comp.messageTriggers.filter((t) => t.sink === "file").map((t) => t.evidence));
  if (nodes.has("sink:network")) edge("sink:network", asset("internal-service", "Sandbox-local or internal services"), "asset", "A network sink driven by the message can reach services the caller should not.", comp.messageTriggers.filter((t) => t.sink === "network").map((t) => t.evidence));

  // Output rendering: the browser session is an asset if the reply is injected as HTML.
  const sinks = detectRenderSinks(src, { routePaths: [bound.path, ...comp.endpoints.map((e) => e.split(" ").pop() ?? "")], replySelector: bound.responseSelector });
  if (sinks.length) {
    edge(component, node("render", "sink", "Reply rendered as HTML"), "sink", "A page injects the assistant reply as HTML.", sinks);
    edge("render", asset("browser-session", "The user's browser session"), "asset", "Markup in a reply can execute in the user's browser.", sinks);
  }

  return { nodes: [...nodes.values()], edges };
}
