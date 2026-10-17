import type { Evidence, SecurityFinding, SecurityObligation, SecurityProof, SecurityProofType } from "@cybercheck/contracts";

// Correlates static hypotheses (findings from the scan) with runtime proofs, then settles obligations.
//   - A proof confirms or clears only the finding categories it is an oracle for (an IDOR proof never speaks to a
//     token-forgery finding, even on the same endpoint and lane).
//   - A failed proof (the control did not hold) with its preconditions met upgrades the matching suspected finding to
//     confirmed, with controlled_reproduction evidence from this run. If no static finding covered it (SAST cannot see
//     IDOR or a missing role check), a confirmed finding is synthesized from the proof.
//   - A passing proof never hides a static finding: the weakness may still be real where the proof could not reach it,
//     so the finding stays suspected with a note. Only the obligation it names is marked passed for its exact target.
//   - One proof settles only the obligations it names.

/** The finding categories each proof type is an oracle for. */
const CONFIRMS: Record<SecurityProofType, string[]> = {
  authz_object: ["access-control", "idor", "object-authorization", "broken-object-authorization"],
  authz_function: ["access-control", "function-authorization", "missing-authorization", "admin"],
  authz_property: ["mass-assignment", "property-authorization"],
  input_differential: ["sql-injection", "nosql-injection", "injection"],
  browser_script_canary: ["xss"],
  file_containment: ["path-traversal"],
  outbound_request_canary: ["ssrf"],
  redirect_target: ["open-redirect"],
  error_disclosure: ["error-disclosure"],
  log_disclosure: ["credentials-in-logs", "logging"],
  response_headers: ["security-headers", "configuration"],
  cors_response: ["cors", "misconfiguration"],
  authn_required: ["authentication", "broken-authentication"],
  authn_invalid_credential: ["token-integrity", "broken-authentication", "authentication"],
  login_throttling: ["login-throttling", "rate-limiting"],
  csrf_origin: ["csrf"],
  webhook_signature: ["webhook"],
  upload_handling: ["upload"],
  command_injection: ["command-injection"],
  code_injection: ["code-injection"],
  session_integrity: ["session", "session-fixation", "broken-authentication"],
  account_enumeration: ["account-enumeration", "user-enumeration"],
};

