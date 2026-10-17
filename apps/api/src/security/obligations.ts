import type { AnalyzeReadiness, Evidence, ProjectDossier, ProofStrategy, SecurityFact, SecurityLane, SecurityObligation } from "@cybercheck/contracts";
import type { SnapshotSource } from "../understanding/source.ts";

// The Security obligation compiler (Round 1, step 3). Every applicable requirement becomes an obligation, built by code
// from the checked facts; AI may add obligations in later rounds but can never remove one. Runtime proofs are planned
// now and marked unsupported until Round 2 builds them, so they stay in the denominator and coverage stays honest.
// Standards: ASVS 5.0 at chapter level, OWASP API Security Top 10 2023, and CWE.

/**
 * reliesOn: the analysis lanes whose facts the check trusts. A contradiction in the analysis makes a check inconclusive
 * only when the check relies on it: scanners read the snapshot itself, and an input check does not depend on whether
 * the analysis got the route's authentication right. Defaults to the obligation's own lane for fact-based checks.
 */
type Ob = Omit<SecurityObligation, "status" | "reason" | "executionIds" | "findingIds"> & Partial<Pick<SecurityObligation, "status" | "reason">> & { reliesOn?: SecurityLane[] };
const SCANNERS: ProofStrategy[] = ["secret_scan", "dependency_scan", "sast_rule", "iac_scan"];

const ASVS = {
  encoding: "ASVS-5.0:V1 Encoding and Sanitization",
  validation: "ASVS-5.0:V2 Validation and Business Logic",
  frontend: "ASVS-5.0:V3 Web Frontend Security",
  api: "ASVS-5.0:V4 API and Web Service",
  files: "ASVS-5.0:V5 File Handling",
  authn: "ASVS-5.0:V6 Authentication",
  session: "ASVS-5.0:V7 Session Management",
  authz: "ASVS-5.0:V8 Authorization",
  tokens: "ASVS-5.0:V9 Self-contained Tokens",
  crypto: "ASVS-5.0:V11 Cryptography",
  config: "ASVS-5.0:V13 Configuration",
  data: "ASVS-5.0:V14 Data Protection",
  coding: "ASVS-5.0:V15 Secure Coding and Architecture",
  logging: "ASVS-5.0:V16 Security Logging and Error Handling",
} as const;

const ROUND_2 = "Needs a runtime proof against the running app, which arrives in Round 2; counted as not yet tested.";
const SUPPORTED_CODE = /\.(c|m)?[jt]sx?$|\.py$/;
const PUBLIC_CLASSES = new Set(["public_intentional"]);

/** The static SAST categories Round 1 checks with Cybercheck's own rule pack. */
export const SAST_CATEGORIES: Array<{ key: string; requirement: string; control: string; standards: string[]; priority: SecurityObligation["priority"]; lane: SecurityLane }> = [
  { key: "sql-injection", requirement: "Database queries never build SQL or NoSQL from request input as text", control: "Parameterised queries or query builders", standards: [ASVS.encoding, "CWE-89", "CWE-943"], priority: "critical", lane: "injection" },
  { key: "command-injection", requirement: "Shell commands never include request input", control: "No shell, or arguments passed as a list", standards: [ASVS.encoding, "CWE-78"], priority: "critical", lane: "injection" },
  { key: "code-injection", requirement: "Request input never reaches eval, Function or template compilation", control: "No dynamic code from input", standards: [ASVS.encoding, "CWE-94", "CWE-1336"], priority: "critical", lane: "injection" },
  { key: "xss", requirement: "Request input is never written into HTML unescaped", control: "Output encoding or a templating engine that escapes", standards: [ASVS.encoding, ASVS.frontend, "CWE-79"], priority: "high", lane: "injection" },
  { key: "path-traversal", requirement: "File paths built from request input stay inside their directory", control: "Resolve and check the path, or an allow-list of names", standards: [ASVS.files, "CWE-22"], priority: "high", lane: "injection" },
  { key: "ssrf", requirement: "The server never fetches a URL taken from request input without an allow-list", control: "Allow-listed hosts, no internal addresses", standards: [ASVS.api, "API7:2023", "CWE-918"], priority: "high", lane: "injection" },
  { key: "open-redirect", requirement: "Redirects never go to a location taken from request input", control: "Relative paths or an allow-list", standards: [ASVS.validation, "CWE-601"], priority: "medium", lane: "injection" },
  { key: "unsafe-deserialization", requirement: "Untrusted data is never deserialised into objects or code", control: "Safe parsers (JSON, yaml.safe_load)", standards: [ASVS.coding, "CWE-502"], priority: "high", lane: "injection" },
  { key: "token-integrity", requirement: "Session and API tokens are signed and verified, never decoded or built by hand", control: "A maintained token library with signature and expiry checks", standards: [ASVS.tokens, "API2:2023", "CWE-347"], priority: "critical", lane: "auth" },
  { key: "mass-assignment", requirement: "Request bodies are never copied onto stored records wholesale", control: "An allow-list of writable fields", standards: [ASVS.validation, "API3:2023", "CWE-915"], priority: "high", lane: "access_control" },
  { key: "credentials-in-logs", requirement: "Passwords, tokens and request bodies with credentials are never logged", control: "Redacted or field-limited logging", standards: [ASVS.logging, "CWE-532"], priority: "medium", lane: "logging" },
  { key: "error-disclosure", requirement: "Error responses never include stack traces or internal messages", control: "A generic error response, details only in server logs", standards: [ASVS.logging, "CWE-209"], priority: "medium", lane: "logging" },
  { key: "debug-mode", requirement: "Debug modes are off in the shipped configuration", control: "Debug flags off by default", standards: [ASVS.config, "CWE-489"], priority: "medium", lane: "configuration" },
  { key: "weak-crypto", requirement: "No broken hash or cipher protects secrets or integrity, and security tokens use a secure random source", control: "Modern algorithms and crypto-grade randomness", standards: [ASVS.crypto, "CWE-327", "CWE-338"], priority: "medium", lane: "crypto" },
];

