import { createHash } from "node:crypto";
import { ProjectDossier, SecurityLane, type AnalyzeReadiness, type ControlKind, type Evidence, type FactState, type SecurityFact } from "@cybercheck/contracts";
import { checkConsistency } from "../understanding/consistency.ts";
import type { SnapshotSource } from "../understanding/source.ts";

// Phase Zero of the Security check: Analyze's output is never accepted as automatically correct. The dossier is parsed
// again, its consistency is recomputed against the snapshot, every piece of evidence is checked against the snapshot's
// own files, and contradicted conclusions are rejected as authoritative while their evidence is kept. Facts come from
// code and configuration only: documentation, comments, diagrams and the AI summary never set Security policy.

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ALL_LANES = SecurityLane.options;

/** Documentation never counts as evidence for a Security fact (a README can say anything, including instructions). */
const DOC_FILE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
const isDoc = (path: string) => DOC_FILE.test(path) || /(^|\/)(readme|changelog|license|contributing)(\.|$)/i.test(path);

/**
 * Code Security does not analyse deeply in Round 1 (JavaScript, TypeScript and Python are supported), counted from the
 * snapshot's own files: the analyzer may not list a language at all, and silence must not look like coverage.
 */
const UNSUPPORTED_CODE: Record<string, string> = { go: "Go", rs: "Rust", java: "Java", kt: "Kotlin", kts: "Kotlin", scala: "Scala", cs: "C#", fs: "F#", vb: "Visual Basic", rb: "Ruby", php: "PHP", swift: "Swift", m: "Objective-C", mm: "Objective-C", c: "C", h: "C", cc: "C++", cpp: "C++", hpp: "C++", dart: "Dart", sol: "Solidity", ex: "Elixir", exs: "Elixir", erl: "Erlang", hs: "Haskell", lua: "Lua", pl: "Perl", r: "R", jl: "Julia", zig: "Zig", clj: "Clojure", groovy: "Groovy" };
const unsupportedLanguages = (paths: string[]) => {
  const n = new Map<string, number>();
  for (const p of paths) {
    if (p.includes("node_modules/")) continue;
    const lang = UNSUPPORTED_CODE[p.split(".").pop()!.toLowerCase()];
    if (lang && p.includes(".")) n.set(lang, (n.get(lang) ?? 0) + 1);
  }
  return [...n].map(([name, files]) => ({ name, files })).sort((a, b) => b.files - a.files);
};

/**
 * Which Security lanes each consistency rule makes untrustworthy. Rules about human-facing summaries block nothing:
 * Security reads the records, never the summary text. Evidence that points nowhere is dropped fact by fact.
 */
export const RULE_BLOCKS: Record<string, SecurityLane[]> = {
  "schema-files-without-tables": ["privacy", "crypto"],
  "guards-without-mechanism": ["auth", "access_control"],
  "auth-negative-contradiction": ["auth", "access_control"],
  "control-without-reason": ["auth", "access_control"],
  "duplicate-ids": ["auth", "access_control"],
  "non-authorization-role": ["access_control"],
  "finding-on-public-route": [],
  "integration-summary-mismatch": [],
  "api-summary-mismatch": [],
  "coverage-does-not-reconcile": [],
  "evidence-out-of-range": [],
};

/** The plan's public-endpoint classes, from the analyzer's control kinds. */
export const CONTROL_CLASS: Record<ControlKind, string> = {
  public_intentional: "PUBLIC_INTENTIONAL",
  session_required: "SESSION_REQUIRED",
  role_required: "ROLE_REQUIRED",
  service_token: "SERVICE_TOKEN_REQUIRED",
  webhook_signature: "WEBHOOK_SIGNATURE_REQUIRED",
  callback_state: "CALLBACK_STATE_REQUIRED",
  handler_check: "HANDLER_LEVEL_CHECK",
  none_found: "NO_CONTROL_FOUND",
  unknown: "UNKNOWN",
};

