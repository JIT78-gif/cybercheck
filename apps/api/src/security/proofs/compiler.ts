import type { ProjectDossier, SecurityProofType } from "@cybercheck/contracts";
import { endpointKeys, routeKey } from "../../testing/scenarios.ts";

/**
 * Whether a concrete request path matches one of the project's route patterns. A request path has real values where
 * the route has parameters (/api/users/7 against /api/users/:id), so a plain routeKey would not line up; this
 * matches segment by segment, treating a route's {} as a wildcard.
 */
export function pathMatchesRoute(method: string, path: string, endpoints: Set<string>): boolean {
  const key = routeKey(method, path);
  if (endpoints.has(key)) return true;
  const [m, p = ""] = key.split(" ", 2);
  const reqSegs = p.split("/");
  for (const route of endpoints) {
    const [rm, rp = ""] = route.split(" ", 2);
    if (rm !== m) continue;
    const routeSegs = rp.split("/");
    if (routeSegs.length !== reqSegs.length) continue;
    if (routeSegs.every((seg, i) => seg === "{}" || seg === reqSegs[i])) return true;
  }
  return false;
}

// The Security proof compiler and safety validator (Round 2). Every runtime proof is built as a ProofRequest and
// must pass this gate before it runs. The gate permits only catalogued probes against the project's own endpoints,
// as synthetic identities, with bounded, loopback-only, non-destructive payloads. Nothing here trusts the project,
// and in Round 2 Step 8 it is also the gate for anything an AI critic proposes: the AI can never widen it.

/** How many requests a proof type may send against one target, and whether it may mutate state. */
const PER_TYPE: Partial<Record<SecurityProofType, { maxSteps: number; mutates: boolean }>> = {
  login_throttling: { maxSteps: 22, mutates: false }, // up to 20 attempts plus a before/after probe
  input_differential: { maxSteps: 8, mutates: false },
  authz_object: { maxSteps: 6, mutates: false },
  authz_function: { maxSteps: 4, mutates: false },
  authz_property: { maxSteps: 6, mutates: true },
};
const DEFAULT_PER_TYPE = { maxSteps: 6, mutates: false };

export const PROOF_LIMITS = {
  maxConcurrent: 4,
  maxRequestsPerRun: 300,
  maxRequestsPerTarget: 25,
  maxLoginAttempts: 20,
  perProofTimeoutSec: 120,
};

/** Identities a proof may act as; "anonymous" is always allowed (no credentials). */
export const ANONYMOUS = "anonymous";

export type ProofStep = {
  as: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  raw?: string;
  contentType?: string;
  /** The harness judge shape (status, statusClass, json checks, bodyIncludes). */
  expect?: unknown;
  /** Capture a value from the response for a later step (e.g. an object id). */
  /** Keep a value from this step's response for a later step, e.g. { name: "ccUploadId", path: "$.id" }. */
  capture?: { name: string; path: string };
  /** A login attempt counts toward the throttling budget. */
  loginAttempt?: boolean;
};

export type ProofRequest = {
  type: SecurityProofType;
  target: { kind: "endpoint" | "screen" | "app"; ref: string };
  obligationIds: string[];
  identities: string[];
  payloadClass: string;
  expected: string;
  reset: "none_needed" | "fresh_app" | "rollback" | "not_possible";
  steps: ProofStep[];
  /** A sandbox-local canary (SSRF): the URL the app will be asked to fetch, and the token to correlate. */
  canary?: { url: string; token: string };
  /** A browser canary (XSS): the path to open and the marker a script would set. */
  browser?: { path: string; marker: string };
};

export type CompiledProof = ProofRequest & { requests: number };
export type Rejection = { request: ProofRequest; reasons: string[] };

