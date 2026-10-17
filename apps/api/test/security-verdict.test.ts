import { describe, expect, it } from "vitest";
import type { CompiledProof } from "../src/security/proofs/compiler.ts";
import { readProof, type ProofContext, type StepResult } from "../src/security/proofs/verdict.ts";

// Every proof class, with a vulnerable (failed) fixture and a fixed (passed) one, plus the cases that must stay
// inconclusive or blocked: a failed exploit attempt is never a silent pass.

const ctx: ProofContext = { executionIds: ["e1"], sensitiveFields: ["email", "passwordHash", "ssn"], redactExcerpt: (s) => s };
const step = (over: Partial<StepResult>): StepResult => ({ as: "anonymous", method: "GET", path: "/x", status: 200, text: "", location: null, headers: {}, ...over });
const proof = (type: CompiledProof["type"], over: Partial<CompiledProof> = {}): CompiledProof => ({ type, target: { kind: "endpoint", ref: "GET /x" }, obligationIds: ["o"], identities: [], payloadClass: "p", expected: "e", reset: "none_needed", steps: [], requests: 0, ...over });
const verdict = (type: CompiledProof["type"], steps: StepResult[], over: Partial<CompiledProof> = {}) => readProof(proof(type, over), steps, ctx, "P1").verdict;

