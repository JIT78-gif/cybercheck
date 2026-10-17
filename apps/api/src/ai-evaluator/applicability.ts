import { posix } from "node:path";
import type { AiApplicability, AiComponentInventory, AiEvaluationTarget, AiProviderFamily, AiTargetCandidate, Evidence, ProjectDossier } from "@cybercheck/contracts";
import { handlerRanges } from "../security/scan.ts";
import type { SnapshotSource } from "../understanding/source.ts";

// AI Evaluator Step 2 of the plan: is there an AI component, does its evidence belong to this snapshot, which route
// calls it, and how is that route called? Nothing here runs code or calls a model. A target is bound automatically
// only when exactly one route qualifies; an endpoint, a response field, an identity or a tool trace is never guessed.

const CODE_FILE = /\.(c|m)?[jt]sx?$|\.py$/;
const MESSAGE_FIELDS = ["message", "prompt", "question", "query", "input", "userMessage", "user_message", "content", "text", "msg", "messages"];
const CONVERSATION_FIELDS = ["conversationId", "conversation_id", "threadId", "thread_id", "chatId", "chat_id", "sessionId", "session_id"];
const REPLY_FIELDS = ["reply", "answer", "response", "output", "completion", "content", "text", "result", "message"];
const CITATION_FIELDS = ["citations", "sources", "references"];
const CONSEQUENTIAL = /(cancel|delete|remove|refund|transfer|pay|charge|send|email|update|create|write|book|purchase|approve|grant|revoke|reset|post|submit|execute|run)/i;
const READ_ONLY = /^(get|list|read|search|find|lookup|look_up|fetch|check|view|show|describe|count)/i;

