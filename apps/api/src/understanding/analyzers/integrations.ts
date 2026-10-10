import type { Node } from "web-tree-sitter";
import type { AiComponent, BackgroundJob, EntryPoint, EnumDef, EnvVar, Evidence, Integration, RuntimeFacts, SecurityModel } from "@cybercheck/contracts";
import { line, stringValue, walk } from "../parse.ts";
import { isFrontendPath, type Ctx } from "./context.ts";
import type { StructureResult } from "./structure.ts";

type Cat = Integration["category"];

/** Known packages -> integration name and category (npm and PyPI names). */
const CATALOG: Array<[RegExp, string, Cat]> = [
  [/^(stripe)$/, "Stripe", "payment"],
  [/^(@paypal\/.+|paypalrestsdk|paypal-.+)$/, "PayPal", "payment"],
  [/^(razorpay)$/, "Razorpay", "payment"],
  [/^(@lemonsqueezy\/.+|lemonsqueezy)$/, "Lemon Squeezy", "payment"],
  [/^(nodemailer|smtplib|django\.core\.mail|flask_mail|flask-mail)$/, "SMTP email", "email"],
  [/^(resend)$/, "Resend", "email"],
  [/^(@sendgrid\/.+|sendgrid)$/, "SendGrid", "email"],
  [/^(postmark|mailgun\.js|mailgun|@mailchimp\/.+)$/, "Transactional email", "email"],
  [/^(twilio)$/, "Twilio", "sms"],
  [/^(whatsapp-web\.js|@whiskeysockets\/baileys|whatsapp-api-js)$/, "WhatsApp", "messaging"],
  [/^(@slack\/web-api|@slack\/bolt|slack_sdk|discord\.js|telegraf|node-telegram-bot-api|python-telegram-bot)$/, "Chat platform", "messaging"],
  [/^(@aws-sdk\/client-s3|boto3|aws-sdk|@aws-sdk\/lib-storage)$/, "AWS (S3/SDK)", "storage"],
  [/^(@google-cloud\/storage|google\.cloud\.storage)$/, "Google Cloud Storage", "storage"],
  [/^(@azure\/storage-blob|azure\.storage\.blob)$/, "Azure Blob Storage", "storage"],
  [/^(cloudinary|uploadthing|@vercel\/blob)$/, "File storage service", "storage"],
  [/^(@supabase\/supabase-js|supabase)$/, "Supabase", "database"],
  [/^(firebase|firebase-admin|firebase_admin)$/, "Firebase", "database"],
  [/^(@prisma\/client|prisma)$/, "Prisma ORM", "database"],
  [/^(pg|postgres|psycopg2?|psycopg|asyncpg|@neondatabase\/serverless|@vercel\/postgres)$/, "PostgreSQL", "database"],
  [/^(mysql2?|pymysql|mysqlclient)$/, "MySQL", "database"],
  [/^(mongodb|mongoose|pymongo|motor|beanie)$/, "MongoDB", "database"],
  [/^(better-sqlite3|sqlite3|sqlite)$/, "SQLite", "database"],
  [/^(drizzle-orm|typeorm|sequelize|sqlalchemy|sqlmodel|tortoise|peewee|@mikro-orm\/.+|kysely|knex)$/, "SQL ORM", "database"],
  [/^(redis|ioredis|@upstash\/redis|aioredis)$/, "Redis", "cache"],
  [/^(bullmq|bull|bee-queue|amqplib|kafkajs|@aws-sdk\/client-sqs|celery|rq|dramatiq|pika|kombu|inngest|@trigger\.dev\/.+)$/, "Job queue / messaging", "queue"],
  [/^(openai)$/, "OpenAI", "ai"],
  [/^(@anthropic-ai\/sdk|anthropic)$/, "Anthropic", "ai"],
  [/^(ai|@ai-sdk\/.+)$/, "Vercel AI SDK", "ai"],
  [/^(langchain|@langchain\/.+|langchain_core|langchain_openai|langchain_community|langgraph)$/, "LangChain", "ai"],
  [/^(llamaindex|llama_index)$/, "LlamaIndex", "ai"],
  [/^(@google\/generative-ai|@google\/genai|google\.generativeai|google\.genai)$/, "Google Gemini", "ai"],
  [/^(cohere-ai|cohere)$/, "Cohere", "ai"],
  [/^(@mistralai\/mistralai|mistralai)$/, "Mistral", "ai"],
  [/^(@openrouter\/.+|openrouter)$/, "OpenRouter", "ai"],
  [/^(@pinecone-database\/pinecone|pinecone|chromadb|weaviate-client|qdrant-client|@qdrant\/js-client-rest|pgvector)$/, "Vector database", "ai"],
  [/^(googleapis|google-auth-library|@googleapis\/.+|google-api-python-client|google_auth_oauthlib)$/, "Google APIs (OAuth, Calendar and others)", "calendar"],
  [/^(next-auth|@auth\/core|better-auth|lucia|@clerk\/.+|@supabase\/auth-helpers-.+|passport|passport-.+|@kinde-oss\/.+|auth0|@auth0\/.+|django\.contrib\.auth|flask_login|fastapi_users|authlib|python-jose|jose|jsonwebtoken)$/, "Authentication", "auth"],
  [/^(@sentry\/.+|sentry_sdk|sentry-sdk)$/, "Sentry", "monitoring"],
  [/^(dd-trace|ddtrace|@datadog\/.+|newrelic|@opentelemetry\/.+|opentelemetry|posthog-node|posthog|mixpanel|@vercel\/analytics)$/, "Monitoring / analytics", "monitoring"],
  [/^(algoliasearch|@elastic\/elasticsearch|elasticsearch|meilisearch|typesense)$/, "Search service", "search"],
  [/^(axios|got|ky|node-fetch|undici|requests|httpx|aiohttp|urllib3)$/, "HTTP client", "http"],
];

