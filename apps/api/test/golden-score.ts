// Scores a dossier against a hand-checked answer key, plus hard quality gates.
// Shared by scripts/eval-understanding.ts (scorecards) and test/acceptance.test.ts (CI).
import type { ProjectDossier } from "@cybercheck/contracts";
import type { SnapshotSource } from "../src/understanding/source.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Golden = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export type Metric = { name: string; found: number; expected: number; extra?: number; detail?: string[] };

/** Old dossiers have auth.status; new ones have control.kind. */
function controlOf(e: Any): string {
  if (e.control?.kind) return e.control.kind;
  return e.auth?.status === "required" ? "protected(legacy)" : e.auth?.status ?? "unknown";
}
const PROTECTED = new Set(["session_required", "role_required", "service_token", "handler_check", "callback_state", "webhook_signature"]);

export function score(d: ProjectDossier, g: Golden, src: SnapshotSource) {
  const D = d as Any;
  const metrics: Metric[] = [];
  const gates: Array<{ name: string; ok: boolean; detail: string }> = [];

  // Entities and columns
  if (g.entities) {
    const want = Object.keys(g.entities);
    const got = new Map<string, Any>(D.dataModel.entities.map((e: Any) => [String(e.table ?? e.name).toLowerCase(), e]));
    const hit = want.filter((t) => got.has(t));
    metrics.push({ name: "tables", found: hit.length, expected: want.length, extra: [...got.keys()].filter((k) => !want.includes(k)).length, detail: want.filter((t) => !got.has(t)).map((t) => `missing ${t}`) });
    let colsWant = 0;
    let colsHit = 0;
    const colMiss: string[] = [];
    for (const t of want) {
      const cols: string[] = g.entities[t];
      colsWant += cols.length;
      const have = new Set((got.get(t)?.fields ?? []).map((f: Any) => String(f.name)));
      for (const c of cols) (have.has(c) ? colsHit++ : colMiss.push(`${t}.${c}`));
    }
    metrics.push({ name: "columns", found: colsHit, expected: colsWant, detail: colMiss.slice(0, 8) });
    const rels = new Set<string>(D.dataModel.entities.flatMap((e: Any) => e.relations.map((r: Any) => `${String(e.table ?? e.name).toLowerCase()}->${String(r.to).toLowerCase()}`)));
    const relHit = (g.relations ?? []).filter((r: string) => rels.has(r));
    metrics.push({ name: "relations", found: relHit.length, expected: (g.relations ?? []).length, detail: (g.relations ?? []).filter((r: string) => !rels.has(r)) });
  }

  // Routes and their controls
  if (g.routes) {
    const eps = D.entryPoints.filter((e: Any) => e.kind !== "page");
    const byKey = new Map<string, Any>(eps.map((e: Any) => [`${e.method} ${e.path}`, e]));
    const want: Array<{ method: string; path: string; control: string }> = g.routes;
    const hit = want.filter((r) => byKey.has(`${r.method} ${r.path}`));
    const wantKeys = new Set(want.map((r) => `${r.method} ${r.path}`));
    const extra = [...byKey.keys()].filter((k) => !wantKeys.has(k));
    metrics.push({ name: "routes", found: hit.length, expected: want.length, extra: extra.length, detail: [...want.filter((r) => !byKey.has(`${r.method} ${r.path}`)).map((r) => `missing ${r.method} ${r.path}`), ...extra.slice(0, 5).map((k) => `extra ${k}`)] });
    const wrong: string[] = [];
    let right = 0;
    for (const r of hit) {
      const c = controlOf(byKey.get(`${r.method} ${r.path}`));
      const ok = c === r.control || (c === "protected(legacy)" && PROTECTED.has(r.control));
      if (ok && c !== "protected(legacy)") right++;
      else wrong.push(`${r.method} ${r.path}: ${c} (expected ${r.control})`);
    }
    metrics.push({ name: "route controls (exact)", found: right, expected: hit.length, detail: wrong.slice(0, 10) });
  }

  // Environment variables (every sub-list is optional in an answer key)
  if (g.env) {
    const vars = new Map<string, Any>(D.config.envVars.map((v: Any) => [v.name, v]));
    const CODE = /\.(ts|js|mjs|cjs|tsx|jsx|py)$/;
    const check = (name: string, want: string[] | undefined, ok: (v: Any) => boolean) => {
      if (!want) return;
      const hit = want.filter((n) => vars.has(n) && ok(vars.get(n)));
      metrics.push({ name, found: hit.length, expected: want.length, detail: want.filter((n) => !hit.includes(n)).slice(0, 8) });
    };
    check("env used in code (with evidence)", g.env.usedInCode, (v) => v.usedIn.some((e: Any) => CODE.test(e.path)));
    check("env used in deploy files", g.env.usedInDeployFiles, (v) => v.usedIn.some((e: Any) => !CODE.test(e.path)));
    check("env documented flag", g.env.documented, (v) => v.documented);
    check("env required flag", g.env.required, (v) => v.required === true);
    check("env not required flag", g.env.notRequired, (v) => v.required === false);
    check("env secret flag", g.env.secret, (v) => v.sensitivity === "secret");
    check("env not secret", g.env.notSecret, (v) => v.sensitivity !== "secret");
    check("env browser-exposed", g.env.browser, (v) => v.side === "browser");
    if (g.env.documented) {
      const falseDoc = [...vars.values()].filter((v: Any) => v.documented && !(g.env.documented as string[]).includes(v.name)).map((v: Any) => v.name);
      if (falseDoc.length) metrics.push({ name: "env wrongly marked documented", found: 0, expected: falseDoc.length, detail: falseDoc });
    }
  }

  if (g.domainTypeIds) {
    const ids = new Set((D.domainTypes as Any[]).map((t) => t.id));
    const hit = (g.domainTypeIds as string[]).filter((i) => ids.has(i));
    metrics.push({ name: "domain types kept separate by file", found: hit.length, expected: g.domainTypeIds.length, detail: [...ids].slice(0, 6) as string[] });
  }
  if (g.rateLimitingCustom !== undefined) metrics.push({ name: "custom rate limiter recognised", found: (D.securityModel.rateLimiting as string[]).some((x) => /custom/.test(x)) === g.rateLimitingCustom ? 1 : 0, expected: 1, detail: D.securityModel.rateLimiting });
  if (g.logging !== undefined) metrics.push({ name: "logging detected", found: (D.quality.logging.length > 0) === g.logging ? 1 : 0, expected: 1, detail: D.quality.logging });
  if (g.tests !== undefined) metrics.push({ name: "test file count", found: D.quality.testFiles === g.tests ? 1 : 0, expected: 1, detail: [`got ${D.quality.testFiles}`] });
  if (g.aiAbsent) metrics.push({ name: "AI Evaluator marked not applicable", found: D.aiComponents.length === 0 && /does not apply/.test(D.checklist.find((c: Any) => c.area === "ai_components")?.summary ?? "") ? 1 : 0, expected: 1 });
  if (g.coverage?.categories) {
    const got = Object.fromEntries((D.coverage.categories as Any[]).map((c) => [c.id, c.count]));
    const want = Object.entries(g.coverage.categories as Record<string, number>);
    const hit = want.filter(([k, n]) => got[k] === n);
    metrics.push({ name: "coverage categories", found: hit.length, expected: want.length, detail: want.filter(([k, n]) => got[k] !== n).map(([k, n]) => `${k}: got ${got[k] ?? 0}, expected ${n}`) });
  }
  if (g.authMechanisms) {
    const kinds = (D.securityModel.authMechanisms as Any[]).map((m) => m.kind);
    const ok = (g.authMechanisms as string[]).every((k) => kinds.includes(k)) && kinds.every((k: string) => (g.authMechanisms as string[]).includes(k));
    metrics.push({ name: "auth mechanisms exactly", found: ok ? 1 : 0, expected: 1, detail: [`got ${kinds.join(", ") || "none"}`] });
  }

  // Jobs
  if (g.jobs) {
    const jobs = D.background as Any[];
    let ok = 0;
    const miss: string[] = [];
    for (const j of g.jobs) {
      const hit = jobs.find((x) => (x.schedule ?? "") === j.scheduleRaw || x.resolvedSchedule === j.resolved);
      if (hit && (hit.resolvedSchedule ?? null) === j.resolved && (hit.handler ?? "").includes(j.handler)) ok++;
      else miss.push(`${j.handler}: got schedule=${hit?.schedule ?? jobs.map((x) => x.schedule).join("|")} resolved=${hit?.resolvedSchedule} handler=${hit?.handler}`);
    }
    metrics.push({ name: "jobs (schedule + resolved + handler)", found: ok, expected: g.jobs.length, extra: Math.max(0, jobs.length - g.jobs.length), detail: miss });
  }

  // Integrations
  if (g.integrations) {
    const names = (D.integrations as Any[]).map((i) => `${i.name} ${(i.hosts ?? []).join(" ")} ${(i.packages ?? []).join(" ")}`.toLowerCase());
    const req = g.integrations.required as Array<{ match: string }>;
    const hit = req.filter((r) => names.some((n) => new RegExp(r.match, "i").test(n)));
    metrics.push({ name: "integrations", found: hit.length, expected: req.length, detail: req.filter((r) => !hit.includes(r)).map((r) => `missing ${r.match}`) });
    const sum = D.checklist.find((c: Any) => c.area === "integrations")?.summary ?? "";
    const named = req.filter((r) => new RegExp(r.match, "i").test(sum));
    metrics.push({ name: "integrations named in summary", found: named.length, expected: req.length, detail: [sum.slice(0, 160)] });
  }

  // Containers
  if (g.containers) {
    const cs = D.deployment.containers as Any[];
    const hit = (g.containers as Array<{ name: string; file: string }>).filter((c) => cs.some((x) => x.name === c.name && (x.file ?? x.evidence?.path) === c.file));
    metrics.push({ name: "containers (name + file)", found: hit.length, expected: g.containers.length, extra: Math.max(0, cs.length - g.containers.length), detail: cs.map((x) => `${x.name}@${x.file ?? x.evidence?.path}`) });
  }

  // Screens
  if (g.screens) {
    const routes = new Set((D.screens as Any[]).map((s) => s.route));
    const hit = (g.screens as string[]).filter((s) => routes.has(s));
    metrics.push({ name: "screens", found: hit.length, expected: g.screens.length, extra: [...routes].filter((r) => !g.screens.includes(r)).length, detail: [...(g.screens as string[]).filter((s) => !routes.has(s)).map((s) => `missing ${s}`), ...[...routes].filter((r) => !g.screens.includes(r)).map((r) => `extra ${r}`)] });
    const withInputs = (g.screensWithInputs as string[]).filter((r) => (D.screens as Any[]).some((s) => s.route === r && ((s.interactions?.inputs ?? 0) > 0 || s.forms > 0)));
    metrics.push({ name: "screens with inputs detected", found: withInputs.length, expected: g.screensWithInputs.length });
  }

  // AI
  if (g.ai) {
    const comps = D.aiComponents as Any[];
    const text = comps.map((c) => `${c.sdk} ${c.calls.map((x: Any) => x.api).join(" ")}`).join(" ").toLowerCase() + " " + (D.integrations as Any[]).filter((i) => i.category === "ai").map((i) => i.name.toLowerCase()).join(" ");
    const prov = (g.ai.providers as string[]).filter((p) => text.includes(p));
    metrics.push({ name: "AI providers", found: prov.length, expected: g.ai.providers.length });
    const calls = comps.reduce((s, c) => s + c.calls.length, 0);
    metrics.push({ name: "AI call sites", found: Math.min(calls, g.ai.minCallSites), expected: g.ai.minCallSites });
  }

  // Auth model and roles
  if (g.auth) {
    const sm = D.securityModel;
    const mech = (sm.authMechanisms ?? []).map((m: Any) => m.kind);
    if (g.auth.mechanism) metrics.push({ name: "auth mechanism identified", found: mech.includes(g.auth.mechanism) ? 1 : 0, expected: 1, detail: [`got ${mech.join(", ")}`] });
    const cred = (sm.credentialChecks ?? []).map((c: Any) => c.kind);
    if (g.auth.credential) metrics.push({ name: "credential check identified", found: cred.includes(g.auth.credential) ? 1 : 0, expected: 1 });
    const rolesItem = D.checklist.find((c: Any) => c.area === "users_roles")?.summary ?? "";
    // Leaked = presented as a user role (mentioning it as "not a user role" is correct).
    const leaked = ((g.auth.llmRoleTypes ?? []) as string[]).filter((t) => new RegExp(`Roles defined in code:[^.]*\\b${t}\\b`).test(rolesItem));
    if (g.auth.llmRoleTypes) metrics.push({ name: "no LLM types used as user roles", found: leaked.length ? 0 : 1, expected: 1, detail: [rolesItem.slice(0, 160)] });
  }

  // Findings
  if (g.findingsMust) {
    const obsText = (D.observations as Any[]).map((o) => `${o.title} ${o.detail}`).join("\n");
    const must = (g.findingsMust as string[]).filter((f) => (f === "raw webhook body logged" ? /log/i.test(obsText) && /webhook/i.test(obsText) && /body|payload|personal/i.test(obsText) : obsText.includes(f)));
    metrics.push({ name: "required findings present", found: must.length, expected: g.findingsMust.length, detail: (g.findingsMust as string[]).filter((f) => !must.includes(f)) });
    const titles = (D.observations as Any[]).map((o) => o.title);
    const mustNot = (g.findingsMustNot ?? []) as string[];
    const bad = mustNot.filter((r) => titles.some((t) => t.startsWith(`${r}:`) || t.startsWith(`${r} `)));
    if (mustNot.length) metrics.push({ name: "no findings on public-by-design routes", found: mustNot.length - bad.length, expected: mustNot.length, detail: bad });
  }

  // ---------- Hard gates ----------
  // Evidence: every {path, line} must exist and be in range.
  const lines = new Map<string, number>([...src.files.values()].map((f) => [f.path, f.lines]));
  const all = new Set(src.allPaths);
  let evTotal = 0;
  const evBad: string[] = [];
  const visit = (x: unknown) => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x)) return x.forEach(visit);
    const o = x as Any;
    if (typeof o.path === "string" && typeof o.line === "number") {
      evTotal++;
      const n = lines.get(o.path);
      if (!all.has(o.path)) evBad.push(`${o.path}:${o.line} (no such file)`);
      else if (n !== undefined && (o.line < 1 || o.line > n || (o.endLine && o.endLine > n))) evBad.push(`${o.path}:${o.line} (out of range, ${n} lines)`);
    }
    for (const v of Object.values(o)) visit(v);
  };
  visit({ ...D, diagrams: undefined, meta: undefined });
  gates.push({ name: "evidence resolves", ok: evBad.length === 0, detail: `${evTotal - evBad.length}/${evTotal}${evBad.length ? `; e.g. ${evBad.slice(0, 3).join(", ")}` : ""}` });

  // Coverage reconciles.
  const c = D.coverage;
  const parts = c.categories ? (c.categories as Any[]).reduce((s, x) => s + x.count, 0) : c.filesParsed + Object.values(c.skipped as Record<string, number>).reduce((a, b) => a + b, 0);
  gates.push({ name: "coverage reconciles", ok: parts === c.filesTotal, detail: `${parts} accounted of ${c.filesTotal}` });

  // Unique diagram ids (node declarations).
  const dup: string[] = [];
  for (const [k, code] of Object.entries(D.diagrams as Record<string, string>)) {
    const ids = new Map<string, number>();
    for (const m of code.matchAll(/^\s*(?:class\s+)?([A-Za-z_][\w]*)\s*(?:\[|\(|\{(?!$))/gm)) ids.set(m[1]!, (ids.get(m[1]!) ?? 0) + 1);
    for (const m of code.matchAll(/^\s*class\s+([A-Za-z_]\w*)\s*\[/gm)) void m;
    for (const [id, n] of ids) if (n > 1 && !["subgraph", "end", "style", "classDef"].includes(id)) dup.push(`${k}:${id}x${n}`);
  }
  gates.push({ name: "diagram ids unique", ok: dup.length === 0, detail: dup.slice(0, 6).join(", ") || "ok" });

  // Consistency gate (new dossiers).
  const issues = (D.consistency ?? null) as Any[] | null;
  gates.push({ name: "consistency gate: 0 errors", ok: issues ? issues.filter((i) => i.severity === "error").length === 0 : false, detail: issues ? `${issues.filter((i) => i.severity === "error").length} errors, ${issues.filter((i) => i.severity === "warning").length} warnings` : "no consistency gate yet" });

  // Every endpoint has a control class (new dossiers).
  const eps = (D.entryPoints as Any[]).filter((e) => e.kind !== "page");
  gates.push({ name: "every endpoint has a control class", ok: eps.every((e) => e.control?.kind), detail: `${eps.filter((e) => e.control?.kind).length}/${eps.length}` });

  // Claim status present.
  const claimish = [...(D.entryPoints ?? []), ...(D.dataModel?.entities ?? []), ...(D.integrations ?? []), ...(D.config?.envVars ?? [])] as Any[];
  gates.push({ name: "claims carry status", ok: claimish.every((x) => x.status), detail: `${claimish.filter((x) => x.status).length}/${claimish.length}` });

  return { metrics, gates };
}

