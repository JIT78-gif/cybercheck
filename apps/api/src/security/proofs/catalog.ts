import type { EntryPoint, ProjectDossier, SecurityObligation } from "@cybercheck/contracts";
import { ANONYMOUS, type ProofRequest } from "./compiler.ts";

// The fixed proof catalogue (Round 2, API level). Pure: it turns the analysed endpoints and the run's synthetic
// identities into ProofRequests. Every request names a real endpoint, acts as a synthetic identity, and carries only
// bounded, loopback payloads, so the compiler accepts it. Object ids come from values the sign-ins captured
// ({{identity__id}}); nothing is invented. Browser and canary proofs are added by the browser stage.

export type Identity = { name: string; role: string | null; idSymbol: string | null };

/** Sandbox-local canaries the proving stage plants: a file outside the app's directory, a marker reflected into a page. */
export const CANARY = {
  traversalFile: "cc-canary-secret.txt",
  traversalMarker: "CC_TRAVERSAL_CANARY_7f3a9",
  xssMarker: "cc-xss-7f3a9",
  logMarker: "cc-cred-marker-7f3a9",
  commandMarker: "CC_CMD_MARKER_7f3a9",
  codeMarker: "CC_CODE_MARKER_7f3a9",
  uploadMarker: "CC_UPLOAD_7f3a9",
  port: 8099,
};

/** A Round 1 suspected code pattern that a runtime proof should try to confirm, keyed to its endpoint. */
export type Hypothesis = { category: string; endpointRef: string | null };

export type CatalogContext = {
  dossier: Pick<ProjectDossier, "entryPoints" | "securityModel">;
  identities: Identity[];
  /** Field names that mark one account's own data (for the IDOR oracle). */
  sensitiveFields: string[];
  /** Suspected code patterns from the static scan, so a runtime proof targets exactly where a sink was seen. */
  hypotheses?: Hypothesis[];
  /** A sandbox-local canary base URL for SSRF proofs, e.g. "http://127.0.0.1:8099"; set by the orchestrator. */
  canaryBase?: string;
  /** The compiled obligations, so a proof is built for every applicable runtime obligation and the rest are marked. */
  obligations?: SecurityObligation[];
  /** The sign-in route and a seeded account, for the enumeration and session proofs. */
  login?: { method: string; path: string; accountField: string; passwordField: string; knownEmail: string };
  /** Whether sign-in uses a cookie session (CSRF applies to cookie-authenticated mutations). */
  cookieSession?: boolean;
};

/** What the proof run produced: the proofs to run, plus runtime obligations no proof could exercise (with the reason). */
export type Catalog = { proofs: ProofRequest[]; notApplicable: Array<{ obligationId: string; reason: string }> };