/** Known API hosts -> integration. Matched anywhere in backend strings, not only in fetch() calls. */
const HOSTS: Array<[RegExp, string, Cat]> = [
  [/^openrouter\.ai$/, "OpenRouter", "ai"],
  [/^api\.openai\.com$/, "OpenAI", "ai"],
  [/^api\.anthropic\.com$/, "Anthropic", "ai"],
  [/^generativelanguage\.googleapis\.com$/, "Google Gemini", "ai"],
  [/^api\.(groq\.com|mistral\.ai|together\.xyz|deepseek\.com|fireworks\.ai|cohere\.ai|perplexity\.ai)$/, "AI provider API", "ai"],
  [/tokenfactory\.nebius\.com$|studio\.nebius\.(ai|com)$/, "Nebius AI", "ai"],
  [/^api\.resend\.com$/, "Resend", "email"],
  [/^api\.sendgrid\.com$/, "SendGrid", "email"],
  [/^api\.postmarkapp\.com$/, "Postmark", "email"],
  [/^api\.mailgun\.net$/, "Mailgun", "email"],
  [/^graph\.facebook\.com$/, "Meta Graph API (WhatsApp Cloud API)", "messaging"],
  [/^api\.telegram\.org$/, "Telegram Bot API", "messaging"],
  [/^(hooks\.slack\.com|slack\.com)$/, "Slack", "messaging"],
  [/^discord(app)?\.com$/, "Discord", "messaging"],
  [/^api\.twilio\.com$/, "Twilio", "sms"],
  [/^(www|oauth2)\.googleapis\.com$|^accounts\.google\.com$/, "Google APIs (OAuth, Calendar and others)", "calendar"],
  [/^api\.stripe\.com$/, "Stripe", "payment"],
  [/^api\.github\.com$/, "GitHub API", "other"],
];
/** Hosts that are documentation, consoles or assets, never runtime API calls. */
const NON_API_HOST = /^(console\.cloud\.google\.com|aistudio\.google\.com|platform\.openai\.com|fonts\.(googleapis|gstatic)\.com|github\.com|docs\.[\w.-]+|developers\.[\w.-]+|www\.w3\.org|schemas?\.[\w.-]+|example\.(com|org)|localhost|127\.0\.0\.1|0\.0\.0\.0|resend\.com|stripe\.com|cdn\.[\w.-]+|unpkg\.com|cdnjs\.cloudflare\.com)$/;

/** Env-name prefixes that tie configuration to a service. */
const ENV_HINTS: Array<[RegExp, string]> = [
  [/^GEMINI_|^GOOGLE_(GENAI|AI)_/, "Google Gemini"],
  [/^OPENROUTER_/, "OpenRouter"],
  [/^OPENAI_/, "OpenAI"],
  [/^ANTHROPIC_/, "Anthropic"],
  [/^RESEND_/, "Resend"],
  [/^META_|^WHATSAPP_|^WA_/, "Meta Graph API (WhatsApp Cloud API)"],
  [/^GOOGLE_(OAUTH|CALENDAR|CLIENT)/, "Google APIs (OAuth, Calendar and others)"],
  [/^STRIPE_/, "Stripe"],
  [/^LITESTREAM_/, "Litestream backup (S3-compatible storage)"],
  [/^SENTRY_/, "Sentry"],
  [/^TWILIO_/, "Twilio"],
  [/^NEBIUS_/, "Nebius AI"],
];

