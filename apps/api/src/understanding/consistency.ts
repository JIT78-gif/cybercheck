import type { ConsistencyIssue, ProjectDossier } from "@cybercheck/contracts";
import type { SnapshotSource } from "./source.ts";

/**
 * Contradiction and gap rules across the dossier. Errors mean the dossier says two
 * incompatible things (a bug to fix in the analyzer); warnings are gaps a reader should know.
 */
export function checkConsistency(d: ProjectDossier, src: SnapshotSource): ConsistencyIssue[] {
  const out: ConsistencyIssue[] = [];
  const err = (rule: string, message: string, evidence: ConsistencyIssue["evidence"] = []) => out.push({ rule, severity: "error", message, evidence });
  const warn = (rule: string, message: string, evidence: ConsistencyIssue["evidence"] = []) => out.push({ rule, severity: "warning", message, evidence });
  const routes = d.entryPoints.filter((e) => e.kind !== "page");
  const sm = d.securityModel;

  // Schema-like files exist, but no tables were recognised.
  const schemaFiles = src.allPaths.filter((p) => /(^|\/)(schema|migrations?|models?)(\.\w+|\/)/i.test(p) && /\.(sql|prisma|ts|js|py)$/.test(p) && !/node_modules|\.test\.|\.spec\./.test(p));
  if (schemaFiles.length && !d.dataModel.entities.length) err("schema-files-without-tables", `Files that usually define the database (${schemaFiles.slice(0, 3).join(", ")}) exist, but no tables were recognised.`, schemaFiles.slice(0, 3).map((path) => ({ path, line: 1 })));

  // Guarded endpoints but no authentication mechanism.
  const guarded = routes.filter((r) => r.control.kind === "session_required" || r.control.kind === "role_required");
  if (guarded.length && !sm.authMechanisms.length) err("guards-without-mechanism", `${guarded.length} endpoints are protected by ${[...new Set(guarded.flatMap((r) => r.control.via))].join(", ")}, but no authentication mechanism was identified.`, guarded.slice(0, 2).flatMap((r) => r.control.evidence.slice(0, 1)));
  if (sm.notDetected.some((n) => n.control === "Authentication") && guarded.length) err("auth-negative-contradiction", "The security model says no authentication was found while endpoints are protected.");

  // Every endpoint has a control; every unprotected endpoint has a reason.
  for (const r of routes) if (!r.control.reason) err("control-without-reason", `${r.method} ${r.path} has no reason for its control class.`, [r.handler]);

  // Findings must not target public-by-design endpoints.
  const publicIds = new Set(routes.filter((r) => r.control.kind === "public_intentional").map((r) => `${r.method} ${r.path}`));
  for (const o of d.observations) for (const id of publicIds) if (o.title.startsWith(`${id}:`)) err("finding-on-public-route", `Finding "${o.title}" targets an endpoint that is public by design.`, o.evidence);

  // Summary counts must match the records they describe.
  const integ = d.checklist.find((c) => c.area === "integrations");
  if (integ && d.integrations.length) {
    const missing = d.integrations.filter((i) => !integ.summary.includes(i.name));
    if (missing.length) err("integration-summary-mismatch", `The integrations summary leaves out ${missing.map((i) => i.name).join(", ")}.`);
  }
  const apis = d.checklist.find((c) => c.area === "apis");
  if (apis && routes.length && !apis.summary.startsWith(`${routes.length.toLocaleString("en-US")} endpoint`)) err("api-summary-mismatch", `The API summary does not match the ${routes.length} endpoints listed.`);

  // Coverage must add up.
  const sum = d.coverage.categories.reduce((s, c) => s + c.count, 0);
  if (sum !== d.coverage.filesTotal) err("coverage-does-not-reconcile", `Coverage categories add up to ${sum}, but the snapshot has ${d.coverage.filesTotal} files.`);

  // Ids must be unique.
  const ids = [...d.entryPoints.map((e) => e.id), ...d.dataModel.entities.map((e) => e.id), ...d.integrations.map((i) => i.id), ...d.config.envVars.map((e) => e.id), ...d.background.map((j) => j.id), ...d.deployment.containers.map((c) => c.id), ...d.domainTypes.map((t) => t.id)];
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  if (dup.length) err("duplicate-ids", `Duplicate ids: ${[...new Set(dup)].slice(0, 5).join(", ")}.`);

  // Roles must come from authorization enums only.
  const rolesItem = d.checklist.find((c) => c.area === "users_roles");
  for (const r of sm.roles.filter((x) => x.kind !== "app_role")) if (rolesItem && new RegExp(`Roles defined in code:[^.]*\\b${r.name}\\b`).test(rolesItem.summary)) err("non-authorization-role", `${r.name} is a ${r.kind} but is listed as a user role.`, [r.evidence]);

  // Evidence must point at real files and lines.
  const lines = new Map([...src.files.values()].map((f) => [f.path, f.lines]));
  const all = new Set(src.allPaths);
  let bad = 0;
  const visit = (x: unknown) => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) return x.forEach(visit);
    const o = x as Record<string, unknown>;
    if (typeof o.path === "string" && typeof o.line === "number") {
      const n = lines.get(o.path);
      if (!all.has(o.path) || (n !== undefined && o.line > n)) bad++;
    }
    for (const v of Object.values(o)) visit(v);
  };
  visit({ ...d, diagrams: undefined, meta: undefined, consistency: undefined, coverage: undefined });
  if (bad) err("evidence-out-of-range", `${bad} evidence references point at missing files or lines.`);

  // Gaps worth stating.
  const usedUndeclared = d.config.envVars.filter((e) => e.usedIn.length && !e.documented);
  if (usedUndeclared.length && d.config.envVars.some((e) => e.documented)) warn("env-used-not-declared", `${usedUndeclared.length} ${usedUndeclared.length === 1 ? "variable is" : "variables are"} read but missing from the example file: ${usedUndeclared.slice(0, 6).map((e) => e.name).join(", ")}.`);
  const declaredUnused = d.config.envVars.filter((e) => e.documented && !e.usedIn.length);
  if (declaredUnused.length) warn("env-declared-not-used", `${declaredUnused.length} ${declaredUnused.length === 1 ? "variable is" : "variables are"} documented but never read by the code or deployment files: ${declaredUnused.slice(0, 6).map((e) => e.name).join(", ")}.`, declaredUnused.slice(0, 3).flatMap((e) => e.declaredIn));
  for (const j of d.background.filter((x) => x.kind === "cron" && !x.resolvedSchedule)) warn("job-schedule-unresolved", `The schedule of ${j.name} could not be resolved${j.schedule ? ` (written as ${j.schedule})` : ""}.`, [j.evidence]);
  for (const r of routes.filter((x) => x.control.kind === "unknown")) warn("control-undetermined", `${r.method} ${r.path}: ${r.control.reason}.`, [r.handler]);
  const sameName = new Map<string, string[]>();
  for (const c of d.deployment.containers) sameName.set(c.name, [...(sameName.get(c.name) ?? []), c.file]);
  for (const [name, files] of sameName) if (files.length > 1) warn("service-in-several-compose-files", `The ${name} service is defined in ${files.join(" and ")}; they describe different deployments.`);
  return out;
}
