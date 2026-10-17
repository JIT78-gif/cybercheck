import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { ProjectDossier, SecurityObligation } from "@cybercheck/contracts";
import { compileObligations, SAST_CATEGORIES } from "../src/security/obligations.ts";
import { readinessGate } from "../src/security/readiness.ts";
import { analyzeSource } from "../src/understanding/analyze.ts";
import { sourceFromFiles, type SnapshotSource } from "../src/understanding/source.ts";

// The obligation compiler (Security Round 1, step 3): fixed requirements built by code from the checked facts.

const dir = join(import.meta.dirname, "testing-bench/cybercheck-gauntlet/project");
const files: Record<string, string> = {};
const walk = (d: string) => {
  for (const n of readdirSync(d)) {
    const f = join(d, n);
    if (n === "node_modules") continue;
    if (statSync(f).isDirectory()) walk(f);
    else files[relative(dir, f).replace(/\\/g, "/")] = readFileSync(f, "utf8");
  }
};
walk(dir);

let src: SnapshotSource;
let dossier: ProjectDossier;
const compile = (d: ProjectDossier, s: SnapshotSource = src) => {
  const g = readinessGate({ raw: d, src: s, snapshotId: "snap-1", contentDigest: "digest-1", engine: "test" });
  return compileObligations({ dossier: g.dossier!, facts: g.facts, readiness: g.readiness, src: s });
};
const ob = (list: SecurityObligation[], id: string) => list.find((o) => o.id === id)!;
/** The Gauntlet's analysis with its authentication contradiction resolved (a mechanism recorded, the negative claim gone). */
const consistent = () => {
  const d = structuredClone(dossier);
  d.securityModel.authMechanisms = [{ kind: "jwt", detail: "Bearer token checked by requireUser", library: null, evidence: [{ path: "src/auth.js", line: 1 }] }];
  d.securityModel.notDetected = d.securityModel.notDetected.filter((n) => n.control !== "Authentication");
  return d;
};
/** A dossier with the authentication contradiction forced on: no mechanism recorded, the negative claim present. */
const contradicted = () => {
  const d = structuredClone(dossier);
  d.securityModel.authMechanisms = [];
  if (!d.securityModel.notDetected.some((n) => n.control === "Authentication")) d.securityModel.notDetected.push({ control: "Authentication", scope: "No authentication library, session use, token check or guard was found in the code." });
  return d;
};

beforeAll(async () => {
  src = sourceFromFiles(files);
  dossier = await analyzeSource(src, { snapshotId: "snap-1", contentDigest: "digest-1" });
}, 60_000);