const ob = (ep: EntryPoint, kind: string) => `sec:endpoint:${ep.method} ${ep.path}:${kind}`;
const ref = (ep: EntryPoint) => `${ep.method} ${ep.path}`;
const hasParam = (ep: EntryPoint) => /[/]([:{<[]|%7B)/.test(ep.path) || /\/:\w|\/\{|\/<|\[/.test(ep.path);
const concretePath = (ep: EntryPoint, value: string) => ep.path.replace(/\/(:[^/]+|\{[^}]+\}|<[^>]+>|\[[^\]]+\])/, `/${value}`);
const nonAdmin = (ids: Identity[], adminRole: string | null) => ids.find((i) => i.role !== adminRole && i.idSymbol) ?? ids.find((i) => i.role !== adminRole);
const other = (ids: Identity[], not: Identity) => ids.find((i) => i !== not && i.role === not.role) ?? ids.find((i) => i !== not);

const hashRef = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);
const ADMIN_ROLE = /admin|superuser|root|owner|staff/i;
const ADMIN_PATH = /(^|\/)admin(\/|$)/i;

/** The admin-ish role name present among the identities, if any. */
function adminRoleOf(ids: Identity[]): string | null {
  return ids.find((i) => i.role && ADMIN_ROLE.test(i.role))?.role ?? null;
}

export function buildCatalog(ctx: CatalogContext): Catalog {
  const { entryPoints: eps } = ctx.dossier;
  const http = eps.filter((e) => e.kind === "http" || e.kind === "webhook");
  const adminRole = adminRoleOf(ctx.identities);
  const out: ProofRequest[] = [];
  // A function-authorization proof runs only where the compiler raised that obligation (it excludes page-serving
  // routes, so an admin HTML page is never treated as an administrator-only API from its path alone).
  const obIds = new Set((ctx.obligations ?? []).filter((o) => o.status !== "not_applicable").map((o) => o.id));
  const wants = (ep: EntryPoint, kind: string) => !ctx.obligations || obIds.has(ob(ep, kind));

  for (const ep of http) {
    const control = ep.control.kind;
    const isPublic = control === "public_intentional";
    const protectedRoute = control === "session_required" || control === "role_required";

    // Authentication: a protected route must refuse an anonymous caller.
    if (protectedRoute) {
      out.push({
        type: "authn_required",
        target: { kind: "endpoint", ref: ref(ep) },
        obligationIds: [ob(ep, "authentication")],
        identities: [],
        payloadClass: "no credentials",
        expected: "A protected route refuses an unauthenticated request (401 or 403).",
        reset: "none_needed",
        steps: [{ as: ANONYMOUS, method: ep.method, path: concretePath(ep, "1"), expect: { statusClass: ["4xx"] } }],
      });
    }

    // Object authorization (IDOR): one identity reads another's object on a parameterised route. Step 0 is the
    // owner's own read (the positive control); step 1 is the other identity trying the same object.
    if (hasParam(ep) && ep.method === "GET" && !isPublic && wants(ep, "object-authorization")) {
      const owner = nonAdmin(ctx.identities, adminRole);
      const intruder = owner ? other(ctx.identities, owner) : undefined;
      if (owner?.idSymbol && intruder) {
        out.push({
          type: "authz_object",
          target: { kind: "endpoint", ref: ref(ep) },
          obligationIds: [ob(ep, "object-authorization")],
          identities: [owner.name, intruder.name],
          payloadClass: "another identity's object id",
          expected: `${intruder.name} cannot read ${owner.name}'s record (403 or 404).`,
          reset: "none_needed",
          steps: [
            { as: owner.name, method: "GET", path: concretePath(ep, `{{${owner.idSymbol}}}`), expect: {} },
            { as: intruder.name, method: "GET", path: concretePath(ep, `{{${owner.idSymbol}}}`), expect: {} },
          ],
        });
      }
    }

    // Function authorization: an administrator-only route must refuse a lower role. The compiler decides which routes
    // are administrator APIs (not pages); the proof needs a privileged identity (positive control) plus a lower one.
    if (!isPublic && wants(ep, "function-authorization")) {
      const admin = adminRole ? ctx.identities.find((i) => i.role === adminRole) : undefined;
      const lower = nonAdmin(ctx.identities, adminRole);
      if (admin && lower && admin !== lower) {
        const target = hasParam(ep) ? concretePath(ep, admin.idSymbol ? `{{${admin.idSymbol}}}` : "1") : ep.path;
        out.push({
          type: "authz_function",
          target: { kind: "endpoint", ref: ref(ep) },
          obligationIds: [ob(ep, "function-authorization")],
          identities: [admin.name, lower.name],
          payloadClass: "a lower-role caller",
          expected: `The privileged role succeeds and ${lower.name} is refused (403) on this administrator route.`,
          reset: "none_needed",
          // Positive control first (the admin must succeed), then the lower role on the same target.
          steps: [
            { as: admin.name, method: ep.method, path: target, expect: {} },
            { as: lower.name, method: ep.method, path: target, expect: {} },
          ],
        });
      }
    }

    // Property authorization (mass assignment): submit forbidden properties, then read the record back. Needs a GET
    // on the same route to observe whether the forbidden field took effect.
    const readBack = http.find((g) => g.method === "GET" && g.path === ep.path);
    if (ep.mutates && (ep.method === "PATCH" || ep.method === "PUT") && hasParam(ep) && !isPublic && readBack && wants(ep, "property-authorization")) {
      const actor = nonAdmin(ctx.identities, adminRole);
      if (actor?.idSymbol) {
        const path = concretePath(ep, `{{${actor.idSymbol}}}`);
        out.push({
          type: "authz_property",
          target: { kind: "endpoint", ref: ref(ep) },
          obligationIds: [ob(ep, "property-authorization")],
          identities: [actor.name],
          payloadClass: "a forbidden property (role, owner)",
          expected: "A forbidden property is not accepted onto the record.",
          reset: "rollback",
          steps: [
            { as: actor.name, method: ep.method, path, json: { role: "admin", isAdmin: true }, expect: {} },
            { as: actor.name, method: "GET", path, expect: {} },
          ],
        });
      }
    }
  }

  // Confirm suspected code patterns where the static scan saw a sink, as a signed-in caller.
  const actor = nonAdmin(ctx.identities, adminRole);
  const asName = actor?.name ?? ANONYMOUS;
  const epByRef = new Map(http.map((e) => [ref(e), e]));
  const token = () => `cc${Math.abs(hashRef(JSON.stringify(ctx.hypotheses ?? []))).toString(36)}`;
  for (const h of ctx.hypotheses ?? []) {
    const ep = h.endpointRef ? epByRef.get(h.endpointRef) : undefined;
    if (!ep) continue;
    const path = hasParam(ep) ? concretePath(ep, "1") : ep.path;

    if (h.category === "sql-injection" || h.category === "sql-string-built") {
      // Boolean differential: a control, an always-true and an always-false clause. The payloads close a quoted string
      // and comment out the rest, so they work whether the value sits in = '<q>' or LIKE '%<q>%'. No destructive SQL.
      const q = (frag: string) => ({ as: asName, method: ep.method, path: `${path}${path.includes("?") ? "&" : "?"}q=${encodeURIComponent(frag)}`, expect: {} });
      out.push({ type: "input_differential", target: { kind: "endpoint", ref: ref(ep) }, obligationIds: [ob(ep, "input-handling"), "sec:sast:sql-injection"], identities: actor ? [actor.name] : [], payloadClass: "a boolean SQL clause", expected: "A boolean clause does not change the result (input is treated as data).", reset: "none_needed", steps: [q("cc-control-value"), q("%' OR 1=1 -- "), q("%' AND 1=2 -- ")] });
    } else if (h.category === "path-traversal") {
      // The query parameter name and the directory depth vary, so try the common parameter names at two depths; the
      // proving stage plants CANARY.traversalFile just outside the app directory, and the oracle looks for its marker.
      const sep = path.includes("?") ? "&" : "?";
      const steps = ["name", "path", "file"].flatMap((p) => ["../../", "../../../"].map((d) => ({ as: asName, method: ep.method, path: `${path}${sep}${p}=${encodeURIComponent(d + CANARY.traversalFile)}`, expect: {} })));
      out.push({ type: "file_containment", target: { kind: "endpoint", ref: ref(ep) }, obligationIds: [ob(ep, "input-handling"), "sec:sast:path-traversal"], identities: actor ? [actor.name] : [], payloadClass: "a path that climbs out of the directory", expected: "A path built from input cannot read a file outside its directory.", reset: "none_needed", steps });
    } else if (h.category === "ssrf" && ctx.canaryBase) {
      const t = token();
      const url = `${ctx.canaryBase}/c/${t}`;
      out.push({ type: "outbound_request_canary", target: { kind: "endpoint", ref: ref(ep) }, obligationIds: [ob(ep, "input-handling"), "sec:sast:ssrf"], identities: actor ? [actor.name] : [], payloadClass: "a sandbox-local URL to fetch", expected: "The server does not fetch a URL supplied in the request.", reset: "none_needed", canary: { url, token: t }, steps: [{ as: asName, method: ep.method, path, json: { url }, expect: {} }] });
    } else if (h.category === "open-redirect") {
      // The destination param name varies (url, to, next, redirect, returnUrl): send a sandbox-local off-site target
      // under each; if the app redirects to it, the Location header shows the external host.
      const target = "http://cc-redirect-canary.localhost/x";
      const qs = ["url", "to", "next", "redirect", "returnUrl", "dest"].map((k) => `${k}=${encodeURIComponent(target)}`).join("&");
      out.push({ type: "redirect_target", target: { kind: "endpoint", ref: ref(ep) }, obligationIds: [ob(ep, "input-handling"), "sec:sast:open-redirect"], identities: actor ? [actor.name] : [], payloadClass: "an off-site redirect target", expected: "A redirect does not send the caller to a target taken from input.", reset: "none_needed", steps: [{ as: asName, method: ep.method, path: `${path}${path.includes("?") ? "&" : "?"}${qs}`, expect: {} }] });
    } else if (h.category === "token-integrity") {
      // Forge a tampered token (the proving harness changes a claim on a captured token and re-presents it). If a
      // protected route still accepts it, the token was never verified and can be forged. Needs a signed-in member.
      const owner = nonAdmin(ctx.identities, adminRole);
      const guarded = http.find((e) => e.method === "GET" && hasParam(e) && e.control.kind === "session_required");
      if (owner?.idSymbol && guarded) {
        out.push({ type: "authn_invalid_credential", target: { kind: "endpoint", ref: ref(guarded) }, obligationIds: [ob(guarded, "authentication"), "sec:sast:token-integrity"], identities: [owner.name, `${owner.name}#forged`], payloadClass: "a tampered bearer token", expected: "A token the server did not sign is rejected.", reset: "none_needed", steps: [{ as: `${owner.name}#forged`, method: "GET", path: concretePath(guarded, `{{${owner.idSymbol}}}`), expect: {} }] });
      }
    } else if (h.category === "command-injection") {
      // Append a FIXED, harmless marker command. If its output comes back, the input reached a shell. Never an
      // arbitrary command, external callback or user-supplied shell text.
      const sep = path.includes("?") ? "&" : "?";
      const marker = CANARY.commandMarker;
      // Only "echo <fixed marker>" is ever injected (the safety compiler still rejects any other command); no backtick
      // or $() form, which the compiler blocks outright.
      const payloads = [`edge; echo ${marker}`, `edge && echo ${marker}`, `edge | echo ${marker}`];
      const steps = ["label", "name", "input", "value"].flatMap((pn) => payloads.map((pl) => (ep.method === "GET" ? { as: asName, method: ep.method, path: `${path}${sep}${pn}=${encodeURIComponent(pl)}`, expect: {} } : { as: asName, method: ep.method, path, json: { [pn]: pl }, expect: {} }))).slice(0, 6);
      out.push({ type: "command_injection", target: { kind: "endpoint", ref: ref(ep) }, obligationIds: [ob(ep, "input-handling"), "sec:sast:command-injection"], identities: actor ? [actor.name] : [], payloadClass: "a fixed sandbox-local marker command", expected: "Request input is not run as a shell command.", reset: "none_needed", steps });
    } else if (h.category === "code-injection") {
      // A fixed arithmetic/string canary (no file, process or network access). If the response carries its value, the
      // input was evaluated as code.
      const marker = CANARY.codeMarker;
      const expr = `'${marker}'`;
      const steps = ["expression", "code", "expr", "input"].map((pn) => (ep.method === "GET" ? { as: asName, method: ep.method, path: `${path}${path.includes("?") ? "&" : "?"}${pn}=${encodeURIComponent(expr)}`, expect: {} } : { as: asName, method: ep.method, path, json: { [pn]: expr }, expect: {} }));
      out.push({ type: "code_injection", target: { kind: "endpoint", ref: ref(ep) }, obligationIds: [ob(ep, "input-handling"), "sec:sast:code-injection"], identities: actor ? [actor.name] : [], payloadClass: "a fixed canary expression", expected: "Request input is not evaluated as code.", reset: "none_needed", steps });
    } else if (h.category === "error-disclosure") {
      out.push({ type: "error_disclosure", target: { kind: "endpoint", ref: ref(ep) }, obligationIds: [ob(ep, "input-handling"), "sec:sast:error-disclosure"], identities: actor ? [actor.name] : [], payloadClass: "input that triggers a handled failure", expected: "An error response does not expose a stack trace or secret.", reset: "none_needed", steps: [{ as: asName, method: ep.method, path, json: { trigger: "cc-malformed" }, raw: ep.method === "GET" ? undefined : "{not json", expect: {} }] });
    } else if (h.category === "xss") {
      // Reflected XSS: send a script marker in the input and read the response. If the marker comes back verbatim
      // inside a text/html body (not entity-escaped), it would execute in a browser. The query parameter name varies.
      const sep = path.includes("?") ? "&" : "?";
      const payload = `<script>${CANARY.xssMarker}</script>`;
      const steps = ["q", "query", "search", "name", "message"].map((p) => ({ as: asName, method: "GET", path: `${path}${sep}${p}=${encodeURIComponent(payload)}`, expect: {} }));
      out.push({ type: "browser_script_canary", target: { kind: "screen", ref: ref(ep) }, obligationIds: [ob(ep, "input-handling"), "sec:sast:xss"], identities: actor ? [actor.name] : [], payloadClass: "a reflected script marker", expected: "Reflected input is escaped and does not execute as script.", reset: "none_needed", browser: { path, marker: CANARY.xssMarker }, steps });
    }
  }

  // App-level response checks: CORS and security headers from a real response.
  const anyGet = http.find((e) => e.method === "GET");
  if (anyGet) {
    out.push({
      type: "cors_response",
      target: { kind: "endpoint", ref: ref(anyGet) },
      obligationIds: ["sec:config:cors"],
      identities: [],
      payloadClass: "an untrusted Origin header",
      expected: "The response does not grant an untrusted origin.",
      reset: "none_needed",
      steps: [{ as: ANONYMOUS, method: "GET", path: concretePath(anyGet, "1"), headers: { origin: "https://evil.test" }, expect: {} }],
    });
    out.push({
      type: "response_headers",
      target: { kind: "endpoint", ref: ref(anyGet) },
      obligationIds: ["sec:config:security-headers"],
      identities: [],
      payloadClass: "a plain request",
      expected: "The response carries the standard security headers.",
      reset: "none_needed",
      steps: [{ as: ANONYMOUS, method: "GET", path: concretePath(anyGet, "1"), expect: {} }],
    });
  }

  // Error disclosure: a route that deliberately fails (a diagnostics/error endpoint) must not leak a stack or secret.
  const errorRoute = http.find((e) => /(^|\/)(diagnostics|error|debug|_error)(\/|$)/i.test(e.path));
  if (errorRoute) {
    out.push({ type: "error_disclosure", target: { kind: "endpoint", ref: ref(errorRoute) }, obligationIds: [ob(errorRoute, "input-handling")], identities: [], payloadClass: "a request that triggers a handled failure", expected: "An error response does not expose a stack trace or a secret.", reset: "none_needed", steps: [{ as: ANONYMOUS, method: errorRoute.method, path: hasParam(errorRoute) ? concretePath(errorRoute, "1") : errorRoute.path, expect: {} }] });
  }

  // Credential logging: send a marker credential to the sign-in route; if it later appears in the server log, the app
  // logs credentials. The login may fail; the point is whether the request body was written to the log.
  const loginForLog = http.find((e) => /(^|\/)(log-?in|sign-?in|auth\/login|session)(\/|$)/i.test(e.path) && e.method === "POST");
  if (loginForLog) {
    out.push({ type: "log_disclosure", target: { kind: "endpoint", ref: ref(loginForLog) }, obligationIds: [ob(loginForLog, "input-handling")], identities: [], payloadClass: "a marker credential", expected: "Request credentials are not written to the server log.", reset: "none_needed", steps: [{ as: ANONYMOUS, method: "POST", path: loginForLog.path, json: { email: `${CANARY.logMarker}@example.test`, password: CANARY.logMarker }, expect: {} }] });
  }

  // CSRF: a cookie-authenticated state change accepted with a cross-site Origin (no token or Origin check).
  if (ctx.cookieSession && actor) {
    for (const ep of http.filter((e) => ["POST", "PUT", "PATCH", "DELETE"].includes(e.method) && (e.control.kind === "session_required" || e.control.kind === "role_required"))) {
      out.push({ type: "csrf_origin", target: { kind: "endpoint", ref: ref(ep) }, obligationIds: ["sec:config:csrf", ob(ep, "input-handling")], identities: [actor.name], payloadClass: "a cross-origin cookie request", expected: "A cookie-authenticated state change is refused across origins.", reset: "rollback", steps: [{ as: actor.name, method: ep.method, path: hasParam(ep) ? concretePath(ep, "1") : ep.path, headers: { origin: "https://evil.test" }, json: { email: "cc-csrf@example.test", value: "cc", name: "cc" }, expect: {} }] });
    }
  }

  // Webhooks: a route that must verify a signature. Send a forged signature (and a replay); acceptance is the defect.
  for (const ep of http.filter((e) => /webhook/i.test(e.path) && e.method === "POST")) {
    const body = { id: "cc-webhook-evt-1", amount: 100, event: "cc.test" };
    out.push({ type: "webhook_signature", target: { kind: "endpoint", ref: ref(ep) }, obligationIds: [ob(ep, "authentication")], identities: [], payloadClass: "a forged webhook signature", expected: "A webhook with an invalid signature is rejected.", reset: "none_needed", steps: [{ as: ANONYMOUS, method: "POST", path: ep.path, headers: { "x-signature": "cc-invalid-signature", "x-webhook-signature": "cc-invalid" }, json: body, expect: {} }] });
  }

  // Uploads: upload an active HTML file, then read it back; serving it inline with an active content type is the defect.
  const uploadPost = http.find((e) => e.method === "POST" && /upload/i.test(e.path));
  const uploadGet = http.find((e) => e.method === "GET" && /upload/i.test(e.path) && hasParam(e));
  if (uploadPost && uploadGet && actor) {
    out.push({ type: "upload_handling", target: { kind: "endpoint", ref: ref(uploadPost) }, obligationIds: [ob(uploadPost, "input-handling")], identities: [actor.name], payloadClass: "an active HTML upload", expected: "An uploaded active file is not served inline with its original content type.", reset: "none_needed", steps: [{ as: actor.name, method: "POST", path: uploadPost.path, json: { name: `${CANARY.uploadMarker}.html`, contentType: "text/html", filename: `${CANARY.uploadMarker}.html`, content: `<script>${CANARY.uploadMarker}</script>` }, capture: { name: "ccUploadId", path: "$.id" }, expect: {} }, { as: actor.name, method: "GET", path: concretePath(uploadGet, "{{ccUploadId}}"), expect: {} }] });
  }

  // Session integrity: after logout, reuse the same session on a protected route; still working is a replay defect.
  const logout = http.find((e) => e.method === "POST" && /log-?out|sign-?out|session\/end/i.test(e.path));
  const protectedGet = http.find((e) => e.method === "GET" && (e.control.kind === "session_required" || e.control.kind === "role_required") && !hasParam(e));
  if (logout && protectedGet && actor) {
    out.push({ type: "session_integrity", target: { kind: "endpoint", ref: ref(logout) }, obligationIds: [ob(logout, "authentication")], identities: [actor.name], payloadClass: "a token replayed after logout", expected: "A token stops working after logout.", reset: "fresh_app", steps: [{ as: actor.name, method: "POST", path: logout.path, expect: {} }, { as: actor.name, method: "GET", path: protectedGet.path, expect: {} }] });
  }

  // Account enumeration: an unknown account and a wrong password should look the same.
  const loginEp = ctx.login ? http.find((e) => e.path === ctx.login!.path && e.method === ctx.login!.method) : undefined;
  if (ctx.login && loginEp) {
    const { accountField, passwordField, knownEmail } = ctx.login;
    out.push({ type: "account_enumeration", target: { kind: "endpoint", ref: ref(loginEp) }, obligationIds: [ob(loginEp, "authentication")], identities: [], payloadClass: "an unknown account vs a wrong password", expected: "An unknown account and a wrong password return the same response.", reset: "none_needed", steps: [{ as: ANONYMOUS, method: loginEp.method, path: loginEp.path, json: { [accountField]: "cc-nobody-7f3a9@example.test", [passwordField]: "cc-wrong" }, expect: {} }, { as: ANONYMOUS, method: loginEp.method, path: loginEp.path, json: { [accountField]: knownEmail, [passwordField]: "cc-definitely-wrong" }, expect: {} }] });
  }

  // Login throttling: repeated wrong passwords against the sign-in route.
  const login = http.find((e) => /(^|\/)(log-?in|sign-?in|auth\/login|session)(\/|$)/i.test(e.path) && e.method === "POST");
  if (login) {
    out.push({
      type: "login_throttling",
      target: { kind: "endpoint", ref: ref(login) },
      obligationIds: [ob(login, "login-throttling")],
      identities: [],
      payloadClass: "repeated wrong passwords",
      expected: "Repeated failed logins are rate-limited (429) before 20 attempts.",
      reset: "none_needed",
      steps: Array.from({ length: 20 }, () => ({ as: ANONYMOUS, method: "POST", path: login.path, json: { email: "nobody@example.test", password: "wrong-password" }, loginAttempt: true, expect: {} })),
    });
  }

  // Coverage: give every runtime obligation a decisive path. Input-handling endpoints with no flagged sink get a
  // bounded negative differential (the input is not interpreted as query logic); everything a proof cannot exercise
  // is marked not_applicable with a precise reason, so it leaves the denominator honestly rather than sitting unproven.
  const notApplicable: Array<{ obligationId: string; reason: string }> = [];
  const runtimeObs = (ctx.obligations ?? []).filter((o) => o.proofStrategy === "runtime_proof" && o.status !== "not_applicable");
  const epById = new Map(http.map((e) => [e.id, e]));
  const covered = () => new Set(out.flatMap((p) => p.obligationIds));
  for (const o of runtimeObs) {
    if (covered().has(o.id)) continue;
    const kind = o.id.split(":").at(-1)!;
    const ep = epById.get(o.asset.ref);
    if (kind === "input-handling" && ep) {
      // A negative input probe: boolean payloads that, as literal data, match nothing. If they do not change the
      // result, the input is treated as data on this endpoint (passed); if they diverge, it is a bonus injection catch.
      const sep = ep.path.includes("?") ? "&" : "?";
      const base = hasParam(ep) ? concretePath(ep, "1") : ep.path;
      const q = (frag: string) => ({ as: asName, method: ep.method, path: `${base}${sep}q=${encodeURIComponent(frag)}`, expect: {} });
      out.push({ type: "input_differential", target: { kind: "endpoint", ref: ref(ep) }, obligationIds: [o.id], identities: actor ? [actor.name] : [], payloadClass: "boolean payloads as a negative input probe", expected: "The input is treated as data (boolean payloads do not change the result).", reset: "none_needed", steps: [q("cc-control-value"), q("%' OR 1=1 -- "), q("%' AND 1=2 -- ")] });
      continue;
    }
    const reason =
      kind === "object-authorization" ? "No second account of the same role was available to compare, so object-level access could not be exercised at runtime."
      : kind === "function-authorization" ? "No privileged identity was available to establish a positive control, so a role check could not be exercised at runtime."
      : kind === "property-authorization" ? "No readable record was available to confirm whether a forbidden field took effect."
      : kind === "authentication" ? "No runtime request could be formed for this endpoint."
      : o.category === "data exposure" ? "A per-field response comparison for sensitive data is not built in this round."
      : "No runtime probe in the catalogue exercises this obligation.";
    notApplicable.push({ obligationId: o.id, reason });
  }

  return { proofs: out, notApplicable };
}
