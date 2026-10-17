import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { ProjectDossier } from "@cybercheck/contracts";
import { buildCatalog, type Identity } from "../src/security/proofs/catalog.ts";
import { compilePlan } from "../src/security/proofs/compiler.ts";
import { analyzeSource } from "../src/understanding/analyze.ts";
import { sourceFromFiles } from "../src/understanding/source.ts";

// The catalogue builds runtime proofs for the Gauntlet's own endpoints, as its seeded identities, and every proof it
// produces passes the safety compiler.

const dir = join(import.meta.dirname, "testing-bench/cybercheck-gauntlet/project");
const files: Record<string, string> = {};
const walk = (d: string) => {
  for (const n of readdirSync(d)) {
    if (n === "node_modules") continue;
    const f = join(d, n);
    if (statSync(f).isDirectory()) walk(f);
    else files[relative(dir, f).split("\\").join("/")] = readFileSync(f, "utf8");
  }
};
walk(dir);

let d: ProjectDossier;
const identities: Identity[] = [
  { name: "customer", role: "customer", idSymbol: "customer__id" },
  { name: "customer-2", role: "customer", idSymbol: "customer-2__id" },
  { name: "admin", role: "admin", idSymbol: "admin__id" },
];

beforeAll(async () => {
  d = await analyzeSource(sourceFromFiles(files), { snapshotId: "snap-1", contentDigest: "digest-1" });
}, 60_000);

describe("proof catalogue on the Gauntlet", () => {
  it("builds the proofs for the mandatory authorization and authentication defects", () => {
    const proofs = buildCatalog({ dossier: d, identities, sensitiveFields: ["email", "password", "passwordHash"] }).proofs;
    const types = new Map<string, Set<string>>();
    for (const p of proofs) types.set(p.type, (types.get(p.type) ?? new Set()).add(p.target.ref));
    // IDOR on GET /api/users/:id, admin authorization on /api/admin/users, mass assignment on PATCH /api/users/:id.
    expect([...(types.get("authz_object") ?? [])]).toContain("GET /api/users/:id");
    expect([...(types.get("authz_function") ?? [])]).toContain("GET /api/admin/users");
    expect([...(types.get("authz_property") ?? [])]).toContain("PATCH /api/users/:id");
    expect([...(types.get("authn_required") ?? [])]).toContain("GET /api/users/:id");
    expect(types.has("login_throttling")).toBe(true);
    expect(types.has("cors_response")).toBe(true);
  });

  it("acts only as seeded identities and the IDOR proof reads one customer's id as the other customer", () => {
    const proofs = buildCatalog({ dossier: d, identities, sensitiveFields: ["email"] }).proofs;
    const idor = proofs.find((p) => p.type === "authz_object" && p.target.ref === "GET /api/users/:id")!;
    expect(idor.identities).toEqual(["customer", "customer-2"]);
    expect(idor.steps[1]!.as).toBe("customer-2");
    expect(idor.steps[1]!.path).toContain("{{customer__id}}");
  });

  it("produces nothing the safety compiler rejects", () => {
    const proofs = buildCatalog({ dossier: d, identities, sensitiveFields: ["email"] }).proofs;
    const { proofs: ok, rejected } = compilePlan(proofs, d, identities.map((i) => i.name));
    expect(rejected).toEqual([]);
    expect(ok.length).toBe(proofs.length);
  });

  it("does not probe a public-by-design route for authentication", () => {
    const proofs = buildCatalog({ dossier: d, identities, sensitiveFields: ["email"] }).proofs;
    expect(proofs.some((p) => p.type === "authn_required" && /\/api\/login|\/health/.test(p.target.ref))).toBe(false);
  });

  it("turns suspected code patterns into runtime proofs the compiler accepts", () => {
    const hypotheses = [
      { category: "sql-injection", endpointRef: "GET /api/data/customers" },
      { category: "path-traversal", endpointRef: "GET /api/files" },
      { category: "ssrf", endpointRef: "POST /api/integrations/preview" },
      { category: "open-redirect", endpointRef: "GET /api/redirect" },
      { category: "xss", endpointRef: "GET /api/search" },
    ];
    const proofs = buildCatalog({ dossier: d, identities, sensitiveFields: ["email"], hypotheses, canaryBase: "http://127.0.0.1:8099" }).proofs;
    const byType = new Map(proofs.map((p) => [p.type, p]));
    expect(byType.get("input_differential")?.target.ref).toBe("GET /api/data/customers");
    expect(byType.get("input_differential")?.steps).toHaveLength(3);
    expect(byType.get("file_containment")?.target.ref).toBe("GET /api/files");
    expect(byType.get("outbound_request_canary")?.canary?.url).toMatch(/^http:\/\/127\.0\.0\.1:8099\/c\//);
    expect(byType.get("browser_script_canary")?.browser?.marker).toBe("cc-xss-7f3a9");
    const { rejected } = compilePlan(proofs, d, identities.map((i) => i.name));
    expect(rejected).toEqual([]);
  });
});
