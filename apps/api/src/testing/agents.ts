import { z } from "zod";
import type { ControlKind, EntryPoint, Evidence, ProjectDossier } from "@cybercheck/contracts";
import type { AiSession } from "../understanding/ai/gateway.ts";
import { numbered } from "../understanding/ai/context.ts";
import type { SnapshotSource } from "../understanding/source.ts";
import { slug, type WorkspacePlan } from "./adapters.ts";
import { transform } from "esbuild";
import { concretePath, type FixtureNode, type Probe, type ProbeStep } from "./plan.ts";

/**
 * The reasoning agents of the Testing check. They never run anything and never decide a verdict
 * alone: the boot planner proposes how to start the app, the authors propose extra probes and
 * tests (hypotheses with cited oracles), triage explains failures, and a critic from a different
 * model family must agree before a product defect is confirmed. Project text is data, never
 * instructions (the gateway says so in every system prompt).
 */

/** A citation, also accepted as "src/a.ts:12" or "src/a.ts:12-20 explanation" (models often write it that way). */
const EvidenceIn = z.preprocess(
  (v) => {
    if (typeof v !== "string") return v;
    const m = v.match(/([\w@./-]+\.\w+):(\d+)/);
    return m ? { path: m[1], line: Number(m[2]) } : v;
  },
  z.object({ path: z.string(), line: z.coerce.number().int().positive() }),
);
const EvidenceList = z.preprocess((v) => (v == null ? [] : Array.isArray(v) ? v : [v]), z.array(z.unknown())).transform((list) =>
  list.flatMap((x) => {
    const r = EvidenceIn.safeParse(x);
    return r.success ? [r.data] : [];
  }),
);

/** Lines around a location, numbered and redacted, inside <project_data>. */
export function excerpt(src: SnapshotSource, path: string, line: number, before = 12, after = 25) {
  const f = src.files.get(path);
  if (!f) return null;
  const start = Math.max(1, line - before);
  return `<project_data file="${path}" lines="${start}-${Math.min(f.lines, line + after)}">\n${numbered(f.text, start, line + after)}\n</project_data>`;
}