/** A short, human finding a reproduced proof stands up on its own (SAST could not see IDOR or a missing role check). */
const SYNTHESIZE: Partial<Record<SecurityProofType, { lane: SecurityFinding["lane"]; category: string; severity: SecurityFinding["severity"]; title: string; cwe: string[]; owasp: string[]; impact: string; remediation: string }>> = {
  authz_object: { lane: "access_control", category: "idor", severity: "high", title: "One user can read another user's object", cwe: ["CWE-639"], owasp: ["API1:2023"], impact: "A caller can read records that belong to other users.", remediation: "Scope every object lookup to the signed-in user (or check ownership) before returning it." },
  authz_function: { lane: "access_control", category: "missing-authorization", severity: "high", title: "An administrator-only route serves a lower role", cwe: ["CWE-862"], owasp: ["API5:2023"], impact: "A non-administrator can use an administrator action.", remediation: "Check the caller's role on the route before running the handler." },
  authz_property: { lane: "access_control", category: "mass-assignment", severity: "high", title: "A caller can set a protected property through this route", cwe: ["CWE-915"], owasp: ["API6:2023"], impact: "A caller can change a field they should not control (role, owner).", remediation: "Accept only an allow-list of fields from the request body." },
  input_differential: { lane: "injection", category: "sql-injection", severity: "critical", title: "Request input is interpreted as query logic", cwe: ["CWE-89"], owasp: ["API8:2023"], impact: "A caller can change the query the database runs.", remediation: "Use parameterised queries; never build SQL from request text." },
  file_containment: { lane: "injection", category: "path-traversal", severity: "high", title: "A request path can read a file outside its directory", cwe: ["CWE-22"], owasp: ["API1:2023"], impact: "A caller can read files outside the intended directory.", remediation: "Resolve the path and confirm it stays within the allowed directory." },
  outbound_request_canary: { lane: "injection", category: "ssrf", severity: "high", title: "The server fetches a URL taken from request input", cwe: ["CWE-918"], owasp: ["API7:2023"], impact: "A caller can make the server send requests to addresses of their choosing.", remediation: "Allow-list the hosts the server may fetch; reject the rest." },
  redirect_target: { lane: "injection", category: "open-redirect", severity: "medium", title: "A redirect target is taken from request input", cwe: ["CWE-601"], owasp: ["API7:2023"], impact: "A caller can send users to an off-site address through the app.", remediation: "Allow only relative paths or an allow-list of destinations." },
  error_disclosure: { lane: "logging", category: "error-disclosure", severity: "medium", title: "An error response exposes internals", cwe: ["CWE-209"], owasp: ["API8:2023"], impact: "Error responses leak stack traces or secrets.", remediation: "Return a generic error; log the detail server-side only." },
  cors_response: { lane: "configuration", category: "cors", severity: "medium", title: "CORS grants an untrusted origin in the live response", cwe: ["CWE-942"], owasp: ["API8:2023"], impact: "A site the user did not trust can read authenticated responses from a browser.", remediation: "Allow-list specific origins; never reflect the request Origin while allowing credentials." },
  response_headers: { lane: "configuration", category: "security-headers", severity: "low", title: "The live response is missing security headers", cwe: ["CWE-693"], owasp: ["API8:2023"], impact: "Browsers get no clickjacking, MIME-sniffing or content-security protection.", remediation: "Set the standard security headers (helmet or equivalent)." },
  login_throttling: { lane: "auth", category: "login-throttling", severity: "medium", title: "Repeated failed logins are not rate-limited", cwe: ["CWE-307"], owasp: ["API4:2023"], impact: "Credential-stuffing and brute force are unhindered.", remediation: "Rate-limit or lock out repeated failed sign-ins." },
  csrf_origin: { lane: "configuration", category: "csrf", severity: "high", title: "A cookie-authenticated state change is accepted cross-origin", cwe: ["CWE-352"], owasp: ["API8:2023"], impact: "Another site can make a logged-in user's browser perform this action.", remediation: "Require a CSRF token or check the Origin on cookie-authenticated mutations." },
  webhook_signature: { lane: "auth", category: "webhook", severity: "high", title: "A webhook accepts an unsigned or replayed request", cwe: ["CWE-345"], owasp: ["API8:2023"], impact: "Anyone can forge or replay webhook events.", remediation: "Verify a signature and reject replays (an idempotency key or timestamp window)." },
  upload_handling: { lane: "configuration", category: "upload", severity: "medium", title: "An uploaded active file is served inline with its original content type", cwe: ["CWE-434"], owasp: ["API8:2023"], impact: "An uploaded HTML or SVG runs in the victim's browser on this origin.", remediation: "Store with a safe content type and Content-Disposition: attachment; do not trust the client's type." },
  command_injection: { lane: "injection", category: "command-injection", severity: "critical", title: "Request input is executed as a shell command", cwe: ["CWE-78"], owasp: ["API8:2023"], impact: "A caller can run arbitrary commands on the server.", remediation: "Never pass request input to a shell; use a safe API with an argument array." },
  code_injection: { lane: "injection", category: "code-injection", severity: "critical", title: "Request input is evaluated as code", cwe: ["CWE-94"], owasp: ["API8:2023"], impact: "A caller can execute arbitrary code in the server process.", remediation: "Never eval request input; parse it with a safe, bounded evaluator." },
  session_integrity: { lane: "auth", category: "session", severity: "high", title: "A session is fixable or replayable after logout", cwe: ["CWE-384"], owasp: ["API2:2023"], impact: "A session id set by the caller is honoured, or a token keeps working after logout.", remediation: "Issue a fresh session id on login and invalidate it on logout." },
  account_enumeration: { lane: "auth", category: "account-enumeration", severity: "low", title: "The sign-in route reveals whether an account exists", cwe: ["CWE-204"], owasp: ["API2:2023"], impact: "An attacker can learn which emails are registered.", remediation: "Return the same response for an unknown account and a wrong password." },
};

export type Correlation = { findings: SecurityFinding[]; obligations: SecurityObligation[]; rejected: SecurityFinding[] };

const endpointOfProof = (p: SecurityProof) => p.target.ref;
/** True when a proof is an oracle for this finding: it confirms the finding's category and names its endpoint/obligation. */
function relates(proof: SecurityProof, f: SecurityFinding): boolean {
  if (!(CONFIRMS[proof.type] ?? []).some((c) => f.category === c || f.category.includes(c) || c.includes(f.category))) return false;
  if (proof.obligationIds.some((id) => f.obligationIds.includes(id))) return true;
  const ref = endpointOfProof(proof);
  return f.observed.includes(ref) || f.title.includes(ref) || f.rootCause.includes(ref);
}