export type EvidenceRecord = {
  id: string;
  snapshotId: string;
  path: string;
  line: number;
  endLine?: number;
  detector: string;
  /** sha256 of the cited line as stored in the snapshot: the text itself is not copied (it may hold a secret). */
  lineSha256: string;
  sanitization: "hash_only";
  claims: string[];
};

export type AnalysisManifest = {
  schemaVersion: 1;
  analyzerVersion: string | null;
  securityEngine: string;
  snapshotId: string;
  contentDigest: string;
  files: { stored: number; listed: number; skipped: Array<{ path: string; reason: string }>; excluded: Array<{ path: string; reason: string }> };
  coverage: { filesTotal: number; filesParsed: number; categories: Array<{ id: string; count: number }> } | null;
  unsupportedLanguages: Array<{ name: string; files: number }>;
  evidence: { cited: number; verified: number; dropped: number; documentationOnly: number };
  readiness: { level: AnalyzeReadiness["level"]; issues: number };
  artifacts: Record<string, string>;
};

export type ReadinessResult = {
  readiness: AnalyzeReadiness;
  dossier: ProjectDossier | null;
  facts: SecurityFact[];
  evidence: EvidenceRecord[];
  manifest: AnalysisManifest;
  /** The four artifacts, as stored: project-facts.json, evidence.ndjson, project-analysis.md, analysis-manifest.json. */
  artifacts: Record<"project-facts.json" | "evidence.ndjson" | "project-analysis.md" | "analysis-manifest.json", string>;
};

/** Whether an evidence record belongs to this snapshot and still matches its file: anything else is refused. */
export function evidenceBelongs(rec: Pick<EvidenceRecord, "snapshotId" | "path" | "line" | "lineSha256">, snapshotId: string, src: SnapshotSource): boolean {
  if (rec.snapshotId !== snapshotId) return false;
  const f = src.files.get(rec.path);
  if (!f || rec.line < 1 || rec.line > f.lines) return false;
  return sha(f.text.split("\n")[rec.line - 1] ?? "") === rec.lineSha256;
}

