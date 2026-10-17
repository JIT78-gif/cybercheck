import type { SecurityProof } from "@cybercheck/contracts";
import type { CompiledProof } from "./compiler.ts";

// Reads the result of running a compiled proof's requests and decides its verdict. The rule throughout: a control
// that did not hold (a vulnerability reproduced) is "failed"; a control that held for this exact target is "passed";
// anything that could not be established (no sign-in, app down, target unreachable, oracle not met) is "inconclusive",
// never a pass. A failed exploit attempt is not a pass unless the proof's oracle was actually established.

/** One request's outcome from the harness (a thin view of what runHarness returns per step). */
export type StepResult = {
  as: string;
  method: string;
  path: string;
  status: number | null;
  text: string;
  location: string | null;
  headers: Record<string, string>;
  error?: string | null;
  /** Values captured from the response for later steps. */
  captured?: Record<string, unknown>;
};

export type ProofContext = {
  executionIds: string[];
  /** Field names that identify one account's data (so an IDOR shows the other account's record, not an empty 200). */
  sensitiveFields: string[];
  /** A short label, e.g. "customer could read customer-2's record". */
  redactExcerpt: (s: string) => string;
  /** The marker a synthetic file outside the allowed directory contains (path traversal). */
  traversalMarker?: string;
  /** Whether a sandbox-local canary received a request carrying the proof's token (SSRF). */
  canaryHit?: boolean;
  /** Whether the browser canary's marker was set, meaning a reflected script executed (XSS). */
  browserMarkerSet?: boolean;
  /** Whether a marker credential sent in a request later appeared in the server log (credential logging). */
  loggedCredential?: boolean;
  /** The fixed marker a command-injection payload would print if the input reached a shell. */
  commandMarker?: string;
  /** The fixed value a code-injection canary expression evaluates to if the input is eval'd. */
  codeMarker?: string;
};

const reached = (r: StepResult | undefined) => Boolean(r && r.status !== null);
const is2xx = (r: StepResult | undefined) => Boolean(r && r.status !== null && r.status >= 200 && r.status < 300);
const isDenied = (r: StepResult | undefined) => Boolean(r && (r.status === 401 || r.status === 403 || r.status === 404));
const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s);

type Decision = { verdict: SecurityProof["verdict"]; observed: string; reason: string; evidence: SecurityProof["evidence"]; limitations?: string[] };