export function correlate(findings: SecurityFinding[], proofs: SecurityProof[], obligations: SecurityObligation[], endpointEvidence: Map<string, Evidence> = new Map()): Correlation {
  const out: SecurityFinding[] = findings.map((f) => ({ ...f }));
  const confirmedByProof = new Set<string>();

  for (const f of out) {
    if (f.status !== "suspected") {
      // An already-confirmed static finding (e.g. CORS confirmed by the scanner) that a runtime proof also reproduced
      // cites that proof and is marked runtime-confirmed; its status does not change.
      const live = f.status === "confirmed" ? proofs.find((p) => p.verdict === "failed" && p.preconditions.every((c) => c.met) && relates(p, f)) : undefined;
      if (live) {
        f.proofIds = [...new Set([...(f.proofIds ?? []), live.id])];
        f.basis = "runtime_confirmed";
      } else f.basis ??= f.status === "confirmed" ? "component_present" : f.basis;
      continue;
    }
    const related = proofs.filter((p) => relates(p, f));
    const confirming = related.find((p) => p.verdict === "failed" && p.preconditions.every((c) => c.met));
    if (confirming) {
      f.status = "confirmed";
      f.basis = "runtime_confirmed";
      f.proofIds = [...new Set([...(f.proofIds ?? []), confirming.id])];
      f.trust = "controlled_reproduction";
      f.confirmation = `Confirmed by a runtime proof (${confirming.id}): ${confirming.reason} Expected ${confirming.expected.toLowerCase()} observed ${confirming.observed.toLowerCase()}`;
      confirming.obligationIds.forEach((id) => confirmedByProof.add(id));
    } else if (related.some((p) => p.verdict === "passed") && !related.some((p) => p.verdict === "failed")) {
      // The proof could not reproduce it. The weakness may still be real where the proof could not reach, so it stays
      // suspected rather than being hidden.
      const p = related.find((x) => x.verdict === "passed")!;
      f.proofIds = [...new Set([...(f.proofIds ?? []), p.id])];
      f.confirmation = `${f.confirmation} A runtime proof (${p.id}) did not reproduce it on the exact target tried; it stays suspected, not cleared.`;
    }
    f.basis ??= "static_only";
  }

  // Runtime-only discoveries: a reproduced proof whose vulnerability no static finding covered becomes a finding.
  let nextId = Math.max(0, ...out.map((f) => Number(f.id.replace(/\D/g, "")) || 0));
  for (const p of proofs) {
    if (p.verdict !== "failed" || !p.preconditions.every((c) => c.met)) continue;
    const spec = SYNTHESIZE[p.type];
    if (!spec) continue;
    // Only synthesize when no finding already covers this proof: an existing static/suspected finding of the same
    // category is upgraded or has the proof attached above, so synthesizing here would duplicate it.
    if (out.some((f) => relates(p, f))) continue;
    const ev = endpointEvidence.get(p.target.ref);
    out.push({
      id: `S${++nextId}`,
      status: "confirmed",
      severity: spec.severity,
      lane: spec.lane,
      category: spec.category,
      title: `${spec.title} (${p.target.ref})`,
      cwe: spec.cwe,
      owasp: spec.owasp,
      expected: p.expected,
      observed: p.observed,
      impact: spec.impact,
      location: ev ?? null,
      evidence: ev ? [ev] : [],
      trust: "controlled_reproduction",
      detector: { tool: "cybercheck runtime proof", version: p.type, rule: null },
      secret: null,
      confirmation: `Confirmed by a runtime proof (${p.id}): ${p.reason}`,
      obligationIds: p.obligationIds,
      executionIds: p.executionIds,
      remediation: spec.remediation,
      rootCause: `proof:${p.type}:${p.target.ref}`,
      proofIds: [p.id],
      basis: "runtime_confirmed",
    });
    p.obligationIds.forEach((id) => confirmedByProof.add(id));
  }

  // Recompute the obligations the proofs touched. A proof settles only the obligations it names.
  const byOb = new Map<string, SecurityProof[]>();
  for (const p of proofs) for (const id of p.obligationIds) byOb.set(id, [...(byOb.get(id) ?? []), p]);
  const obs = obligations.map((o) => {
    const mine = byOb.get(o.id);
    if (!mine?.length) return o;
    const execs = [...new Set(mine.flatMap((p) => p.executionIds))];
    if (mine.some((p) => p.verdict === "failed" && p.preconditions.every((c) => c.met))) {
      const fid = out.filter((f) => f.status === "confirmed" && f.obligationIds.includes(o.id)).map((f) => f.id);
      return { ...o, status: "failed" as const, reason: "A runtime proof reproduced the weakness.", findingIds: [...new Set([...o.findingIds, ...fid])], executionIds: execs };
    }
    if (mine.every((p) => p.verdict === "passed")) return { ...o, status: "passed" as const, reason: `A runtime proof held for this exact target (${mine.map((p) => p.id).join(", ")}).`, executionIds: execs };
    if (mine.some((p) => p.verdict === "blocked")) return { ...o, status: "inconclusive" as const, reason: mine.find((p) => p.verdict === "blocked")!.reason, executionIds: execs };
    return { ...o, status: "inconclusive" as const, reason: "A runtime proof ran but did not settle the question.", executionIds: execs };
  });

  return { findings: out, obligations: obs, rejected: [] };
}