export function readinessGate(input: { raw: unknown; src: SnapshotSource; snapshotId: string; contentDigest: string; engine: string }): ReadinessResult {
  const { src, snapshotId, contentDigest, engine } = input;
  const issues: AnalyzeReadiness["issues"] = [];
  const parsed = ProjectDossier.safeParse(input.raw);
  const d = parsed.success ? parsed.data : null;

  // ---------------- blocking problems: an unusable dossier or one that belongs to other content
  if (!parsed.success) issues.push({ rule: "dossier-schema", severity: "error", message: `The analysis does not match its schema (${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "dossier"}: ${i.message}`).join("; ")}).`, evidence: [], blocks: [...ALL_LANES] });
  else if (d!.meta.contentDigest !== contentDigest) issues.push({ rule: "dossier-other-content", severity: "error", message: "The analysis describes different content than this snapshot.", evidence: [], blocks: [...ALL_LANES] });

  // ---------------- evidence: every citation is checked against this snapshot's files
  const records = new Map<string, EvidenceRecord>();
  const tally = { cited: 0, verified: 0, dropped: 0, documentationOnly: 0 };
  const verify = (list: Evidence[], detector: string, claim: string): Evidence[] => {
    const out: Evidence[] = [];
    for (const e of list) {
      tally.cited++;
      const f = src.files.get(e.path);
      if (!f || e.line < 1 || e.line > f.lines) {
        tally.dropped++;
        continue;
      }
      if (isDoc(e.path)) {
        tally.documentationOnly++;
        continue;
      }
      tally.verified++;
      out.push(e);
      const id = `ev:${sha(`${e.path}:${e.line}`).slice(0, 12)}`;
      const rec = records.get(id) ?? { id, snapshotId, path: e.path, line: e.line, ...(e.endLine ? { endLine: e.endLine } : {}), detector, lineSha256: sha(f.text.split("\n")[e.line - 1] ?? ""), sanitization: "hash_only" as const, claims: [] };
      if (!rec.claims.includes(claim)) rec.claims.push(claim);
      records.set(id, rec);
    }
    return out;
  };

  const facts: SecurityFact[] = [];
  if (d && !issues.length) {
    // ---------------- consistency, recomputed against the snapshot (the stored copy is not trusted)
    for (const c of checkConsistency(d, src)) issues.push({ ...c, blocks: c.severity === "error" ? (RULE_BLOCKS[c.rule] ?? [...ALL_LANES]) : [] });

    const version = d.meta.analyzerVersion;
    const det = (part: string) => `analyze:${part}@${version}`;
    const sm = d.securityModel;
    const routes = d.entryPoints.filter((e) => e.kind !== "page");
    const ruleSet = new Set(issues.map((i) => i.rule));
    const authContradicted = ruleSet.has("auth-negative-contradiction") || ruleSet.has("guards-without-mechanism");
    const fact = (f: Omit<SecurityFact, "snapshotId" | "tabs" | "evidence"> & { tabs?: SecurityFact["tabs"] }, cites: Evidence[]) => {
      const evidence = verify(cites, f.detector, f.id);
      // A positive claim whose citations are all gone or are documentation can no longer be called observed.
      const state: FactState = f.state === "observed" && cites.length && !evidence.length ? "unresolved" : f.state;
      const limitations = state !== f.state ? [...f.limitations, "Its evidence could not be verified in this snapshot (missing, out of range, or documentation only)."] : f.limitations;
      facts.push({ ...f, snapshotId, state, evidence, limitations, tabs: f.tabs ?? ["security"] });
    };

    // ---------------- the authentication model, recomputed from guards and handler checks
    const protectedRoutes = routes.filter((r) => ["session_required", "role_required", "service_token", "webhook_signature", "callback_state", "handler_check"].includes(r.control.kind));
    const via = [...new Set(protectedRoutes.flatMap((r) => r.control.via))].slice(0, 6);
    fact(
      authContradicted
        ? { id: "auth:model", state: "unresolved", statement: `The analysis both reports ${protectedRoutes.length} protected endpoint(s)${via.length ? ` (by ${via.join(", ")})` : ""} and ${sm.authMechanisms.length ? "an authentication mechanism" : "no authentication mechanism"}; neither conclusion is used until a runtime check settles it.`, detector: det("security-model"), confidence: "low", limitations: ["Recomputed from guards and handler checks because the analysis contradicts itself."], contradictions: [...ruleSet].filter((r) => r === "auth-negative-contradiction" || r === "guards-without-mechanism") }
        : protectedRoutes.length
          ? { id: "auth:model", state: sm.authMechanisms.length ? "observed" : "inferred", statement: `${protectedRoutes.length} of ${routes.length} endpoint(s) are protected${via.length ? ` by ${via.join(", ")}` : ""}${sm.authMechanisms.length ? `; mechanisms: ${sm.authMechanisms.map((m) => m.kind).join(", ")}` : ""}.`, detector: det("routes"), confidence: sm.authMechanisms.length ? "high" : "medium", limitations: [], contradictions: [] }
          : { id: "auth:model", state: "not_observed", statement: "No endpoint protection was found in the scanned code.", detector: det("routes"), confidence: "medium", limitations: [sm.notDetected.find((n) => /auth/i.test(n.control))?.scope ?? "Absence in the scanned code only: authentication outside it (a gateway, a proxy) is not seen."], contradictions: [] },
      [...sm.guards.flatMap((g) => g.evidence), ...sm.authMechanisms.flatMap((m) => m.evidence)],
    );

    // ---------------- endpoints, each with its control class
    for (const r of routes) {
      const kind = r.control.kind;
      const contradictions = [...(authContradicted && ["session_required", "role_required"].includes(kind) ? ["auth:model"] : []), ...(kind === "unknown" ? ["control-undetermined"] : [])];
      fact(
        {
          id: r.id,
          state: r.status,
          statement: `${r.method} ${r.path}: ${CONTROL_CLASS[kind]}${r.control.reason ? ` (${r.control.reason})` : ""}.`,
          detector: det("routes"),
          confidence: kind === "unknown" || contradictions.length ? "low" : kind === "none_found" ? "medium" : r.control.evidence.length ? "high" : "medium",
          limitations: kind === "none_found" ? ["No guard was found in the scanned code; only a runtime check shows whether the route is really open."] : [],
          contradictions,
          tabs: ["security", "testing"],
        },
        [r.handler, ...r.control.evidence],
      );
    }

    // ---------------- mechanisms, credential checks and roles (application roles are not LLM roles)
    sm.authMechanisms.forEach((m, i) => fact({ id: `auth:mechanism:${m.kind}:${i + 1}`, state: "observed", statement: m.detail, detector: det("security-model"), confidence: "high", limitations: [], contradictions: [] }, m.evidence));
    sm.credentialChecks.forEach((c, i) => fact({ id: `auth:credential:${c.kind}:${i + 1}`, state: "observed", statement: c.detail, detector: det("security-model"), confidence: "high", limitations: [], contradictions: [] }, c.evidence));
    for (const role of sm.roles) {
      fact(
        { id: `role:${role.kind}:${role.name}`, state: "observed", statement: `${role.name} is ${role.kind === "app_role" ? "an application role" : role.kind === "llm_role" ? "an LLM message role, not a user permission" : role.kind === "message_direction" ? "a message direction, not a user permission" : "a status value, not a user permission"} (${role.values.slice(0, 8).join(", ")}).`, detector: det("security-model"), confidence: "high", limitations: [], contradictions: ruleSet.has("non-authorization-role") && role.kind !== "app_role" ? ["non-authorization-role"] : [], tabs: role.kind === "llm_role" ? ["security", "ai-evaluator"] : ["security"] },
        [role.evidence],
      );
    }
    // Library-level controls: present as a dependency only, so inferred; absent ones carry the scope of the search.
    for (const [key, libs, label] of [["rate_limiting", sm.rateLimiting, "Rate limiting"], ["security_headers", sm.securityHeaders, "Security headers"], ["csrf", sm.csrf, "CSRF protection"], ["password_hashing", sm.passwordHashing, "Password hashing"], ["validation", sm.validationLibraries, "Input validation"]] as const) {
      const absent = sm.notDetected.find((n) => n.control.toLowerCase().includes(label.toLowerCase().split(" ")[0]!));
      fact(
        libs.length
          ? { id: `control:${key}`, state: "inferred", statement: `${label} library present: ${libs.join(", ")}.`, detector: det("security-model"), confidence: "medium", limitations: ["Found as a library; where it is applied is not proven here."], contradictions: [] }
          : { id: `control:${key}`, state: "not_observed", statement: `${label} was not found.`, detector: det("security-model"), confidence: "medium", limitations: [absent?.scope ?? "Absence in the scanned code only."], contradictions: [] },
        [],
      );
    }
    sm.cors.forEach((c, i) => fact({ id: `config:cors:${i + 1}`, state: "observed", statement: c.allowsAnyOrigin ? "CORS allows any origin." : "CORS is restricted to listed origins.", detector: det("security-model"), confidence: "high", limitations: [], contradictions: [] }, [c.evidence]));

    // ---------------- data, integrations, settings, dependencies, deployment
    for (const e of d.dataModel.entities) {
      const sensitive = e.fields.filter((f) => f.sensitivity && f.sensitivity !== "none");
      if (sensitive.length) fact({ id: e.id, state: e.status, statement: `${e.name} holds ${sensitive.map((f) => `${f.name} (${f.sensitivity})`).join(", ")}.`, detector: det("datamodel"), confidence: "high", limitations: [], contradictions: ruleSet.has("schema-files-without-tables") ? ["schema-files-without-tables"] : [], tabs: ["security", "testing"] }, [e.evidence]);
    }
    for (const i of d.integrations) fact({ id: i.id, state: i.status, statement: `${i.name} (${i.category}, ${i.side}) detected by ${i.detectedBy.join(", ")}.`, detector: det("integrations"), confidence: i.usedIn.length ? "high" : "medium", limitations: i.usedIn.length ? [] : ["Detected from a package or setting; no call site was located."], contradictions: [], tabs: i.category === "ai" ? ["security", "ai-evaluator"] : ["security"] }, i.usedIn);
    for (const v of d.config.envVars.filter((x) => x.sensitivity === "secret")) {
      fact({ id: v.id, state: v.status, statement: `${v.name} is a secret setting read on the ${v.side} side${v.hasDefault ? ", with a default in code" : ""}.`, detector: det("config"), confidence: "high", limitations: v.side === "browser" ? ["Read by frontend code: anything bundled into the browser is public."] : [], contradictions: [] }, v.usedIn);
    }
    const manifests = [...new Set(d.dependencies.map((x) => x.manifest))];
    for (const m of manifests) {
      const deps = d.dependencies.filter((x) => x.manifest === m);
      const resolved = deps.filter((x) => x.resolved).length;
      fact({ id: `manifest:${m}`, state: "observed", statement: `${m}: ${deps.length} dependencies, ${resolved} with a resolved version from a lockfile.`, detector: det("manifests"), confidence: "high", limitations: resolved < deps.length ? ["Without a resolved version, a vulnerability can only be suspected, never confirmed."] : [], contradictions: [] }, src.files.has(m) ? [{ path: m, line: 1 }] : []);
    }
    for (const f of d.deployment.dockerfiles) fact({ id: `dockerfile:${f.path}`, state: "observed", statement: `${f.path}: base ${f.baseImages.join(", ") || "unknown"}${f.exposes.length ? `, exposes ${f.exposes.join(", ")}` : ""}.`, detector: det("deployment"), confidence: "high", limitations: [], contradictions: [] }, src.files.has(f.path) ? [{ path: f.path, line: 1 }] : []);
    for (const c of d.deployment.containers) fact({ id: c.id, state: c.status, statement: `${c.name} in ${c.file}${c.ports.length ? `, published ports ${c.ports.join(", ")}` : ""}.`, detector: det("deployment"), confidence: "high", limitations: [], contradictions: ruleSet.has("service-in-several-compose-files") ? ["service-in-several-compose-files"] : [] }, src.files.has(c.file) ? [{ path: c.file, line: 1 }] : []);
    for (const w of d.deployment.ci) fact({ id: `ci:${w.path}`, state: "observed", statement: `${w.provider} workflow ${w.path} with ${w.jobs.length} job(s).`, detector: det("deployment"), confidence: "high", limitations: [], contradictions: [] }, src.files.has(w.path) ? [{ path: w.path, line: 1 }] : []);
    for (const [i, a] of d.aiComponents.entries()) fact({ id: `ai:component:${i + 1}`, state: "observed", statement: `${a.sdk}: ${a.calls.length} call(s), ${a.toolDefinitions.length} tool definition(s), ${a.systemPrompts.length} system prompt(s).`, detector: det("integrations"), confidence: "high", limitations: [], contradictions: [], tabs: ["security", "ai-evaluator"] }, [...a.calls.map((c) => c.evidence), ...a.toolDefinitions, ...a.systemPrompts.map((p) => p.evidence)]);

    if (tally.dropped) issues.push({ rule: "evidence-not-in-snapshot", severity: "warning", message: `${tally.dropped} evidence reference(s) point at files or lines this snapshot does not have; they were not used.`, evidence: [], blocks: [] });
  }

  // ---------------- the readiness level and the lanes that may run
  const blocked = new Set(issues.flatMap((i) => i.blocks));
  const level: AnalyzeReadiness["level"] = issues.some((i) => i.rule === "dossier-schema" || i.rule === "dossier-other-content") ? "BLOCKED" : blocked.size ? "PARTIALLY_READY" : issues.length ? "READY_WITH_WARNINGS" : "READY";
  const readiness: AnalyzeReadiness = { level, issues, runnableLanes: level === "BLOCKED" ? [] : ALL_LANES.filter((l) => !blocked.has(l)) };

  // ---------------- artifacts
  const evidence = [...records.values()];
  const projectFacts = JSON.stringify({ schemaVersion: 1, snapshotId, contentDigest, engine, readiness, facts }, null, 2);
  const evidenceNdjson = evidence.map((e) => JSON.stringify(e)).join("\n");
  const markdown = analysisMarkdown(d, readiness, facts);
  const manifest: AnalysisManifest = {
    schemaVersion: 1,
    analyzerVersion: d?.meta.analyzerVersion ?? null,
    securityEngine: engine,
    snapshotId,
    contentDigest,
    files: { stored: src.files.size, listed: src.allPaths.length, skipped: [...src.skipped].map(([path, reason]) => ({ path, reason })), excluded: [...src.excluded].map(([path, reason]) => ({ path, reason })) },
    coverage: d ? { filesTotal: d.coverage.filesTotal, filesParsed: d.coverage.filesParsed, categories: d.coverage.categories.map((c) => ({ id: c.id, count: c.count })) } : null,
    unsupportedLanguages: unsupportedLanguages(src.allPaths),
    evidence: tally,
    readiness: { level, issues: issues.length },
    artifacts: { "project-facts.json": sha(projectFacts), "evidence.ndjson": sha(evidenceNdjson), "project-analysis.md": sha(markdown) },
  };
  return { readiness, dossier: d, facts, evidence, manifest, artifacts: { "project-facts.json": projectFacts, "evidence.ndjson": evidenceNdjson, "project-analysis.md": markdown, "analysis-manifest.json": JSON.stringify(manifest, null, 2) } };
}

/** The short human explanation: what Security will rely on, what it will not, and why. */
function analysisMarkdown(d: ProjectDossier | null, readiness: AnalyzeReadiness, facts: SecurityFact[]) {
  const out = ["# Project analysis for Security", "", `Readiness: **${readiness.level}**`, ""];
  if (readiness.issues.length) out.push("## Issues in the analysis", "", ...readiness.issues.map((i) => `- ${i.severity === "error" ? "Contradiction" : "Gap"} (${i.rule}): ${i.message}${i.blocks.length ? ` Makes these lanes inconclusive: ${i.blocks.join(", ")}.` : ""}`), "");
  if (!d) return [...out, "The analysis could not be used, so no facts were derived from it."].join("\n");
  const routes = facts.filter((f) => f.id.startsWith("endpoint:"));
  const byClass = new Map<string, number>();
  for (const f of routes) {
    const cls = f.statement.match(/: ([A-Z_]+)/)?.[1] ?? "UNKNOWN";
    byClass.set(cls, (byClass.get(cls) ?? 0) + 1);
  }
  out.push("## Entry points", "", `${routes.length} endpoint(s): ${[...byClass].map(([k, n]) => `${n} ${k}`).join(", ") || "none"}.`, "");
  const auth = facts.find((f) => f.id === "auth:model");
  if (auth) out.push("## Authentication", "", `${auth.statement} (${auth.state}, ${auth.confidence} confidence)`, "");
  const roles = facts.filter((f) => f.id.startsWith("role:"));
  if (roles.length) out.push("## Roles", "", ...roles.map((r) => `- ${r.statement}`), "");
  const data = facts.filter((f) => f.id.startsWith("entity:"));
  if (data.length) out.push("## Sensitive data", "", ...data.map((x) => `- ${x.statement}`), "");
  const other = facts.filter((f) => /^(integration|env|manifest|dockerfile|container|ci|ai):/.test(f.id));
  if (other.length) out.push("## Integrations, settings and deployment", "", ...other.map((x) => `- ${x.statement}`), "");
  const unresolved = facts.filter((f) => f.state === "unresolved" || f.contradictions.length);
  if (unresolved.length) out.push("## Not trusted yet", "", ...unresolved.map((f) => `- ${f.id}: ${f.limitations[0] ?? "contradicted by the analysis"}`), "");
  out.push("## Limitations", "", "- Facts come from code and configuration only; documentation, comments and the AI summary are not used for decisions.", "- Absence claims cover the scanned code only.", "");
  return out.join("\n");
}