const commentFree = (text: string) => text.split("\n").map((l) => (/^\s*(\/\/|#|\*|\/\*)/.test(l) ? "" : l)).join("\n");
const lineAt = (text: string, i: number) => text.slice(0, i).split("\n").length;
const uniq = <T>(xs: T[]) => [...new Set(xs)];

// ---------------------------------------------------------------- imports (text level, enough to link routes)

type ImportBinding = { spec: string; ns: string | null; names: string[] };

export function importBindings(path: string, text: string): ImportBinding[] {
  const out: ImportBinding[] = [];
  const names = (list: string) => list.split(",").map((x) => x.trim().split(/\s+as\s+|\s*:\s*/).pop()!.trim()).filter((x) => /^[A-Za-z_$][\w$]*$/.test(x));
  if (path.endsWith(".py")) {
    for (const m of text.matchAll(/^\s*from\s+([.\w]+)\s+import\s+\(?([^)\n]+)\)?/gm)) out.push({ spec: m[1]!, ns: null, names: names(m[2]!) });
    for (const m of text.matchAll(/^\s*import\s+([.\w]+)(?:\s+as\s+(\w+))?/gm)) out.push({ spec: m[1]!, ns: m[2] ?? m[1]!.split(".").pop()!, names: [] });
    return out;
  }
  for (const m of text.matchAll(/(?:const|let|var)\s+(\{[^}]*\}|[A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:require|import)\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
    out.push(m[1]!.startsWith("{") ? { spec: m[2]!, ns: null, names: names(m[1]!.slice(1, -1)) } : { spec: m[2]!, ns: m[1]!, names: [] });
  }
  for (const m of text.matchAll(/import\s+(?:type\s+)?([^'"`;]+?)\s+from\s+["'`]([^"'`]+)["'`]/g)) {
    const clause = m[1]!.trim();
    const ns = clause.match(/^\*\s+as\s+([\w$]+)/)?.[1] ?? clause.match(/^([A-Za-z_$][\w$]*)\s*(,|$)/)?.[1] ?? null;
    const named = clause.match(/\{([^}]*)\}/)?.[1];
    out.push({ spec: m[2]!, ns, names: named ? names(named) : [] });
  }
  return out;
}

const JS_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
export function resolveImport(src: SnapshotSource, from: string, spec: string): string | null {
  const has = (p: string) => src.files.has(p);
  if (from.endsWith(".py")) {
    const dots = spec.match(/^\.*/)![0].length;
    const rest = spec.slice(dots).replace(/\./g, "/");
    const bases = dots ? [posix.join(posix.dirname(from), ...Array(Math.max(0, dots - 1)).fill(".."), rest)] : [rest, `src/${rest}`];
    for (const b of bases) for (const c of [`${b}.py`, `${b}/__init__.py`]) if (has(posix.normalize(c))) return posix.normalize(c);
    return null;
  }
  if (!spec.startsWith(".")) return null;
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  if (has(base)) return base;
  const noExt = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
  for (const e of JS_EXT) if (has(noExt + e)) return noExt + e;
  for (const e of JS_EXT) if (has(`${base}/index${e}`)) return `${base}/index${e}`;
  return null;
}

// ---------------------------------------------------------------- inventory

function familyOf(name: string, local: boolean): AiProviderFamily {
  if (local) return "none";
  if (/gemini|google/i.test(name)) return "gemini";
  if (/anthropic|claude/i.test(name)) return "anthropic";
  if (/openai|openrouter|nebius|groq|together|deepseek|mistral|ollama|lm studio|fireworks|perplexity|azure/i.test(name)) return "openai_compatible";
  return "other";
}

const ENV_REF = /process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]|import\.meta\.env\.([A-Z][A-Z0-9_]*)|os\.environ(?:\.get)?[[(]\s*["']([A-Z][A-Z0-9_]*)["']|os\.getenv\(\s*["']([A-Z][A-Z0-9_]*)["']/g;
const AI_HOST = /\b(api\.openai\.com|generativelanguage\.googleapis\.com|api\.anthropic\.com|openrouter\.ai|api\.groq\.com|api\.together\.xyz|api\.mistral\.ai|api\.deepseek\.com|api\.studio\.nebius\.(?:ai|com)|[\w-]+\.openai\.azure\.com)\b/g;

function envNames(text: string): string[] {
  return uniq([...commentFree(text).matchAll(ENV_REF)].map((m) => m.slice(1).find(Boolean)!));
}

/** Tool definitions written as data, with their parameter names. */
function toolsIn(path: string, text: string): AiComponentInventory["tools"] {
  const out: AiComponentInventory["tools"] = [];
  for (const m of text.matchAll(/\btype\s*:\s*["']function["']\s*,\s*function\s*:\s*\{\s*name\s*:\s*["']([\w-]+)["']|\bname\s*:\s*["']([\w-]+)["']\s*,\s*description\s*:[^\n]*(?:\n[^\n]*)?\b(?:parameters|input_schema|inputSchema)\s*:/g)) {
    const name = m[1] ?? m[2]!;
    const after = text.slice(m.index!, m.index! + 600);
    const props = after.match(/properties\s*:\s*\{([\s\S]*?)\}\s*,?\s*(required|additionalProperties|\})/)?.[1] ?? "";
    const parameters = uniq([...props.matchAll(/(?:^|[,{])\s*["']?(\w+)["']?\s*:\s*\{/g)].map((x) => x[1]!));
    out.push({ name, evidence: { path, line: lineAt(text, m.index!) }, consequential: CONSEQUENTIAL.test(name) && !READ_ONLY.test(name), parameters });
  }
  return out;
}

const SINKS: Array<[RegExp, AiComponentInventory["messageTriggers"][number]["sink"]]> = [
  [/\b(readFile|readFileSync|createReadStream|open\()|fs\.\w+\(/, "file"],
  [/\b(exec|execSync|spawn|spawnSync|execFile)\s*\(|child_process|subprocess\.|os\.system\(/, "command"],
  [/\bfetch\(|axios\.|requests\.(get|post)\(|httpx\.|http\.get\(/, "network"],
  [/\.(query|prepare|execute|raw)\(/, "database"],
];

/** A regular expression applied to the user's text that gates a sensitive operation a few lines later. */
function messageTriggers(path: string, text: string): AiComponentInventory["messageTriggers"] {
  const out: AiComponentInventory["messageTriggers"] = [];
  const lines = text.split("\n");
  lines.forEach((l, i) => {
    const m = l.match(/\b(?:message|input|prompt|text|query|content|msg|question)\w*\s*\.\s*match\(\s*\/((?:[^/\\\n]|\\.)+)\/([gimsuy]*)\s*\)|re\.(?:search|match)\(\s*r?["']([^"']+)["']\s*,\s*(?:message|input|prompt|text|query)/);
    if (!m) return;
    const window = lines.slice(i, i + 5).join("\n");
    for (const [re, sink] of SINKS) {
      if (re.test(window)) {
        out.push({ pattern: m[1] ?? m[3]!, sink, evidence: { path, line: i + 1 } });
        break;
      }
    }
  });
  return out;
}

// ---------------------------------------------------------------- route handlers

/** Fields the handler reads from the request body. */
export function bodyFields(handler: string): string[] {
  const out: string[] = [];
  for (const m of handler.matchAll(/\b(?:req|request|ctx\.request|c\.req)\.body\??\.(\w+)/g)) out.push(m[1]!);
  for (const m of handler.matchAll(/(?:const|let|var)\s*\{([^}]+)\}\s*=\s*(?:await\s+)?(?:req|request|ctx\.request)\.body\b|(?:const|let|var)\s*\{([^}]+)\}\s*=\s*(?:await\s+)?(?:req|request|c\.req)\.json\(\)/g)) {
    for (const part of (m[1] ?? m[2]!).split(",")) {
      const k = part.trim().split(/\s*[:=]\s*/)[0]!.trim();
      if (/^\w+$/.test(k)) out.push(k);
    }
  }
  for (const m of handler.matchAll(/\b(?:body|payload|data|json)\??\.(\w+)/g)) out.push(m[1]!);
  for (const m of handler.matchAll(/\brequest\.(?:json|get_json\(\))\s*(?:\.get\(\s*|\[\s*)["'](\w+)["']/g)) out.push(m[1]!);
  return uniq(out);
}

/** Keys of object literals written in the text (`{ reply: x }` or shorthand `{ reply }`). */
function objectKeys(text: string): string[] {
  return uniq([...commentFree(text).matchAll(/[{,]\s*["']?([A-Za-z_]\w*)["']?\s*(?=[:,}])/g)].map((m) => m[1]!));
}

export type ApplicabilityInput = { dossier: ProjectDossier; src: SnapshotSource; contentDigest: string; target?: AiEvaluationTarget };

export function assessApplicability({ dossier: d, src, contentDigest, target }: ApplicabilityInput): AiApplicability {
  const base = { components: [] as AiComponentInventory[], candidates: [] as AiTargetCandidate[], targets: [] as AiApplicability["targets"], unbound: [] as AiApplicability["unbound"], unsupported: [] as AiApplicability["unsupported"] };

  // Ownership: the analysis belongs to this exact content, and every cited line exists in this snapshot.
  const cited: Evidence[] = d.aiComponents.flatMap((a) => [...a.calls.map((c) => c.evidence), ...a.toolDefinitions, ...a.systemPrompts.map((p) => p.evidence)]);
  const failed: string[] = [];
  if (d.meta.contentDigest !== contentDigest) failed.push(`the analysis was made for content ${d.meta.contentDigest.slice(0, 12)}, not this snapshot's ${contentDigest.slice(0, 12)}`);
  for (const e of cited) {
    const f = src.files.get(e.path);
    if (!f || e.line > f.text.split("\n").length) failed.push(`${e.path}:${e.line} is not in this snapshot`);
  }
  const ownership = { ok: failed.length === 0, checked: cited.length + 1, failed: failed.slice(0, 20) };
  if (!ownership.ok) return { ...base, status: "ownership_failed", reason: "The AI evidence does not belong to this snapshot, so nothing about it can be trusted.", ownership };
  if (!d.aiComponents.length) return { ...base, status: "not_applicable", reason: "No AI model, agent, prompt or retrieval component was found in the code.", ownership };

  // Components that share a file are one feature (an SDK call and the wrapper around it).
  const groups: Array<{ names: string[]; comps: ProjectDossier["aiComponents"] }> = [];
  for (const a of d.aiComponents) {
    const files = new Set([...a.calls.map((c) => c.evidence.path), ...a.toolDefinitions.map((t) => t.path), ...a.systemPrompts.map((p) => p.evidence.path)]);
    const g = groups.find((x) => x.comps.some((b) => [...b.calls.map((c) => c.evidence.path), ...b.systemPrompts.map((p) => p.evidence.path)].some((p) => files.has(p))));
    if (g) {
      g.names.push(a.sdk);
      g.comps.push(a);
    } else groups.push({ names: [a.sdk], comps: [a] });
  }

  const routes = d.entryPoints.filter((e) => e.kind === "http" || e.kind === "webhook");
  const ranges = handlerRanges(d, src);
  const handlerOf = (e: (typeof routes)[number]) => {
    const h = ranges.all().find((x) => x.handler.path === e.handler.path && x.handler.line === e.handler.line);
    return h ? ranges.body(h) : "";
  };
  const importsByFile = new Map<string, Array<ImportBinding & { file: string | null }>>();
  for (const [path, f] of src.files) if (CODE_FILE.test(path)) importsByFile.set(path, importBindings(path, f.text).map((b) => ({ ...b, file: resolveImport(src, path, b.spec) })));

  groups.forEach((g, gi) => {
    const id = `ai:${gi + 1}`;
    const local = g.names.every((n) => /Local assistant logic/.test(n));
    const name = g.names.find((n) => !/^via /.test(n)) ?? g.names[0]!;
    const evidence = uniq(g.comps.flatMap((a) => [...a.calls.map((c) => c.evidence), ...a.toolDefinitions, ...a.systemPrompts.map((p) => p.evidence)]).map((e) => JSON.stringify(e))).map((s) => JSON.parse(s) as Evidence);
    const files = uniq(evidence.map((e) => e.path));
    // Files that reach the component: its own files plus files importing them (three hops: route -> service -> client).
    const reach = new Set(files);
    for (let hop = 0; hop < 3; hop++) for (const [f, imps] of importsByFile) if (!reach.has(f) && imps.some((b) => b.file && reach.has(b.file))) reach.add(f);
    const texts = files.map((f) => src.files.get(f)?.text ?? "");
    const neighbours = uniq(files.flatMap((f) => (importsByFile.get(f) ?? []).map((b) => b.file).filter((x): x is string => Boolean(x))));
    const env = uniq([...texts, ...neighbours.map((f) => src.files.get(f)?.text ?? "")].flatMap(envNames));
    const family = familyOf(name, local);
    const sdk = !local && !/\(HTTP/.test(name);
    const baseUrlEnv = uniq([...env.filter((n) => /(BASE_?URL|API_?BASE|_URL|ENDPOINT|_HOST)$/.test(n)), ...(sdk && family === "openai_compatible" && /openai/i.test(name) ? ["OPENAI_BASE_URL"] : []), ...(sdk && family === "anthropic" ? ["ANTHROPIC_BASE_URL"] : [])]);
    const apiKeyEnv = uniq([...env.filter((n) => /(API_?KEY|_KEY|_TOKEN)$/.test(n)), ...(sdk && /openai/i.test(name) ? ["OPENAI_API_KEY"] : []), ...(family === "gemini" && sdk ? ["GEMINI_API_KEY", "GOOGLE_API_KEY"] : []), ...(family === "anthropic" && sdk ? ["ANTHROPIC_API_KEY"] : [])]);
    const hardcodedHosts = uniq(texts.flatMap((t) => [...commentFree(t).matchAll(AI_HOST)].map((m) => m[1]!)));
    const model = g.comps.flatMap((a) => a.calls.map((c) => c.model)).find((m): m is string => Boolean(m)) ?? null;
    let interceptable = true;
    let reason: string | null = null;
    if (local) {
      interceptable = false;
      reason = "No model provider: the component builds its prompt and reply in code, so cases run directly against its route and replay or live mode does not apply.";
    } else if (family === "anthropic" || family === "other") {
      interceptable = false;
      reason = `${name} traffic is not supported by the replay server or the gateway yet (OpenAI-compatible and Gemini APIs are); its model calls will be blocked.`;
    } else if (!baseUrlEnv.length) {
      interceptable = false;
      reason = `The provider address is fixed in the code${hardcodedHosts.length ? ` (${hardcodedHosts.join(", ")})` : " or by the SDK"}; cybercheck cannot route its traffic through the replay server or the gateway without changing the code.`;
    }
    const tools = files.flatMap((f) => toolsIn(f, src.files.get(f)?.text ?? ""));
    const triggers = files.flatMap((f) => messageTriggers(f, src.files.get(f)?.text ?? ""));
    const retrieval: Evidence[] = [];
    for (const f of files) {
      const t = src.files.get(f)?.text ?? "";
      for (const m of t.matchAll(/^.*\b(retriev\w*|knowledge\w*|vector\w*|embedding\w*|similarity|rerank\w*|documents?|chunks?|articles?)\b.*$/gim)) if (retrieval.length < 6 && /(const|let|var|def|function)\s+\w*(retriev|knowledge|vector|embed|search|docs?|articles?)/i.test(m[0])) retrieval.push({ path: f, line: lineAt(t, m.index!) });
    }

    // Routes whose handler reaches the component through an import, or that live in a component file and call into it.
    const linked: typeof routes = [];
    for (const e of routes) {
      const body = handlerOf(e);
      if (!body) continue;
      const imps = (importsByFile.get(e.handler.path) ?? []).filter((b) => b.file && reach.has(b.file));
      const viaImport = imps.some((b) => (b.ns && new RegExp(`\\b${b.ns.replace(/\$/g, "\\$")}\\s*[.(]`).test(body)) || b.names.some((n) => new RegExp(`\\b${n.replace(/\$/g, "\\$")}\\s*\\(`).test(body)));
      const inFile = reach.has(e.handler.path) && /chat\.completions|generateContent|messages\.create|\/chat\/completions|SYSTEM_?PROMPT|systemPrompt/i.test(body);
      if (viaImport || inFile) linked.push(e);
    }
    const endpoints = linked.map((e) => `${e.method} ${e.path}`);
    const limitations: string[] = [];
    if (!linked.length) limitations.push("No route was found that reaches this component, so it cannot be called from outside.");
    base.components.push({ id, name, kind: local ? "local_logic" : sdk ? "provider_sdk" : "provider_http", provider: { name: local ? null : name, family, baseUrlEnv, apiKeyEnv, hardcodedHosts, model, interceptable, reason }, files, systemPrompts: g.comps.flatMap((a) => a.systemPrompts.map((p) => p.evidence)), tools, retrieval, messageTriggers: triggers, endpoints, evidence, limitations });

    // Chat-style candidates: a POST that reads a message field.
    const compText = [...reach].map((f) => src.files.get(f)?.text ?? "").join("\n");
    const keys = objectKeys(compText);
    for (const e of linked.filter((x) => x.method === "POST")) {
      const body = handlerOf(e);
      const fields = bodyFields(body);
      const messageField = MESSAGE_FIELDS.find((f) => fields.includes(f)) ?? null;
      const handlerKeys = objectKeys(body);
      const replyFields = REPLY_FIELDS.filter((f) => keys.includes(f) || handlerKeys.includes(f)).filter((f) => f !== messageField);
      base.candidates.push({
        componentId: id,
        method: e.method,
        path: e.path,
        messageField,
        conversationField: CONVERSATION_FIELDS.find((f) => fields.includes(f)) ?? null,
        replyFields,
        citationField: CITATION_FIELDS.find((f) => keys.includes(f) || handlerKeys.includes(f)) ?? null,
        requiresAuth: ["session_required", "role_required", "handler_check", "service_token"].includes(e.control.kind),
        evidence: [e.handler],
        reason: messageField ? `reads the message from the request field "${messageField}"` : "reaches the component but reads no message field",
      });
    }
    const historyPath = linked.find((e) => e.method === "GET" && !e.path.includes(":") && /history|conversation|messages|chats?|threads?/i.test(e.path))?.path ?? null;
    const approvalPaths = linked.filter((e) => e.method === "POST" && /approv|confirm/i.test(e.path)).map((e) => e.path);
    const listPaths = routes.filter((e) => e.method === "GET" && !e.path.includes(":") && /^\/api\//.test(e.path) && ["session_required", "role_required", "handler_check"].includes(e.control.kind) && !linked.includes(e) && !/admin/i.test(e.path)).map((e) => e.path).slice(0, 6);
    const auxiliary = { historyPath, listPaths, approvalPaths };

    if (target && target.componentId === id) {
      const known = routes.some((e) => e.path === target.path && (target.method ?? "POST") === e.method);
      if (!known) base.unbound.push({ componentId: id, reason: `The declared target ${target.method ?? "POST"} ${target.path} is not a route of this snapshot.`, candidates: endpoints });
      else base.targets.push({ target, boundBy: "user", auxiliary: { ...auxiliary, historyPath: target.historyPath ?? historyPath } });
      return;
    }
    const usable = base.candidates.filter((c) => c.componentId === id && c.messageField && c.replyFields.length);
    if (usable.length === 1) {
      const c = usable[0]!;
      base.targets.push({
        target: { componentId: id, transport: "http", method: "POST", path: c.path, requestTemplate: { [c.messageField!]: "{{message}}" }, responseSelector: c.replyFields[0]!, ...(c.requiresAuth ? { authFixture: "user-a" } : {}), ...(c.conversationField && keys.includes(c.conversationField) ? { conversationSelector: c.conversationField } : {}), ...(c.citationField ? { citationSelector: c.citationField } : {}), ...(historyPath ? { historyPath } : {}) },
        boundBy: "single_route",
        auxiliary,
      });
    } else {
      base.unbound.push({ componentId: id, reason: usable.length ? `${usable.length} routes could be the assistant's entry point; choose one so nothing is guessed.` : linked.length ? "No route that reaches it reads a message and returns a reply field cybercheck can recognise; declare the target." : "No route reaches this component.", candidates: (usable.length ? usable : base.candidates.filter((c) => c.componentId === id)).map((c) => `${c.method} ${c.path}`) });
    }
  });
  if (target && !base.components.some((c) => c.id === target.componentId)) base.unbound.push({ componentId: target.componentId, reason: "The declared target names a component that does not exist in this analysis.", candidates: base.components.map((c) => c.id) });

  for (const path of src.files.keys()) if (/\.(go|rb|java|kt|cs|php|rs)$/.test(path) && /openai|anthropic|gemini|llm|prompt/i.test(src.files.get(path)!.text)) base.unsupported.push({ what: path, reason: "AI code in a language AI Evaluator does not support (JavaScript, TypeScript and Python only)." });
  const status = base.targets.length ? "applicable" : "no_target";
  return { ...base, status, reason: status === "applicable" ? `${base.targets.length} AI component${base.targets.length === 1 ? "" : "s"} bound to a callable route.` : `AI was found (${base.components.map((c) => c.name).join(", ")}) but no callable route could be bound.`, ownership };
}