const AI_CALL = /(chat\.completions\.create|responses\.create|messages\.create|completions\.create|embeddings\.create|generateText|streamText|generateObject|streamObject|embed\(|\.invoke\(|\.generate_content|generateContent|generateContentStream|files\.upload|ChatOpenAI|ChatAnthropic|ChatGoogleGenerativeAI)/;
const AI_PATH = /\/(chat\/completions|completions|responses|messages|embeddings|generateContent)\b/;

function catalogMatch(pkg: string): [string, Cat] | null {
  for (const [re, name, cat] of CATALOG) if (re.test(pkg)) return [name, cat];
  return null;
}
function hostMatch(host: string): [string, Cat] | null {
  for (const [re, name, cat] of HOSTS) if (re.test(host)) return [name, cat];
  return null;
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const lineAt = (text: string, i: number) => text.slice(0, i).split("\n").length;

/** Host of the first URL in a string or template literal (template prefix up to the first ${). */
function urlHost(n: Node | null | undefined): string | null {
  if (!n) return null;
  const raw = n.type === "template_string" ? n.text.slice(1).split("${")[0]! : (stringValue(n) ?? (n.type === "string" ? n.text.replace(/^[rbuf]*["']|["']$/g, "") : ""));
  return raw.match(/^https?:\/\/([^/"'`\s:?#]+)/)?.[1] ?? null;
}

export function analyzeIntegrations(ctx: Ctx, structure: StructureResult, envVars: EnvVar[]) {
  type Draft = Omit<Integration, "id" | "envNames" | "scopes">;
  const byName = new Map<string, Draft>();
  const add = (name: string, cat: Cat, by: "package" | "host" | "config", pkg: string | null, ev: Evidence | null, host?: string) => {
    const side: Integration["side"] = by === "config" ? "infrastructure" : ev && isFrontendPath(ctx, ev.path) ? "frontend" : "backend";
    const i: Draft = byName.get(name) ?? { name, category: cat, side, detectedBy: [], packages: [], hosts: [], usedIn: [], status: by === "config" ? "inferred" : "observed" };
    if (!i.detectedBy.includes(by)) i.detectedBy.push(by);
    if (by !== "config") i.status = "observed";
    if (i.side !== side && by !== "config") i.side = i.side === "infrastructure" ? side : "backend";
    if (pkg && !i.packages.includes(pkg)) i.packages.push(pkg);
    if (host && !i.hosts.includes(host)) i.hosts.push(host);
    if (ev && i.usedIn.length < 15 && !i.usedIn.some((e) => e.path === ev.path && e.line === ev.line)) i.usedIn.push(ev);
    byName.set(name, i);
  };

  for (const [pkg, uses] of structure.externalImports) {
    const hit = catalogMatch(pkg) ?? catalogMatch(pkg.split(".")[0]!) ?? catalogMatch(pkg.split("/")[0]!);
    if (!hit) continue;
    for (const u of uses) if (!ctx.isTest(u.path)) add(hit[0], hit[1], "package", pkg, { path: u.path, line: u.line });
  }

  for (const [path, p] of ctx.parsed) {
    if (ctx.isTest(path)) continue;
    for (const n of walk(p.tree.rootNode)) {
      // Known API hosts in any string (constants, fetch(), axios.create({ baseURL }), ...).
      if (n.type === "string" || n.type === "template_string") {
        const host = urlHost(n);
        if (!host || NON_API_HOST.test(host)) continue;
        const known = hostMatch(host);
        if (known) add(known[0], known[1], "host", null, { path, line: line(n) }, host);
        continue;
      }
      // Unknown hosts only count when called directly.
      if (n.type !== "call_expression" && n.type !== "call") continue;
      const fnText = (n.childForFieldName("function")?.text ?? "").slice(0, 60);
      if (!/^(fetch|axios(\.\w+)?|got(\.\w+)?|ky(\.\w+)?|requests\.\w+|httpx\.\w+|client\.(get|post|put|patch|delete)|session\.(get|post))$/.test(fnText)) continue;
      const host = urlHost(n.childForFieldName("arguments")?.namedChildren[0]);
      if (!host || NON_API_HOST.test(host) || hostMatch(host)) continue;
      add(`HTTP API: ${host}`, "http", "host", null, { path, line: line(n) }, host);
    }
  }

  // Services configured only in deployment files.
  for (const [path, f] of ctx.src.files) {
    if (/(^|\/)litestream\.ya?ml$/.test(path)) add("Litestream backup (S3-compatible storage)", "backup", "config", null, { path, line: 1 });
    for (const m of f.text.matchAll(/^\s*image:\s*["']?(minio|localstack|mailhog|mailpit)[/:\w.-]*/gm)) add(m[1] === "minio" ? "MinIO object storage" : m[1] === "localstack" ? "LocalStack (AWS emulator)" : "Local mail catcher", m[1] === "minio" ? "storage" : "other", "config", null, { path, line: lineAt(f.text, m.index!) });
  }

  // AI components: SDK call sites, HTTP calls to AI APIs, calls through project wrappers,
  // tool definitions and system prompts. Model names written as config references are resolved.
  const configs = configObjects(ctx);
  const modelOf = (text: string) => {
    const lit = text.match(/model\s*[:=]\s*["'`]([\w.:/-]+)["'`]/)?.[1];
    if (lit) return lit;
    const ref = text.match(/model\s*[:=]\s*([a-z]\w*(?:\.\w+)+)/i)?.[1];
    const r = ref ? resolveMember(ref, configs) : null;
    return r?.value ? `${r.value}${r.env ? ` (${r.env} default)` : ""}` : ref ? `set by ${ref}` : null;
  };
  // Project functions that wrap an AI call (callJsonModel, askLlm, ...): calls to them are AI calls too.
  const wrappers = new Map<string, string[]>();
  for (const p of ctx.parsed.values()) {
    if (ctx.isTest(p.path)) continue;
    for (const n of walk(p.tree.rootNode)) {
      const name = n.type === "function_declaration" || n.type === "function_definition" ? n.childForFieldName("name")?.text : n.type === "variable_declarator" && /function|arrow_function/.test(n.childForFieldName("value")?.type ?? "") ? n.childForFieldName("name")?.text : undefined;
      if (!name || name.length < 4 || !AI_CALL.test(n.text) && !/openrouter\.ai|api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com/.test(n.text)) continue;
      const providers = [...new Set([...(/generateContent|@google\/genai|gemini/i.test(n.text) ? ["Google Gemini"] : []), ...(/openrouter/i.test(n.text) ? ["OpenRouter"] : []), ...(/openai/i.test(n.text) ? ["OpenAI"] : []), ...(/anthropic|claude/i.test(n.text) ? ["Anthropic"] : [])])];
      wrappers.set(name, providers);
    }
  }
  const aiBySdk = new Map<string, AiComponent>();
  const comp = (sdk: string) => aiBySdk.get(sdk) ?? (aiBySdk.set(sdk, { sdk, calls: [], toolDefinitions: [], systemPrompts: [] }).get(sdk) as AiComponent);
  for (const [path, p] of ctx.parsed) {
    if (ctx.isTest(path)) continue;
    const sdkImports = [...structure.externalImports.entries()].filter(([pkg, uses]) => catalogMatch(pkg)?.[1] === "ai" && uses.some((u) => u.path === path));
    const sdk = sdkImports.length ? catalogMatch(sdkImports[0]![0])![0] : null;
    for (const n of walk(p.tree.rootNode)) {
      const isCall = n.type === "call_expression" || n.type === "call";
      const fn = isCall ? (n.childForFieldName("function")?.text ?? "").slice(0, 80) : "";
      const short = fn.split(".").at(-1) ?? "";
      if (isCall && sdk && AI_CALL.test(fn)) {
        const c = comp(sdk);
        if (c.calls.length < 40) c.calls.push({ evidence: { path, line: line(n) }, model: modelOf(n.text), api: /files\.upload/.test(fn) ? `${fn.slice(0, 50)} (uploads a file to the provider)` : fn.slice(0, 60) });
      } else if (isCall && /^(fetch|axios(\.\w+)?|requests\.post|httpx\.post|client\.post)$/.test(fn)) {
        const arg = n.childForFieldName("arguments")?.namedChildren[0];
        const host = urlHost(arg);
        const known = host ? hostMatch(host) : null;
        if (known?.[1] === "ai" || (host && AI_PATH.test(arg?.text ?? "") && /ai|llm|model|openai|router/i.test(host))) {
          const c = comp(`${known?.[0] ?? host} (HTTP)`);
          if (c.calls.length < 40) c.calls.push({ evidence: { path, line: line(n) }, model: modelOf(n.text), api: `HTTP ${(arg?.text ?? "").match(AI_PATH)?.[0] ?? "request"}` });
        }
      } else if (isCall && wrappers.has(short)) {
        const providers = wrappers.get(short)!;
        const c = comp(`via ${short}()${providers.length ? ` → ${providers.join(", ")}` : ""}`);
        if (c.calls.length < 40) c.calls.push({ evidence: { path, line: line(n) }, model: modelOf(n.text), api: `${short}()` });
      }
      if (!sdk) continue;
      if ((n.type === "pair" || n.type === "keyword_argument") && /^["']?tools["']?$/.test((n.childForFieldName("key") ?? n.childForFieldName("name"))?.text ?? "")) {
        const c = comp(sdk);
        if (c.toolDefinitions.length < 20) c.toolDefinitions.push({ path, line: line(n) });
      }
      if ((n.type === "pair" || n.type === "keyword_argument") && /^["']?(system|system_prompt|systemPrompt|instructions|systemInstruction)["']?$/.test((n.childForFieldName("key") ?? n.childForFieldName("name"))?.text ?? "")) {
        const v = n.childForFieldName("value");
        const preview = (stringValue(v) ?? v?.text ?? "").replace(/\s+/g, " ").slice(0, 160);
        const c = comp(sdk);
        if (preview && c.systemPrompts.length < 10) c.systemPrompts.push({ evidence: { path, line: line(n) }, preview });
      }
      if (n.type === "pair" && /^["']?role["']?$/.test(n.childForFieldName("key")?.text ?? "") && /["']system["']/.test(n.childForFieldName("value")?.text ?? "")) {
        const content = n.parent?.namedChildren.find((c) => c?.type === "pair" && /content/.test(c.childForFieldName("key")?.text ?? ""));
        const preview = (stringValue(content?.childForFieldName("value")) ?? content?.childForFieldName("value")?.text ?? "").replace(/\s+/g, " ").slice(0, 160);
        const c = comp(sdk);
        if (c.systemPrompts.length < 10) c.systemPrompts.push({ evidence: { path, line: line(n) }, preview });
      }
    }
  }

  // OAuth scopes written in code (Google-style scope URLs and space-separated scope strings).
  const scopes = new Map<string, Set<string>>();
  for (const p of ctx.parsed.values()) {
    if (ctx.isTest(p.path)) continue;
    for (const m of p.text.matchAll(/["'`](https:\/\/www\.googleapis\.com\/auth\/[\w./-]+)["'`]/g)) {
      const set = scopes.get("Google APIs (OAuth, Calendar and others)") ?? new Set<string>();
      set.add(m[1]!.replace("https://www.googleapis.com/auth/", ""));
      scopes.set("Google APIs (OAuth, Calendar and others)", set);
    }
  }

  const integrations: Integration[] = [...byName.values()]
    .map((i) => ({ ...i, id: `integration:${slug(i.name)}`, scopes: [...(scopes.get(i.name) ?? [])], envNames: envVars.filter((e) => ENV_HINTS.some(([re, name]) => name === i.name && re.test(e.name))).map((e) => e.name) }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  return { integrations, aiComponents: [...aiBySdk.values()].filter((c) => c.calls.length || c.toolDefinitions.length || c.systemPrompts.length) };
}

// ---------------------------------------------------------------- Security model

const LIB = (deps: Set<string>, names: string[]) => [...new Set(names.filter((n) => deps.has(n)))];
const SESSION_LIBS: Array<[string, string]> = [["@fastify/secure-session", "Encrypted cookie session"], ["@fastify/session", "Server-side session"], ["express-session", "Server-side session"], ["cookie-session", "Cookie session"], ["iron-session", "Encrypted cookie session"], ["flask-login", "Flask-Login session"], ["django", "Django session"]];
const JWT_LIBS = ["jsonwebtoken", "jose", "@fastify/jwt", "@nestjs/jwt", "pyjwt", "python-jose", "djangorestframework-simplejwt", "flask-jwt-extended"];
const THIRD_PARTY_AUTH: Array<[RegExp, string]> = [[/^next-auth$|^@auth\/core$/, "Auth.js (NextAuth)"], [/^better-auth$/, "Better Auth"], [/^lucia$/, "Lucia"], [/^@clerk\//, "Clerk"], [/^@supabase\/(supabase-js|auth-helpers)/, "Supabase Auth"], [/^firebase(-admin)?$/, "Firebase Auth"], [/^auth0$|^@auth0\//, "Auth0"], [/^@kinde-oss\//, "Kinde"], [/^passport$/, "Passport"], [/^django-allauth$/, "django-allauth"], [/^fastapi-users$/, "FastAPI Users"]];
const LLM_ROLE_VALUES = new Set(["user", "assistant", "system", "model", "tool", "function", "developer"]);
const DIRECTION_VALUES = new Set(["in", "out", "inbound", "outbound", "incoming", "outgoing", "sent", "received", "bot", "human", "agent", "customer"]);

function firstUse(ctx: Ctx, re: RegExp): Evidence[] {
  const out: Evidence[] = [];
  for (const [path, p] of ctx.parsed) {
    if (ctx.isTest(path)) continue;
    const m = p.text.match(re);
    if (m?.index !== undefined) out.push({ path, line: lineAt(p.text, m.index) });
    if (out.length >= 3) break;
  }
  return out;
}

export function classifyRole(e: EnumDef): SecurityModel["roles"][number]["kind"] | null {
  const vals = e.values.map((v) => v.toLowerCase());
  if (vals.length && vals.every((v) => LLM_ROLE_VALUES.has(v))) return "llm_role";
  if (/direction|sender|sent_?by|from/i.test(e.name) || (vals.length && vals.every((v) => DIRECTION_VALUES.has(v)))) return "message_direction";
  if (/llm|chat|message|prompt|completion/i.test(e.name)) return "llm_role";
  if (/role|permission|access|scope|privilege|tier|plan/i.test(e.name)) return "app_role";
  if (/status|state|stage|phase/i.test(e.name)) return "status";
  return null;
}

export function analyzeSecurityModel(ctx: Ctx, entryPoints: EntryPoint[], enums: EnumDef[], session: RuntimeFacts["session"] = null): SecurityModel {
  const d = ctx.declared;
  const parsedCount = [...ctx.parsed.keys()].filter((p) => !ctx.isTest(p)).length;
  const scope = (what: string, extra = "") => `No ${what} was found in ${parsedCount} parsed source files or the declared dependencies.${extra} Settings in a reverse proxy, platform or gateway were not checked.`;

  const cors: SecurityModel["cors"] = [];
  for (const [path, p] of ctx.parsed) {
    if (ctx.isTest(path)) continue;
    for (const m of p.text.matchAll(/\b(cors\s*\(|@fastify\/cors|CORSMiddleware|CORS\(|CORS_ALLOW_ALL_ORIGINS|CORS_ORIGIN_ALLOW_ALL|Access-Control-Allow-Origin)/g)) {
      const around = p.text.slice(m.index!, m.index! + 400);
      cors.push({
        evidence: { path, line: lineAt(p.text, m.index!) },
        allowsAnyOrigin: /origin\s*[:=]\s*(["']\*["']|true)|allow_origins\s*=\s*\[\s*["']\*["']|ALLOW_ALL_ORIGINS\s*=\s*True|ORIGIN_ALLOW_ALL\s*=\s*True|Allow-Origin["']?\s*[:,]\s*["']\*/.test(around) || /\bcors\(\s*\)/.test(around),
      });
      if (cors.length > 20) break;
    }
  }

  // How callers prove who they are.
  const authMechanisms: SecurityModel["authMechanisms"] = [];
  for (const [lib, detail] of SESSION_LIBS) {
    if (!d.has(lib) || (lib === "django" && !firstUse(ctx, /SessionMiddleware|request\.session/).length)) continue;
    authMechanisms.push({ kind: "session", detail: `${detail} (${lib})`, library: lib, evidence: firstUse(ctx, new RegExp(`["']${lib.replace(/[/.]/g, "\\$&")}["']|session\\.(set|get)\\(|request\\.session`)) });
  }
  if (!authMechanisms.some((m) => m.kind === "session")) {
    const ev = firstUse(ctx, /\b(req|request|ctx)\.session\.(set|get|user|userId|authenticated)\b|request\.session\[/);
    if (ev.length) authMechanisms.push({ kind: "session", detail: "Custom session handling", library: null, evidence: ev });
  }
  const jwt = LIB(d, JWT_LIBS);
  if (jwt.length) authMechanisms.push({ kind: "jwt", detail: `Signed tokens (${jwt.join(", ")})`, library: jwt[0]!, evidence: firstUse(ctx, /jwt\.(verify|sign|decode)\(|jwtVerify\(|SignJWT|decode_token|jwt_required/) });
  for (const [re, name] of THIRD_PARTY_AUTH) {
    // Declared is not enough: the library must be imported somewhere.
    const lib = [...d].find((x) => re.test(x));
    const used = lib ? firstUse(ctx, new RegExp(`["']${lib.replace(/[/.]/g, "\\$&")}(/[\\w./-]*)?["']`)) : [];
    if (lib && used.length) authMechanisms.push({ kind: "third_party", detail: name, library: lib, evidence: used });
  }
  const callbacks = entryPoints.filter((e) => /(^|\/)(callback|oauth2?callback)(\/|$)/i.test(e.path));
  if (callbacks.length) {
    const signsIn = callbacks.some((cb) => /session\.(set|regenerate)\(\s*["'](authenticated|user|userId|uid)|login\(\s*request|req\.login\(/.test(ctx.src.files.get(cb.handler.path)?.text ?? ""));
    authMechanisms.push({
      kind: "oauth",
      detail: signsIn ? "OAuth sign-in" : `OAuth flow that connects an external account (${callbacks.map((c) => c.path).join(", ")}); it does not sign users in`,
      library: null,
      evidence: callbacks.map((c) => c.handler),
    });
  }
  const tokenRoutes = entryPoints.filter((e) => e.control.kind === "service_token");
  if (tokenRoutes.length) authMechanisms.push({ kind: "api_key", detail: `Shared token in a request header for ${tokenRoutes.map((e) => `${e.method} ${e.path}`).join(", ")}`, library: null, evidence: tokenRoutes.flatMap((e) => e.control.evidence).slice(0, 4) });

  // How credentials are checked.
  const passwordHashing = LIB(d, ["bcrypt", "bcryptjs", "argon2", "@node-rs/argon2", "@node-rs/bcrypt", "scrypt-js", "passlib", "argon2-cffi"]);
  const credentialChecks: SecurityModel["credentialChecks"] = [];
  if (passwordHashing.length) credentialChecks.push({ kind: "password_hash", detail: `Passwords hashed with ${passwordHashing.join(", ")}`, evidence: firstUse(ctx, /bcrypt\.(hash|compare)|argon2\.(hash|verify)|check_password|make_password|pwd_context/) });
  const ct = firstUse(ctx, /timingSafeEqual\(|hmac\.compare_digest\(|secrets\.compare_digest\(|constant_time_compare\(/);
  if (ct.length) credentialChecks.push({ kind: "constant_time_compare", detail: "A password or token is compared in constant time with a configured value", evidence: ct });
  const login = entryPoints.find((e) => /(^|\/)(log-?in|sign-?in)(\/|$)/i.test(e.path) && e.method === "POST");
  const loginText = login ? ctx.src.files.get(login.handler.path)?.text ?? "" : "";
  if (login && !ct.length && !passwordHashing.length && /password[\s\S]{0,80}(===|==|!==|!=)/.test(loginText)) credentialChecks.push({ kind: "plain_compare", detail: "The sign-in handler compares the password with ===", evidence: [login.handler] });
  const hosted = authMechanisms.filter((m) => m.kind === "third_party" && /Clerk|Auth0|Supabase|Firebase|Kinde/.test(m.detail));
  if (hosted.length) credentialChecks.push({ kind: "third_party", detail: `Credentials are checked by ${hosted.map((m) => m.detail).join(", ")}`, evidence: hosted.flatMap((m) => m.evidence).slice(0, 3) });

  // Guards and how many endpoints each protects.
  const guardMap = new Map<string, { endpoints: number; evidence: Evidence[] }>();
  for (const e of entryPoints) {
    if (e.control.kind !== "session_required" && e.control.kind !== "role_required") continue;
    for (const v of e.control.via) {
      const g = guardMap.get(v) ?? { endpoints: 0, evidence: [] };
      g.endpoints++;
      for (const ev of e.control.evidence) if (g.evidence.length < 6 && !g.evidence.some((x) => x.path === ev.path && x.line === ev.line)) g.evidence.push(ev);
      guardMap.set(v, g);
    }
  }
  const guards = [...guardMap.entries()].map(([name, g]) => ({ name, ...g })).sort((a, b) => b.endpoints - a.endpoints);

  const roles = enums.map((e) => ({ e, kind: classifyRole(e) })).filter((x) => x.kind && x.kind !== "status").map(({ e, kind }) => ({ name: e.name, values: e.values, kind: kind!, evidence: e.evidence }));

  // Controls with library names plus recognised custom code.
  const customLimiter = firstUse(ctx, /\b(rateLimit|rate_limit|RateLimiter|limiter\.(consume|check)|tooManyRequests|status\(\s*429|code\(\s*429|HTTP_429)/);
  const rateLimiting = [...LIB(d, ["express-rate-limit", "@fastify/rate-limit", "rate-limiter-flexible", "@upstash/ratelimit", "@nestjs/throttler", "slowapi", "django-ratelimit", "flask-limiter"]), ...(customLimiter.length ? [`custom limiter (${customLimiter[0]!.path}:${customLimiter[0]!.line})`] : [])];
  const customHeaders = firstUse(ctx, /header\(\s*["'](Content-Security-Policy|Strict-Transport-Security|X-Frame-Options|X-Content-Type-Options)["']/i);
  const securityHeaders = [...LIB(d, ["helmet", "@fastify/helmet", "django-csp", "flask-talisman", "secure"]), ...(customHeaders.length ? [`headers set in code (${customHeaders[0]!.path}:${customHeaders[0]!.line})`] : [])];
  const csrf = [...LIB(d, ["csurf", "@fastify/csrf-protection", "csrf-csrf", "lusca", "flask-wtf"]), ...(d.has("django") ? ["django (CsrfViewMiddleware)"] : [])];
  const validationLibraries = LIB(d, ["zod", "joi", "yup", "class-validator", "valibot", "ajv", "@sinclair/typebox", "superstruct", "pydantic", "marshmallow", "cerberus"]);

  const notDetected: SecurityModel["notDetected"] = [];
  const proxy = [...ctx.src.files.keys()].find((p) => /(^|\/)(Caddyfile|nginx\.conf|traefik\.ya?ml)$/.test(p));
  const proxyNote = proxy ? ` A reverse proxy is configured in ${proxy}; its settings are not analysed.` : "";
  if (!rateLimiting.length) notDetected.push({ control: "Rate limiting", scope: scope("rate-limiting library or recognised custom limiter", proxyNote) });
  if (!securityHeaders.length) notDetected.push({ control: "Security headers", scope: scope("security-header library (such as helmet) or headers set in code", proxyNote) });
  const cookieSession = authMechanisms.some((m) => m.kind === "session");
  if (cookieSession && !csrf.length) {
    const sameSite = session?.cookie.sameSite;
    const note = sameSite ? ` The session cookie is set with SameSite=${sameSite}${/lax|strict/i.test(sameSite) ? ", which stops browsers from sending it on cross-site form posts, the usual CSRF path" : ""}.` : " Cookie sessions make this relevant; check the cookie's SameSite setting.";
    notDetected.push({ control: "CSRF token", scope: scope("CSRF token library", note) });
  }
  if (!validationLibraries.length) notDetected.push({ control: "Input validation library", scope: scope("validation library") });
  if (!cors.length) notDetected.push({ control: "CORS configuration", scope: scope("CORS configuration", " Without it, browsers block cross-site calls by default.") });
  const storesPasswords = false; // password columns are checked against hashing in the findings step
  void storesPasswords;
  if (!authMechanisms.length) notDetected.push({ control: "Authentication", scope: scope("authentication library, session use, token check or guard") });

  return { authMechanisms, credentialChecks, guards, roles, passwordHashing, validationLibraries, rateLimiting, securityHeaders, csrf, cors, notDetected };
}

// ---------------------------------------------------------------- Background jobs

/** Object literal assigned to `config` (or settings) anywhere, for resolving config.a.b references. */
export function configObjects(ctx: Ctx): Map<string, Node> {
  const out = new Map<string, Node>();
  for (const [, p] of ctx.parsed) {
    for (const n of walk(p.tree.rootNode)) {
      if (n.type !== "variable_declarator") continue;
      const name = n.childForFieldName("name")?.text ?? "";
      let v = n.childForFieldName("value");
      // { ... } as const / satisfies Config / ({ ... })
      while (v && /^(as_expression|satisfies_expression|parenthesized_expression)$/.test(v.type)) v = v.namedChildren[0] ?? null;
      if (/^(config|settings|env|cfg|appConfig)$/i.test(name) && v?.type === "object") out.set(name, v);
    }
  }
  return out;
}

/** Value of config.a.b: a literal, or the env var and default of required('X')/optional('X', 'd'). */
export function resolveMember(expr: string, configs: Map<string, Node>): { value: string | null; env: string | null } | null {
  const parts = expr.trim().split(".");
  let node: Node | null | undefined = configs.get(parts[0]!);
  for (const key of parts.slice(1)) {
    if (node?.type !== "object") return null;
    node = node.namedChildren.find((c) => c?.type === "pair" && c.childForFieldName("key")?.text.replace(/['"]/g, "") === key)?.childForFieldName("value");
  }
  if (!node) return null;
  const lit = stringValue(node) ?? (node.type === "number" ? node.text : null);
  if (lit != null) return { value: lit, env: null };
  const call = node.text.match(/["']([A-Z][A-Z0-9_]+)["']\s*(?:,\s*["']?([^"')]+)["']?)?/);
  return call ? { value: call[2] ?? null, env: call[1]! } : null;
}

const CRON_FIELDS = ["minute", "hour", "day of month", "month", "day of week"];

function resolveSchedule(raw: string, configs: Map<string, Node>, consts: Map<string, string>) {
  const notes: string[] = [];
  let unresolved = false;
  const fields = raw.trim().split(/\s+/);
  const resolved = raw.replace(/\$\{([^}]+)\}/g, (_m, expr: string) => {
    const field = CRON_FIELDS[fields.findIndex((f) => f.includes(`\${${expr}}`))] ?? "value";
    const c = consts.get(expr.trim());
    if (c != null) return c;
    const r = resolveMember(expr, configs);
    if (r?.value != null) {
      notes.push(`${field} from ${r.env ?? expr.trim()}${r.env ? ` (default ${r.value})` : ""}`);
      return r.value;
    }
    unresolved = true;
    return `{${expr.trim()}}`;
  });
  return { resolved: unresolved ? null : resolved, note: notes.length ? notes.join("; ") : null };
}

const NOT_A_HANDLER = /^(log|info|warn|error|debug|trace|then|catch|finally|import|require|console|setTimeout|setInterval|Promise|resolve|reject|now|toISOString|push|map|filter|forEach)$/;

export function analyzeBackground(ctx: Ctx): BackgroundJob[] {
  const out: Array<Omit<BackgroundJob, "id" | "status">> = [];
  const configs = configObjects(ctx);
  for (const [path, p] of ctx.parsed) {
    if (ctx.isTest(path)) continue;
    const consts = new Map<string, string>();
    for (const n of walk(p.tree.rootNode)) {
      if (n.type !== "variable_declarator") continue;
      const v = stringValue(n.childForFieldName("value"));
      const id = n.childForFieldName("name")?.text;
      if (id && v != null) consts.set(id, v);
    }
    for (const n of walk(p.tree.rootNode)) {
      const isCall = n.type === "call_expression" || n.type === "call";
      const isNew = n.type === "new_expression";
      if (!isCall && !isNew) continue;
      const fn = (isNew ? n.childForFieldName("constructor") : n.childForFieldName("function"))?.text ?? "";
      const args = (n.childForFieldName("arguments")?.namedChildren.filter(Boolean) as Node[]) ?? [];
      const ev = { path, line: line(n) };
      if (/^(cron\.schedule|schedule\.scheduleJob|nodeCron\.schedule)$/.test(fn) || (isNew && fn === "CronJob")) {
        const a0 = args[0];
        const raw = stringValue(a0) ?? (a0?.type === "template_string" ? a0.text.slice(1, -1) : a0?.type === "identifier" ? consts.get(a0.text) ?? a0.text : a0?.text ?? null);
        const sched = raw ? resolveSchedule(raw, configs, consts) : { resolved: null, note: null };
        const cb = args.find((a) => /function|arrow_function/.test(a.type));
        const calls = cb ? [...cb.text.matchAll(/\.?\b([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]!).filter((x) => !NOT_A_HANDLER.test(x)) : [];
        const tzArg = args.find((a) => a.type === "object" && /timezone/.test(a.text));
        const tzExpr = tzArg?.text.match(/timezone\s*:\s*([^,}\s]+)/)?.[1];
        const timezone = tzExpr ? (tzExpr.match(/^["'](.+)["']$/)?.[1] ?? consts.get(tzExpr) ?? tzExpr) : null;
        const label = cb?.text.match(/job\s*:\s*["']([\w-]+)["']/)?.[1] ?? calls[0] ?? fn;
        out.push({ kind: "cron", name: label, schedule: raw, resolvedSchedule: sched.resolved, scheduleNote: sched.note, timezone, handler: calls[0] ?? null, library: fn === "CronJob" ? "cron" : "node-cron", evidence: ev });
      } else if (isNew && /^(Worker|Queue)$/.test(fn) && /bullmq|bull/.test(p.text)) {
        out.push({ kind: fn === "Worker" ? "worker" : "queue", name: stringValue(args[0]) ?? fn, schedule: null, resolvedSchedule: null, scheduleNote: null, timezone: null, handler: null, library: "bullmq", evidence: ev });
      } else if (/(^|\.)(inngest\.createFunction|client\.defineJob)$/.test(fn)) {
        out.push({ kind: "task", name: fn, schedule: null, resolvedSchedule: null, scheduleNote: null, timezone: null, handler: null, library: "inngest/trigger.dev", evidence: ev });
      } else if (/^(setInterval)$/.test(fn) && args.length >= 2) {
        const cb = args[0];
        const calls = cb ? [...cb.text.matchAll(/\.?\b([A-Za-z_]\w*)\s*\(/g)].map((m) => m[1]!).filter((x) => !NOT_A_HANDLER.test(x)) : [];
        out.push({ kind: "task", name: calls[0] ?? "interval task", schedule: `every ${args[1]!.text} ms`, resolvedSchedule: null, scheduleNote: null, timezone: null, handler: calls[0] ?? null, library: "setInterval", evidence: ev });
      }
    }
    if (p.lang === "python") {
      for (const n of walk(p.tree.rootNode)) {
        if (n.type !== "decorated_definition") continue;
        const decos = n.namedChildren.filter((c) => c?.type === "decorator").map((c) => c!.text);
        const name = n.childForFieldName("definition")?.childForFieldName("name")?.text ?? "task";
        const task = decos.find((d) => /@(shared_task|\w+\.task|celery\.task|dramatiq\.actor|app\.periodic_task)/.test(d));
        if (task) out.push({ kind: "task", name, schedule: task.match(/run_every=([\w.()= ]+)/)?.[1] ?? null, resolvedSchedule: null, scheduleNote: null, timezone: null, handler: name, library: /dramatiq/.test(task) ? "dramatiq" : "celery", evidence: { path, line: line(n) } });
        const sched = decos.find((d) => /@(scheduler\.scheduled_job|\w+\.on_event|repeat_every)/.test(d));
        if (sched) out.push({ kind: /on_event/.test(sched) ? "event" : "cron", name, schedule: sched.match(/["']([^"']+)["']/)?.[1] ?? null, resolvedSchedule: null, scheduleNote: null, timezone: null, handler: name, library: "apscheduler/fastapi", evidence: { path, line: line(n) } });
      }
      for (const m of p.text.matchAll(/beat_schedule\s*=|CELERY_BEAT_SCHEDULE/g)) out.push({ kind: "cron", name: "celery beat schedule", schedule: null, resolvedSchedule: null, scheduleNote: null, timezone: null, handler: null, library: "celery", evidence: { path, line: lineAt(p.text, m.index!) } });
    }
    for (const m of p.text.matchAll(/export\s+const\s+config\s*=\s*\{[^}]*schedule\s*:\s*["']([^"']+)["']/g)) out.push({ kind: "cron", name: "scheduled function", schedule: m[1]!, resolvedSchedule: m[1]!, scheduleNote: null, timezone: null, handler: null, library: "platform cron", evidence: { path, line: lineAt(p.text, m.index!) } });
  }
  for (const [path, f] of ctx.src.files) {
    if (/(^|\/)vercel\.json$/.test(path)) for (const m of f.text.matchAll(/"path"\s*:\s*"([^"]+)"\s*,\s*"schedule"\s*:\s*"([^"]+)"/g)) out.push({ kind: "cron", name: m[1]!, schedule: m[2]!, resolvedSchedule: m[2]!, scheduleNote: null, timezone: "UTC", handler: m[1]!, library: "vercel cron", evidence: { path, line: lineAt(f.text, m.index!) } });
  }
  return out.slice(0, 100).map((j) => ({ ...j, resolvedSchedule: j.resolvedSchedule ?? (j.schedule && !j.schedule.includes("${") && j.kind === "cron" ? j.schedule : null), id: `job:${j.evidence.path}:${j.evidence.line}`, status: j.schedule && (j.resolvedSchedule || j.kind !== "cron") ? "observed" : "unresolved" }));
}

// ---------------------------------------------------------------- Quality

export function analyzeQuality(ctx: Ctx) {
  const testFiles = [...ctx.src.allPaths].filter((p) => ctx.isTest(p) && /\.(py|[cm]?[jt]sx?)$/.test(p));
  const d = ctx.declared;
  const testFrameworks = ["vitest", "jest", "mocha", "ava", "@playwright/test", "cypress", "pytest", "unittest", "@testing-library/react", "supertest", "hypothesis"].filter((x) => d.has(x) || (x === "unittest" && testFiles.some((t) => t.endsWith(".py"))));
  const logging = ["pino", "winston", "bunyan", "loglevel", "consola", "structlog", "loguru"].filter((x) => d.has(x));
  const code = [...ctx.parsed.values()].filter((p) => !ctx.isTest(p.path));
  if (d.has("fastify") && code.some((p) => /\blogger\s*:|\b(app|fastify|server|req|request)\.log\.(info|warn|error|debug)\(/.test(p.text))) logging.push("pino (Fastify logger)");
  if (code.some((p) => p.lang === "python" && /\bimport logging\b/.test(p.text))) logging.push("logging (stdlib)");
  if (!logging.length && code.some((p) => /\bconsole\.(log|info|warn|error)\(/.test(p.text))) logging.push("console only");
  const errorTracking = ["@sentry/node", "@sentry/nextjs", "@sentry/react", "sentry-sdk", "rollbar", "bugsnag", "@bugsnag/js", "honeybadger", "dd-trace", "newrelic"].filter((x) => d.has(x));
  let todo = 0;
  const hotspots: Array<{ path: string; loc: number; complexity: number }> = [];
  const BRANCH = new Set(["if_statement", "for_statement", "for_in_statement", "while_statement", "do_statement", "switch_case", "catch_clause", "ternary_expression", "conditional_expression", "elif_clause", "except_clause", "case_clause"]);
  for (const p of code) {
    todo += (p.text.match(/\b(TODO|FIXME|HACK|XXX)\b/g) ?? []).length;
    let complexity = 0;
    for (const n of walk(p.tree.rootNode)) {
      if (BRANCH.has(n.type)) complexity++;
      else if (n.type === "binary_expression" && /^(&&|\|\|)$/.test(n.childForFieldName("operator")?.text ?? "")) complexity++;
      else if (n.type === "boolean_operator") complexity++;
    }
    hotspots.push({ path: p.path, loc: ctx.src.files.get(p.path)?.lines ?? 0, complexity });
  }
  hotspots.sort((a, b) => b.complexity - a.complexity || b.loc - a.loc);
  return { testFiles: testFiles.length, testFrameworks, logging, errorTracking, hotspots: hotspots.slice(0, 15), todoCount: todo };
}

/** Log statements that write request bodies or headers (personal data and secrets can end up in logs). */
export function sensitiveLogging(ctx: Ctx): Evidence[] {
  const out: Evidence[] = [];
  for (const p of ctx.parsed.values()) {
    if (ctx.isTest(p.path)) continue;
    // Request bodies or headers, or fields that hold personal data (phone numbers, emails, message text).
    for (const m of p.text.matchAll(/\b(?:log|logger|console|logging)\??\.(?:info|debug|log|warn|error|trace)\??\.?\(\s*(?:\{[^}]{0,120}\b(?:req|request|ctx\.request)\.(?:body|headers)\b|(?:req|request)\.(?:body|headers)\b|f?["'][^"']*["']\s*,\s*(?:req|request)\.(?:body|headers)\b|JSON\.stringify\(\s*(?:req|request)\.body|\{[^}]{0,160}\b(?:phone|from|email|customerEmail|text|messageText|profileName|transcript|accountEmail)\b\s*[,}:])/g)) {
      out.push({ path: p.path, line: lineAt(p.text, m.index!) });
    }
  }
  return out.slice(0, 10);
}

