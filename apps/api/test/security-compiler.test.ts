import { describe, expect, it } from "vitest";
import type { ProjectDossier } from "@cybercheck/contracts";
import { compilePlan, PROOF_LIMITS, validateProof, type ProofRequest } from "../src/security/proofs/compiler.ts";
import { endpointKeys } from "../src/testing/scenarios.ts";

// The Security proof compiler is the safety gate: only catalogued probes against the project's own endpoints, as
// synthetic identities, bounded, loopback-only and non-destructive, are admitted. Everything else is rejected.

const endpoint = (method: string, path: string) => ({ id: `${method} ${path}`, kind: "http" as const, method, path, framework: "express", handler: { path: "src/app.js", line: 1 }, control: { kind: "session_required" as const, via: ["requireUser"], evidence: [] }, mutates: method !== "GET" });
const d = { entryPoints: [endpoint("GET", "/api/users/:id"), endpoint("PATCH", "/api/users/:id"), endpoint("POST", "/api/login"), endpoint("POST", "/api/integrations/preview")] } as unknown as Pick<ProjectDossier, "entryPoints">;
const identities = ["customer", "customer-2", "admin"];
const ctx = { endpoints: endpointKeys(d), identities: new Set(identities) };

const base = (over: Partial<ProofRequest> = {}): ProofRequest => ({
  type: "authz_object",
  target: { kind: "endpoint", ref: "GET /api/users/:id" },
  obligationIds: ["sec:endpoint:GET /api/users/:id:object-authorization"],
  identities: ["customer", "customer-2"],
  payloadClass: "another identity's object id",
  expected: "403 or 404 for the other customer's record",
  reset: "none_needed",
  steps: [{ as: "customer-2", method: "GET", path: "/api/users/7", expect: { statusClass: ["4xx"] } }],
  ...over,
});

describe("proof compiler safety", () => {
  it("accepts a catalogue probe against a known endpoint, as a synthetic identity, within budget", () => {
    expect(validateProof(base(), ctx)).toEqual([]);
    const { proofs, rejected } = compilePlan([base()], d, identities);
    expect(rejected).toEqual([]);
    expect(proofs[0]).toMatchObject({ requests: 1 });
  });

  it("allows an anonymous request but rejects an unknown identity", () => {
    expect(validateProof(base({ steps: [{ as: "anonymous", method: "GET", path: "/api/users/7" }] }), ctx)).toEqual([]);
    expect(validateProof(base({ identities: ["intruder"], steps: [{ as: "intruder", method: "GET", path: "/api/users/7" }] }), ctx).join(" ")).toMatch(/not a synthetic identity/);
  });

  it("rejects an unknown endpoint and a non-relative path", () => {
    expect(validateProof(base({ steps: [{ as: "customer", method: "GET", path: "/api/secrets" }] }), ctx).join(" ")).toMatch(/not an endpoint/);
    expect(validateProof(base({ steps: [{ as: "customer", method: "GET", path: "http://evil.test/x" }] }), ctx).join(" ")).toMatch(/must be a relative path/);
  });

  it("rejects a payload that reaches an external host, and allows a sandbox-local canary URL", () => {
    expect(validateProof(base({ type: "outbound_request_canary", target: { kind: "endpoint", ref: "POST /api/integrations/preview" }, steps: [{ as: "customer", method: "POST", path: "/api/integrations/preview", json: { url: "http://169.254.169.254/latest" } }] }), ctx).join(" ")).toMatch(/outside the sandbox/);
    expect(validateProof(base({ type: "outbound_request_canary", target: { kind: "endpoint", ref: "POST /api/integrations/preview" }, canary: { url: "http://127.0.0.1:8099/c/abc", token: "abc" }, steps: [{ as: "customer", method: "POST", path: "/api/integrations/preview", json: { url: "http://127.0.0.1:8099/c/abc" } }] }), ctx)).toEqual([]);
  });

  it("rejects destructive, shell and persistence payloads", () => {
    expect(validateProof(base({ type: "input_differential", steps: [{ as: "customer", method: "GET", path: "/api/users/1", json: { q: "'; DROP TABLE users; --" } }] }), ctx).join(" ")).toMatch(/destructive/);
    expect(validateProof(base({ type: "input_differential", steps: [{ as: "customer", method: "GET", path: "/api/users/1", json: { name: "$(rm -rf /)" } }] }), ctx).join(" ")).toMatch(/shell command/);
    expect(validateProof(base({ type: "authz_property", reset: "rollback", steps: [{ as: "customer", method: "PATCH", path: "/api/users/1", json: { bashrc: "echo x >> ~/.bashrc" } }] }), ctx).join(" ")).toMatch(/persist/);
  });

  it("enforces the per-target, login-attempt and per-run request budgets", () => {
    const many = (n: number) => Array.from({ length: n }, () => ({ as: "anonymous", method: "POST", path: "/api/login", loginAttempt: true, json: { email: "a@b.test", password: "x" } }));
    expect(validateProof(base({ type: "login_throttling", target: { kind: "endpoint", ref: "POST /api/login" }, reset: "none_needed", steps: many(25) }), ctx).join(" ")).toMatch(/login attempts exceed|exceed the 22/);
    // Per-run budget: many small proofs until the 300-request budget runs out.
    const one = base();
    const { proofs, rejected } = compilePlan(Array.from({ length: PROOF_LIMITS.maxRequestsPerRun + 5 }, () => one), d, identities);
    expect(proofs).toHaveLength(PROOF_LIMITS.maxRequestsPerRun);
    expect(rejected[0]!.reasons.join(" ")).toMatch(/budget is used up/);
  });

  it("requires a reset strategy for a state-changing proof", () => {
    expect(validateProof(base({ type: "authz_property", target: { kind: "endpoint", ref: "PATCH /api/users/:id" }, reset: "none_needed", steps: [{ as: "customer", method: "PATCH", path: "/api/users/1", json: { role: "admin" } }] }), ctx).join(" ")).toMatch(/needs a reset strategy/);
    expect(validateProof(base({ type: "authz_property", target: { kind: "endpoint", ref: "PATCH /api/users/:id" }, reset: "rollback", steps: [{ as: "customer", method: "PATCH", path: "/api/users/1", json: { role: "admin" } }] }), ctx)).toEqual([]);
  });
});