describe("proof verdicts", () => {
  it("IDOR: failed when another identity's record is returned, passed when denied, inconclusive on an empty 2xx", () => {
    expect(verdict("authz_object", [step({ as: "customer", status: 200, text: '{"id":1}' }), step({ as: "customer-2", status: 200, text: '{"id":1,"email":"a@b.test","passwordHash":"x"}' })])).toBe("failed");
    expect(verdict("authz_object", [step({ as: "customer", status: 200 }), step({ as: "customer-2", status: 404, text: "not found" })])).toBe("passed");
    expect(verdict("authz_object", [step({ as: "customer", status: 200 }), step({ as: "customer-2", status: 200, text: "" })])).toBe("inconclusive");
    // No positive control: if the owner cannot read their own object (e.g. 404 from an id that never existed), a
    // denial to the other identity is meaningless -> inconclusive, never a pass.
    expect(verdict("authz_object", [step({ as: "customer", status: 404, text: "not found" }), step({ as: "customer-2", status: 404, text: "not found" })])).toBe("inconclusive");
  });

  it("function authorization needs a positive control: the admin must succeed first, then the lower role decides", () => {
    // admin 2xx (control) + lower 2xx -> failed; admin 2xx + lower 403 -> passed; admin not 2xx -> inconclusive.
    expect(verdict("authz_function", [step({ as: "admin", path: "/admin", status: 200, text: "[...]" }), step({ as: "customer", path: "/admin", status: 200, text: "[...]" })])).toBe("failed");
    expect(verdict("authz_function", [step({ as: "admin", path: "/admin", status: 200 }), step({ as: "customer", path: "/admin", status: 403 })])).toBe("passed");
    expect(verdict("authz_function", [step({ as: "admin", path: "/admin", status: 404 }), step({ as: "customer", path: "/admin", status: 404 })])).toBe("inconclusive");
  });

  it("mass assignment: failed only when the forbidden field is seen on read-back", () => {
    expect(verdict("authz_property", [step({ method: "PATCH", status: 200 }), step({ method: "GET", status: 200, text: '{"id":1,"role":"admin"}' })])).toBe("failed");
    expect(verdict("authz_property", [step({ method: "PATCH", status: 200 }), step({ method: "GET", status: 200, text: '{"id":1,"role":"member"}' })])).toBe("passed");
  });

  it("injection differential: failed only when the false clause matches the control and the true clause opens up", () => {
    // Real boolean SQLi: control (benign) and always-false both match nothing; always-true returns all rows.
    const control = step({ status: 200, text: "[]" });
    const falsy = step({ status: 200, text: "[]" });
    const truthy = step({ status: 200, text: '[{"id":1},{"id":2},{"id":3}]' });
    expect(verdict("input_differential", [control, truthy, falsy])).toBe("failed");
    // Not injectable: all three identical.
    expect(verdict("input_differential", [step({ text: "rows:3" }), step({ text: "rows:3" }), step({ text: "rows:3" })])).toBe("passed");
    // Output varies with the input itself (an AI reply, a per-request computation): control != false, so NOT injection.
    expect(verdict("input_differential", [step({ text: "answer about control" }), step({ text: "answer about true" }), step({ text: "answer about false" })])).toBe("passed");
  });

  it("redirect, error disclosure, headers and CORS read the live response", () => {
    expect(verdict("redirect_target", [step({ status: 302, location: "https://evil.test/" })])).toBe("failed");
    expect(verdict("redirect_target", [step({ status: 302, location: "/home" })])).toBe("passed");
    expect(verdict("error_disclosure", [step({ status: 500, text: "Error\n    at handler (/app/src/app.js:12:9)" })])).toBe("failed");
    expect(verdict("error_disclosure", [step({ status: 500, text: '{"error":"internal error"}' })])).toBe("passed");
    expect(verdict("response_headers", [step({ headers: {} })])).toBe("failed");
    expect(verdict("response_headers", [step({ headers: { "x-content-type-options": "nosniff", "x-frame-options": "DENY", "content-security-policy": "default-src 'self'" } })])).toBe("passed");
    expect(verdict("cors_response", [step({ headers: { "access-control-allow-origin": "*" } })])).toBe("failed");
    expect(verdict("cors_response", [step({ headers: { "access-control-allow-origin": "https://app.test" } })])).toBe("passed");
  });

  it("authentication: failed when anonymous gets a 2xx, passed when denied", () => {
    expect(verdict("authn_required", [step({ status: 200, text: "ok" })])).toBe("failed");
    expect(verdict("authn_required", [step({ status: 401 })])).toBe("passed");
  });

  it("throttling: passed when a 429 appears, failed when many attempts never throttle, blocked when too few", () => {
    const attempts = (n: number, withThrottle: boolean) => Array.from({ length: n }, (_, i) => step({ method: "POST", path: "/login", status: withThrottle && i === n - 1 ? 429 : 401 }));
    expect(verdict("login_throttling", attempts(10, true))).toBe("passed");
    expect(verdict("login_throttling", attempts(10, false))).toBe("failed");
    expect(verdict("login_throttling", attempts(3, false))).toBe("blocked");
  });

  it("path traversal, SSRF canary and XSS canary rest on evidence beyond a status code", () => {
    expect(readProof(proof("file_containment"), [step({ status: 200, text: "CC_TRAVERSAL_MARKER_7 contents" })], { ...ctx, traversalMarker: "CC_TRAVERSAL_MARKER_7" }, "P").verdict).toBe("failed");
    expect(readProof(proof("file_containment"), [step({ status: 200, text: "a normal file" })], { ...ctx, traversalMarker: "CC_TRAVERSAL_MARKER_7" }, "P").verdict).toBe("passed");
    expect(readProof(proof("outbound_request_canary"), [step({ status: 200 })], { ...ctx, canaryHit: true }, "P").verdict).toBe("failed");
    expect(readProof(proof("outbound_request_canary"), [step({ status: 200 })], { ...ctx, canaryHit: false }, "P").verdict).toBe("passed");
    expect(readProof(proof("outbound_request_canary"), [step({ status: 200 })], ctx, "P").verdict).toBe("inconclusive");
    expect(readProof(proof("browser_script_canary"), [], { ...ctx, browserMarkerSet: true }, "P").verdict).toBe("failed");
    expect(readProof(proof("browser_script_canary"), [], { ...ctx, browserMarkerSet: false }, "P").verdict).toBe("passed");
    expect(readProof(proof("browser_script_canary"), [], ctx, "P").verdict).toBe("inconclusive");
  });

  it("forged credential: failed when a tampered token is accepted, passed when rejected", () => {
    expect(verdict("authn_invalid_credential", [step({ as: "customer#forged", status: 200, text: "{}" })])).toBe("failed");
    expect(verdict("authn_invalid_credential", [step({ as: "customer#forged", status: 401 })])).toBe("passed");
    expect(verdict("authn_invalid_credential", [step({ as: "customer#forged", status: null, error: "x" })])).toBe("inconclusive");
  });

  it("csrf, webhook and upload read the live response", () => {
    expect(verdict("csrf_origin", [step({ method: "POST", status: 200 })])).toBe("failed");
    expect(verdict("csrf_origin", [step({ method: "POST", status: 403 })])).toBe("passed");
    expect(verdict("webhook_signature", [step({ method: "POST", status: 200 })])).toBe("failed");
    expect(verdict("webhook_signature", [step({ method: "POST", status: 401 })])).toBe("passed");
    expect(verdict("upload_handling", [step({ status: 200, headers: { "content-type": "text/html" } })])).toBe("failed");
    expect(verdict("upload_handling", [step({ status: 200, headers: { "content-type": "application/octet-stream" } })])).toBe("passed");
  });

  it("account enumeration: failed when the two sign-in attempts differ, passed when identical, blocked with one step", () => {
    const unknown = step({ method: "POST", path: "/api/login", status: 404, text: '{"error":"account does not exist"}' });
    const wrongPass = step({ method: "POST", path: "/api/login", status: 401, text: '{"error":"password is incorrect"}' });
    expect(verdict("account_enumeration", [unknown, wrongPass])).toBe("failed");
    const same = step({ method: "POST", path: "/api/login", status: 401, text: '{"error":"sign in failed"}' });
    expect(verdict("account_enumeration", [same, { ...same }])).toBe("passed");
    // Only one request reached the oracle (e.g. the second was never sent): never a silent pass.
    expect(verdict("account_enumeration", [unknown])).toBe("blocked");
  });

  it("never passes when the app did not answer, and marks the oracle unmet when blocked", () => {
    expect(verdict("authz_object", [step({ as: "customer", status: 200 }), step({ as: "customer-2", status: null, error: "ECONNREFUSED" })])).toBe("inconclusive");
    const blocked = readProof(proof("authz_object"), [step({ as: "customer-2", status: null, error: "ECONNREFUSED" })], ctx, "P1");
    expect(blocked.preconditions.find((p) => p.what.includes("oracle"))!.met).toBe(false);
  });
});