const isAdminPath = (p: string) => /(^|\/)(admin|manage|internal|staff|ops)(\/|$)/i.test(p);

/** Request input read in the handler's own code: the analysis may miss an input, and that must not drop a check. */
const READS_INPUT = /\breq(uest)?\.(query|body|params|files?|headers|cookies)\b|\brequest\.(args|form|json|get_json|values|query_params|path_params)\b|\bctx\.(query|params|request)\b|searchParams|useSearchParams/;
function handlerReadsInput(src: SnapshotSource, handler: Evidence) {
  const text = src.files.get(handler.path)?.text;
  return Boolean(text && READS_INPUT.test(text.split("\n").slice(Math.max(0, handler.line - 1), handler.line + 25).join("\n")));
}

/** A route that only serves a static page or file (res.sendFile/render), not privileged data. Its being reachable is
 * not an authorization defect by itself, so it is never treated as an administrator-only API from its path alone. */
function servesPage(src: SnapshotSource, handler: Evidence) {
  const text = src.files.get(handler.path)?.text;
  if (!text) return false;
  const body = text.split("\n").slice(Math.max(0, handler.line - 1), handler.line + 8).join("\n");
  return /\bres\.(sendFile|render|sendfile)\b|\.html['"]\s*\)|sendFile\s*\(/i.test(body);
}

export function compileObligations(input: { dossier: ProjectDossier; facts: SecurityFact[]; readiness: AnalyzeReadiness; src: SnapshotSource }): SecurityObligation[] {
  const { dossier: d, facts, readiness, src } = input;
  const factById = new Map(facts.map((f) => [f.id, f]));
  const ev = (id: string): Evidence[] => factById.get(id)?.evidence ?? [];
  const out: Ob[] = [];
  const add = (o: Ob) => out.push(o);

  // ---------------- per endpoint: authentication, object- and function-level authorization, mass assignment, input
  for (const e of d.entryPoints.filter((x) => x.kind !== "page")) {
    const label = `${e.method} ${e.path}`;
    const asset = { kind: "endpoint" as const, ref: e.id, label };
    const isPublic = PUBLIC_CLASSES.has(e.control.kind);
    const hasParams = /\/:[\w]+|\/\{[^}]+\}|\/<[^>]+>/.test(e.path);
    const takesInput = Boolean(e.inputs.params || e.inputs.query || e.inputs.body || e.inputs.files || hasParams || ["POST", "PUT", "PATCH"].includes(e.method) || handlerReadsInput(src, e.handler));
    const critical = e.mutates || isAdminPath(e.path) || hasParams;
    add({
      id: `sec:${e.id}:authentication`,
      lane: "auth",
      category: "authentication",
      asset,
      requirement: `${label} refuses a request without valid credentials unless it is public by design`,
      expectedControl: e.control.kind === "none_found" ? "A guard, or a documented reason it is public" : `${e.control.kind} (${e.control.reason})`,
      applicabilityEvidence: ev(e.id),
      standards: [ASVS.authn, "API2:2023", "CWE-306"],
      priority: critical ? "critical" : "high",
      proofStrategy: "runtime_proof",
      dependencies: [e.id, "auth:model"],
      ...(isPublic ? { status: "not_applicable" as const, reason: `Public by design: ${e.control.reason}. A public route is never reported for being public.` } : {}),
    });
    if (hasParams && !isPublic) {
      add({ id: `sec:${e.id}:object-authorization`, lane: "access_control", category: "authorization", asset, requirement: `${label} only returns or changes records the caller owns or may access`, expectedControl: "An ownership or tenant check on the record id", applicabilityEvidence: ev(e.id), standards: [ASVS.authz, "API1:2023", "CWE-639"], priority: "critical", proofStrategy: "runtime_proof", dependencies: [e.id, "auth:model"] });
    }
    if ((e.control.kind === "role_required" || (isAdminPath(e.path) && !servesPage(src, e.handler))) && !isPublic) {
      add({ id: `sec:${e.id}:function-authorization`, lane: "access_control", category: "authorization", asset, requirement: `${label} is refused to callers without the required role`, expectedControl: "A role check before the handler runs", applicabilityEvidence: ev(e.id), standards: [ASVS.authz, "API5:2023", "CWE-285"], priority: "critical", proofStrategy: "runtime_proof", dependencies: [e.id, "auth:model"] });
    }
    if (["POST", "PUT", "PATCH"].includes(e.method) && e.mutates && !isPublic) {
      add({ id: `sec:${e.id}:property-authorization`, lane: "access_control", category: "authorization", asset, requirement: `${label} ignores fields the caller may not set (role, owner, price)`, expectedControl: "An allow-list of writable fields", applicabilityEvidence: ev(e.id), standards: [ASVS.validation, "API3:2023", "CWE-915"], priority: "high", proofStrategy: "runtime_proof", dependencies: [e.id] });
    }
    if (takesInput) {
      add({ id: `sec:${e.id}:input-handling`, lane: "injection", category: "injection", asset, requirement: `${label} treats its inputs as data (no injection into queries, commands, paths, URLs or HTML)`, expectedControl: "Validation and context-specific encoding", applicabilityEvidence: ev(e.id), standards: [ASVS.encoding, ASVS.validation, "CWE-74"], priority: critical ? "high" : "medium", proofStrategy: "runtime_proof", dependencies: [], reliesOn: ["injection"] });
    }
  }
  // Sign-in throttling: a bounded check on public sign-in routes (never a load test).
  for (const e of d.entryPoints.filter((x) => x.kind !== "page" && x.method === "POST" && /(login|signin|sign-in|session|token|auth)/i.test(x.path) && x.control.kind === "public_intentional")) {
    add({ id: `sec:${e.id}:login-throttling`, lane: "auth", category: "authentication", asset: { kind: "endpoint", ref: e.id, label: `${e.method} ${e.path}` }, requirement: "Repeated failed sign-ins are slowed down or locked", expectedControl: "Rate limiting or lockout on sign-in", applicabilityEvidence: ev(e.id), standards: [ASVS.authn, "API4:2023", "CWE-307"], priority: "high", proofStrategy: "runtime_proof", dependencies: [], reliesOn: [] });
  }

  // ---------------- secrets
  add({ id: "sec:secrets:repository", lane: "secrets", category: "secrets", asset: { kind: "repository", ref: ".", label: "the whole snapshot" }, requirement: "No credentials, private keys or tokens are committed to the code", expectedControl: "Secrets come from the environment or a secret manager", applicabilityEvidence: [], standards: [ASVS.config, "CWE-798"], priority: "critical", proofStrategy: "secret_scan", dependencies: [] });
  for (const [path, reason] of src.excluded) {
    if (reason !== "secret") continue;
    add({ id: `sec:secrets:file:${path}`, lane: "secrets", category: "secrets", asset: { kind: "file", ref: path, label: path }, requirement: `${path} is not committed with the code`, expectedControl: "Secret files stay out of the repository (.gitignore)", applicabilityEvidence: [], standards: [ASVS.config, "CWE-540"], priority: "critical", proofStrategy: "fact_rule", dependencies: [] });
  }
  for (const v of d.config.envVars.filter((x) => x.sensitivity === "secret" && x.side === "browser")) {
    add({ id: `sec:secrets:browser:${v.name}`, lane: "secrets", category: "secrets", asset: { kind: "config", ref: v.id, label: v.name }, requirement: `${v.name} is not bundled into browser code`, expectedControl: "Secrets stay on the server", applicabilityEvidence: ev(v.id), standards: [ASVS.frontend, "CWE-200"], priority: "critical", proofStrategy: "fact_rule", dependencies: [v.id] });
  }

  // ---------------- dependencies and supply chain
  for (const m of [...new Set(d.dependencies.map((x) => x.manifest))]) {
    const deps = d.dependencies.filter((x) => x.manifest === m);
    const locked = deps.some((x) => x.resolved);
    add({ id: `sec:deps:${m}`, lane: "dependencies", category: "dependencies", asset: { kind: "manifest", ref: m, label: m }, requirement: `No dependency in ${m} has a known vulnerability at its resolved version`, expectedControl: "Patched versions, pinned by a lockfile", applicabilityEvidence: ev(`manifest:${m}`), standards: [ASVS.coding, "CWE-1395"], priority: "high", proofStrategy: "dependency_scan", dependencies: [`manifest:${m}`] });
    if (!locked) add({ id: `sec:deps:${m}:lockfile`, lane: "dependencies", category: "supply chain", asset: { kind: "manifest", ref: m, label: m }, requirement: `${m} installs from a lockfile, so the versions checked are the versions shipped`, expectedControl: "A committed lockfile", applicabilityEvidence: ev(`manifest:${m}`), standards: [ASVS.coding, "CWE-1357"], priority: "medium", proofStrategy: "fact_rule", dependencies: [`manifest:${m}`] });
  }

  // ---------------- SAST with Cybercheck's rule pack (JavaScript, TypeScript, Python)
  const codeFiles = [...src.files.keys()].filter((p) => SUPPORTED_CODE.test(p) && !p.includes("node_modules/"));
  for (const c of SAST_CATEGORIES) {
    add({
      id: `sec:sast:${c.key}`,
      lane: c.lane,
      category: c.key,
      asset: { kind: "repository", ref: ".", label: `${codeFiles.length} JavaScript, TypeScript and Python file(s)` },
      requirement: c.requirement,
      expectedControl: c.control,
      applicabilityEvidence: [],
      standards: c.standards,
      priority: c.priority,
      proofStrategy: "sast_rule",
      dependencies: [],
      ...(codeFiles.length ? {} : { status: "not_applicable" as const, reason: "No JavaScript, TypeScript or Python code in the snapshot." }),
    });
  }

  // ---------------- configuration visible in code
  const hasHttp = d.entryPoints.some((e) => e.kind !== "page");
  const corsFacts = facts.filter((f) => f.id.startsWith("config:cors:"));
  // Checked by a code rule as well as the analysis' CORS facts: CORS set by hand (a header) is not always in the facts.
  if (hasHttp || corsFacts.length) add({ id: "sec:config:cors", lane: "configuration", category: "configuration", asset: { kind: "config", ref: "cors", label: "CORS" }, requirement: "CORS does not let any origin read authenticated responses", expectedControl: "An allow-list of origins", applicabilityEvidence: corsFacts.flatMap((f) => f.evidence), standards: [ASVS.frontend, "API8:2023", "CWE-942"], priority: "medium", proofStrategy: "config_rule", dependencies: corsFacts.map((f) => f.id), reliesOn: [] });
  if (hasHttp) add({ id: "sec:config:security-headers", lane: "configuration", category: "configuration", asset: { kind: "config", ref: "headers", label: "HTTP security headers" }, requirement: "Responses carry the standard security headers (content type options, frame protection, a content security policy for pages)", expectedControl: "Header middleware or a reverse-proxy configuration", applicabilityEvidence: [], standards: [ASVS.frontend, "API8:2023", "CWE-693"], priority: "low", proofStrategy: "config_rule", dependencies: ["control:security_headers"] });
  const session = d.runtime.session;
  add({
    id: "sec:config:session-cookie",
    lane: "configuration",
    category: "session",
    asset: { kind: "config", ref: "session", label: "session cookie" },
    requirement: "The session cookie is HttpOnly, Secure and SameSite",
    expectedControl: "Cookie flags set where the session is configured",
    applicabilityEvidence: session?.evidence ?? [],
    standards: [ASVS.session, "CWE-1004", "CWE-614"],
    priority: "medium",
    proofStrategy: "config_rule",
    dependencies: [],
    ...(session ? {} : { status: "not_applicable" as const, reason: "No cookie-based session library was found in the code." }),
  });
  const cookieSession = Boolean(session) || d.securityModel.authMechanisms.some((m) => m.kind === "session");
  const stateChanging = d.entryPoints.some((e) => e.mutates && e.control.kind !== "public_intentional");
  add({
    id: "sec:config:csrf",
    lane: "configuration",
    category: "session",
    asset: { kind: "config", ref: "csrf", label: "cross-site request forgery" },
    requirement: "State-changing requests authenticated by a cookie are protected against cross-site requests",
    expectedControl: "SameSite cookies, a CSRF token, or an origin check",
    applicabilityEvidence: session?.evidence ?? [],
    standards: [ASVS.session, "CWE-352"],
    priority: "high",
    proofStrategy: "config_rule",
    dependencies: ["control:csrf"],
    ...(cookieSession && stateChanging ? {} : { status: "not_applicable" as const, reason: "No cookie-authenticated state-changing request was found (bearer tokens are not sent cross-site by browsers)." }),
  });
  d.runtime.uploads.forEach((u, i) => add({ id: `sec:config:upload:${i + 1}`, lane: "configuration", category: "file upload", asset: { kind: "endpoint", ref: u.endpoint ?? `upload-${i + 1}`, label: u.endpoint ?? u.library }, requirement: "Uploaded files have size limits and a content type the server decides", expectedControl: "Limits, an allow-list of types, and served Content-Type not taken from the client", applicabilityEvidence: u.evidence, standards: [ASVS.files, "CWE-434"], priority: "high", proofStrategy: "config_rule", dependencies: [] }));

  // ---------------- infrastructure and CI
  for (const f of d.deployment.dockerfiles) add({ id: `sec:iac:dockerfile:${f.path}`, lane: "infrastructure", category: "container", asset: { kind: "container", ref: f.path, label: f.path }, requirement: `${f.path} runs as a non-root user from a pinned base image`, expectedControl: "USER set to a non-root user; base image pinned by digest or exact tag", applicabilityEvidence: ev(`dockerfile:${f.path}`), standards: [ASVS.config, "CWE-250", "CWE-1357"], priority: "medium", proofStrategy: "iac_scan", dependencies: [`dockerfile:${f.path}`] });
  for (const file of [...new Set(d.deployment.containers.map((c) => c.file))]) add({ id: `sec:iac:compose:${file}`, lane: "infrastructure", category: "container", asset: { kind: "config", ref: file, label: file }, requirement: `${file} publishes only the ports it needs and runs no privileged container`, expectedControl: "No privileged mode or host networking; only needed ports published", applicabilityEvidence: d.deployment.containers.filter((c) => c.file === file).flatMap((c) => ev(c.id)), standards: [ASVS.config, "CWE-250"], priority: "medium", proofStrategy: "iac_scan", dependencies: d.deployment.containers.filter((c) => c.file === file).map((c) => c.id) });
  for (const path of [...new Set(d.deployment.infraResources.map((r) => r.evidence.path))]) add({ id: `sec:iac:resources:${path}`, lane: "infrastructure", category: "infrastructure", asset: { kind: "config", ref: path, label: path }, requirement: `${path} exposes no resource publicly and grants no excessive privilege`, expectedControl: "Private by default, least privilege", applicabilityEvidence: [{ path, line: 1 }].filter((e) => src.files.has(e.path)), standards: [ASVS.config, "CWE-732"], priority: "medium", proofStrategy: "iac_scan", dependencies: [] });
  for (const w of d.deployment.ci) add({ id: `sec:ci:${w.path}`, lane: "infrastructure", category: "ci", asset: { kind: "workflow", ref: w.path, label: w.path }, requirement: `${w.path} limits its token permissions and pins third-party actions`, expectedControl: "Explicit least-privilege permissions; actions pinned by commit", applicabilityEvidence: ev(`ci:${w.path}`), standards: [ASVS.config, "CWE-829"], priority: "medium", proofStrategy: "iac_scan", dependencies: [`ci:${w.path}`] });

  // ---------------- passwords: only where the app itself stores or checks them
  const credentialFacts = facts.filter((f) => f.id.startsWith("auth:credential:"));
  const passwordFields = d.dataModel.entities.flatMap((e) => e.fields.filter((x) => /pass(word)?|pwd|hash/i.test(x.name)).map(() => e.id));
  const storesPasswords = credentialFacts.some((f) => /password|compare/i.test(f.id) || /password/i.test(f.statement)) || passwordFields.length > 0;
  add({
    id: "sec:crypto:password-storage",
    lane: "crypto",
    category: "password storage",
    asset: { kind: "repository", ref: ".", label: "stored passwords" },
    requirement: "Stored passwords are hashed with a slow, salted algorithm and compared in constant time",
    expectedControl: "bcrypt, scrypt or Argon2; no plain-text storage or === comparison",
    applicabilityEvidence: credentialFacts.flatMap((f) => f.evidence),
    standards: [ASVS.authn, ASVS.crypto, "CWE-256", "CWE-916"],
    priority: "critical",
    proofStrategy: "fact_rule",
    dependencies: [...credentialFacts.map((f) => f.id), "control:password_hashing"],
    // "Password hashing not detected" alone is never a finding: the app may delegate sign-in or compare an operator secret.
    ...(storesPasswords ? {} : { status: "not_applicable" as const, reason: "The app does not store or check user passwords itself (no password column and no password comparison found)." }),
  });

  // ---------------- sensitive data exposure through the API (runtime, Round 2)
  for (const f of facts.filter((x) => x.id.startsWith("entity:"))) {
    add({ id: `sec:privacy:${f.id}`, lane: "privacy", category: "data exposure", asset: { kind: "entity", ref: f.id, label: f.statement.split(" holds ")[0]! }, requirement: `${f.statement.replace(/\.$/, "")}: these fields are only returned to callers allowed to see them`, expectedControl: "Field-level filtering in responses", applicabilityEvidence: f.evidence, standards: [ASVS.data, "API3:2023", "CWE-213"], priority: "high", proofStrategy: "runtime_proof", dependencies: [f.id] });
  }

  // ---------------- statuses: blocked lanes and contradicted facts first, then what Round 1 cannot prove yet
  const blockedBy = new Map<SecurityLane, string[]>();
  for (const i of readiness.issues) for (const lane of i.blocks) blockedBy.set(lane, [...(blockedBy.get(lane) ?? []), i.rule]);
  const reliesOn = (o: Ob) => o.reliesOn ?? (SCANNERS.includes(o.proofStrategy) ? [] : [o.lane]);
  const order = { critical: 0, high: 1, medium: 2, low: 3 };
  return out
    .map((o): SecurityObligation => {
      const { reliesOn: _r, ...rest } = o;
      const base = { ...rest, executionIds: [], findingIds: [] };
      if (o.status === "not_applicable") return { ...base, status: "not_applicable", reason: o.reason ?? null };
      const lanes = reliesOn(o).filter((l) => blockedBy.has(l));
      const rules = [...new Set(lanes.flatMap((l) => blockedBy.get(l)!))];
      if (rules.length) return { ...base, status: "inconclusive", reason: `The project analysis contradicts itself (${rules.join(", ")}), so the ${lanes.map((l) => l.replace("_", " ")).join(" and ")} facts this check relies on are not trusted.${o.proofStrategy === "runtime_proof" ? ` ${ROUND_2}` : ""}` };
      const contradicted = o.dependencies.map((id) => factById.get(id)).find((f) => f && (f.contradictions.length || f.state === "unresolved"));
      if (contradicted) return { ...base, status: "inconclusive", reason: `It depends on ${contradicted.id}, which is ${contradicted.state === "unresolved" ? "unresolved" : `contradicted (${contradicted.contradictions.join(", ")})`}.` };
      if (o.proofStrategy === "runtime_proof" || o.proofStrategy === "browser_proof") return { ...base, status: "unsupported", reason: ROUND_2 };
      return { ...base, status: "planned", reason: null };
    })
    .map((o, i) => ({ o, i }))
    .sort((a, b) => order[a.o.priority] - order[b.o.priority] || a.i - b.i)
    .map(({ o }) => o);
}

/** Proof strategies that the Round 1 scanners and rules will execute. */
export const STATIC_STRATEGIES: ProofStrategy[] = ["secret_scan", "dependency_scan", "sast_rule", "config_rule", "iac_scan", "fact_rule"];
