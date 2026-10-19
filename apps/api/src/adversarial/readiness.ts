import type { AdversarialApplicability, AdversarialLane, AiApplicability, AiEvaluationTarget } from "@cybercheck/contracts";
import { seededAccounts } from "../testing/fixtures.ts";
import type { SnapshotSource } from "../understanding/source.ts";
import { detectRenderSinks } from "../ai-evaluator/rendering.ts";

// The AI Adversarial readiness gate. Before any attack is planned it checks that the run can be exercised safely and
// decides, per lane, whether there is enough surface and fixtures to attack it. It reuses the AI Evaluator's
// applicability (ownership, component detection, target binding) and adds the adversarial surface and lane gating.
// A missing surface blocks only the lanes that depend on it; independent lanes still run. An AI component with no
// reachable target is insufficient evidence, never not_applicable.

const LANE_LABEL: Record<AdversarialLane, string> = {
  prompt: "Prompt and context control",
  leakage: "Leakage",
  rag_memory: "RAG and memory isolation",
  tools_approval: "Tools and approval",
  identity_tenant: "Identity and tenant boundaries",
  mcp_agent: "MCP and agent trust",
  output_handling: "Output handling",
  resource_concurrency: "Resource and concurrency resilience",
  multi_stage: "Multi-stage chain resistance",
};
const LANES = Object.keys(LANE_LABEL) as AdversarialLane[];

export type AdversarialSurface = {
  hasRag: boolean;
  hasMemory: boolean;
  hasTools: boolean;
  hasMcp: boolean;
  rendersHtml: boolean;
  /** Message-driven sinks the component exposes (file read, command, network, database), for tool-escape and SSRF lanes. */
  sinks: string[];
  identities: number;
  multiTenant: boolean;
  resetSupported: boolean;
  resetStrategy: string;
};

export type LaneReadiness = { lane: AdversarialLane; label: string; available: boolean; reason: string };

export type AdversarialReadiness = {
  status: "ready" | "not_applicable" | "no_target" | "ownership_failed";
  reason: string;
  applicability: AdversarialApplicability;
  surface: AdversarialSurface;
  lanes: LaneReadiness[];
  /** Human notes about what blocked a lane or the whole run (fixtures, runtime, contradictions). */
  notes: string[];
};

/** Map the AI Evaluator's applicability (shared detection) into the adversarial shape. */
function toAdversarialApplicability(a: AiApplicability): AdversarialApplicability {
  const status = a.status === "ownership_failed" ? "not_applicable" : a.status; // ownership is reported separately below
  return {
    status: status as AdversarialApplicability["status"],
    reason: a.reason,
    components: a.components,
    targets: a.targets.map((t) => ({ target: t.target, boundBy: t.boundBy, auxiliary: (t.auxiliary ?? {}) as Record<string, unknown> })),
    unbound: a.unbound.map((u) => ({ componentId: u.componentId, reason: u.reason })),
  };
}

export function detectSurface(a: AiApplicability, src: SnapshotSource, target: AiEvaluationTarget | null): AdversarialSurface {
  const comp = a.components.find((c) => c.id === (target?.componentId ?? a.targets[0]?.target.componentId)) ?? a.components[0] ?? null;
  const files = comp?.files ?? [];
  const text = files.map((f) => src.files.get(f)?.text ?? "").join("\n");
  const aux = (a.targets[0]?.auxiliary ?? {}) as { historyPath?: string | null };
  const accounts = seededAccounts(src);
  const bound = target ?? a.targets[0]?.target ?? null;
  const routePaths = bound ? [bound.path, ...(comp?.endpoints.map((e) => e.split(" ").pop() ?? "") ?? [])] : [];
  const rendersHtml = bound ? detectRenderSinks(src, { routePaths, replySelector: bound.responseSelector }).length > 0 : false;
  // Tenancy lives in the data model (seed/store files), not the component file, so scan the project's own code.
  const multiTenant = [...src.files].some(([p, f]) => !p.includes("node_modules/") && /\.(c|m)?[jt]sx?$|\.py$|\.json$|\.sql$/.test(p) && /\btenant\b|\borg(ani[sz]ation)?Id\b|\baccountId\b/i.test(f.text));
  return {
    hasRag: Boolean(comp && comp.retrieval.length > 0),
    hasMemory: Boolean(bound?.historyPath || aux.historyPath || /\b(memory|remember|recall|conversation\s*history|long[-\s]?term)\b/i.test(text)),
    hasTools: Boolean(comp && comp.tools.length > 0),
    hasMcp: Boolean(comp && comp.tools.length > 0 && /description\s*[:=]|mcp|modelcontextprotocol/i.test(text)),
    rendersHtml,
    sinks: comp ? [...new Set(comp.messageTriggers.map((t) => t.sink))] : [],
    identities: accounts.length,
    multiTenant,
    resetSupported: true, // a fresh application sandbox is always available as a last-resort reset
    resetStrategy: /\/reset\b|resetDatabase|reseed|truncate/i.test(text) || [...src.files.keys()].some((p) => /reset/i.test(p)) ? "db_reseed" : "fresh_app",
  };
}