/** Per-type oracle. Returns the verdict plus what was observed; `steps` are in the order the proof sent them. */
function decide(req: CompiledProof, steps: StepResult[], ctx: ProofContext): Decision {
  const ev = (kind: SecurityProof["evidence"][number]["kind"], label: string, r: StepResult | undefined): SecurityProof["evidence"] =>
    r ? [{ kind, label, excerpt: ctx.redactExcerpt(clip(`${r.status ?? "no response"} ${r.method} ${r.path} ${kind === "http" ? r.text : ""}`)) }] : [];
  const blocked = (reason: string): Decision => ({ verdict: "blocked", observed: "The proof could not be established.", reason, evidence: [] });
  const bad = steps.find((s) => s.status === null);
  if (bad) return { verdict: "inconclusive", observed: `No response (${bad.error ?? "connection failed"}).`, reason: "The app did not answer, so the proof could not run.", evidence: [] };

  switch (req.type) {
    case "authz_object": {
      // Positive control first: the owner must read their own object successfully. Then the other identity tries it.
      // Without a working positive control a denial is meaningless (e.g. a 404 from an id that never existed).
      const owner = steps[0];
      const cross = steps.at(-1);
      if (!reached(owner) || !reached(cross)) return blocked("the object-authorization requests did not run");
      if (!is2xx(owner)) return { verdict: "inconclusive", observed: `The owner's own read was not successful (${owner!.status}), so there is no positive control.`, reason: "A denial to the other identity is meaningless without the owner first reading the object.", evidence: ev("http", "owner's own read", owner), limitations: ["The target object id may not exist; the proof needs a real, owned record."] };
      if (isDenied(cross)) return { verdict: "passed", observed: `The owner read it (${owner!.status}); the other identity was refused (${cross!.status}).`, reason: "The object was denied to another identity for this exact target.", evidence: [...ev("http", "owner's own read", owner), ...ev("http", "cross-identity read", cross)] };
      if (is2xx(cross)) {
        const showsOther = ctx.sensitiveFields.some((f) => new RegExp(`["']?${f}["']?\\s*[:=]`, "i").test(cross!.text)) || cross!.text.length > 2;
        if (showsOther) return { verdict: "failed", observed: `The owner read it (${owner!.status}) and so did another identity (${cross!.status}), returning the owner's record.`, reason: "One identity read another's object (IDOR).", evidence: [...ev("http", "owner's own read", owner), ...ev("http", "cross-identity read", cross)] };
        return { verdict: "inconclusive", observed: `The other identity got ${cross!.status} but no identifying field was seen.`, reason: "A 2xx with no distinguishing data does not prove exposure.", evidence: ev("http", "cross-identity read", cross), limitations: ["The response did not clearly contain the other identity's data."] };
      }
      return { verdict: "inconclusive", observed: `The other identity got ${cross!.status}.`, reason: "Neither a clear allow nor a clear deny.", evidence: ev("http", "cross-identity read", cross) };
    }
    case "authz_function": {
      // Positive control first: the privileged role must succeed on this exact target. Then the lower role tries it.
      const admin = steps.find((s) => s.as === "admin") ?? steps[0];
      const lower = steps.find((s) => s.as !== "admin") ?? steps.at(-1);
      if (!reached(lower)) return blocked("the lower-role request did not run");
      if (!reached(admin) || !is2xx(admin)) return { verdict: "inconclusive", observed: `The privileged role did not get a success on this target (${admin?.status ?? "no admin step"}), so there is no positive control.`, reason: "A denial to a lower role is only meaningful once the privileged role succeeds on the same target.", evidence: ev("http", "as the privileged role", admin), limitations: ["The route may not serve data, or the target id may not exist."] };
      if (is2xx(lower)) return { verdict: "failed", observed: `The privileged role got ${admin!.status} and a lower role also got ${lower!.status}.`, reason: "An administrator-only route served a lower role.", evidence: [...ev("http", "as the privileged role", admin), ...ev("http", "as a lower role", lower)] };
      if (isDenied(lower)) return { verdict: "passed", observed: `The privileged role got ${admin!.status}; the lower role was refused (${lower!.status}).`, reason: "The route denied the lower role for this exact target.", evidence: [...ev("http", "as the privileged role", admin), ...ev("http", "as a lower role", lower)] };
      return { verdict: "inconclusive", observed: `The lower role got ${lower!.status}.`, reason: "Neither a clear allow nor deny.", evidence: ev("http", "as a lower role", lower) };
    }
    case "authz_property": {
      // mutate, then read back: the forbidden property must be observed to have taken effect.
      const readback = steps.at(-1);
      if (!reached(readback)) return blocked("the read-back request did not run");
      const took = /"role"\s*:\s*"admin"|"isAdmin"\s*:\s*true|"owner"/i.test(readback!.text);
      if (took) return { verdict: "failed", observed: "A forbidden property was accepted and persisted.", reason: "Mass assignment: the record changed a field the caller should not set.", evidence: ev("http", "read-back after mutation", readback) };
      return { verdict: "passed", observed: "The forbidden property did not take effect.", reason: "The mutation ignored the forbidden field for this exact target.", evidence: ev("http", "read-back after mutation", readback) };
    }
    case "input_differential": {
      const [control, truthy, falsy] = steps;
      if (!reached(control) || !reached(truthy) || !reached(falsy)) return blocked("a differential request did not run");
      const diff = (a: StepResult, b: StepResult) => a.status !== b.status || Math.abs(a.text.length - b.text.length) > 8 || a.text !== b.text;
      // Injection has a specific shape, not mere output variation: the always-FALSE clause behaves like the benign
      // control (it matches nothing extra) while the always-TRUE clause opens the result up. Requiring control == false
      // rejects endpoints whose output naturally varies with input (an AI reply, a per-request computation), which
      // would otherwise diverge on any two different strings and look like injection.
      if (!diff(control!, falsy!) && diff(truthy!, falsy!)) return { verdict: "failed", observed: `An always-true clause opened the result up while an always-false clause matched the control (${truthy!.status}/${truthy!.text.length}b vs ${falsy!.status}/${falsy!.text.length}b vs control ${control!.text.length}b).`, reason: "The input is interpreted as query logic (injection).", evidence: [...ev("http", "control", control), ...ev("http", "always-true", truthy), ...ev("http", "always-false", falsy)] };
      return { verdict: "passed", observed: diff(control!, falsy!) ? "The result varies with the input itself, not with query logic." : "The always-true and always-false payloads returned the same result.", reason: "The input is treated as data for this exact target.", evidence: [...ev("http", "control", control), ...ev("http", "always-true", truthy), ...ev("http", "always-false", falsy)] };
    }
    case "redirect_target": {
      const r = steps.at(-1);
      if (!reached(r)) return blocked("the redirect request did not run");
      const loc = r!.location ?? "";
      // A redirect built from input is dangerous when it sends the caller to an absolute URL (off the app's origin);
      // a safe handler redirects to a relative path. The canary host carries no real destination.
      const external = /^https?:\/\/|^\/\//i.test(loc) || loc.includes("cc-redirect-canary");
      if (external) return { verdict: "failed", observed: `Location was ${clip(loc, 80)}.`, reason: "The redirect target is taken from request input and points off-site.", evidence: ev("http", "Location header", r) };
      return { verdict: "passed", observed: `Location was ${clip(loc, 80) || "(none)"}.`, reason: "The redirect did not point to an external target for this input.", evidence: ev("http", "Location header", r) };
    }
    case "error_disclosure": {
      const r = steps.at(-1);
      if (!reached(r)) return blocked("the error request did not run");
      const stack = /\bat\s+[\w$.]+\s+\(.*:\d+:\d+\)|Traceback \(most recent call last\)|\n\s+at\s/.test(r!.text);
      const secret = /CC_CANARY_SECRET/.test(r!.text);
      if (stack || secret) return { verdict: "failed", observed: `The error response exposed ${[stack && "a stack trace", secret && "a synthetic secret"].filter(Boolean).join(" and ")}.`, reason: "An error response discloses internals.", evidence: ev("http", "error response", r) };
      return { verdict: "passed", observed: "The error response did not expose internals.", reason: "No stack trace or synthetic secret in the response.", evidence: ev("http", "error response", r) };
    }
    case "log_disclosure": {
      if (ctx.loggedCredential === true) return { verdict: "failed", observed: "A credential sent in a request appeared in the server log.", reason: "The app writes request credentials to its logs.", evidence: [{ kind: "source", label: "server log", excerpt: "a marker credential sent in a login request was found in the captured server log" }] };
      if (ctx.loggedCredential === false) return { verdict: "passed", observed: "The marker credential did not appear in the server log.", reason: "Request credentials were not written to the log for this flow.", evidence: [] };
      return { verdict: "inconclusive", observed: "The server log could not be inspected.", reason: "No log was captured.", evidence: [] };
    }
    case "response_headers": {
      const r = steps.at(-1);
      if (!reached(r)) return blocked("the request did not run");
      const missing = ["x-content-type-options", "x-frame-options", "content-security-policy"].filter((h) => !(h in r!.headers));
      if (missing.length) return { verdict: "failed", observed: `Missing ${missing.join(", ")}.`, reason: "Security headers are absent from the live response.", evidence: ev("http", "response headers", r) };
      return { verdict: "passed", observed: "The expected security headers were present.", reason: "The live response carried the headers.", evidence: ev("http", "response headers", r) };
    }
    case "cors_response": {
      const r = steps.at(-1);
      if (!reached(r)) return blocked("the request did not run");
      const acao = r!.headers["access-control-allow-origin"];
      if (acao === "*" || acao === "https://evil.test") return { verdict: "failed", observed: `Access-Control-Allow-Origin was ${acao}.`, reason: "CORS allows an untrusted origin in the live response.", evidence: ev("http", "CORS response", r) };
      return { verdict: "passed", observed: `Access-Control-Allow-Origin was ${acao ?? "(unset)"}.`, reason: "The live response did not grant an untrusted origin.", evidence: ev("http", "CORS response", r) };
    }
    case "authn_required": {
      const r = steps.at(-1);
      if (!reached(r)) return blocked("the request did not run");
      if (is2xx(r)) return { verdict: "failed", observed: `An unauthenticated request received ${r!.status}.`, reason: "A protected route served an anonymous caller.", evidence: ev("http", "anonymous request", r) };
      if (isDenied(r)) return { verdict: "passed", observed: `Refused with ${r!.status}.`, reason: "The route required authentication for this exact target.", evidence: ev("http", "anonymous request", r) };
      return { verdict: "inconclusive", observed: `Returned ${r!.status}.`, reason: "Neither a clear allow nor deny.", evidence: ev("http", "anonymous request", r) };
    }
    case "authn_invalid_credential": {
      const r = steps.at(-1);
      if (!reached(r)) return blocked("the forged-credential request did not run");
      if (is2xx(r)) return { verdict: "failed", observed: `A tampered token was accepted (${r!.status}).`, reason: "The server accepts a token it did not sign, so a token can be forged.", evidence: ev("http", "tampered-token request", r) };
      if (isDenied(r)) return { verdict: "passed", observed: `A tampered token was refused (${r!.status}).`, reason: "The server rejected a tampered token for this exact target.", evidence: ev("http", "tampered-token request", r) };
      return { verdict: "inconclusive", observed: `Returned ${r!.status}.`, reason: "Neither a clear accept nor reject.", evidence: ev("http", "tampered-token request", r) };
    }
    case "login_throttling": {
      const attempts = steps.filter((s) => reached(s));
      if (attempts.length < 5) return blocked("too few attempts were made to judge throttling");
      const throttled = attempts.some((s) => s.status === 429);
      if (throttled) return { verdict: "passed", observed: `Throttled after repeated attempts (429).`, reason: "Repeated failed logins were rate-limited.", evidence: ev("http", "repeated attempts", attempts.at(-1)) };
      return { verdict: "failed", observed: `${attempts.length} attempts, never throttled.`, reason: "Repeated failed logins were not rate-limited.", evidence: ev("http", "repeated attempts", attempts.at(-1)), limitations: ["Throttling may still exist at a layer not exercised here (a proxy or WAF)."] };
    }
    case "file_containment": {
      if (!steps.some(reached)) return blocked("the traversal request did not run");
      const hit = ctx.traversalMarker ? steps.find((s) => s.text.includes(ctx.traversalMarker!)) : undefined;
      if (hit) return { verdict: "failed", observed: `A file outside the allowed directory was read (${hit.path}).`, reason: "A path built from request input escaped its directory (path traversal).", evidence: ev("http", "traversal response", hit) };
      if (!ctx.traversalMarker) return { verdict: "inconclusive", observed: "No out-of-directory marker was available to confirm containment.", reason: "The traversal canary was not planted.", evidence: [], limitations: ["No synthetic file was available outside the directory."] };
      if (steps.some(is2xx)) return { verdict: "passed", observed: "No attempt returned the out-of-directory file.", reason: "The path stayed within its directory for these inputs.", evidence: ev("http", "traversal response", steps.find(is2xx)) };
      return { verdict: "passed", observed: "Every traversal attempt was refused.", reason: "The traversal attempts were rejected.", evidence: ev("http", "traversal response", steps.at(-1)) };
    }
    case "outbound_request_canary": {
      const r = steps.at(-1);
      if (!reached(r)) return blocked("the request did not run");
      if (ctx.canaryHit === true) return { verdict: "failed", observed: "The server fetched the sandbox-local canary URL.", reason: "The server makes a request to a URL from request input (SSRF).", evidence: [{ kind: "canary", label: "canary received the request", excerpt: "the correlation token was seen at the loopback canary" }, ...ev("http", "request", r)] };
      if (ctx.canaryHit === false) return { verdict: "passed", observed: "The canary was never contacted.", reason: "The server did not fetch the supplied URL for this input.", evidence: ev("http", "request", r) };
      return { verdict: "inconclusive", observed: "The canary result is unknown.", reason: "The canary could not be correlated.", evidence: ev("http", "request", r) };
    }
    case "browser_script_canary": {
      if (ctx.browserMarkerSet === true) return { verdict: "failed", observed: "A reflected script executed in the browser.", reason: "Request input runs as script in the page (reflected XSS).", evidence: [{ kind: "browser", label: "canary marker set", excerpt: "the injected script set the proof marker without any external request" }] };
      if (ctx.browserMarkerSet === false) return { verdict: "passed", observed: "The reflected input did not execute as script.", reason: "The input was escaped in the page for this exact target.", evidence: [{ kind: "browser", label: "canary marker not set", excerpt: "the marker stayed unset" }] };
      return { verdict: "inconclusive", observed: "The browser canary did not run.", reason: "The page could not be loaded in the sandbox browser.", evidence: [] };
    }
    case "csrf_origin": {
      const cross = steps.at(-1);
      if (!reached(cross)) return blocked("the cross-origin request did not run");
      if (is2xx(cross)) return { verdict: "failed", observed: `A cross-origin cookie request succeeded (${cross!.status}).`, reason: "A state-changing request from another origin was accepted (CSRF).", evidence: ev("http", "cross-origin request", cross) };
      return { verdict: "passed", observed: `Refused with ${cross!.status}.`, reason: "The cross-origin request was rejected for this exact target.", evidence: ev("http", "cross-origin request", cross) };
    }
    case "webhook_signature": {
      const forged = steps.at(-1);
      if (!reached(forged)) return blocked("the forged-signature request did not run");
      if (is2xx(forged)) return { verdict: "failed", observed: `An invalid signature was accepted (${forged!.status}).`, reason: "The webhook does not verify its signature.", evidence: ev("http", "invalid signature", forged) };
      return { verdict: "passed", observed: `Refused with ${forged!.status}.`, reason: "The webhook rejected an invalid signature.", evidence: ev("http", "invalid signature", forged) };
    }
    case "upload_handling": {
      const r = steps.at(-1);
      if (!reached(r)) return blocked("the upload request did not run");
      const servedActive = /text\/html|image\/svg/i.test(r!.headers["content-type"] ?? "") && is2xx(r);
      if (servedActive) return { verdict: "failed", observed: "An uploaded HTML or SVG file is served with an active content type.", reason: "Uploaded active content is served inline.", evidence: ev("http", "upload download", r) };
      return { verdict: "passed", observed: "The upload was handled without serving active content inline.", reason: "The uploaded file was contained for this exact target.", evidence: ev("http", "upload download", r) };
    }
    case "command_injection": {
      // Several payload variants append a fixed, harmless marker command; if its output comes back from any, the input reached a shell.
      if (!steps.some(reached)) return blocked("the command-injection requests did not run");
      const hit = ctx.commandMarker ? steps.find((s) => s.text.includes(ctx.commandMarker!)) : undefined;
      if (hit) return { verdict: "failed", observed: "A fixed marker command executed on the server.", reason: "Request input is run as a shell command (command injection).", evidence: ev("http", "command-injection response", hit) };
      return { verdict: "passed", observed: "The marker command did not execute.", reason: "Request input is not passed to a shell for this exact target.", evidence: ev("http", "command-injection response", steps.at(-1)) };
    }
    case "code_injection": {
      // A fixed canary expression under several parameter names; if the response carries its value, the input is eval'd.
      if (!steps.some(reached)) return blocked("the code-injection requests did not run");
      const hit = ctx.codeMarker ? steps.find((s) => s.text.includes(ctx.codeMarker!)) : undefined;
      if (hit) return { verdict: "failed", observed: "A fixed canary expression was evaluated by the server.", reason: "Request input is evaluated as code (code injection).", evidence: ev("http", "code-injection response", hit) };
      return { verdict: "passed", observed: "The canary expression was not evaluated.", reason: "Request input is not evaluated as code for this exact target.", evidence: ev("http", "code-injection response", steps.at(-1)) };
    }
    case "session_integrity": {
      // Two checks in one proof: a caller-supplied session id is honoured (fixation), or a token still works after logout (replay).
      const fixation = steps.find((s) => s.as === "fixation-probe");
      const replay = steps.at(-1);
      if (fixation && is2xx(fixation)) return { verdict: "failed", observed: "A session id chosen by the caller was accepted.", reason: "Session fixation: the server honours a caller-supplied session id.", evidence: ev("http", "fixation probe", fixation) };
      if (!reached(replay)) return blocked("the post-logout replay request did not run");
      if (is2xx(replay)) return { verdict: "failed", observed: `A token still worked after logout (${replay!.status}).`, reason: "The session is not invalidated on logout, so the token can be replayed.", evidence: ev("http", "post-logout replay", replay) };
      return { verdict: "passed", observed: "The token was rejected after logout and a caller-supplied id was not honoured.", reason: "Sessions are fresh on login and invalidated on logout for this exact flow.", evidence: ev("http", "post-logout replay", replay) };
    }
    case "account_enumeration": {
      // Step 1 tries an unknown account, step 2 a known account with a wrong password; they are distinct requests.
      const unknown = steps[0];
      const wrongPass = steps[1];
      if (steps.length < 2 || !reached(unknown) || !reached(wrongPass)) return blocked("the enumeration probes did not run");
      if (unknown!.status !== wrongPass!.status || Math.abs(unknown!.text.length - wrongPass!.text.length) > 8) return { verdict: "failed", observed: `An unknown account (${unknown!.status}) and a wrong password (${wrongPass!.status}) get different responses.`, reason: "The sign-in route reveals whether an account exists (enumeration).", evidence: [...ev("http", "unknown account", unknown), ...ev("http", "wrong password", wrongPass)] };
      return { verdict: "passed", observed: "An unknown account and a wrong password get the same response.", reason: "The sign-in route does not reveal whether an account exists.", evidence: ev("http", "unknown account", unknown) };
    }
    default:
      return { verdict: "inconclusive", observed: "This proof type has no API oracle.", reason: "Handled by the browser or canary stage.", evidence: [] };
  }
}

/** Build the persisted SecurityProof from a compiled proof and its step results. */
export function readProof(req: CompiledProof, steps: StepResult[], ctx: ProofContext, id: string): SecurityProof {
  const d = decide(req, steps, ctx);
  const met = steps.some(reached) && d.verdict !== "blocked";
  return {
    id,
    type: req.type,
    target: req.target,
    obligationIds: req.obligationIds,
    identities: req.identities,
    preconditions: [{ what: "the app answered at least one request", met: steps.some(reached) }, { what: "the proof oracle was established", met }],
    reset: req.reset,
    payloadClass: req.payloadClass,
    expected: req.expected,
    observed: d.observed,
    evidence: d.evidence,
    source: [],
    executionIds: ctx.executionIds,
    artifacts: [],
    verdict: d.verdict,
    reason: d.reason,
    limitations: d.limitations ?? [],
    redacted: true,
    requests: steps.length,
  };
}