describe("security obligations", () => {
  it("never plans a check against a public-by-design route for being public", () => {
    const list = compile(dossier);
    for (const id of ["sec:endpoint:POST /api/login:authentication", "sec:endpoint:GET /health:authentication"]) expect(ob(list, id)).toMatchObject({ status: "not_applicable", reason: expect.stringMatching(/^Public by design/) });
    expect(list.some((o) => o.id.startsWith("sec:endpoint:GET /health:object-authorization"))).toBe(false);
  });

  it("makes only the checks that rely on the contradicted auth facts inconclusive; scanners still run", () => {
    const list = compile(contradicted());
    expect(ob(list, "sec:endpoint:GET /api/users/:id:object-authorization")).toMatchObject({ status: "inconclusive", reason: expect.stringMatching(/contradicts itself \(guards-without-mechanism, auth-negative-contradiction\).*access control facts/) });
    expect(ob(list, "sec:endpoint:GET /api/admin/users:function-authorization").status).toBe("inconclusive");
    // Code scanning reads the snapshot itself: the forged-token and mass-assignment rules run regardless.
    for (const id of ["sec:sast:token-integrity", "sec:sast:mass-assignment", "sec:sast:sql-injection", "sec:secrets:repository", "sec:deps:package.json"]) expect(ob(list, id).status).toBe("planned");
    // An input check does not depend on whether the analysis got authentication right.
    expect(ob(list, "sec:endpoint:GET /api/search:input-handling")).toMatchObject({ status: "unsupported", reason: expect.stringMatching(/arrives in Round 2/) });
  });

  it("plans runtime proofs as unsupported until Round 2 when the analysis is consistent, so they stay in the denominator", () => {
    const list = compile(consistent());
    expect(list.filter((o) => o.status === "inconclusive")).toEqual([]);
    for (const id of ["sec:endpoint:GET /api/users/:id:authentication", "sec:endpoint:GET /api/users/:id:object-authorization", "sec:endpoint:PATCH /api/users/:id:property-authorization", "sec:endpoint:GET /api/admin/users:function-authorization"]) {
      expect(ob(list, id)).toMatchObject({ status: "unsupported", proofStrategy: "runtime_proof" });
    }
  });

  it("makes a check inconclusive when the one fact it depends on is undetermined", () => {
    const d = consistent();
    const r = d.entryPoints.find((e) => e.path === "/api/orders" && e.method === "GET")!;
    r.control = { kind: "unknown", reason: "a custom decorator could not be resolved", via: [], evidence: [] };
    expect(ob(compile(d), "sec:endpoint:GET /api/orders:authentication")).toMatchObject({ status: "inconclusive", reason: expect.stringMatching(/depends on endpoint:GET \/api\/orders, which is contradicted \(control-undetermined\)/) });
  });

  it("checks password storage only where the app stores or checks passwords itself", () => {
    // The Gauntlet compares the password with ===: the obligation applies.
    expect(ob(compile(dossier), "sec:crypto:password-storage")).toMatchObject({ status: "planned", applicabilityEvidence: expect.arrayContaining([expect.objectContaining({ path: "src/app.js" })]) });
    // Sign-in delegated elsewhere: "password hashing not detected" alone is not a reason to check (or report) anything.
    const d = consistent();
    d.securityModel.credentialChecks = [];
    d.dataModel.entities = d.dataModel.entities.map((e) => ({ ...e, fields: e.fields.filter((f) => !/pass|hash/i.test(f.name)) }));
    expect(ob(compile(d), "sec:crypto:password-storage")).toMatchObject({ status: "not_applicable", reason: expect.stringMatching(/does not store or check user passwords/) });
  });

  it("applies CSRF and cookie checks only to cookie sessions", () => {
    expect(ob(compile(dossier), "sec:config:csrf")).toMatchObject({ status: "not_applicable", reason: expect.stringMatching(/bearer tokens/) });
    const d = consistent();
    d.runtime.session = { library: "express-session", storage: "server", cookie: { httpOnly: "true" }, keys: ["userId"], evidence: [{ path: "src/app.js", line: 1 }] };
    const list = compile(d);
    expect(ob(list, "sec:config:csrf").status).toBe("planned");
    expect(ob(list, "sec:config:session-cookie").status).toBe("planned");
  });

  it("adds secret-file, browser-secret, lockfile, container and CI obligations from what the project has", async () => {
    const extra = {
      ...files,
      "web/package.json": JSON.stringify({ name: "web", dependencies: { react: "^18.0.0" } }),
      "web/src/api.js": "export const key = import.meta.env.VITE_STRIPE_SECRET_KEY;\n",
      Dockerfile: "FROM node:22\nCOPY . .\nCMD [\"node\", \"src/server.js\"]\n",
      ".github/workflows/ci.yml": "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm test\n",
    };
    const s = sourceFromFiles(extra, { ".env.production": "secret" });
    const d = await analyzeSource(s, { snapshotId: "snap-1", contentDigest: "digest-1" });
    const list = compile(d, s);
    expect(ob(list, "sec:secrets:file:.env.production")).toMatchObject({ status: "planned", priority: "critical", proofStrategy: "fact_rule" });
    expect(list.find((o) => o.id.startsWith("sec:secrets:browser:"))).toMatchObject({ asset: { label: "VITE_STRIPE_SECRET_KEY" }, status: "planned" });
    expect(ob(list, "sec:deps:web/package.json:lockfile")).toMatchObject({ status: "planned", proofStrategy: "fact_rule" });
    expect(list.some((o) => o.id === "sec:deps:package.json:lockfile")).toBe(false);
    expect(ob(list, "sec:iac:dockerfile:Dockerfile")).toMatchObject({ status: "planned", proofStrategy: "iac_scan" });
    expect(ob(list, "sec:ci:.github/workflows/ci.yml")).toMatchObject({ status: "planned", proofStrategy: "iac_scan" });
  });

  it("does not plan code scanning for a snapshot without supported code", async () => {
    const s = sourceFromFiles({ "main.go": "package main\nfunc main() {}\n", "go.mod": "module x\n" });
    const d = await analyzeSource(s, { snapshotId: "snap-1", contentDigest: "digest-1" });
    const list = compile(d, s);
    for (const c of SAST_CATEGORIES) expect(ob(list, `sec:sast:${c.key}`)).toMatchObject({ status: "not_applicable", reason: expect.stringMatching(/No JavaScript, TypeScript or Python code/) });
  });

  it("is deterministic, puts critical obligations first, and cites standards on every one", () => {
    const a = compile(dossier);
    expect(JSON.stringify(compile(dossier))).toBe(JSON.stringify(a));
    const rank = { critical: 0, high: 1, medium: 2, low: 3 };
    expect(a.map((o) => rank[o.priority])).toEqual([...a.map((o) => rank[o.priority])].sort((x, y) => x - y));
    for (const o of a) {
      expect(o.standards.some((s) => s.startsWith("CWE-")), o.id).toBe(true);
      expect(o.standards.some((s) => s.startsWith("ASVS-5.0:")), o.id).toBe(true);
    }
    expect(new Set(a.map((o) => o.id)).size).toBe(a.length);
  });
});