export type ReadinessInput = {
  applicability: AiApplicability;
  src: SnapshotSource;
  target?: AiEvaluationTarget | null;
  /** A runtime (Nebius or local Docker) is available to execute campaigns. */
  runtimeAvailable: boolean;
  /** The app can be booted in the sandbox. */
  appStartable: boolean;
  /** Lanes a contradiction with Analyze, Security or the AI Evaluator makes untrustworthy (blocks only these). */
  contradictions?: Partial<Record<AdversarialLane, string>>;
};

export function assessReadiness(input: ReadinessInput): AdversarialReadiness {
  const { applicability: a, src } = input;
  const applicability = toAdversarialApplicability(a);
  const bound = input.target ?? a.targets[0]?.target ?? null;
  const surface = detectSurface(a, src, bound);
  const notes: string[] = [];

  if (a.status === "ownership_failed") return { status: "ownership_failed", reason: a.reason, applicability, surface, lanes: [], notes: [a.reason] };
  if (a.status === "not_applicable") return { status: "not_applicable", reason: a.reason, applicability, surface, lanes: [], notes: [] };
  if (a.status === "no_target") {
    const unsupported = a.unsupported?.length ? ` Unsupported AI code was also seen: ${a.unsupported.map((u) => u.what).slice(0, 3).join(", ")}.` : "";
    return { status: "no_target", reason: a.reason, applicability, surface, lanes: [], notes: [`An AI component was found but no reachable target could be bound, so there is not enough evidence to attack it.${unsupported}`] };
  }
  // a.status === "applicable"
  const contradictions = input.contradictions ?? {};
  const gate = (lane: AdversarialLane, surfaceOk: boolean, surfaceReason: string): LaneReadiness => {
    const label = LANE_LABEL[lane];
    if (contradictions[lane]) return { lane, label, available: false, reason: `A contradiction with another check blocks this lane: ${contradictions[lane]}` };
    if (!input.runtimeAvailable) return { lane, label, available: false, reason: "No sandbox runtime is available to execute campaigns." };
    if (!input.appStartable) return { lane, label, available: false, reason: "The app could not be started in the sandbox." };
    return { lane, label, available: surfaceOk, reason: surfaceReason };
  };

  const lanes: LaneReadiness[] = [
    gate("prompt", true, "The assistant takes untrusted input through its bound route."),
    gate("leakage", true, "Every reply is checked for leaked prompts, secrets, markers and other users' data."),
    gate("rag_memory", surface.hasRag || surface.hasMemory, surface.hasRag || surface.hasMemory ? "Retrieval or memory surface found." : "No retrieval or memory surface was detected."),
    gate("tools_approval", surface.hasTools, surface.hasTools ? "The component exposes tools." : "The component exposes no tools."),
    gate("identity_tenant", surface.identities >= 2, surface.identities >= 2 ? `${surface.identities} seeded identities to compare across users and tenants.` : "Fewer than two seeded identities, so cross-user and cross-tenant boundaries cannot be compared."),
    gate("mcp_agent", surface.hasMcp, surface.hasMcp ? "Self-describing tools or an MCP/agent surface were detected." : "No MCP server, tool description or agent delegation surface was detected."),
    gate("output_handling", true, surface.rendersHtml ? "A page injects the reply as HTML, so unsafe rendering can be exercised in a browser." : "Reply-channel checks run; no HTML rendering sink was detected, so the browser XSS canary is limited."),
    gate("resource_concurrency", true, "The bound route can be exercised with bounded repeats and parallelism."),
    gate("multi_stage", false, ""),
  ];
  // Multi-stage chaining needs at least two single-stage weaknesses (a boundary-crossing lane) to correlate. The
  // always-on lanes (leakage, resource) are not boundaries on their own; output rendering counts only with a real sink.
  const weaknessLanes: AdversarialLane[] = ["prompt", "rag_memory", "tools_approval", "identity_tenant", "mcp_agent"];
  const singleStageRunnable = lanes.filter((l) => l.available && (weaknessLanes.includes(l.lane) || (l.lane === "output_handling" && surface.rendersHtml))).length;
  const multi = lanes.find((l) => l.lane === "multi_stage")!;
  if (contradictions.multi_stage) Object.assign(multi, { available: false, reason: `A contradiction with another check blocks this lane: ${contradictions.multi_stage}` });
  else if (!input.runtimeAvailable || !input.appStartable) Object.assign(multi, { available: false, reason: !input.runtimeAvailable ? "No sandbox runtime is available to execute campaigns." : "The app could not be started in the sandbox." });
  else Object.assign(multi, { available: singleStageRunnable >= 2, reason: singleStageRunnable >= 2 ? `${singleStageRunnable} single-stage lanes can be chained.` : "Fewer than two single-stage weaknesses are reachable, so no multi-stage chain can be attempted." });

  for (const l of lanes) if (!l.available) notes.push(`${l.label}: ${l.reason}`);
  const runnable = lanes.filter((l) => l.available).length;
  return { status: "ready", reason: `${runnable} of ${lanes.length} lanes can be attacked; ${surface.identities} identities, surface [${[surface.hasRag && "rag", surface.hasMemory && "memory", surface.hasTools && "tools", surface.hasMcp && "mcp", surface.rendersHtml && "render-sink"].filter(Boolean).join(", ") || "none"}].`, applicability, surface, lanes, notes };
}
