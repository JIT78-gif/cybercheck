import { AD_PROFILE_LIMITS, AttackOperation, type AdversarialAttacker, type AdversarialLane, type AdversarialPriority, type AdversarialProfile, type RulesOfEngagement } from "@cybercheck/contracts";
import { pathMatchesRoute } from "../security/proofs/compiler.ts";
import { defaultRulesOfEngagement } from "./report.ts";

// The rules-of-engagement compiler (plan step 7). Only the typed catalogue operations are executable, and every plan
// is checked against the rules of engagement and the safety rules: no external host or callback, no unknown endpoint,
// tool, file or identity, no shell, reverse shell, persistence, destructive query, cloud-metadata target or arbitrary
// navigation, and nothing unbounded. AI may propose a plan; only a plan that passes here is ever executed.

const SHELL = /(^|[;&|`$])\s*(rm|wget|curl|nc|ncat|netcat|bash|sh|zsh|python|perl|ruby|powershell|cmd|chmod|chown|kill|mkfifo|mount|certutil)\b|\/bin\/(sh|bash)|\brevshell\b|\bnc\s+-e|\|\s*(ba|z)?sh\b|\$\([^)]*\)|`[^`]*`/i;
const DESTRUCTIVE = /\b(drop|truncate|delete)\s+(table|from|database)\b|\bshutdown\b|\balter\s+table\b|;\s*--|\bupdate\b[^;]*\bset\b[^;]*\bwhere\b\s+1\s*=\s*1/i;
const PERSIST = /\b(crontab|systemctl|authorized_keys|startup|registry|HKLM|HKCU)\b|\.(bashrc|profile|bash_profile|zshrc)\b/i;
const CLOUD_META = /169\.254\.169\.254|metadata\.google\.internal|metadata\.azure\.com|100\.100\.100\.200/i;
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1", "0.0.0.0"]);

/** URLs in a value that reach outside the sandbox (external host, callback or non-http scheme). */
export function externalUrls(value: unknown): string[] {
  const bad: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\b([a-z][a-z0-9+.-]*):\/\/([^/\s"']+)/gi)) {
        const scheme = m[1]!.toLowerCase();
        const host = m[2]!.toLowerCase().replace(/^[^@]*@/, "").replace(/:\d+$/, "");
        if (scheme !== "http" && scheme !== "https") bad.push(m[0]!);
        else if (!LOCAL_HOSTS.has(host) && !host.endsWith(".localhost")) bad.push(m[0]!);
      }
      if (/^\/\/[^/]/.test(v)) bad.push(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return bad;
}

export const ENDPOINT_OPS = new Set<AttackOperation>(["send_message", "send_indirect_content", "upload_synthetic_document", "retrieve_synthetic_document", "inspect_known_state", "compare_identity_response", "reset_state", "send_request"]);
export const ANONYMOUS = "anonymous";

export type PlannedStep = {
  operation: AttackOperation;
  asIdentity: string | null;
  /** An endpoint "METHOD /path", a tool name, a file path, or a page path, depending on the operation. */
  target: string;
  inputClass: string;
  message?: string;
  content?: string;
  toolArgs?: Record<string, unknown>;
  url?: string;
  filePath?: string;
  repeat?: number;
  parallel?: number;
  // General attacker track (send_request / capture).
  body?: Record<string, unknown>;
  query?: Record<string, string>;
  /** For `capture`: read a value from the previous response into a named symbol the next step can use. */
  capture?: { name: string; path: string };
};
export type PlannedCampaign = {
  id: string;
  lane: AdversarialLane;
  techniqueId: string;
  priority: AdversarialPriority;
  title: string;
  target: { componentId: string; endpoint: string };
  attacker: AdversarialAttacker;
  resetStrategy: "none" | "db_rollback" | "db_reseed" | "new_conversation" | "memory_cleanup" | "file_overlay" | "fresh_app" | "fresh_browser";
  steps: PlannedStep[];
  track?: "general" | "ai";
  /** Setup/identity graph nodes that must pass before an attack request can be sent. */
  fixtureDependencies?: string[];
  source: "catalogue" | "attacker_model" | "attack_pack";
};
export type CompileContext = {
  roe: RulesOfEngagement;
  endpoints: Set<string>;
  identities: Set<string>;
  tools: Set<string>;
  /** File paths the file tool may read (synthetic fixtures and the planted canary). */
  files: Set<string>;
  /** Maximum catalogue campaigns for this profile. */
  maxCampaigns?: number;
};

export type RulesAuthority = Pick<RulesOfEngagement, "allowedEndpoints" | "allowedIdentities" | "allowedTools" | "allowedFiles" | "allowedDataClasses" | "allowedMutationTypes" | "canaries">;

/**
 * Narrow requested rules against resources the server proved belong to this run. A request can remove authority but
 * can never add it. With no authority argument the returned lists remain empty; callers must not treat those empty
 * lists as permission to access arbitrary resources.
 */
export function clampRules(requested: Partial<RulesOfEngagement> | null, profile: AdversarialProfile, authority?: RulesAuthority): RulesOfEngagement {
  const base = defaultRulesOfEngagement(profile);
  const limits = base.limits;
  const rl = (requested?.limits ?? {}) as Partial<typeof limits>;
  const narrow = (k: keyof typeof limits) => Math.max(0, Math.min(limits[k], rl[k] ?? limits[k]));
  const owned = authority ?? base;
  const restrict = (key: keyof RulesAuthority) => {
    const server = new Set(owned[key]);
    const asked = requested?.[key];
    return asked === undefined ? [...server] : [...new Set(asked)].filter((v) => server.has(v));
  };
  return {
    allowedEndpoints: restrict("allowedEndpoints"),
    allowedIdentities: restrict("allowedIdentities"),
    allowedTools: restrict("allowedTools"),
    allowedFiles: restrict("allowedFiles"),
    allowedDataClasses: restrict("allowedDataClasses"),
    allowedMutationTypes: restrict("allowedMutationTypes"),
    canaries: restrict("canaries"),
    externalNetwork: false, // external network can never be enabled through a request
    limits: { requests: narrow("requests"), requestsPerTarget: narrow("requestsPerTarget"), authAttempts: narrow("authAttempts"), stepsPerChain: narrow("stepsPerChain"), toolCalls: narrow("toolCalls"), tokens: narrow("tokens"), timeoutSec: narrow("timeoutSec"), costUsd: narrow("costUsd"), concurrency: narrow("concurrency") },
  };
}

const text = (s: PlannedStep) => [s.message ?? "", s.content ?? "", s.toolArgs ? JSON.stringify(s.toolArgs) : "", s.url ?? "", s.filePath ?? "", s.body ? JSON.stringify(s.body) : "", s.query ? JSON.stringify(s.query) : ""].join(" ");

/** Reasons a campaign is rejected (empty = allowed). */
export function validateCampaign(c: PlannedCampaign, ctx: CompileContext): string[] {
  const reasons: string[] = [];
  const allowedIdentity = (name: string) => ctx.roe.allowedIdentities.includes(name) || ctx.roe.allowedIdentities.includes(name.replace(/#(forged|tampered)$/, ""));
  const known = (name: string | null) => name === null || ((name === ANONYMOUS || ctx.identities.has(name) || ctx.identities.has(name.replace(/#(forged|tampered)$/, ""))) && allowedIdentity(name));
  const endpointKnown = (ref: string) => {
    const [method, path] = ref.split(/\s+/, 2);
    return Boolean(path) && pathMatchesRoute(method!, path!.split("?")[0]!, ctx.endpoints) && pathMatchesRoute(method!, path!.split("?")[0]!, new Set(ctx.roe.allowedEndpoints));
  };
  if (!c.steps.length) reasons.push("a campaign must have at least one step");
  if (c.steps.length > ctx.roe.limits.stepsPerChain) reasons.push(`${c.steps.length} steps exceed the ${ctx.roe.limits.stepsPerChain} allowed per chain`);
  if (!endpointKnown(c.target.endpoint)) reasons.push(`the campaign target ${c.target.endpoint} is not an endpoint of this project`);

  for (const s of c.steps) {
    if (!AttackOperation.options.includes(s.operation)) {
      reasons.push(`operation "${s.operation}" is not an allowed catalogue operation`);
      continue;
    }
    if (!known(s.asIdentity)) reasons.push(`a step acts as "${s.asIdentity}", which is not a synthetic identity of this run`);
    // Target must be known for its operation kind.
    if (ENDPOINT_OPS.has(s.operation)) {
      if (!endpointKnown(s.target)) reasons.push(`${s.target} is not an endpoint of this project`);
    } else if (s.operation === "invoke_known_tool") {
      if (!ctx.tools.has(s.target) || !ctx.roe.allowedTools.includes(s.target)) reasons.push(`tool "${s.target}" is not a known tool or is not allowed for this run`);
    } else if (s.operation === "open_known_page") {
      if (!/^\/[^\s]*$/.test(s.target)) reasons.push(`page "${s.target}" must be a relative path on the app, never an external address`);
    } else if (s.operation === "observe_local_canary") {
      if (s.url && externalUrls(s.url).length) reasons.push("a canary observation points outside the sandbox");
    }
    // A file tool argument must stay within the allowed files.
    if (s.filePath && (!ctx.files.has(s.filePath) || !ctx.roe.allowedFiles.includes(s.filePath))) {
      // A traversal to the planted canary just outside the app directory is the intended, allowed probe; anything else is not.
      if (!/(^|\/)\.\.\/[\w.-]*canary/i.test(s.filePath)) reasons.push(`the file path "${s.filePath}" is not an allowed synthetic file`);
    }
    if (s.operation === "repeat_bounded") {
      if (!s.repeat || s.repeat < 1) reasons.push("a bounded repeat must set a positive count");
      else if (s.repeat > ctx.roe.limits.requestsPerTarget) reasons.push(`a repeat of ${s.repeat} exceeds the per-target limit of ${ctx.roe.limits.requestsPerTarget}`);
    }
    if (s.operation === "run_parallel_bounded") {
      if (!s.parallel || s.parallel < 2) reasons.push("a bounded parallel run must set a count of at least 2");
      else if (s.parallel > ctx.roe.limits.concurrency) reasons.push(`a parallel run of ${s.parallel} exceeds the allowed concurrency`);
    }
    const t = text(s);
    const ext = externalUrls({ m: s.message, c: s.content, a: s.toolArgs, u: s.url, b: s.body, q: s.query });
    if (ext.length) reasons.push(`a payload reaches outside the sandbox: ${ext.slice(0, 2).join(", ")}`);
    if (CLOUD_META.test(t)) reasons.push("a payload targets a cloud metadata service");
    if (SHELL.test(t)) reasons.push("a payload contains a shell command");
    if (DESTRUCTIVE.test(t)) reasons.push("a payload contains a destructive database operation");
    if (PERSIST.test(t)) reasons.push("a payload tries to persist on the host");
  }

  const mutating = c.steps.some((s) => ["invoke_known_tool", "upload_synthetic_document", "send_message"].includes(s.operation)) && /mutat|refund|cancel|delete|write|poison/i.test(c.techniqueId + c.title);
  if (mutating && c.resetStrategy === "none") reasons.push("a mutating campaign needs a reset strategy");
  return [...new Set(reasons)];
}

export type CompiledCampaign = PlannedCampaign & { requests: number };
export type Rejection = { id: string; reasons: string[] };

/**
 * Compile a plan: accepted campaigns keep their typed steps and a request count; anything unsafe is rejected with
 * reasons, and campaigns past the run's total request budget are returned as over budget (critical lanes first). Never
 * mutates the input.
 */
export function compilePlan(campaigns: PlannedCampaign[], ctx: CompileContext): { campaigns: CompiledCampaign[]; rejected: Rejection[]; overBudget: Array<{ id: string; reason: string }> } {
  const compiled: CompiledCampaign[] = [];
  const rejected: Rejection[] = [];
  const overBudget: Array<{ id: string; reason: string }> = [];
  const PRIORITY: Record<AdversarialPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const ordered = [...campaigns].sort((a, b) => PRIORITY[a.priority] - PRIORITY[b.priority]);
  let used = 0;
  const maxCampaigns = Math.max(0, ctx.maxCampaigns ?? Number.POSITIVE_INFINITY);
  for (const c of ordered) {
    const reasons = validateCampaign(c, ctx);
    if (reasons.length) {
      rejected.push({ id: c.id, reasons });
      continue;
    }
    const requests = c.steps.reduce((n, s) => n + (s.operation === "repeat_bounded" ? (s.repeat ?? 1) : s.operation === "run_parallel_bounded" ? (s.parallel ?? 1) : 1), 0);
    const toolCalls = c.steps.filter((s) => s.operation === "invoke_known_tool").length;
    if (toolCalls > ctx.roe.limits.toolCalls) {
      overBudget.push({ id: c.id, reason: `the campaign's ${toolCalls} tool call(s) exceed the limit of ${ctx.roe.limits.toolCalls}` });
      continue;
    }
    if (compiled.length >= maxCampaigns) {
      overBudget.push({ id: c.id, reason: `the profile's campaign limit of ${maxCampaigns} is used up` });
      continue;
    }
    if (used + requests > ctx.roe.limits.requests) {
      overBudget.push({ id: c.id, reason: `the run's request budget of ${ctx.roe.limits.requests} is used up` });
      continue;
    }
    used += requests;
    compiled.push({ ...c, requests });
  }
  return { campaigns: compiled, rejected, overBudget };
}