const DESTRUCTIVE = /\b(drop|truncate|delete)\s+(table|from|database)\b|\bshutdown\b|\balter\s+table\b|;\s*--/i;
const SHELL = /(^|[;&|`$])\s*(rm|wget|curl|nc|bash|sh|python|perl|powershell|cmd|chmod|chown|kill|mkfifo|mount)\b|\/bin\/(sh|bash)|\brevshell\b|\bnc\s+-e|2>&1|\$\(|`[^`]*`/i;
const PERSIST = /\b(crontab|systemctl|authorized_keys|startup|registry|HKLM|HKCU)\b|\.(bashrc|profile|bash_profile|zshrc)\b/i;

/** Values that look like a URL must point at the sandbox itself, never an external host or a callback. */
function externalUrls(value: unknown): string[] {
  const bad: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\b([a-z][a-z0-9+.-]*):\/\/([^/\s"']+)/gi)) {
        const scheme = m[1]!.toLowerCase();
        const host = m[2]!.toLowerCase().replace(/^[^@]*@/, "").replace(/:\d+$/, "");
        if (scheme !== "http" && scheme !== "https") bad.push(m[0]!);
        else if (!["127.0.0.1", "localhost", "[::1]", "::1", "0.0.0.0"].includes(host) && !host.endsWith(".localhost")) bad.push(m[0]!);
      }
      // A protocol-relative or bare-host reference is also an external reach.
      if (/^\/\/[^/]/.test(v)) bad.push(v);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return bad;
}

function payloadText(s: ProofStep): string {
  return [s.raw ?? "", s.json !== undefined ? JSON.stringify(s.json) : "", s.form ? JSON.stringify(s.form) : "", JSON.stringify(s.headers ?? {})].join(" ");
}

/** The Origin and Referer headers declare where a browser request came from; they are not fetch targets, so a CORS
 * proof may carry an external origin there. Every other header and the body must stay sandbox-local. */
function nonOriginHeaders(headers?: Record<string, string>): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(origin|referer)$/i.test(k)));
}

/** Check one proof request against the safety rules. Returns the reasons it is rejected (empty = allowed). */
export function validateProof(req: ProofRequest, ctx: { endpoints: Set<string>; identities: Set<string> }): string[] {
  const reasons: string[] = [];
  // A "<id>#forged" actor is the tampered-token variant of a known identity (built by the proving harness).
  const allowedId = (name: string) => name === ANONYMOUS || ctx.identities.has(name) || (name.endsWith("#forged") && ctx.identities.has(name.replace(/#forged$/, "")));
  const limit = PER_TYPE[req.type] ?? DEFAULT_PER_TYPE;

  if (req.target.kind === "endpoint") {
    const [method, path] = req.target.ref.split(/\s+/, 2);
    if (!path || !ctx.endpoints.has(routeKey(method!, path))) reasons.push(`target ${req.target.ref} is not an endpoint of this project`);
  }
  for (const id of req.identities) if (!allowedId(id)) reasons.push(`identity "${id}" is not a synthetic identity of this run`);

  if (!req.steps.length) reasons.push("a proof must send at least one request");
  if (req.steps.length > limit.maxSteps) reasons.push(`${req.steps.length} requests exceed the ${limit.maxSteps} allowed for a ${req.type} proof`);
  if (req.steps.length > PROOF_LIMITS.maxRequestsPerTarget) reasons.push(`${req.steps.length} requests exceed the per-target limit of ${PROOF_LIMITS.maxRequestsPerTarget}`);
  const logins = req.steps.filter((s) => s.loginAttempt).length;
  if (logins > PROOF_LIMITS.maxLoginAttempts) reasons.push(`${logins} login attempts exceed the limit of ${PROOF_LIMITS.maxLoginAttempts}`);

  for (const s of req.steps) {
    if (!allowedId(s.as)) reasons.push(`a request acts as "${s.as}", which is not a synthetic identity`);
    if (!/^\/[^\s]*$/.test(s.path)) reasons.push(`request path "${s.path}" must be a relative path on the app`);
    else if (!pathMatchesRoute(s.method, s.path.split("?")[0]!, ctx.endpoints)) reasons.push(`${s.method} ${s.path} is not an endpoint of this project`);
    const ext = externalUrls({ p: s.json, f: s.form, r: s.raw, h: nonOriginHeaders(s.headers) });
    if (ext.length) reasons.push(`a payload reaches outside the sandbox: ${ext.slice(0, 2).join(", ")}`);
    const text = payloadText(s);
    if (DESTRUCTIVE.test(text)) reasons.push("a payload contains a destructive database operation");
    if (SHELL.test(text)) reasons.push("a payload contains a shell command");
    if (PERSIST.test(text)) reasons.push("a payload tries to persist on the host");
  }

  if (req.canary && externalUrls(req.canary.url).length) reasons.push("the SSRF canary URL is not sandbox-local");
  if (!["none_needed", "fresh_app", "rollback", "not_possible"].includes(req.reset)) reasons.push(`unknown reset strategy "${req.reset}"`);
  if (limit.mutates && req.reset === "none_needed") reasons.push(`a ${req.type} proof changes state, so it needs a reset strategy`);

  return [...new Set(reasons)];
}

/**
 * Validate and admit a batch of proof requests. Keeps only safe ones, in order, up to the per-run request budget;
 * anything over budget or unsafe is returned in `rejected` with reasons. Never mutates the input.
 */
export function compilePlan(requests: ProofRequest[], d: Pick<ProjectDossier, "entryPoints">, identities: Iterable<string>): { proofs: CompiledProof[]; rejected: Rejection[] } {
  const ctx = { endpoints: endpointKeys(d), identities: new Set(identities) };
  const proofs: CompiledProof[] = [];
  const rejected: Rejection[] = [];
  let budget = PROOF_LIMITS.maxRequestsPerRun;
  for (const req of requests) {
    const reasons = validateProof(req, ctx);
    if (req.steps.length > budget) reasons.push(`the run's ${PROOF_LIMITS.maxRequestsPerRun}-request budget is used up`);
    if (reasons.length) {
      rejected.push({ request: req, reasons });
      continue;
    }
    budget -= req.steps.length;
    proofs.push({ ...req, requests: req.steps.length });
  }
  return { proofs, rejected };
}