/** Keep only citations that point at a real line of a real file. */
export function validEvidence(src: SnapshotSource, ev: Array<{ path: string; line: number }>): Evidence[] {
  return ev.filter((e) => {
    const f = src.files.get(e.path.replace(/^\/?work\/app\//, "").replace(/^\.\//, ""));
    return f && e.line >= 1 && e.line <= f.lines;
  }).map((e) => ({ path: e.path.replace(/^\/?work\/app\//, "").replace(/^\.\//, ""), line: e.line }));
}

// ---------------------------------------------------------------- boot planner

/** Normalises the shapes models use for identities (body vs json, headers inside request, missing names). */
function normaliseIdentity(v: unknown, i: number): unknown {
  if (!v || typeof v !== "object") return v;
  const o = { ...(v as Record<string, unknown>) };
  const req = o.request && typeof o.request === "object" ? { ...(o.request as Record<string, unknown>) } : undefined;
  const headers = (req?.headers ?? o.headers) as Record<string, string> | undefined;
  if (req && req.body !== undefined && req.json === undefined) req.json = req.body;
  const auth = headers ? Object.entries(headers).find(([k]) => k.toLowerCase() === "authorization")?.[1] : undefined;
  let kind = String(o.kind ?? (req?.path ? "login" : auth ? "bearer" : "header")).toLowerCase();
  if (/session|cookie|password|form/.test(kind)) kind = "login";
  if (/token|jwt|api_?key/.test(kind)) kind = auth && /^Bearer /i.test(auth) ? "bearer" : headers ? "header" : "bearer";
  if (kind === "bearer" && !o.token && auth) o.token = auth.replace(/^Bearer\s+/i, "");
  if (kind === "header" && headers && !o.header) {
    const [h, val] = Object.entries(headers)[0] ?? [];
    o.header = h;
    o.value = val;
  }
  const name = typeof o.name === "string" && /^[\w-]{1,40}$/.test(o.name) ? o.name : `${kind}-${i + 1}`;
  return { ...o, name, kind, request: kind === "login" ? req : undefined };
}

export const Identity = z.object({
  name: z.string().regex(/^[\w-]{1,40}$/),
  kind: z.enum(["bearer", "header", "basic", "login"]),
  /** Control kinds this identity satisfies, e.g. ["session_required"]. */
  appliesTo: z.array(z.string()),
  token: z.string().optional(),
  header: z.string().optional(),
  value: z.string().optional(),
  user: z.string().optional(),
  pass: z.string().optional(),
  request: z.object({ method: z.string(), path: z.string(), json: z.unknown().optional(), form: z.record(z.string(), z.string()).optional() }).optional(),
  tokenPath: z.string().optional(),
  /** Setup steps (by id) that must succeed before this sign-in can work, e.g. a licence activation. */
  dependsOn: z.array(z.string()).catch([]).default([]),
  /** A protected request that proves the sign-in works (a 401 or 403 means it does not). */
  verify: z.object({ method: z.string().default("GET"), path: z.string() }).nullable().catch(null).default(null),
  evidence: EvidenceList,
});
export type Identity = z.infer<typeof Identity>;

/** A step that must happen before checks can run: a command after start-up (seed script) or requests that create data. */
const SetupStep = z.object({
  id: z.string().regex(/^[\w-]{1,40}$/),
  label: z.string().default(""),
  kind: z.enum(["command", "request"]),
  command: z.string().optional(),
  exports: z.array(z.string()).catch([]).default([]),
  identity: z.string().nullable().catch(null).default(null),
  steps: z.array(z.lazy(() => AuthoredStep)).max(4).optional(),
  dependsOn: z.array(z.string()).catch([]).default([]),
  evidence: EvidenceList,
});
export type SetupStep = z.infer<typeof SetupStep>;

/** A frontend served for browser tests: built with network (fonts and the like), started for real, wired to the backend. */
export const FrontendApp = z.object({
  workspace: z.string(),
  build: z.array(z.string()).default([]),
  start: z.string(),
  port: z.coerce.number().int().min(1).max(65535),
  readyPath: z.string().default("/"),
  /** Non-secret settings, e.g. NEXT_PUBLIC_API_URL=http://127.0.0.1:8000 pointing at the backend app. */
  config: z.array(z.object({ name: z.string(), value: z.string(), why: z.string().default("") })).default([]),
});
export type FrontendApp = z.infer<typeof FrontendApp>;

export const BootApp = z.object({
  workspace: z.string(),
  /** Commands to run before starting (e.g. build), inside the workspace directory. */
  prepare: z.array(z.string()).default([]),
  start: z.string(),
  port: z.coerce.number().int().min(1).max(65535),
  readyPath: z.string().default("/"),
  /** Non-secret configuration values chosen for the test (secrets are generated by cybercheck). */
  config: z.array(z.object({ name: z.string(), value: z.string(), why: z.string().default("") })).default([]),
  identities: z.preprocess((v) => (Array.isArray(v) ? v.map(normaliseIdentity) : []), z.array(Identity)),
  /** Seed commands and data creation that sign-in or checks depend on, in order. */
  setup: z.preprocess((v) => (Array.isArray(v) ? v : []), z.array(z.unknown())).transform((list) => list.flatMap((x) => { const r = SetupStep.safeParse(x); return r.success ? [r.data] : []; }).slice(0, 10)).default([]),
  /** External services the app cannot start without (postgres, redis ...). */
  needsServices: z.array(z.string()).default([]),
  notes: z.array(z.string()).default([]),
});
export type BootApp = z.infer<typeof BootApp>;
const BootPlanOut = z.object({ apps: z.array(BootApp).transform((a) => a.slice(0, 3)), frontends: z.preprocess((v) => (Array.isArray(v) ? v : []), z.array(z.unknown())).transform((list) => list.flatMap((x) => { const r = FrontendApp.safeParse(x); return r.success ? [r.data] : []; }).slice(0, 2)).default([]) });

const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL|AUTH)/i;

/** Plausible test value for a variable name. Secrets are random so nothing real can leak in. */
export function syntheticValue(name: string, seed: string): string {
  const rand = Buffer.from(`${seed}:${name}`).toString("base64url").replace(/[^a-zA-Z0-9]/g, "").slice(0, 24).padEnd(24, "x");
  // Passwords cybercheck chooses for accounts it creates satisfy common complexity rules (length, cases, digit, symbol).
  if (/^CC_/.test(name)) return /EMAIL/.test(name) ? `cc-${rand.slice(0, 8).toLowerCase()}@example.com` : `Cc-${rand.slice(0, 16)}-7x`;
  // Whole words only: ADMIN must not read as MIN, nor DEMO_ADMIN_EMAIL as a number.
  // One address per setting: an admin and a staff email must not collide on a UNIQUE column.
  if (/EMAIL|_FROM$|RECIPIENT/.test(name)) return `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-?(email|from|recipient)$/, "") || "test"}@example.com`;
  if (SECRET_NAME.test(name) && !/(^|_)(TTL|TIMEOUT|EXPIRY|EXPIRES|LIFETIME|LENGTH|ROUNDS|SECONDS|MINUTES|HOURS|DAYS)(_|$)/.test(name)) return `cc-test-${rand}`;
  if (/^(PORT|.*_PORT)$/.test(name)) return "3000";
  if (/(^|_)HOURS?(_|$)/.test(name)) return "9";
  if (/(^|_)(MINUTES?|SECONDS?|BYTES|LIMIT|SIZE|COUNT|TIMEOUT|MAX|MIN|DAYS|TTL|MS|HOURS|RETRIES|INTERVAL|GAP|ROUNDS|LENGTH)(_|$)/.test(name)) return "10";
  if (/^(ENABLE|DISABLE)_|_(ENABLED|DISABLED)$/.test(name)) return "false";
  if (/DATABASE_URL|DB_URL/.test(name)) return "sqlite:///tmp/cybercheck-test.db";
  if (/(_URL|_URI|ENDPOINT|_HOST|BASE_URL)$/.test(name)) return /REDIRECT|CALLBACK/.test(name) ? "http://127.0.0.1:3000/callback" : "http://127.0.0.1:9";
  if (/(_ID|_NUMBER)$/.test(name)) return "1234567890";
  if (/(PATH|_DIR|_FILE)$/.test(name)) return `/tmp/cybercheck/${name.toLowerCase()}`;
  if (SECRET_NAME.test(name)) return `cc-test-${rand}`;
  return `cc-test-${rand.slice(0, 12)}`;
}

/** Lines in server-side code (not tests, not frontends) matching a pattern, first per file region. */
function searchLines(src: SnapshotSource, re: RegExp, max = 24): Evidence[] {
  const out: Evidence[] = [];
  for (const f of src.files.values()) {
    if (!/\.(ts|mts|js|mjs|cjs|py)$/.test(f.path) || /(\.|\/)(test|spec)\.|(^|\/)(tests?|__tests__|web|client|frontend|public|dist|scripts)\/|test_\w+\.py$/.test(f.path)) continue;
    const lines = f.text.split("\n");
    let last = -100;
    for (let i = 0; i < lines.length && out.length < max; i++) {
      if (re.test(lines[i]!) && i - last > 25) {
        out.push({ path: f.path, line: i + 1 });
        last = i;
      }
    }
  }
  return out;
}

/**
 * A login that types a literal password (copied from a README, say) cannot work: cybercheck injects its
 * own synthetic value for that setting. When exactly one setting of that kind exists, refer to it instead.
 */
function bindLiteralSecrets(identity: Identity, d: ProjectDossier): Identity {
  const json = identity.request?.json;
  if (!json || typeof json !== "object") return identity;
  const fields = { ...(json as Record<string, unknown>) };
  let changed = false;
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v !== "string" || v.includes("${ENV:")) continue;
    const kind = /pass(word)?|pwd/i.test(k) ? "PASS" : /token|secret|api_?key/i.test(k) ? "TOKEN|SECRET|KEY" : null;
    if (!kind) continue;
    const vars = d.config.envVars.filter((e) => e.side === "server" && new RegExp(kind, "i").test(e.name));
    if (vars.length === 1) {
      fields[k] = `\${ENV:${vars[0]!.name}}`;
      changed = true;
    }
  }
  return changed ? { ...identity, request: { ...identity.request!, json: fields } } : identity;
}

/** Variable names an identity relies on that appear nowhere in the code (a guessed name). */
function unknownVars(src: SnapshotSource, identity: unknown): string[] {
  const names = [...JSON.stringify(identity).matchAll(/\$\{ENV:([A-Z0-9_]+)\}/g)].map((m) => m[1]!);
  return names.filter((n) => !n.startsWith("CC_") && ![...src.files.values()].some((f) => f.text.includes(n)));
}

/** Request bodies of mutating endpoints with their field names and types, e.g. "POST /admin/tables {number: str}". */
export function requestModels(d: ProjectDossier, max = 40) {
  const out: string[] = [];
  for (const e of d.entryPoints.filter((x) => x.mutates && x.inputs.body)) {
    const t = d.domainTypes.find((x) => x.name === e.inputs.body);
    if (t) out.push(`${e.method} ${e.path} {${t.fields.map((f) => `${f.name}: ${f.type}`).join(", ")}}`);
    if (out.length >= max) break;
  }
  return out;
}

/** What the boot planner sees: run facts and the code that reads config and checks credentials. */
function bootContext(d: ProjectDossier, src: SnapshotSource, workspaces: WorkspacePlan[]) {
  const env = d.config.envVars.filter((e) => e.side === "server").map((e) => `${e.name} required=${e.required} default=${e.sensitivity === "secret" ? (e.hasDefault ? "(secret default)" : "none") : (e.defaultValue ?? (e.hasDefault ? "yes" : "none"))} ${e.sensitivity} ${e.usedIn[0] ? `${e.usedIn[0].path}:${e.usedIn[0].line}` : ""}`);
  const eps = d.entryPoints.filter((e) => e.kind !== "page").slice(0, 80).map((e) => `${e.method} ${e.path} [${e.control.kind}] ${e.handler.path}:${e.handler.line}${e.inputs.body ? ` body=${e.inputs.body}` : ""}`);
  const cites: Evidence[] = [
    ...d.securityModel.credentialChecks.flatMap((c) => c.evidence.slice(0, 2)),
    ...d.securityModel.authMechanisms.flatMap((a) => a.evidence.slice(0, 1)),
    ...d.securityModel.guards.flatMap((g) => g.evidence.slice(0, 1)),
    ...d.entryPoints.filter((e) => e.control.kind === "public_intentional" && /login|signin|session|auth|token/i.test(e.path) && e.mutates).map((e) => e.handler),
    ...d.runPlan.ports.filter((p) => !/compose|Dockerfile/i.test(p.evidence.path)).map((p) => p.evidence),
    ...d.config.envVars.filter((e) => e.required).flatMap((e) => e.usedIn.slice(0, 1)),
    // Found by direct search, so start-up and sign-in still work when the analysis missed a guard or setting.
    ...searchLines(src, /process\.env|os\.environ|getenv\(|import\.meta\.env|[Aa]uthorization|Bearer |x-api-key|preHandler|onRequest|addHook\(|\.listen\(|uvicorn\.run|app\.run\(/),
  ];
  // Sign-up, activation and login handlers: a sign-in often needs an earlier step (activate a licence, register, verify).
  cites.unshift(...d.entryPoints.filter((e) => e.kind === "http" && /activat|regist|signup|sign-up|login|signin|token|invite|setup|onboard|bootstrap/i.test(e.path)).slice(0, 8).map((e) => e.handler));
  const seen = new Set<string>();
  const excerpts: string[] = [];
  let budget = 48_000;
  // Seed and demo-data scripts show how a usable account and data are created.
  for (const f of src.files.values()) {
    if (!/(^|\/)[\w-]*(seed|demo|fixture|bootstrap|init_?db|create_?(admin|user|superuser))[\w-]*\.(py|ts|js|mjs|sql|sh)$/i.test(f.path) || /node_modules|(\.|\/)(test|spec)\./.test(f.path) || f.lines > 300) continue;
    const x = `<project_data file="${f.path}">\n${numbered(f.text)}\n</project_data>`;
    if (budget - x.length < 20_000) continue;
    excerpts.push(x);
    budget -= x.length;
    seen.add(`${f.path}:0`);
  }
  // The project's own tests show working recipes: how they sign in, which header carries a session, how a second
  // tenant is made. Fixture-style files first, then tests that sign in.
  const testFiles = [...src.files.values()]
    .filter((f) => /(^|\/)(tests?|__tests__|spec)\/|(\.|_)(test|spec)\.[jt]sx?$|(^|\/)test_\w+\.py$|(^|\/)conftest\.py$/.test(f.path) && !/node_modules/.test(f.path))
    .filter((f) => /login|sign_?in|token|session|checkin|check_in|authorization|x-[\w-]+-token|make_\w+|create_\w+/i.test(f.text))
    .sort((a, b) => Number(/conftest|fixture|helpers?/i.test(b.path)) - Number(/conftest|fixture|helpers?/i.test(a.path)))
    .slice(0, 3);
  for (const f of testFiles) {
    const x = `<project_data file="${f.path}" note="the project's own test: a working recipe for sign-in and test data">\n${numbered(f.text.split("\n").slice(0, 120).join("\n"))}\n</project_data>`;
    if (budget - x.length < 12_000) continue;
    excerpts.push(x);
    budget -= x.length;
  }
  for (const c of cites) {
    const key = `${c.path}:${Math.floor(c.line / 30)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const x = excerpt(src, c.path, c.line, 10, 22);
    if (x && budget - x.length > 0) {
      excerpts.push(x);
      budget -= x.length;
    }
  }
  return [
    "Workspaces (commands cybercheck detected):",
    ...workspaces.map((w) => `- ${w.dir} (${w.ecosystem}, ${w.packageManager})${w.ecosystem === "python" ? ` dependencies installed in the virtualenv /work/venv-${slug(w.dir)} (use /work/venv-${slug(w.dir)}/bin/python; there is no .venv in the project)` : ` scripts: ${JSON.stringify(w.scripts)}`}`),
    `Run plan notes: ${JSON.stringify(d.runPlan.notes.map((n) => n.note))}`,
    `Ports seen: ${JSON.stringify(d.runPlan.ports.map((p) => `${p.port} (${p.note}) ${p.evidence.path}:${p.evidence.line}`))}`,
    `Required env: ${JSON.stringify(d.runPlan.requiredEnv)}; at least one of: ${JSON.stringify(d.runPlan.requiredOneOf)}`,
    `Dockerfiles: ${JSON.stringify(d.deployment.dockerfiles.map((f) => ({ path: f.path, cmd: f.cmd, exposes: f.exposes })))}`,
    `Databases/services: ${JSON.stringify(d.integrations.filter((i) => ["database", "cache", "queue"].includes(i.category)).map((i) => i.name))}`,
    `Auth: ${JSON.stringify({ mechanisms: d.securityModel.authMechanisms.map((a) => a.detail), credentialChecks: d.securityModel.credentialChecks.map((c) => c.detail), session: d.runtime.session ? { library: d.runtime.session.library, keys: d.runtime.session.keys } : null })}`,
    "Environment variables (name required default sensitivity first-use):",
    ...env,
    "Request bodies (field: type; send exactly these names and types):",
    ...requestModels(d),
    "Endpoints (method path [control] handler):",
    ...eps,
    `Screens (browser routes): ${JSON.stringify(d.screens.slice(0, 30).map((s) => `${s.url} (${s.file})`))}`,
    `Browser-side settings (baked into a frontend build): ${JSON.stringify(d.config.envVars.filter((e) => e.side !== "server").map((e) => e.name))}`,
    "",
    "Relevant code:",
    ...excerpts,
  ].join("\n");
}

const BOOT_SYSTEM = `You plan how to start a project's server inside a Linux test sandbox (Debian, Node 22, Python 3.11, no internet, nothing else running) so its HTTP endpoints can be probed.
Rules:
- Use the project's own commands. "start" runs inside the workspace directory after "prepare" (for example a build). Prefer the production start script after a build; use a dev script only if there is no other way, and never a watch mode.
- Commands must not need the internet. Dependencies are already installed.
- List only non-secret configuration in "config" (for example NODE_ENV, PORT, DB_PATH pointing into /tmp, feature flags). Every other variable the app reads, including all secrets, gets a synthetic value from cybercheck automatically; refer to them as \${ENV:NAME}.
- The port must be the one the app will listen on given your config. Set PORT in config when the app reads it.
- readyPath: a cheap GET path that answers when the app is up (a health route if one exists, else "/").
- identities: how a test client gets past each kind of protection, using only synthetic values: for a password login, a "login" identity whose request posts \${ENV:THE_PASSWORD_VARIABLE}; for a shared token, a "bearer" or "header" identity with \${ENV:THE_TOKEN_VARIABLE}. "appliesTo" lists the control kinds it satisfies (session_required, role_required, service_token, handler_check). Cite the code that proves each identity works in "evidence". Use only variable names that appear in the code shown (never guess a name), with one exception: for an account that your own setup steps create (register, activate, invite), choose its password yourself as \${ENV:CC_<NAME>}, e.g. \${ENV:CC_ADMIN_PASSWORD}; cybercheck fills CC_ names with synthetic values, and the sign-in must use the same name. Omit identities you cannot ground in code.
- Sign-in often needs earlier steps: an account must exist (a seed script, a register call) or be activated (a licence key, an invite) before login works. Put those steps in "setup", in order, and list their ids in the identity's "dependsOn". A setup step is either {"kind":"command","command":"..."} run in the workspace AFTER the app is up (the app's base URL is in $BASE_URL; a seed script that calls the API works), or {"kind":"request","steps":[...]} requests that create data; capture values later steps need ("capture":{"name":"licenseKey","path":"license_key"}) and use them as {{licenseKey}}. A command can print NAME=value lines: list NAME in "exports" to use it as {{NAME}}.
- Create data through the API with "request" steps (one request per step, using the exact field names and types of the request models shown, and capture paths that exist in the response model). Use "command" steps only to run the project's own scripts (a seed script, migrations); never write a script that calls the API yourself, because cybercheck cannot check or repair it.
- The database starts EMPTY on every run. Never assume an account, licence, tenant or record exists unless a setup step creates it.
- When the app has several roles (admin, staff, customer...), create one identity per role and name it after the role ("admin", "staff"), so cybercheck can check that a lower role is refused on routes for a higher one. Create the lower-role account through the API the app offers for it (an admin creating staff, a register call).
- Give each identity a "verify": a protected GET that should answer 2xx once signed in, e.g. {"method":"GET","path":"/api/me"}.
- Every kind of protection needs an identity, including guest or customer sessions that a public request creates (a check-in, a cart, an anonymous session). For those, add setup request steps that create the session (and anything it needs, such as a table, using the admin identity), capture the session value, and declare an identity of kind "header" (or "bearer") whose value is that capture, e.g. {"name":"customer","kind":"header","header":"X-Session","value":"{{session}}","appliesTo":["session_required"],"dependsOn":["checkin"]}. Use the exact header name the code reads.
- Frontends: use the port the frontend uses by default (usually 3000). If the backend restricts browser origins through a setting (CORS), set that setting in the backend's "config" to include http://localhost:<frontend port>.
- needsServices: databases or brokers that must be running (postgres, mysql, mongodb, redis). SQLite needs nothing.
- At most one app per workspace that serves HTTP. Pure frontends (Next.js, Vite, React) go in "frontends" instead: "build" commands (the internet is available while building), a production "start" (next start, vite preview --host 127.0.0.1 --port N, or a static server), its port, and "config" with the browser-side settings that point it at the backend app, e.g. {"name":"NEXT_PUBLIC_API_URL","value":"http://127.0.0.1:8000"}. Use only setting names that appear in the frontend code, and leave an optional override unset when the code's own default (for example localhost and port 8000) already reaches the backend; read how the code builds URLs from the setting before choosing its value.
Reply with JSON exactly in this shape:
{"apps":[{"workspace":".","prepare":["npm run build"],"start":"npm start","port":3000,"readyPath":"/health",
 "config":[{"name":"NODE_ENV","value":"production","why":"read in src/config.ts:18"}],
 "setup":[
  {"id":"seed","kind":"command","command":"python seed_demo.py","exports":["LICENSE_KEY"],"evidence":[{"path":"seed_demo.py","line":5}]},
  {"id":"activate","kind":"request","dependsOn":["seed"],"steps":[{"method":"POST","path":"/auth/activate","json":{"license_key":"{{LICENSE_KEY}}","email":"admin-{{$uid}}@example.com","password":"\${ENV:ADMIN_PASSWORD}"},"expect":{"statusClass":["2xx"]}}],"evidence":[{"path":"app/auth.py","line":40}]}
 ],
 "identities":[
  {"name":"dashboard","kind":"login","appliesTo":["session_required"],"dependsOn":["activate"],"request":{"method":"POST","path":"/api/auth/login","json":{"password":"\${ENV:DASHBOARD_PASSWORD}"}},"tokenPath":"access_token","verify":{"method":"GET","path":"/api/me"},"evidence":[{"path":"src/routes/auth.ts","line":23}]},
  {"name":"uploader","kind":"bearer","appliesTo":["service_token"],"token":"\${ENV:UPLOAD_TOKEN}","evidence":[{"path":"src/routes/upload.ts","line":52}]},
  {"name":"apikey","kind":"header","appliesTo":["handler_check"],"header":"x-api-key","value":"\${ENV:API_KEY}","evidence":[{"path":"src/auth.ts","line":9}]}
 ],
 "needsServices":[],"notes":["..."]}],
 "frontends":[{"workspace":"web","build":["npm run build"],"start":"npm start -- -p 3100","port":3100,"readyPath":"/","config":[{"name":"NEXT_PUBLIC_API_URL","value":"http://127.0.0.1:3000","why":"read in web/lib/api.ts:3"}]}]}`;

export async function planBoot(session: AiSession | null, d: ProjectDossier, src: SnapshotSource, workspaces: WorkspacePlan[]): Promise<{ apps: BootApp[]; frontends: FrontendApp[]; source: "ai" | "rules"; error: string | null }> {
  const fallback = fallbackBoot(d, workspaces);
  if (!session) return { apps: fallback, frontends: [], source: "rules", error: null };
  try {
    // Reasoning models spend part of the output budget thinking; a second model family answers if the first returns nothing usable.
    const req = { purpose: "boot plan", system: BOOT_SYSTEM, user: bootContext(d, src, workspaces), schema: BootPlanOut, maxTokens: 16000 };
    const out = await session.json("triage", req).catch((err: Error) => {
      if (err.name === "BudgetExceededError") throw err;
      return session.json("author", { ...req, purpose: "boot plan (fallback)" });
    });
    const known = new Set(workspaces.map((w) => w.dir));
    const corpus = [...src.files.values()].map((f) => f.text).join("\n");
    const safeConfig = (list: Array<{ name: string; value: string; why: string }>) => list.filter((c) => !SECRET_NAME.test(c.name) && /^[A-Z_][A-Z0-9_]*$/.test(c.name));
    const apps = out.apps
      .filter((a) => known.has(a.workspace))
      .map((a) => ({
        ...a,
        // Secrets are never chosen by a model.
        config: safeConfig(a.config),
        // An identity built on a variable name that appears nowhere in the code is a guess: drop it.
        identities: a.identities.map((i) => bindLiteralSecrets(i, d)).filter((i) => unknownVars(src, i).length === 0).map((i) => ({ ...i, evidence: validEvidence(src, i.evidence) })),
        setup: a.setup.map((s) => ({ ...s, evidence: validEvidence(src, s.evidence) })),
      }));
    // A frontend setting the code never reads is a guess; the backend apps must be among the planned ones.
    const frontends = out.frontends.filter((f) => known.has(f.workspace) && !apps.some((a) => a.workspace === f.workspace)).map((f) => ({ ...f, config: safeConfig(f.config).filter((c) => corpus.includes(c.name)) }));
    return apps.length ? { apps, frontends, source: "ai", error: null } : { apps: fallback, frontends, source: "rules", error: "the boot planner proposed no usable app" };
  } catch (err) {
    return { apps: fallback, frontends: [], source: "rules", error: (err as Error).message };
  }
}

/**
 * The fixture graph of one app from its boot plan: setup steps, then identities (each verified by a
 * protected request), then records the probe author knows how to create.
 */
export function bootGraph(app: BootApp, verifyFor: (appliesTo: string[]) => { method: string; path: string } | null): FixtureNode[] {
  const nodes: FixtureNode[] = [];
  for (const s of app.setup) {
    nodes.push({
      id: s.id,
      label: s.label || (s.kind === "command" ? `Run ${s.command}` : `Set up ${s.id}`),
      kind: s.kind,
      dependsOn: s.dependsOn,
      command: s.command,
      exports: s.exports,
      identity: s.identity,
      steps: s.steps?.map((st) => ({ method: st.method.toUpperCase(), path: concretePath(st.path.replace(/\{\{(\$?\w+)\}\}/g, "@@$1@@")).replace(/@@(\$?\w+)@@/g, "{{$1}}"), json: st.json, headers: st.headers, expect: { status: st.expect.status, statusClass: st.expect.statusClass ?? (st.expect.status ? undefined : ["2xx"]), json: st.expect.json, not5xx: true }, capture: st.capture })),
      origin: "plan",
    });
  }
  for (const i of app.identities) {
    nodes.push({
      id: i.name,
      label: `Sign in as ${i.name}`,
      kind: "identity",
      dependsOn: i.dependsOn.filter((x) => app.setup.some((s) => s.id === x)),
      auth: { kind: i.kind, token: i.token, header: i.header, value: i.value, user: i.user, pass: i.pass, request: i.request, tokenPath: i.tokenPath },
      verify: i.verify ?? verifyFor(i.appliesTo),
      appliesTo: i.appliesTo,
      origin: "plan",
    });
  }
  return nodes;
}

function fallbackBoot(d: ProjectDossier, workspaces: WorkspacePlan[]): BootApp[] {
  const w = workspaces.find((x) => x.start && d.entryPoints.some((e) => e.kind !== "page" && (x.dir === "." || e.handler.path.startsWith(`${x.dir}/`))));
  if (!w?.start) return [];
  const port = Number(d.runPlan.ports.find((p) => /^\d+$/.test(p.port))?.port ?? 3000);
  return [{ workspace: w.dir, prepare: w.scripts.build ? [w.packageManager === "npm" ? "npm run build" : `${w.packageManager} run build`] : [], start: w.start, port, readyPath: "/", config: [{ name: "PORT", value: String(port), why: "default" }], identities: [], setup: [], needsServices: [], notes: ["Planned by rules (the AI boot planner was not available)."] }];
}

/** Identity name that satisfies an endpoint's control, if any. */
export function identityFor(app: BootApp | undefined, control: ControlKind, path = ""): string | null {
  const ids = app?.identities ?? [];
  // Among identities that fit, prefer the one named after a path segment: /admin/... runs as "admin",
  // /staff/... as "staff", so a role check is not sent with the wrong account.
  const segs = path.toLowerCase().split(/[/?#]/).filter(Boolean);
  const best = (list: typeof ids) => list.find((i) => segs.some((g) => g.length > 2 && i.name.toLowerCase().includes(g.replace(/s$/, "")))) ?? list[0];
  const exact = ids.filter((i) => i.appliesTo.includes(control));
  if (exact.length) return best(exact)!.name;
  if (control === "role_required") return best(ids.filter((i) => i.appliesTo.includes("session_required")))?.name ?? null;
  // Protection unknown or not found by the analysis: sending valid credentials is harmless and
  // lets the request reach the handler if a guard exists after all.
  if (control === "unknown" || control === "none_found" || control === "handler_check") return best(ids)?.name ?? null;
  return null;
}

const RANK: Array<[RegExp, number]> = [[/admin|owner|root|super/, 3], [/manager|lead|editor/, 2], [/staff|employee|agent|operator|cashier|waiter|clerk/, 1], [/user|customer|guest|member|client|visitor|session/, 0]];
const rankOf = (name: string) => RANK.find(([re]) => re.test(name.toLowerCase()))?.[1] ?? null;

/** A signed-in identity with fewer rights than the one a role-protected route runs as (staff for /admin), if the setup has one. */
export function wrongRoleIdentity(app: BootApp | undefined, path: string): string | null {
  const ids = app?.identities ?? [];
  const right = identityFor(app, "role_required", path);
  const top = right ? rankOf(right) : null;
  if (right == null || top == null) return null;
  const lower = ids.filter((i) => i.name !== right && (rankOf(i.name) ?? 99) < top).sort((a, b) => rankOf(b.name)! - rankOf(a.name)!);
  return lower[0]?.name ?? null;
}

// ---------------------------------------------------------------- probe author

const AuthoredStep = z.object({
  method: z.string(),
  path: z.string(),
  json: z.unknown().optional(),
  // Models mix exact codes and classes ("2xx") in one list; split them.
  expect: z.preprocess(
    (v) => {
      if (!v || typeof v !== "object") return v;
      const o = v as { status?: unknown; statusClass?: unknown };
      const list = (x: unknown) => (x == null ? [] : Array.isArray(x) ? x : [x]).map(String);
      const all = [...list(o.status), ...list(o.statusClass)];
      const codes = all.filter((x) => /^\d{3}$/.test(x)).map(Number);
      const classes = all.filter((x) => /^\dxx$/i.test(x)).map((x) => x.toLowerCase());
      const json = Array.isArray((o as { json?: unknown }).json) ? ((o as { json: unknown[] }).json).filter((c) => c && typeof c === "object" && typeof (c as { path?: unknown }).path === "string").slice(0, 6) : undefined;
      return { status: codes.length ? codes : undefined, statusClass: classes.length ? classes : undefined, json: json?.length ? json : undefined };
    },
    z.object({ status: z.array(z.number()).optional(), statusClass: z.array(z.string()).optional(), json: z.array(z.object({ path: z.string(), equals: z.unknown().optional(), exists: z.boolean().optional(), min: z.number().optional() })).optional() }),
  ),
  capture: z.object({ name: z.string(), path: z.string() }).optional(),
  /** Extra request headers, e.g. {"authorization":"Bearer {{token}}"} with a token captured earlier. */
  headers: z.record(z.string(), z.string()).optional(),
  /** Run this step as another identity, e.g. "admin" creating the menu item a customer then orders. */
  as: z.string().optional(),
});
const AuthoredScenario = z.object({
  endpoint: z.string(),
  title: z.string(),
  identity: z.string().nullable(),
  steps: z.array(AuthoredStep).min(1).max(4),
  /** Why the expected status is right, with the code that says so. */
  oracle: z.string(),
  evidence: EvidenceList,
  priority: z.enum(["critical", "high", "medium"]).catch("medium"),
});
/** How to create one real instance of a resource with a path parameter (used as setup by other checks). */
const AuthoredFixture = z.object({
  resource: z.string(),
  identity: z.string().nullable().catch(null),
  steps: z.array(AuthoredStep).min(1).transform((s) => s.slice(0, 3)),
});
export type AuthoredFixture = z.infer<typeof AuthoredFixture>;
const tolerant = <T,>(schema: z.ZodType<T>, max: number) => z.array(z.unknown()).default([]).transform((list) => list.slice(0, max).flatMap((x) => { const r = schema.safeParse(x); return r.success ? [r.data] : []; }));
const AuthoredOut = z.object({ scenarios: tolerant(AuthoredScenario, 24), fixtures: tolerant(AuthoredFixture, 12) });
/** Exposed for tests: the scenarios a probe-author reply turns into (expectations included). */
export const parseAuthored = (raw: unknown) => AuthoredOut.parse(raw).scenarios;
export type AuthoredScenario = z.infer<typeof AuthoredScenario>;

const AUTHOR_SYSTEM = `You write HTTP test scenarios for endpoints of a running app, to find real defects. You see each endpoint's handler code and validation.
For each endpoint write up to 3 scenarios that a careful tester would run:
1. A valid request that should succeed (a realistic body that satisfies the validation you see), with the exact success status if the code sets one, else statusClass ["2xx"].
2. A request that breaks one validation rule or business rule the code states (wrong type, negative or zero amount where the code requires positive, missing required field, invalid state change), expecting the 4xx the code returns (or statusClass ["4xx"]).
3. Only when useful: a multi-step flow (create, then read it back via a captured id) checking the result.
Rules:
- Ground every expectation in the code or the documentation shown: cite the lines (path and line number from the numbered excerpts) that define the validation, rule or status code. If neither states the rule, do not invent it.
- When the documentation (README, docs, comments) states a rule, expect the DOCUMENTED behaviour even where the code seems not to enforce it: that gap is exactly the defect to find. Never write a scenario that expects behaviour the documentation forbids (for example expecting 200 for a quantity of 11 when the README says 1 to 10).
- Use identity names exactly as given for protected endpoints; null for public ones. A step can act as another identity with "as" (for example "as":"admin" to create the menu item a customer then orders); never pass tokens around yourself.
- Every {{value}} you use must be captured by an earlier step of the same scenario or created by the listed setup; anything else is never filled in.
- To reuse a value from an earlier step, capture it ("capture":{"name":"orderId","path":"id"} where path is the JSON path in that response, e.g. "id" or "data.id") and write it as {{orderId}} in later paths or bodies. Use "999999" only for ids that should not exist.
- Never write a literal record id in a path or body (/orders/1, "product_id": 2): ids depend on what other checks created. Create the record in an earlier step, capture its id and use {{thatId}}; for a record that must not exist, use 999999 and say so in the title.
- Check the RESULT, not just the status: after creating or changing data, read it back and assert the fields that matter with "json" checks, e.g. "expect":{"status":[200],"json":[{"path":"items.length","equals":1},{"path":"total","equals":1},{"path":"status","equals":"paid"}]}. Each check has a "path" (dots, .length works) and one of equals, exists (true/false) or min (a number). Only assert values the code or docs determine.
- The app starts with an EMPTY database, except for the data the listed setup creates (use its values as {{name}}). A scenario that reads, updates or deletes any other record must create it first in an earlier step of the same scenario (capturing its id). If neither is possible, skip that scenario.
- Only JSON (or form) bodies can be sent: skip endpoints that need file uploads (multipart), webhooks from third parties, or OAuth redirects.
- Use enum values, field names and formats exactly as the validation code defines them.
- Every check shares one database: make values that must be unique (SKUs, emails, usernames, slugs) unique with {{$uid}}, e.g. "sku":"SKU-{{$uid}}", "email":"user-{{$uid}}@example.com".
- That shared database already holds the setup data and the fixtures you return, and other checks add more: never assume a list, cart or table is empty or that your record is at a given position. Assert on the record you created (read it by its captured id, or check fields of the response to your own request), not on counts, totals or indexes of a whole collection.
- Test each documented rule on every endpoint that can change the value: a limit enforced when creating may be missing when updating (for example a quantity from 1 to 10 when adding AND when changing it). Probe the boundaries just outside the documented range (0 and 11 for 1 to 10).
- Check each numeric rule at both ends: 0, a negative value and the maximum plus one, not only one side; when the value feeds a total or a price, also check the resulting amount.
- Check what happens to a credential after its lifecycle ends: after logout, after a session is paid or closed, after expiry or after the account is deleted, the old token or session must be refused for further actions.
- Credentials are synthetic: to send the app's own password or token in a request (for example to test a login), write \${ENV:THE_VARIABLE} using the names listed under "Settings".
- Never call external services; never use real personal data (use example.com emails, 5550100 phones).
- Do not repeat these checks, which already run: no credentials, malformed JSON, empty {} body, unknown id.
Also return "fixtures": for each resource with a path parameter among these endpoints (like /api/notes/:id or /cart/<cart_id>), the 1 to 3 requests that create one real instance in the empty database, capturing each path parameter's value under that parameter's own name. Other checks use them as setup, so keep them minimal and valid.
Reply with JSON: {"scenarios":[{"endpoint":"POST /transfers","title":"...","identity":"admin","steps":[{"method":"POST","path":"/transfers","json":{...},"expect":{"status":[201]},"capture":{"name":"id","path":"id"}}],"oracle":"why the expected status is right","evidence":[{"path":"src/routes/transfers.ts","line":14}],"priority":"high"}],"fixtures":[{"resource":"/api/notes/:id","identity":"dashboard","steps":[{"method":"POST","path":"/api/notes","json":{"title":"t","body":"b"},"expect":{"statusClass":["2xx"]},"capture":{"name":"id","path":"id"}}]}]}`;

/** Endpoints worth authored scenarios: mutating or protected first, those without existing tests first. */
export function authoringTargets(d: ProjectDossier, testedPaths: Set<string>, max = 24): EntryPoint[] {
  const score = (e: EntryPoint) => (e.mutates ? 4 : 0) + (e.inputs.body ? 2 : 0) + (e.sideEffects.length ? 1 : 0) + (testedPaths.has(e.path) ? -3 : 0) + (e.control.kind === "public_intentional" ? -2 : 0);
  return d.entryPoints
    // Uploads, third-party webhooks and OAuth redirects cannot be exercised with JSON requests.
    .filter((e) => e.kind === "http" && !e.inputs.files && !/health|ready|live|metrics|favicon|robots|privacy|terms|callback|oauth|webhook/i.test(e.path))
    .sort((a, b) => score(b) - score(a))
    .slice(0, max);
}

export async function authorProbes(session: AiSession, d: ProjectDossier, src: SnapshotSource, targets: EntryPoint[], identities: string[], onBatch?: (done: number, total: number) => void, setup: Array<{ id: string; requests: string[]; captures: string[] }> = []): Promise<{ scenarios: AuthoredScenario[]; fixtures: AuthoredFixture[]; dropped: number }> {
  // Batch by handler file so each call sees the shared validation code once.
  const byFile = new Map<string, EntryPoint[]>();
  for (const e of targets) byFile.set(e.handler.path, [...(byFile.get(e.handler.path) ?? []), e]);
  const batches: EntryPoint[][] = [];
  for (const group of byFile.values()) for (let i = 0; i < group.length; i += 6) batches.push(group.slice(i, i + 6));
  const scenarios: AuthoredScenario[] = [];
  const fixtures: AuthoredFixture[] = [];
  let dropped = 0;
  let done = 0;
  // Three batches at a time: each is an independent call of up to a minute or two.
  const queue = batches.slice(0, 6);
  let budgetHit = false;
  const one = async (batch: EntryPoint[]) => {
    const types = new Set(batch.flatMap((e) => [e.inputs.body, e.inputs.query, e.inputs.params, e.requestSchema]).filter((x): x is string => Boolean(x)));
    const typeDefs = d.domainTypes.filter((t) => types.has(t.name)).slice(0, 6).map((t) => excerpt(src, t.evidence.path, t.evidence.line, 2, 30)).filter(Boolean);
    const file = batch[0]!.handler.path;
    const lines = batch.map((e) => e.handler.line);
    const fileText = src.files.get(file);
    const body = fileText && fileText.lines <= 400 ? `<project_data file="${file}">\n${numbered(fileText.text)}\n</project_data>` : batch.map((e) => excerpt(src, file, e.handler.line, 5, 60)).join("\n");
    const user = [
      `Identities available: ${JSON.stringify(identities)}`,
      `Request bodies (field: type; use exactly these names and types): ${requestModels(d, 30).join("; ")}`,
      setup.length ? `Data the setup creates before your scenarios run (use its values as {{name}}; for example order with a menu item the setup created): ${JSON.stringify(setup)}` : "",
      `Settings (synthetic values, referenced as \${ENV:NAME}): ${d.config.envVars.filter((e) => e.side === "server" && e.sensitivity === "secret").map((e) => e.name).join(", ") || "none"}`,
      "Endpoints:",
      ...batch.map((e) => `- ${e.method} ${e.path} [${e.control.kind}] handler ${e.handler.path}:${e.handler.line}${e.inputs.body ? ` body schema ${e.inputs.body}` : ""}${e.sideEffects.length ? ` side effects: ${e.sideEffects.join(", ")}` : ""}`),
      "",
      body,
      intentContext(src, 4_000),
      ...typeDefs,
    ].join("\n");
    void lines;
    try {
      const out = await session.json("author", { purpose: `probe scenarios for ${file}`, system: AUTHOR_SYSTEM, user, schema: AuthoredOut, maxTokens: 8000 });
      for (const s of out.scenarios) {
        const ev = validEvidence(src, s.evidence);
        const ep = batch.find((e) => `${e.method} ${e.path}` === s.endpoint.trim());
        // Every request must hit an endpoint that exists: an invented route only produces noise.
        // ...and must not address records it never created (the database starts empty).
        if (!ep || ev.length === 0 || !s.steps.every((st) => st.path.startsWith("/") && knownEndpoint(d, st.method, st.path)) || assumesExistingData(d, scenarioToProbe(s, 0, ".", "").steps)) {
          dropped++;
          continue;
        }
        const corpus = [...src.files.values()].map((f) => f.text).join("\n");
        for (const st of s.steps) {
          if (!st.expect.json) continue;
          st.expect.json = st.expect.json.filter((c) => {
            const leaf = c.path.split(".").reverse().find((k) => k !== "length" && !/^\d+$/.test(k));
            // The database is shared with the setup data and other checks: "empty" and "the first one" on a list
            // read back are guesses about other checks' data, not about this behaviour.
            const emptyGuess = (/(^|\.)length$/.test(c.path) && c.equals === 0) || (Array.isArray(c.equals) && c.equals.length === 0);
            const positional = st.method === "GET" && /^(\[0\]|0\.|\w+(\[0\]|\.0)(\.|$))/.test(c.path);
            return (!leaf || corpus.includes(leaf)) && !emptyGuess && !positional;
          });
        }
        // "{{uid}}" is a common slip for the built-in "{{$uid}}" when no step captures a value named uid.
        const own = s.steps.some((st) => st.capture?.name === "uid");
        const fixed = own ? s : (JSON.parse(JSON.stringify(s).replace(/\{\{uid\}\}/g, "{{$uid}}")) as typeof s);
        scenarios.push({ ...fixed, evidence: ev, identity: s.identity && identities.includes(s.identity) ? s.identity : null });
      }
      for (const f of out.fixtures) if (f.steps.every((st) => st.path.startsWith("/") && knownEndpoint(d, st.method, st.path)) && !fixtures.some((x) => x.resource === f.resource)) fixtures.push({ ...f, identity: f.identity && identities.includes(f.identity) ? f.identity : null });
    } catch (err) {
      if ((err as Error).name === "BudgetExceededError") budgetHit = true;
      dropped += batch.length;
    }
    onBatch?.(++done, queue.length);
  };
  const work = [...queue];
  await Promise.all(
    Array.from({ length: Math.min(3, work.length) }, async () => {
      for (let b = work.shift(); b && !budgetHit; b = work.shift()) await one(b);
    }),
  );
  return { scenarios, fixtures, dropped };
}

/** Captured values may be written {{id}}, {id}, :id or ${id}; all become {{id}} so the harness fills them in. */
export function withCaptures(text: string, names: string[]) {
  let out = text;
  for (const n of names) out = out.replace(new RegExp(String.raw`\{\{\s*${n}\s*\}\}|\$\{${n}\}|\{${n}\}|<(?:\w+:)?${n}>|:${n}(?=/|$|\?)`, "g"), `{{${n}}}`);
  return out;
}

export function scenarioToProbe(s: AuthoredScenario, idx: number, app: string, obligationId: string): Probe {
  const seen: string[] = [];
  const steps: ProbeStep[] = s.steps.map((st) => {
    const path = withCaptures(st.path, seen);
    const json = st.json === undefined ? undefined : JSON.parse(withCaptures(JSON.stringify(st.json), seen));
    if (st.capture) seen.push(st.capture.name);
    return {
    method: st.method.toUpperCase(),
    // Remaining route placeholders (not captured values) become harmless sample values.
    path: concretePath(path.replace(/\{\{(\w+)\}\}/g, "@@$1@@")).replace(/@@(\w+)@@/g, "{{$1}}"),
    json,
    expect: { status: st.expect.status, statusClass: st.expect.statusClass, json: st.expect.json, not5xx: true },
    capture: st.capture,
    headers: st.headers ? JSON.parse(withCaptures(JSON.stringify(st.headers), seen)) : undefined,
    as: st.as,
    };
  });
  return { id: `p:authored:${idx}`, obligationId, app, identity: s.identity, steps };
}

/** True when a request (method + concrete or template path) matches an endpoint the analysis found. */
export function knownEndpoint(d: ProjectDossier, method: string, path: string) {
  const norm = (p: string) =>
    p
      .split("?")[0]!
      .replace(/\{\{\w+\}\}/g, "*")
      .replace(/:(\w+)\??|\{(\w+)(?::[^}]*)?\}|<(?:\w+:)?(\w+)>|\[(\w+)\]/g, "*")
      .replace(/\/+$/, "") || "/";
  const target = norm(path).split("/");
  return d.entryPoints.some((e) => {
    if (e.kind === "page" || (e.method !== method.toUpperCase() && e.method !== "ALL" && e.method !== "*")) return false;
    const pattern = norm(e.path).split("/");
    return pattern.length === target.length && pattern.every((seg, i) => seg === "*" || target[i] === "*" || seg === target[i] || /^\d+$|^[0-9a-f-]{8,}$/i.test(target[i]!) && seg === "*");
  });
}

/** Every value a generated test imports from its target is really exported by it (type-only imports aside). */
export function importsExist(f: { target: string; code: string }, importPath: string, src: SnapshotSource) {
  const target = src.files.get(f.target);
  if (!target) return false;
  const exported = exportedNames(target.text);
  const escaped = importPath.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  for (const m of f.code.matchAll(new RegExp(`import\\s+(type\\s+)?\\{([^}]+)\\}\\s+from\\s+["']${escaped}["']`, "g"))) {
    if (m[1]) continue;
    for (const part of m[2]!.split(",")) {
      const p = part.trim();
      if (!p || p.startsWith("type ")) continue;
      if (!exported.has(p.split(/\s+as\s+/)[0]!.trim())) return false;
    }
  }
  return true;
}

/**
 * True when a scenario addresses a record it never created: a literal value sits where the route has a
 * path parameter (the database starts empty, so such a request can only test "not found").
 */
export function assumesExistingData(d: ProjectDossier, steps: Array<{ method: string; path: string; expect: { status?: number[] } }>) {
  const PARAM = /^(:\w+\??|\{\w+(?::[^}]*)?\}|<(?:\w+:)?\w+>|\[\w+\])$/;
  return steps.some((st) => {
    if (st.expect.status?.includes(404)) return false; // deliberately testing "not found"
    const segs = st.path.split("?")[0]!.replace(/\/+$/, "").split("/");
    const ep = d.entryPoints.find((e) => {
      const p = e.path.replace(/\/+$/, "").split("/");
      return e.method === st.method.toUpperCase() && p.length === segs.length && p.every((s, i) => PARAM.test(s) || s === segs[i]);
    });
    if (!ep) return false;
    const pattern = ep.path.replace(/\/+$/, "").split("/");
    // Only identifier-like parameters name a stored record; /status/:status with "open" is a value, not a record.
    const isRecordKey = (s: string) => /id$|phone|uuid|slug|key|number|email|sku|code|token|ref/i.test(s.replace(/[:{}<>[\]?]/g, "").split(":").pop()!);
    return pattern.some((s, i) => PARAM.test(s) && isRecordKey(s) && !/^\{\{\w+\}\}$|^(999999|sample)$/.test(segs[i]!));
  });
}

/** Names a TS/JS module exports (functions, consts, classes, enums, export lists). */
export function exportedNames(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|enum|interface|type)\s+(\w+)/g)) out.add(m[1]!);
  for (const m of text.matchAll(/export\s*\{([^}]+)\}/g)) for (const part of m[1]!.split(",")) out.add(part.trim().split(/\s+as\s+/).pop()!.trim());
  return out;
}

/** The requests of an authored record fixture, as probe steps (placeholders and captures normalised). */
export function fixtureSteps(f: AuthoredFixture, idx: number): ProbeStep[] {
  return scenarioToProbe({ endpoint: "", title: "", identity: f.identity, steps: f.steps, oracle: "", evidence: [], priority: "medium" }, idx, ".", "").steps;
}

// ---------------------------------------------------------------- fixture repair (one bounded attempt)

const REPAIR_SYSTEM = `A test run could not set up what its checks need: some setup steps (seed commands, data creation, sign-in) failed inside a clean sandbox (no internet, EMPTY database, synthetic settings). You get the failed steps with the responses and server log lines they produced, and the relevant code.
Return corrected versions of the failed steps, and any missing earlier steps they need (for example an account must be registered or a licence activated before login works). Keep each step's id when you fix it. Use only endpoints, fields and settings that appear in the code. Ground every change in the code: cite it in "evidence".
Step shapes:
- {"id":"seed","kind":"command","command":"python seed.py","exports":["NAME"],"dependsOn":[]}
- {"id":"make-cafe","kind":"request","identity":null,"dependsOn":[],"steps":[{"method":"POST","path":"/cafes","json":{"name":"Cafe {{$uid}}"},"expect":{"statusClass":["2xx"]},"capture":{"name":"cafeId","path":"id"}}]}
- {"id":"admin","kind":"identity","dependsOn":["activate"],"auth":{"kind":"login","request":{"method":"POST","path":"/auth/login","json":{"email":"...","password":"\${ENV:ADMIN_PASSWORD}"}},"tokenPath":"access_token"},"verify":{"method":"GET","path":"/admin/me"}}
If a step cannot work in the sandbox at all, leave it out and say why in "notes".
Reply with JSON: {"nodes":[...],"notes":["..."]}`;

const RepairNode = z.object({
  id: z.string().regex(/^[\w-]{1,40}$/),
  label: z.string().default(""),
  kind: z.enum(["command", "request", "identity"]),
  dependsOn: z.array(z.string()).catch([]).default([]),
  command: z.string().optional(),
  exports: z.array(z.string()).catch([]).default([]),
  identity: z.string().nullable().catch(null).default(null),
  steps: z.array(z.lazy(() => AuthoredStep)).max(4).optional(),
  auth: z
    .object({
      kind: z.enum(["bearer", "header", "basic", "login"]),
      token: z.string().optional(),
      header: z.string().optional(),
      value: z.string().optional(),
      user: z.string().optional(),
      pass: z.string().optional(),
      request: z.object({ method: z.string(), path: z.string(), json: z.unknown().optional(), form: z.record(z.string(), z.string()).optional() }).optional(),
      tokenPath: z.string().optional(),
    })
    .optional(),
  verify: z.object({ method: z.string().default("GET"), path: z.string() }).nullable().catch(null).default(null),
  evidence: EvidenceList,
});
const RepairOut = z.object({ nodes: z.preprocess((v) => (Array.isArray(v) ? v : []), z.array(z.unknown())).transform((l) => l.flatMap((x) => { const r = RepairNode.safeParse(x); return r.success ? [r.data] : []; }).slice(0, 10)), notes: z.array(z.string()).catch([]).default([]) });

export async function repairGraph(session: AiSession, d: ProjectDossier, src: SnapshotSource, graph: FixtureNode[], failures: Array<{ id: string; note: string; output?: string; log: string }>): Promise<{ nodes: FixtureNode[]; notes: string[] }> {
  const handlers = d.entryPoints.filter((e) => e.kind === "http" && (/activat|regist|signup|login|signin|token|invite|setup|admin|seed/i.test(e.path) || graph.some((n) => JSON.stringify(n).includes(e.path.split("/").filter(Boolean)[0] ?? "\u0000"))));
  const seenFiles = new Set<string>();
  const code: string[] = [];
  let budget = 30_000;
  for (const e of handlers.slice(0, 12)) {
    const key = `${e.handler.path}:${Math.floor(e.handler.line / 40)}`;
    if (seenFiles.has(key)) continue;
    seenFiles.add(key);
    const x = excerpt(src, e.handler.path, e.handler.line, 8, 45);
    if (x && budget - x.length > 0) {
      code.push(x);
      budget -= x.length;
    }
  }
  const user = [
    "Setup graph that was tried (in order):",
    JSON.stringify(graph.map((n) => ({ id: n.id, kind: n.kind, dependsOn: n.dependsOn, command: n.command, identity: n.identity, steps: n.steps?.map((s) => ({ method: s.method, path: s.path, json: s.json, capture: s.capture })), auth: n.auth, verify: n.verify })), null, 1).slice(0, 8000),
    "",
    "What failed:",
    ...failures.map((f) => `- ${f.id}: ${f.note}${f.output ? `\n  output: ${f.output.slice(-800)}` : ""}${f.log ? `\n  server log: ${f.log.slice(-1200)}` : ""}`),
    "",
    `Settings (synthetic values, use as \${ENV:NAME}): ${d.config.envVars.filter((e) => e.side === "server").map((e) => e.name).join(", ")}`,
    "Request bodies (field: type):",
    ...requestModels(d),
    "Endpoints (method path [control]):",
    ...d.entryPoints.filter((e) => e.kind !== "page").slice(0, 80).map((e) => `${e.method} ${e.path} [${e.control.kind}]`),
    "",
    "Code:",
    ...code,
  ].join("\n");
  const out = await session.json("author", { purpose: "fixture repair", system: REPAIR_SYSTEM, user, schema: RepairOut, maxTokens: 6000 });
  const nodes: FixtureNode[] = out.nodes.map((n) => ({
    id: n.id,
    label: n.label || `Set up ${n.id} (repaired)`,
    kind: n.kind,
    dependsOn: n.dependsOn,
    command: n.command,
    exports: n.exports,
    identity: n.identity,
    steps: n.steps?.map((st) => ({ method: st.method.toUpperCase(), path: concretePath(st.path.replace(/\{\{(\$?\w+)\}\}/g, "@@$1@@")).replace(/@@(\$?\w+)@@/g, "{{$1}}"), json: st.json, headers: st.headers, expect: { status: st.expect.status, statusClass: st.expect.statusClass ?? (st.expect.status ? undefined : ["2xx"]), json: st.expect.json, not5xx: true }, capture: st.capture })),
    auth: n.auth,
    verify: n.verify,
    appliesTo: graph.find((g) => g.id === n.id)?.appliesTo,
    origin: "repair",
  }));
  return { nodes, notes: out.notes };
}

// ---------------------------------------------------------------- triage and critic

export const TriageOut = z.object({
  kind: z.enum(["product_defect", "test_defect", "environment", "unclear"]),
  title: z.string().max(160),
  expected: z.string(),
  actual: z.string(),
  rootCause: z.string(),
  location: z.preprocess((v) => (v === "" || v === undefined ? null : v), EvidenceIn.nullable()).catch(null),
  severity: z.enum(["critical", "high", "medium", "low"]),
  confidence: z.enum(["high", "medium", "low"]),
});
export type TriageOut = z.infer<typeof TriageOut>;

const TRIAGE_SYSTEM = `You are the failure triage engineer of an automated test run. The run happened in a clean sandbox with NO internet access, synthetic configuration values, and no external services. Decide what caused ONE failure, using only the evidence given.
Classify:
Three traps to avoid: (0) an expectation that depends on data the request sequence did not create itself (a duplicate, a conflict, "already exists", a count, an existing record id) is a test_defect when the sequence shown never created that data first: the database started empty apart from the setup steps listed; (1) an input outside the declared types (a string not in a union type, a missing required argument) is invalid input; a crash on it is a test_defect unless the code or docs promise to validate it. (2) An expectation about a field, value or route that the code never produces or documents is a test_defect, not a missing feature.
- product_defect: the project's own code behaves wrongly for a valid expectation (the test or probe expectation is grounded in the code, docs, or plain HTTP rules such as "a malformed request must not cause a 500").
- test_defect: the test or probe itself is wrong (bad expectation, wrong fixture, a generated test that misread the code).
- environment: caused by the sandbox (no network, DNS errors, missing database or service, synthetic credentials rejected by a real provider, missing system tool).
- unclear: the evidence cannot decide.
For product_defect, "location" MUST be the line in the product code (not a test file) that causes the wrong behaviour; use the product code excerpts to find it. For test_defect point at the test line. Null only if truly unknown. Severity is the business impact if real. Confidence is how strongly the evidence supports your classification. Be strict: offline failures are environment, never product defects. For a server error caused by unvalidated input, point at the handler line that uses the input without checking it, not at a helper it calls.
Reply with JSON: {"kind":"...","title":"short user-facing title","expected":"...","actual":"...","rootCause":"one or two sentences","location":{"path":"src/x.ts","line":12},"severity":"medium","confidence":"high"}`;

export async function triage(session: AiSession, context: string): Promise<TriageOut & { model: string }> {
  const req = { purpose: "failure triage", system: TRIAGE_SYSTEM, user: context, schema: TriageOut, maxTokens: 6000 };
  try {
    return { ...(await session.json("triage", req)), model: "triage" };
  } catch (err) {
    if ((err as Error).name === "BudgetExceededError") throw err;
    // Another model family answers instead (the critic must then differ from it, see critic()).
    return { ...(await session.json("author", { ...req, purpose: "failure triage (fallback)" })), model: "author" };
  }
}

/** Verdict words models use for the same three answers. */
const verdictWord = (v: unknown) => {
  const s = String(v ?? "").toLowerCase();
  return /^(confirm|confirmed|supported|agree|yes|true|valid|defect)/.test(s) ? "confirm" : /^(reject|rejected|refuted|disagree|no|false|invalid|not)/.test(s) ? "reject" : "uncertain";
};
const CriticOut = z.preprocess(
  (v) => (v && typeof v === "object" ? { ...(v as object), verdict: verdictWord((v as Record<string, unknown>).verdict ?? (v as Record<string, unknown>).decision), reason: String((v as Record<string, unknown>).reason ?? (v as Record<string, unknown>).explanation ?? (v as Record<string, unknown>).rationale ?? "") } : v),
  z.object({ verdict: z.enum(["confirm", "reject", "uncertain"]), reason: z.string() }),
);
const CRITIC_SYSTEM = `You independently review a claimed product defect found by an automated test run (clean sandbox, no internet, synthetic config). Another model proposed it; you must not trust its reasoning, only the evidence.
Confirm only if: the expected behaviour is justified by the code shown, documentation, or basic HTTP rules; the observed behaviour is reproduced in the evidence; and the cause is the project's code, not the sandbox, the synthetic configuration, or a wrong test.
Reject if it is an environment effect, a wrong expectation (including one about data the request sequence never created itself, such as a duplicate of a record it did not create first), a root cause contradicted by the code shown (for example a constraint the schema does declare), intended behaviour, a crash on input outside the declared types, or an expectation about a field the code never produces. Say "uncertain" if the evidence is not enough.
Reply with JSON: {"verdict":"confirm|reject|uncertain","reason":"one or two sentences"}`;

/** The reviewer is always a different model from the one that proposed the finding. */
export async function critic(session: AiSession, context: string, proposal: TriageOut & { model?: string }) {
  const { model, ...finding } = proposal;
  const req = { purpose: "defect review", system: CRITIC_SYSTEM, user: `${context}\n\nProposed finding:\n${JSON.stringify(finding)}`, schema: CriticOut, maxTokens: 6000 };
  const backup = model === "author" ? "triage" : "author";
  try {
    return await session.json("critic", req);
  } catch (err) {
    if ((err as Error).name === "BudgetExceededError") throw err;
    return session.json(backup, { ...req, purpose: "defect review (fallback)" });
  }
}

const ContradictionOut = z.object({ contradicting: z.array(z.object({ id: z.string(), reason: z.string() })).default([]) });
const CONTRADICTION_SYSTEM = `A test run confirmed a defect. Some AI-written checks near the same code PASSED. Decide which of those passes contradict the confirmed defect:
- the check asserts the defective behaviour as correct (for example it expects the wrong rounding the defect describes), or
- its name claims to verify the very property the defect shows is broken, but it only exercised a case where the defect cannot show.
A pass that tests a different, unrelated behaviour does not contradict it. Judge only from what is given.
Reply with JSON: {"contradicting":[{"id":"<check id>","reason":"one sentence"}]}`;

/** Passing AI-written checks that contradict a confirmed defect (asserted the bug, or claim what they did not test). */
export async function findContradictions(session: AiSession, finding: { title: string; expected: string; actual: string; rootCause: string | null; location: string }, checks: Array<{ id: string; objective: string; expected: string; detail: string }>) {
  if (!checks.length) return [];
  const user = [`Confirmed defect: ${finding.title}`, `Expected: ${finding.expected}`, `Actual: ${finding.actual}`, `Cause: ${finding.rootCause ?? "unknown"} (at ${finding.location})`, "", "Passing checks:", ...checks.map((c) => `- id ${c.id}: "${c.objective}"; expected: ${c.expected}${c.detail ? `\n${c.detail}` : ""}`)].join("\n");
  try {
    const out = await session.json("triage", { purpose: "contradiction review", system: CONTRADICTION_SYSTEM, user, schema: ContradictionOut, maxTokens: 3000 });
    return out.contradicting.filter((c) => checks.some((k) => k.id === c.id));
  } catch {
    return [];
  }
}

/** Failure text that clearly comes from the sandbox having no network or services. */
export const OFFLINE = /ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|fetch failed|socket hang up|network (is )?unreachable|Temporary failure in name resolution|Could not resolve host|ConnectError|NameResolutionError|Max retries exceeded|fonts\.(googleapis|gstatic)\.com|Failed to fetch( font)?|Failed to download|unable to (get|fetch) .* from (the )?(registry|internet)/i;

/** A build or tool that tried to download something (fonts, binaries, schemas) and could not: worth one run with network to confirm. */
export const NEEDS_NETWORK = /fonts\.(googleapis|gstatic)\.com|Failed to fetch( font)?|next\/font|Failed to download|ENOTFOUND|EAI_AGAIN|getaddrinfo|Could not resolve host|fetch failed|ECONNREFUSED .*:(443|80)\b/i;

/** The command stopped to ask a question: a setup wizard, not a result. */
export const INTERACTIVE = /How would you like to configure ESLint|\? (Would you like|Do you want|Which|Select|Choose|Are you sure|Ok to proceed)|Need to install the following packages|Ok to proceed\? \(y\)|\(y\/N\)|\[y\/n\]|Press (Enter|any key)/i;

// ---------------------------------------------------------------- unit test author

const GeneratedCase = z.object({
  name: z.string().min(3).max(200),
  /** The rule being checked, in plain words. */
  rule: z.string(),
  evidence: EvidenceList,
  priority: z.enum(["critical", "high", "medium"]).catch("medium"),
});
const GeneratedFile = z.object({ target: z.string(), code: z.string().min(20), cases: z.array(GeneratedCase).min(1).transform((c) => c.slice(0, 16)) });
const GeneratedOut = z.object({ files: z.array(GeneratedFile).transform((f) => f.slice(0, 3)) });
export type GeneratedFile = z.infer<typeof GeneratedFile>;

const UNIT_SYSTEM = `You write focused unit tests for business logic, to find real defects. You get source files of a project.
Write tests with Node's built-in runner, as ES modules in TypeScript or JavaScript:
  import { test } from "node:test"; import assert from "node:assert/strict";
  import { fn } from "<the import path given for the file>";
Rules:
- Test only pure logic: state transitions, calculations, validation, invariants. Never touch the network, a database, the file system, timers or environment variables; skip functions that need them.
- The expected value of every assertion must come from INTENT, never from the implementation: the README or docs, a comment that states what the code should do, the project's existing tests, names (a function called roundToCent must round), or universal invariants (terminal states have no outgoing transitions, an amount cannot go negative where it is forbidden, created ids can be read back). Do not work out the expected value by tracing the implementation: a test that agrees with a wrong implementation is worse than no test.
- Put the citation of that intent in "evidence" (path and line numbers from the numbered excerpts: the README line, the comment, the existing test). If the only source for a rule is the implementation itself, do not write that test.
- Prefer edge cases the authors probably did not test: invalid transitions, boundaries, rounding, zero and negative amounts, empty inputs.
- Do not invent business rules.
- Use exact test names (the "name" in cases must equal the string passed to test()). At most 12 tests per file.
- Use the function and type names exactly as exported. Import only from the given path.
Reply with JSON: {"files":[{"target":"src/orders/lifecycle.ts","code":"import { test } from \\"node:test\\"; ...","cases":[{"name":"rejects shipping a cancelled order","rule":"cancelled is terminal (comment at line 12)","evidence":[{"path":"src/orders/lifecycle.ts","line":12}],"priority":"high"}]}]}`;

const LOGIC_NAME = /(service|domain|logic|lifecycle|state|machine|workflow|calc|pricing|price|money|fee|tax|rules?|policy|billing|invoice|inventory|stock|reserv|ledger|discount|quote|cart|order)/i;

/** Files worth generated unit tests: state machines first, then core logic modules (not routes, not tests). */
export function unitTargets(d: ProjectDossier, src: SnapshotSource, max = 3): string[] {
  const out: string[] = [];
  const add = (p: string) => {
    if (!out.includes(p) && src.files.has(p) && out.length < max) out.push(p);
  };
  for (const sm of d.ai?.stateMachines ?? []) if (sm.verification !== "unverified") for (const e of sm.evidence) if (/\.(ts|js|mjs|py)$/.test(e.path) && !/\.(test|spec)\./.test(e.path)) add(e.path);
  const routes = new Set(d.entryPoints.map((e) => e.handler.path));
  const rank = new Map(d.keyFiles.map((k, i) => [k.path, i]));
  const candidates = [...src.files.values()]
    .filter((f) => /\.(ts|mts|js|mjs)$/.test(f.path) && !/\.(test|spec|d)\.|(^|\/)(tests?|__tests__|scripts|migrations?|web|client|frontend|public)\//.test(f.path) && !routes.has(f.path))
    .filter((f) => /export (async )?function|export const \w+ = (\(|async)/.test(f.text) && f.lines <= 500 && !/fetch\(|axios|prisma|sqlite|from "pg"|express\(|fastify\(/.test(f.text))
    .sort((a, b) => Number(LOGIC_NAME.test(b.path)) - Number(LOGIC_NAME.test(a.path)) || (rank.get(a.path) ?? 999) - (rank.get(b.path) ?? 999));
  for (const f of candidates) if (LOGIC_NAME.test(f.path)) add(f.path);
  return out;
}

/**
 * What the project says it should do, independent of its implementation: README and docs (numbered,
 * so they can be cited) and the names of its existing tests. Expectations are taken from here.
 */
export function intentContext(src: SnapshotSource, budget = 9_000): string {
  const parts: string[] = [];
  const docs = [...src.files.values()].filter((f) => /(^|\/)(readme|docs?\/[\w./-]+|spec|requirements|design)[\w.-]*\.md$/i.test(f.path) && !/node_modules|changelog|license/i.test(f.path)).sort((a, b) => a.path.split("/").length - b.path.split("/").length);
  for (const f of docs.slice(0, 4)) {
    const lines = Math.min(f.lines, 120);
    const text = `<project_data file="${f.path}" lines="1-${lines}">\n${numbered(f.text, 1, lines)}\n</project_data>`;
    if (text.length > budget) continue;
    parts.push(text);
    budget -= text.length;
  }
  const titles: string[] = [];
  for (const f of src.files.values()) {
    if (!/(\.|\/)(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_\w+\.py$/.test(f.path)) continue;
    f.text.split("\n").forEach((l, i) => {
      const m = l.match(/\b(?:it|test|describe)\s*\(\s*["'`](.+?)["'`]|def (test_\w+)/);
      if (m) titles.push(`${f.path}:${i + 1} ${m[1] ?? m[2]}`);
    });
  }
  if (titles.length) parts.push(`Existing test names (path:line title):\n${titles.slice(0, 80).join("\n").slice(0, Math.max(0, budget))}`);
  return parts.length ? `What the project says it should do:\n${parts.join("\n\n")}` : "";
}

/** Syntax errors in generated test code, found locally before any sandbox time is spent (null when it compiles). */
export async function syntaxError(code: string, typescript: boolean): Promise<string | null> {
  try {
    await transform(code, { loader: typescript ? "ts" : "js", format: "esm", target: "node22", logLevel: "silent" });
    return null;
  } catch (err) {
    const errors = (err as { errors?: Array<{ text: string; location?: { line: number; column: number; lineText: string } | null }> }).errors ?? [];
    return errors.length ? errors.slice(0, 3).map((e) => `${e.location ? `line ${e.location.line}:${e.location.column}: ` : ""}${e.text}${e.location ? ` (${e.location.lineText.trim().slice(0, 120)})` : ""}`).join("\n") : String((err as Error).message).slice(0, 400);
  }
}

const UnitRepairOut = z.object({ code: z.string().min(20) });

/** One bounded repair of a generated test file that does not compile; the test names must stay the same. */
async function repairUnitFile(session: AiSession, f: GeneratedFile, error: string) {
  const out = await session.json("author", {
    purpose: "unit test repair",
    system: `You fix a generated unit test file that does not compile. Change only what the compiler error needs (for example make a test callback async when it uses await, close a bracket, fix an import). Keep every test() name exactly as it is and keep every assertion's meaning. Reply with JSON: {"code":"the whole corrected file"}`,
    user: `Compiler error:\n${error}\n\nFile:\n${f.code}`,
    schema: UnitRepairOut,
    maxTokens: 8000,
  });
  return out.code;
}

export async function authorUnitTests(session: AiSession, d: ProjectDossier, src: SnapshotSource, targets: Array<{ path: string; importPath: string }>): Promise<{ files: GeneratedFile[]; dropped: number; rejected?: Array<{ file: GeneratedFile; error: string }> }> {
  const authored = await authorUnitTestsRaw(session, d, src, targets);
  // Compile gate: a file with a syntax error gets one repair; if it still fails it never reaches a sandbox.
  const files: GeneratedFile[] = [];
  const rejected: Array<{ file: GeneratedFile; error: string }> = [];
  for (const f of authored.files) {
    const ts = /\.m?tsx?$/.test(f.target);
    let err = await syntaxError(f.code, ts);
    let code = f.code;
    if (err) {
      try {
        const fixed = await repairUnitFile(session, f, err);
        if (f.cases.every((c) => fixed.includes(c.name))) {
          const again = await syntaxError(fixed, ts);
          if (!again) code = fixed;
          err = again;
        }
      } catch (e) {
        if ((e as Error).name === "BudgetExceededError") err = `${err}\n(no repair: AI budget reached)`;
      }
    }
    if (err) rejected.push({ file: f, error: err });
    else files.push({ ...f, code });
  }
  return { files, dropped: authored.dropped, rejected };
}

async function authorUnitTestsRaw(session: AiSession, d: ProjectDossier, src: SnapshotSource, targets: Array<{ path: string; importPath: string }>): Promise<{ files: GeneratedFile[]; dropped: number }> {
  if (!targets.length) return { files: [], dropped: 0 };
  const machines = (d.ai?.stateMachines ?? []).filter((m) => targets.some((t) => m.evidence.some((e) => e.path === t.path)));
  const user = [
    intentContext(src),
    machines.length ? `State machines described by the project analysis (verify against the code, it may be wrong):\n${machines.map((m) => `- ${m.entity}.${m.field}: states ${m.states.join(", ")}; transitions ${m.transitions.map((t) => `${t.from}->${t.to}`).join(", ")}`).join("\n")}` : "",
    ...targets.map((t) => {
      const f = src.files.get(t.path)!;
      return `File ${t.path} (import it as "${t.importPath}"; exported names you may import: ${[...exportedNames(f.text)].join(", ") || "none"}):\n<project_data file="${t.path}">\n${numbered(f.text)}\n</project_data>${(() => { const deps = codeUnderTest(src, t.path, 6_000); return deps.length ? `\nTypes and modules it imports:\n${deps.join("\n")}` : ""; })()}`;
    }),
  ].filter(Boolean).join("\n\n");
  let dropped = 0;
  try {
    const out = await session.json("author", { purpose: "unit tests", system: UNIT_SYSTEM, user, schema: GeneratedOut, maxTokens: 12000 });
    const files = out.files
      // A file that imports something the module does not export cannot even load: drop it.
      .filter((f) => targets.some((t) => t.path === f.target) && importsExist(f, targets.find((t) => t.path === f.target)!.importPath, src) || (dropped++, false))
      .map((f) => ({ ...f, cases: f.cases.map((c) => ({ ...c, evidence: validEvidence(src, c.evidence) })).filter((c) => (c.evidence.length > 0 && f.code.includes(c.name)) || (dropped++, false)) }))
      .filter((f) => f.cases.length > 0);
    return { files, dropped };
  } catch {
    return { files: [], dropped: targets.length };
  }
}

// ---------------------------------------------------------------- code under test (for triage)

const CODE_EXT = ["", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", "/index.ts", "/index.js", "/__init__.py"];

/** Project files a test file imports (relative JS/TS imports and Python package imports). */
export function importedFiles(src: SnapshotSource, testPath: string): string[] {
  const f = src.files.get(testPath);
  if (!f) return [];
  const dir = testPath.includes("/") ? testPath.slice(0, testPath.lastIndexOf("/")) : "";
  const out = new Set<string>();
  const tryPath = (base: string) => {
    for (const ext of CODE_EXT) {
      const p = `${base.replace(/\.(js|mjs|cjs)$/, "")}${ext}`;
      if (src.files.has(p)) return p;
      if (src.files.has(`${base}${ext}`)) return `${base}${ext}`;
    }
    return null;
  };
  const norm = (p: string) => {
    const parts: string[] = [];
    for (const seg of p.split("/")) {
      if (seg === "..") parts.pop();
      else if (seg && seg !== ".") parts.push(seg);
    }
    return parts.join("/");
  };
  for (const m of f.text.matchAll(/(?:from\s+|require\(\s*|import\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
    const hit = tryPath(norm(`${dir}/${m[1]}`));
    if (hit) out.add(hit);
  }
  if (testPath.endsWith(".py")) {
    // pytest fixtures usually reach the app through conftest.py files in this or parent folders.
    const parts = dir ? dir.split("/") : [];
    for (let i = parts.length; i >= 0; i--) {
      const c = [...parts.slice(0, i), "conftest.py"].join("/");
      if (c !== testPath && src.files.has(c)) out.add(c);
    }
  }
  for (const m of f.text.matchAll(/^\s*(?:from\s+(\.*[\w.]*)\s+import\s+([\w, ()]+)|import\s+([\w.]+))/gm)) {
    const raw = (m[1] ?? m[3])!;
    const names = (m[2] ?? "").replace(/[()]/g, "").split(",").map((x) => x.trim().split(/\s+as\s+/)[0]!).filter(Boolean);
    if (/^(pytest|unittest|typing|os|sys|json|re|datetime|fastapi|httpx|pydantic|starlette|dataclasses|enum|decimal|uuid|collections)\b/.test(raw)) continue;
    const dots = raw.match(/^\.*/)![0].length;
    const mod = raw.slice(dots).replace(/\./g, "/");
    // Relative imports resolve from this file's package; absolute ones from the project root or the top folder.
    const bases = dots ? [norm(`${dir}/${"../".repeat(dots - 1)}`)] : ["", ...(dir ? [dir.split("/")[0]!] : [])];
    for (const b of bases) {
      const target = [b, mod].filter(Boolean).join("/");
      const hit = target ? tryPath(target) : null;
      if (hit) {
        out.add(hit);
        break;
      }
      // "from . import service" or "from app import service": the names are modules.
      let found = false;
      for (const n of names) {
        const sub = tryPath([target, n].filter(Boolean).join("/"));
        if (sub) {
          out.add(sub);
          found = true;
        }
      }
      if (found) break;
    }
  }
  // Test helpers are skipped, except pytest's conftest.py, which is how fixtures reach the app.
  // Test files themselves are skipped; helpers and fixtures next to them (and pytest's conftest.py) are kept: they shape what tests do.
  return [...out].filter((p) => p === testPath || !/(\.|\/)(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_\w+\.py$/.test(p)).slice(0, 6);
}

/** Excerpts of the product code a failing test exercises, within a character budget. */
export function codeUnderTest(src: SnapshotSource, testPath: string | null, budget = 14_000): string[] {
  if (!testPath) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  // One hop further: route files often delegate to a service module.
  const queue = importedFiles(src, testPath);
  // Follow imports (test -> fixtures -> app -> services), breadth first, up to 8 files.
  for (let i = 0; i < queue.length && queue.length < 8; i++) for (const q of importedFiles(src, queue[i]!)) if (!queue.includes(q) && q !== testPath && queue.length < 8) queue.push(q);
  for (const p of queue) {
    if (seen.has(p) || p === testPath) continue;
    seen.add(p);
    const f = src.files.get(p)!;
    const text = f.lines <= 220 ? `<project_data file="${p}">\n${numbered(f.text)}\n</project_data>` : `<project_data file="${p}" lines="1-220">\n${numbered(f.text, 1, 220)}\n</project_data>`;
    if (text.length > budget) continue;
    budget -= text.length;
    out.push(text);
  }
  return out;
}

// ---------------------------------------------------------------- explaining suite problems (hangs, flaky tests)

const ExplainOut = z.object({ rootCause: z.string().max(600), location: z.preprocess((v) => (v === "" || v === undefined ? null : v), EvidenceIn.nullable()).catch(null), test: z.string().nullable().catch(null) });
const EXPLAIN_SYSTEM = `You explain why a project's own test suite misbehaved in a clean sandbox (no internet). The verdict is already fixed by measurements; you only explain it.
Given the runner output and the test code, name the test responsible ("test", its exact title), the likely cause in one or two sentences ("rootCause"), and the line that causes it ("location": path and line from the numbered excerpts; a test line is fine here). If you cannot tell, say so plainly and use null. Decide whether the test or the code is at fault using the project's documentation: if the code does what its docs say and the test expects something else, say the test is at fault and point at the test line.
Reply with JSON: {"test":"...","rootCause":"...","location":{"path":"test/a.test.ts","line":83}}`;

export async function explainProblem(session: AiSession, context: string) {
  const req = { purpose: "explain suite problem", system: EXPLAIN_SYSTEM, user: context, schema: ExplainOut, maxTokens: 4000 };
  try {
    return await session.json("triage", req);
  } catch (err) {
    if ((err as Error).name === "BudgetExceededError") return null;
    return session.json("author", req).catch(() => null);
  }
}

/** Test files of a workspace with their test titles, numbered, within a budget (for explaining hangs). */
export function testFilesContext(src: SnapshotSource, workspace: string, budget = 12_000) {
  const prefix = workspace === "." ? "" : `${workspace}/`;
  const out: string[] = [];
  for (const f of src.files.values()) {
    if (!f.path.startsWith(prefix) || !/(\.|\/)(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_\w+\.py$/.test(f.path)) continue;
    const text = `<project_data file="${f.path}">\n${numbered(f.text, 1, Math.min(f.lines, 200))}\n</project_data>`;
    if (text.length > budget) continue;
    out.push(text);
    budget -= text.length;
  }
  return out;
}

// ---------------------------------------------------------------- browser journey author

const UiTarget = z.object({ role: z.string().optional(), name: z.string().optional(), label: z.string().optional(), placeholder: z.string().optional(), text: z.string().optional(), testId: z.string().optional() });
export const UiStep = z.object({
  action: z.enum(["goto", "fill", "click", "select", "check", "press", "expectText", "expectUrl", "expectVisible", "waitFor"]),
  target: UiTarget.optional(),
  value: z.string().optional(),
  path: z.string().optional(),
});
export type UiStep = z.infer<typeof UiStep>;
const Journey = z.object({
  title: z.string().min(3).max(160),
  identity: z.string().nullable().catch(null),
  priority: z.enum(["critical", "high", "medium"]).catch("high"),
  steps: z.array(UiStep).min(2).max(18),
  oracle: z.string(),
  evidence: EvidenceList,
});
export type Journey = z.infer<typeof Journey>;
const UiLogin = z.object({ identity: z.string(), steps: z.array(UiStep).min(2).max(10) });
export type UiLogin = z.infer<typeof UiLogin>;
const JourneysOut = z.object({ logins: tolerant(UiLogin, 6), journeys: tolerant(Journey, 12) });

const JOURNEY_SYSTEM = `You write end-to-end browser journeys for a web app, run by Playwright in a clean sandbox (no internet, EMPTY database except what the listed setup steps create, synthetic settings).
A journey is what a real user of one role does to reach a business goal: sign in, do the task through the screens, and see the result.
Rules:
- "logins": for each identity that signs in through a screen, the steps on the login screen (goto, fill, click) ending with an expectation that sign-in worked (expectUrl or expectText). Use the same credentials the identity's API sign-in uses (the \${ENV:NAME} values shown).
- "journeys": 1 to 3 per role, most important first. Priority "critical" only for the main goal of each role. Each starts with "goto" and ends with an expectation (expectText, expectUrl or expectVisible) of the visible RESULT, grounded in the code: cite it in "evidence" (path and line from the numbered excerpts). A journey with an identity runs after that identity's login.
- Targets must use what the code renders, exactly: {"role":"button","name":"Place order"}, {"label":"Email"}, {"placeholder":"Search"}, {"text":"Orders"}, {"testId":"cart"}. Prefer role+name, then label. Never invent text that is not in the code.
- Values that must be unique use {{$uid}}, e.g. "Table {{$uid}}". Data created by the setup steps can be referred to by its captured values as {{name}}.
- Never leave the app's own origin; never use real personal data (example.com emails).
Step actions: goto (path), fill (target, value), select (target, value), check (target), click (target), press (target, value like "Enter"), waitFor (target), expectText (value, optional target), expectUrl (value: a path fragment), expectVisible (target).
Reply with JSON: {"logins":[{"identity":"admin","steps":[{"action":"goto","path":"/login"},{"action":"fill","target":{"label":"Email"},"value":"\${ENV:ADMIN_EMAIL}"},{"action":"fill","target":{"label":"Password"},"value":"\${ENV:ADMIN_PASSWORD}"},{"action":"click","target":{"role":"button","name":"Sign in"}},{"action":"expectUrl","value":"/admin"}]}],
 "journeys":[{"title":"Admin adds a menu item and sees it listed","identity":"admin","priority":"critical","steps":[],"oracle":"the new item appears in the menu list (MenuPage renders items)","evidence":[{"path":"frontend/app/admin/menu/page.tsx","line":40}]}]}`;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Screens and identities as the journey author sees them, with the screens' code (numbered). */
function journeyContext(d: ProjectDossier, src: SnapshotSource, identities: Array<{ name: string; login: unknown }>, setup: Array<{ id: string; label: string; captures: string[] }>) {
  const screens = [...d.screens].sort((a, b) => b.interactions.mutations + b.interactions.inputs - (a.interactions.mutations + a.interactions.inputs));
  const code: string[] = [];
  let budget = 45_000;
  const seen = new Set<string>();
  for (const s of screens) {
    if (seen.has(s.file)) continue;
    seen.add(s.file);
    const f = src.files.get(s.file);
    if (!f) continue;
    const x = `<project_data file="${s.file}" route="${s.url}">\n${numbered(f.text, 1, Math.min(f.lines, 260))}\n</project_data>`;
    if (budget - x.length < 0) continue;
    code.push(x);
    budget -= x.length;
  }
  return [
    `Screens (route, file, inputs, buttons, API calls): ${JSON.stringify(screens.slice(0, 40).map((s) => ({ url: s.url, file: s.file, inputs: s.interactions.inputs, buttons: s.interactions.buttons, calls: s.endpoints.slice(0, 6) })))}`,
    `Identities and how they sign in through the API (reuse these credentials in the browser): ${JSON.stringify(identities)}`,
    `Setup steps that already ran before the browser opens (their captured values can be used as {{name}}): ${JSON.stringify(setup)}`,
    intentContext(src, 4_000),
    "Screen code:",
    ...code,
  ].join("\n\n");
}

/** Every label, name and text a journey relies on must exist in the frontend code; goto paths must be real screens. */
export function journeyProblems(j: { steps: UiStep[] }, d: ProjectDossier, corpus: string): string | null {
  const routes = d.screens.map((s) => s.url.split("?")[0]!.replace(/\/+$/, "").split("/"));
  const isScreen = (p: string) => {
    const segs = p.split("?")[0]!.replace(/\/+$/, "").split("/");
    return routes.some((r) => r.length === segs.length && r.every((seg, i) => seg === segs[i] || /^(:|\[|\{|<)/.test(seg)));
  };
  const typed: string[] = [];
  // Text that contains a value the journey itself typed (often with {{$uid}}) is data, not UI text from the code.
  const whole = (t: string) => corpus.includes(norm(t)) || typed.some((v) => v === t || v.includes(t));
  // A text with a generated value ("Table {{$uid}} (guest link: /c/") is checked piece by piece: every fixed
  // piece must be in the code or in what the journey typed; prices and other numbers come from typed data.
  const known = (t: string) =>
    whole(t) ||
    (/\{\{/.test(t) &&
      t
        .split(/\{\{\$?\w+\}\}/)
        .map((x) => x.trim())
        .filter((x) => /[a-z]{2,}/i.test(x))
        .every((x) => corpus.includes(norm(x)) || typed.some((v) => norm(v).includes(norm(x)))));
  for (const st of j.steps) {
    if (st.action === "goto" && (!st.path || !st.path.startsWith("/") || !isScreen(st.path))) return `goto ${st.path ?? "(no path)"} is not a screen of this app`;
    for (const t of [st.target?.name, st.target?.label, st.target?.placeholder, st.target?.text, st.target?.testId]) {
      if (t && !known(t)) return `"${t}" does not appear in the frontend code`;
    }
    if ((st.action === "fill" || st.action === "select") && st.value) typed.push(st.value);
    if (st.action === "expectText" && st.value && !known(st.value)) return `the expected text "${st.value}" appears nowhere in the code`;
  }
  if (!["expectText", "expectUrl", "expectVisible", "waitFor"].includes(j.steps.at(-1)!.action)) return "it does not end by checking a visible result";
  return null;
}

export async function authorJourneys(session: AiSession, d: ProjectDossier, src: SnapshotSource, identities: Array<{ name: string; login: unknown }>, setup: Array<{ id: string; label: string; captures: string[] }>, max: number): Promise<{ logins: UiLogin[]; journeys: Journey[]; dropped: Array<{ title: string; reason: string }> }> {
  if (!d.screens.length) return { logins: [], journeys: [], dropped: [] };
  const out = await session.json("author", { purpose: "browser journeys", system: JOURNEY_SYSTEM, user: journeyContext(d, src, identities, setup), schema: JourneysOut, maxTokens: 9000 });
  const corpus = norm([...src.files.values()].filter((f) => /\.(tsx|jsx|ts|js|vue|svelte|html|py)$/.test(f.path)).map((f) => f.text).join("\n"));
  const names = new Set(identities.map((i) => i.name));
  const dropped: Array<{ title: string; reason: string }> = [];
  const logins = out.logins.filter((l) => {
    const why = names.has(l.identity) ? journeyProblems(l, d, corpus) : `unknown identity ${l.identity}`;
    if (why) dropped.push({ title: `Sign in as ${l.identity} in the browser`, reason: why });
    return !why;
  });
  const journeys: Journey[] = [];
  // A guest whose session comes from a public request (a check-in, a cart) has no login form: the journey makes
  // that session itself through the screens, so it runs without signing in first.
  const sessionOnly = new Set(identities.filter((i) => i.login && typeof i.login === "object" && "kind" in (i.login as object) && !("path" in (i.login as object))).map((i) => i.name));
  for (const raw of out.journeys) {
    const j = raw.identity && sessionOnly.has(raw.identity) && !logins.some((l) => l.identity === raw.identity) ? { ...raw, identity: null } : raw;
    const why = j.identity && !logins.some((l) => l.identity === j.identity) ? `no working browser sign-in for ${j.identity}` : journeyProblems(j, d, corpus);
    if (why) dropped.push({ title: j.title, reason: why });
    else if (journeys.length < max) journeys.push({ ...j, evidence: validEvidence(src, j.evidence) });
  }
  return { logins, journeys, dropped };
}
