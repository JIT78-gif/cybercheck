import type { Evidence, Obligation, TestFinding } from "@cybercheck/contracts";
import type { SnapshotSource } from "../understanding/source.ts";
import { critic, findContradictions, triage, validEvidence, type TriageOut } from "./agents.ts";
import { CI_ENV, LEGACY_ENGINE, POLICY, TSX, addFinding, execute, setOb, sha, shq, tail, toProjectPaths, type Ctx } from "./runtime.ts";

/**
 * Failure candidates from every worker go through one path: triage (what kind of failure), an
 * independent critic for product defects, then merging of duplicates and contradiction checks.
 */

export type Candidate = {
  source: "suite" | "probe" | "boot" | "browser";
  label: string;
  obligationIds: string[];
  executionIds: string[];
  reproduced: number;
  of: number;
  context: string;
  locations: Array<{ path: string; line: number }>;
  workspace: string;
  testNames?: string[];
  probe?: { request: string; status: number | null };
  /** A complete, self-contained reproduction (all steps, sign-in, or the generated test's code). */
  reproduction?: string;
  /** Classified without AI (e.g. clearly offline). */
  forced?: TestFinding["kind"];
};

/** Every request of a probe in order, with how the client signs in (setting names, never values). */

export function testFileOf(src: SnapshotSource, file: string | null, locs: Array<{ path: string }>) {
  if (file && src.files.has(file)) return file;
  return locs.find((l) => /(\.|\/)(test|spec)\.|(^|\/)tests?\/|test_\w+\.py$/.test(l.path))?.path ?? locs[0]?.path ?? null;
}

/** Test cases that failed in every run (and at least one run produced per-test results). */

export function stackLocations(src: SnapshotSource, workspace: string, text: string) {
  const out: Array<{ path: string; line: number }> = [];
  for (const m of text.matchAll(/((?:[\w@.-]+\/)*[\w@.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py))(?::|", line |\()(\d+)/g)) {
    if (m[1]!.includes("node_modules")) continue;
    const cands = [m[1]!, workspace === "." ? m[1]! : `${workspace}/${m[1]!}`];
    const hit = validEvidence(src, cands.map((p) => ({ path: p, line: Number(m[2]) })))[0];
    if (hit && !out.some((o) => o.path === hit.path && o.line === hit.line)) out.push(hit);
  }
  return out.slice(0, 4);
}


/** Probe kinds that test generic input handling: one parser or validation layer usually answers them all. */
const GENERIC_INPUT = /^(malformed-body|empty-body|invalid-id|missing-fields?|wrong-types?|oversized-body)$/;

/**
 * The root-cause signature of a failure, before any AI looks at it: the failure category, the status, and the
 * response body with numbers and stack traces removed. Every malformed-JSON 500 from one body parser shares one.
 */
export function rootSignature(c: Candidate, kindOf: (obligationId: string) => string): string | null {
  if (c.source !== "probe" || c.forced) return null;
  const kind = kindOf(c.obligationIds[0] ?? "");
  if (!GENERIC_INPUT.test(kind)) return null;
  const body = (c.context.match(/Response body \(start\): ([^\n]{0,400})/)?.[1] ?? "")
    .replace(/"stack"\s*:[\s\S]*$/, "")
    .replace(/\bat position \d+|\d+/g, "#")
    .replace(/\s+/g, " ")
    .slice(0, 160);
  return `input|${c.probe?.status ?? "none"}|${body}`;
}

/**
 * Triage order (the 9+/10 plan, section 5): critical business and state failures, then browser journeys and
 * database integrity, the project's own tests, authorization, generic validation and transport, and last tool and
 * environment problems. Lower comes first.
 */
export function triageRank(c: Candidate, ob: (id: string) => Obligation | undefined, kindOf: (id: string) => string) {
  if (c.forced) return 0;
  const obs = c.obligationIds.map(ob).filter((o): o is Obligation => Boolean(o));
  if (c.source === "boot") return 1;
  if (obs.some((o) => o.requirementIds?.length || ((o.proofClass === "business_behavior" || o.proofClass === "state_change") && (o.priority === "critical" || o.priority === "high")))) return 1;
  if (c.source === "browser" || obs.some((o) => o.layer === "data")) return 2;
  if (c.source === "suite") return c.label.startsWith("Generated test") ? 4 : 3;
  if ([401, 403].includes(c.probe?.status ?? 0) || obs.some((o) => /:(unauthenticated|wrong-role)$/.test(o.id))) return 4;
  if (GENERIC_INPUT.test(kindOf(c.obligationIds[0] ?? ""))) return 5;
  return 4;
}

/** A typed scenario's failure against a documented requirement, reproduced: expected and observed are the evidence. */
const SOURCED = new Set(["documentation", "existing_assertion", "user_requirement", "protocol"]);
export const deterministicScenario = (c: Candidate, ob: (id: string) => Obligation | undefined) =>
  c.reproduced >= 2 && c.obligationIds.length > 0 && c.obligationIds.every((id) => { const o = ob(id); return Boolean(o?.scenarioId && o.oracle && SOURCED.has(o.oracle.source)); });

export async function settle(ctx: Ctx, unsorted: Candidate[]) {
  const session = ctx.session;
  const kindOf = (id: string) => id.split(":").at(-1) ?? "";
  const rank = (c: Candidate) => triageRank(c, (id) => ctx.obligations.get(id), kindOf);
  // Failures that share one root cause are analysed once: refusals on one endpoint's guard, and generic input
  // failures with the same status and the same response (one body parser answering every malformed body).
  const grouped: Candidate[] = [];
  const byGuard = new Map<string, Candidate>();
  for (const c of unsorted) {
    const ref = ctx.obligations.get(c.obligationIds[0] ?? "")?.asset.ref;
    const key = c.source === "probe" && ref && c.probe && [401, 403].includes(c.probe.status ?? 0) ? `${ref}|${c.probe.status}` : LEGACY_ENGINE ? null : rootSignature(c, kindOf);
    const head = key ? byGuard.get(key) : undefined;
    if (head) {
      head.obligationIds = [...new Set([...head.obligationIds, ...c.obligationIds])];
      head.executionIds = [...new Set([...head.executionIds, ...c.executionIds])];
      continue;
    }
    const copy = { ...c };
    if (key) byGuard.set(key, copy);
    grouped.push(copy);
  }
  const candidates = grouped.sort((a, b) => rank(a) - rank(b));
  let analysed = 0;
  const one = async (c: Candidate) => {
    const fallback = (kind: TestFinding["kind"], why: string, status: TestFinding["status"] = "suspected"): Omit<TestFinding, "id"> => ({
      kind,
      status,
      severity: kind === "environment_failure" ? "info" : "medium",
      confidence: "low",
      title: c.label,
      expected: c.source === "probe" ? (ctx.obligations.get(c.obligationIds[0]!)?.oracle.expected ?? "") : "The check passes",
      actual: c.probe ? `Answered ${c.probe.status ?? "nothing"}` : "It failed",
      reproduction: c.probe?.request ?? c.testNames?.join("; ") ?? c.label,
      rootCause: why,
      location: c.locations[0] ?? null,
      obligationIds: c.obligationIds,
      executionIds: c.executionIds,
      validation: why,
      limitation: null,
    });
    if (c.forced === "environment_failure") {
      const f = await addFinding(ctx, { ...fallback("environment_failure", "The failure output shows network or service errors, which come from the offline sandbox, not the project's logic.", "confirmed"), confidence: "high" });
      for (const id of c.obligationIds) await setOb(ctx, id, { status: "blocked", blockedBy: "environment", reason: "Needs network access or an external service that the sandbox doesn't provide.", findingIds: [f.id] });
      return;
    }
    // A failing check written by cybercheck's own author is never reported as a product defect without analysis.
    const authored = c.obligationIds.every((id) => ctx.obligations.get(id)?.origin === "authored");
    const unanalysed = async (why: string) => {
      if (authored) {
        for (const id of c.obligationIds) await setOb(ctx, id, { status: "inconclusive", reason: `The check failed but could not be analysed (${why}); an AI-written check is not trusted on its own.` });
      } else await addFinding(ctx, fallback("product_defect", why));
    };
    if (!session || analysed >= POLICY.maxTriage) {
      await unanalysed(session ? "Not analysed: the triage limit for one run was reached." : "Not analysed: AI triage is not configured, so this needs a human look.");
      return;
    }
    analysed++;
    await ctx.store.event("triage", `Analysing failure: ${c.label.slice(0, 120)}`);
    let t: TriageOut & { model: string };
    try {
      t = await triage(session, c.context);
    } catch (err) {
      await unanalysed(`Triage failed: ${(err as Error).message.slice(0, 160)}`);
      return;
    }
    const location = t.location ? (validEvidence(ctx.src, [t.location])[0] ?? c.locations[0] ?? null) : (c.locations[0] ?? null);
    const reproduction = c.reproduction ?? c.probe?.request ?? (c.testNames?.length ? `Run the test${c.testNames.length > 1 ? "s" : ""}: ${c.testNames.slice(0, 5).join("; ")}` : c.label);
    // One root cause seen on several endpoints is one finding that names all of them.
    const seenOn = [...new Set(c.obligationIds.map((id) => ctx.obligations.get(id)?.asset.label).filter((x): x is string => Boolean(x)))];
    const floor = c.obligationIds.map((id) => ctx.obligations.get(id)).filter((o) => o?.requirementIds?.length).map((o) => o!.priority).find((p) => p === "critical" || p === "high");
    const SEV = ["info", "low", "medium", "high", "critical"] as const;
    if (floor && SEV.indexOf(t.severity) < SEV.indexOf(floor)) t = { ...t, severity: floor };
    const base = { title: t.title, expected: t.expected, actual: seenOn.length > 1 ? `${t.actual}\nSeen on ${seenOn.length} endpoints: ${seenOn.slice(0, 20).join(", ")}.` : t.actual, reproduction, rootCause: t.rootCause, location, obligationIds: c.obligationIds, executionIds: c.executionIds, ...(seenOn.length > 1 ? { groupedFrom: seenOn.slice(0, 20) } : {}) };
    if (t.kind === "environment") {
      const f = await addFinding(ctx, { ...base, kind: "environment_failure", status: "confirmed", severity: "info", confidence: t.confidence, validation: "Triage attributed it to the sandbox environment.", limitation: "Run with the real service or credentials to test this part." });
      for (const id of c.obligationIds) await setOb(ctx, id, { status: "blocked", blockedBy: "environment", reason: `Environment: ${t.rootCause}`, findingIds: [f.id] });
      return;
    }
    if (t.kind === "test_defect") {
      const f = await addFinding(ctx, { ...base, kind: "test_defect", status: ctx.obligations.get(c.obligationIds[0]!)?.origin === "authored" ? "rejected" : "confirmed", severity: "low", confidence: t.confidence, validation: "Triage found the test or probe expectation itself to be wrong.", limitation: null });
      // A working sign-in refused with 403 where the app is right to refuse it: the check expected the wrong role,
      // but what happened is real evidence that this role is kept out of the route. Recorded as that guard check.
      const roleRefusal = c.source === "probe" && c.probe?.status === 403 && /\b(role|admin|permission|not allowed|forbidden|refus)/i.test(`${t.rootCause} ${t.title}`);
      for (const id of c.obligationIds) {
        const o = ctx.obligations.get(id);
        if (roleRefusal && o) await setOb(ctx, id, { status: "passed", reachedTarget: true, proofClass: "guard", oracleStrength: "moderate", objective: `Refuses a role without access (${o.objective.slice(0, 80)} was refused with 403, as the code intends)`, reason: `Answered 403 to a working sign-in without the needed role; triage found the refusal intended: ${t.rootCause.slice(0, 240)}`, findingIds: [f.id] });
        else await setOb(ctx, id, { status: "inconclusive", reason: `The check itself was wrong: ${t.rootCause}`, findingIds: [f.id] });
      }
      return;
    }
    if (t.kind === "unclear" && authored) {
      // An AI-written check that even triage cannot explain proves nothing about the product.
      for (const id of c.obligationIds) await setOb(ctx, id, { status: "inconclusive", reason: `The check failed but triage could not tell whether the product or the check is wrong: ${t.rootCause.slice(0, 200)}` });
      return;
    }
    if (t.kind === "unclear" || c.source === "boot") {
      // A start-up failure is a real problem for the user even when its cause is unclear.
      const f = await addFinding(ctx, { ...base, kind: c.source === "boot" ? (t.kind === "product_defect" ? "product_defect" : "product_defect") : "product_defect", status: "suspected", severity: t.severity, confidence: t.confidence, validation: t.kind === "unclear" ? "Triage could not decide; needs a human look." : "Triage attributed it to the project; not independently reviewed because the app never started.", limitation: c.source === "probe" || c.source === "boot" ? "The app was started with synthetic configuration; real settings may avoid this." : null });
      for (const id of c.obligationIds) await setOb(ctx, id, { findingIds: [f.id] });
      return;
    }
    // product_defect: must be reproduced and independently confirmed. A typed scenario's reproduced failure against a
    // documented requirement carries its own evidence (expected and observed values); another model adds nothing to it.
    let verdict: { verdict: string; reason: string } = { verdict: "uncertain", reason: "not reviewed" };
    if (deterministicScenario(c, (id) => ctx.obligations.get(id))) verdict = { verdict: "confirm", reason: "not needed: a documented requirement's assertion failed with recorded expected and observed values, in two clean sandboxes" };
    else
      try {
        verdict = await critic(session, c.context, t);
      } catch (err) {
        verdict = { verdict: "uncertain", reason: `Review failed: ${(err as Error).message.slice(0, 120)}` };
      }
    const reproducedOk = c.reproduced >= 2 || (c.source === "suite" && c.reproduced === c.of && c.of >= 2);
    const status: TestFinding["status"] = verdict.verdict === "confirm" && reproducedOk ? "confirmed" : verdict.verdict === "reject" ? "rejected" : "suspected";
    const f = await addFinding(ctx, {
      ...base,
      kind: "product_defect",
      status,
      severity: t.severity,
      confidence: status === "confirmed" ? t.confidence : "low",
      validation: `Failed in ${c.reproduced} of ${c.of} clean run(s). Triage: product defect (${t.confidence} confidence). Independent review: ${verdict.verdict} (${verdict.reason})`,
      limitation: c.source === "probe" ? "Observed against the app started with synthetic configuration and no external services." : null,
    });
    for (const id of c.obligationIds) {
      await setOb(ctx, id, status === "rejected" ? { status: "inconclusive", reason: `A reviewer rejected the failure as a product defect: ${verdict.reason}`, findingIds: [f.id] } : { findingIds: [f.id] });
    }
  };
  // Three at a time: each triage and review takes up to a minute, and they are independent.
  const queue = [...candidates];
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) await one(c);
  }));
}

/**
 * Passes and findings must not contradict each other. An AI-written check that passed while its
 * oracle cites a line confirmed defective either asserted the defect as correct or tested around
 * it; either way its pass proves nothing, so it becomes inconclusive and names the finding.
 */
export async function reconcile(ctx: Ctx) {
  const confirmed = ctx.findings.filter((f) => f.kind === "product_defect" && f.status === "confirmed" && f.location);
  if (!confirmed.length || !ctx.session) return;
  for (const f of confirmed) {
    const fn = enclosingFunction(ctx.src, f.location!);
    const defectEndpoints = new Set(f.obligationIds.map((id) => ctx.obligations.get(id)?.asset.ref).filter(Boolean));
    // Candidates: AI-written passes on the same function, or on the same endpoint as the defect.
    const near = [...ctx.obligations.values()].filter(
      (o) =>
        o.origin === "authored" &&
        o.status === "passed" &&
        (o.oracle.evidence.some((e) => e.path === f.location!.path && (fn === null || enclosingFunction(ctx.src, e) === fn)) || defectEndpoints.has(o.asset.ref) || (fn !== null && new RegExp(`\\b${fn}\\b`).test(o.objective))),
    );
    if (!near.length) continue;
    const contradicting = await findContradictions(
      ctx.session,
      { title: f.title, expected: f.expected, actual: f.actual, rootCause: f.rootCause, location: `${f.location!.path}:${f.location!.line}` },
      near.slice(0, 12).map((o) => ({ id: o.id, objective: o.objective, expected: o.oracle.expected, detail: o.reason ?? "" })),
    );
    for (const c of contradicting) await setOb(ctx, c.id, { status: "inconclusive", reason: `Passed, but contradicts ${f.id} ("${f.title}"): ${c.reason}` });
  }
}

/** Name of the function (or method / const arrow) that contains a line, found by scanning upwards. */
export function enclosingFunction(src: SnapshotSource, at: Evidence): string | null {
  const lines = src.files.get(at.path)?.text.split("\n") ?? [];
  for (let i = Math.min(at.line, lines.length) - 1; i >= 0; i--) {
    const m = lines[i]!.match(/(?:function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?(?:\(|function)|^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::[^{]+)?\{|def\s+(\w+))/);
    const name = m ? (m[1] ?? m[2] ?? m[3] ?? m[4]) : null;
    if (name && !["if", "for", "while", "switch", "catch", "return"].includes(name) && name.length > 2) return name;
  }
  return null;
}

/**
 * One root cause, one finding: product defects pointing at the same code (within a few lines) are
 * merged, keeping every obligation and execution as evidence. Confirmed wins over suspected.
 */
/** API paths a finding talks about, with ids generalised (/admin/feedback, /orders/:id). */
const apiPaths = (f: TestFinding) =>
  new Set(
    [...`${f.title} ${f.actual} ${f.reproduction}`.matchAll(/(?:^|[\s"'`(])((?:\/[A-Za-z0-9_.-]+)+)/g)]
      .map((m) => m[1]!.split("?")[0]!.replace(/\/\d+(?=\/|$)/g, "/:id").toLowerCase())
      .filter((p) => p.split("/").length > 2 && !/\.(tsx?|jsx?|py|css|png|svg|json)$/.test(p)),
  );

/**
 * The same refusal seen by two workers: an API check and a browser screen both got a 403 from one API path
 * (a staff screen calling an admin-only endpoint). One root cause, so one finding.
 */
export function sameRefusal(a: TestFinding, b: TestFinding, endpointsOf: (f: TestFinding) => string[] = () => []): boolean {
  if (a.layer === b.layer || !/\b403\b/.test(`${a.title} ${a.actual}`) || !/\b403\b/.test(`${b.title} ${b.actual}`)) return false;
  const paths = (f: TestFinding) => new Set([...apiPaths(f), ...endpointsOf(f).map((p) => p.split("?")[0]!.replace(/\{[^}]+\}|:\w+/g, ":id").toLowerCase())]);
  // A frontend often calls the API through a prefix (/api/admin/feedback for /admin/feedback): same route.
  const same = (p: string, q: string) => p === q || (p.split("/").length > 2 && q.split("/").length > 2 && (p.endsWith(q) || q.endsWith(p)));
  const pa = [...paths(a)];
  return [...paths(b)].some((p) => pa.some((q) => same(p, q)));
}

const GENERIC = new Set(["error", "errors", "server", "request", "requests", "returns", "return", "instead", "accepts", "should", "endpoint", "handler", "value", "values", "field", "fields", "check", "without", "items", "cart"]);

/** Whether two findings describe the same behaviour: they share most of their distinctive words. */
export function sameSubject(a: Pick<TestFinding, "title" | "rootCause">, b: Pick<TestFinding, "title" | "rootCause">): boolean {
  const words = (f: Pick<TestFinding, "title" | "rootCause">) => new Set(`${f.title} ${f.rootCause ?? ""}`.toLowerCase().match(/[a-z]{5,}/g)?.filter((w) => !GENERIC.has(w)) ?? []);
  const x = words(a);
  const y = words(b);
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared >= 2 && shared / Math.min(x.size, y.size) >= 0.4;
}

export async function mergeDuplicates(ctx: Ctx) {
  // Rule and measurement findings (axe rules, phone overflow) are each their own defect: never folded into another
  // finding because they sit in the same file.
  const ruleBased = (f: TestFinding) => f.layer === "accessibility" || /^(Deterministic|Measured)/.test(f.validation ?? "");
  const defects = ctx.findings.filter((f) => f.kind === "product_defect" && f.status !== "rejected" && f.location && !ruleBased(f));
  const rank = (f: TestFinding) => (f.status === "confirmed" ? 0 : 1);
  const merged = new Set<string>();
  // The same defect seen through another layer (the API, a root test suite) names the faulty function.
  // The API paths of the checks a finding explains (GET /admin/feedback), for grouping one refusal seen twice.
  const endpointsOf = (f: TestFinding) => f.obligationIds.map((id) => ctx.obligations.get(id)?.asset.label.split(" ")[1] ?? "").filter((p) => p.startsWith("/"));
  const allDefects = ctx.findings.filter((f) => f.kind === "product_defect" && f.status !== "rejected" && !ruleBased(f));
  for (const a of [...defects].sort((x, y) => rank(x) - rank(y))) {
    if (merged.has(a.id)) continue;
    const fn = enclosingFunction(ctx.src, a.location!);
    const mentions = (b: TestFinding) => fn !== null && new RegExp(`\\b${fn}\\b`).test(`${b.title} ${b.rootCause ?? ""}`);
    // A process crash suspected from the load test is the same weakness as a crash a single request confirmed.
    const crashConfirmed = a.status === "confirmed" && /crash|stops the|process (exits|stops)|unhandled/i.test(`${a.title} ${a.rootCause ?? ""}`);
    const loadCrash = (b: TestFinding) => crashConfirmed && b.layer === "reliability" && b.status === "suspected" && /stops (the whole server|under concurrent load)/i.test(b.title);
    // The same words from two sources (a probe and a scenario) are one problem, also when one of them has no location.
    const said = (f: TestFinding) => f.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b(a|an|the)\b/g, "").replace(/\s+/g, " ").trim();
    const sameTitle = (b: TestFinding) => (!b.location || b.location.path === a.location!.path) && said(b) === said(a);
    // Nearby lines alone do not make one defect: a handler can hold two (a missing range check one line above an
    // unguarded parse). Close findings merge only when they also describe the same thing.
    const near = (b: TestFinding) => Boolean(b.location && b.location.path === a.location!.path && Math.abs(b.location.line - a.location!.line) <= 3) && sameSubject(a, b);
    const same = allDefects.filter((b) => b !== a && !merged.has(b.id) && (near(b) || mentions(b) || loadCrash(b) || sameTitle(b) || sameRefusal(a, b, endpointsOf)));
    if (!same.length) continue;
    a.obligationIds = [...new Set([...a.obligationIds, ...same.flatMap((b) => b.obligationIds)])].filter((id) => ctx.obligations.get(id)?.status !== "passed");
    a.executionIds = [...new Set([...a.executionIds, ...same.flatMap((b) => b.executionIds)])];
    a.validation = `${a.validation} Also shown independently by: ${same.map((b) => `"${b.title}"`).join("; ")}.`;
    // One root cause, several evidence sources (an API check and a browser screen): listed, never counted twice.
    a.groupedFrom = [...new Set([...(a.groupedFrom ?? [`${a.layer ?? "check"}: ${a.title}`]), ...same.map((b) => `${b.layer ?? "check"}: ${b.title}`)])];
    if (a.status !== "confirmed" && same.some((b) => b.status === "confirmed")) a.status = "confirmed";
    await ctx.store.putFinding(a);
    for (const b of same) {
      merged.add(b.id);
      await ctx.store.removeFinding(b.id);
      for (const oid of b.obligationIds) {
        const o = ctx.obligations.get(oid);
        if (o) await setOb(ctx, oid, { findingIds: [a.id] }).then(() => Object.assign(o, { findingIds: o.findingIds.filter((x) => x !== b.id) }));
      }
    }
  }
  // Environment problems with the same cause (same code location, or no location and the same explanation) are one item.
  const envGroups = new Map<string, TestFinding[]>();
  for (const f of ctx.findings.filter((x) => x.kind === "environment_failure" && !merged.has(x.id))) {
    const key = f.location ? `${f.location.path}:${f.location.line}` : `cause:${f.rootCause ?? f.title}`;
    envGroups.set(key, [...(envGroups.get(key) ?? []), f]);
  }
  for (const [, group] of envGroups) {
    if (group.length < 2) continue;
    const [a, ...rest] = group;
    a!.obligationIds = [...new Set(group.flatMap((g) => g.obligationIds))];
    a!.executionIds = [...new Set(group.flatMap((g) => g.executionIds))];
    a!.title = `${a!.title.replace(/^[A-Z]+ \S+: /, "")} (affects ${a!.obligationIds.length} checks)`;
    await ctx.store.putFinding(a!);
    for (const b of rest) {
      merged.add(b.id);
      await ctx.store.removeFinding(b.id);
      for (const oid of b.obligationIds) {
        const o = ctx.obligations.get(oid);
        if (o) Object.assign(o, { findingIds: [...new Set([...o.findingIds.filter((x) => x !== b.id), a!.id])] });
      }
    }
  }
  ctx.findings = ctx.findings.filter((f) => !merged.has(f.id));
  if (merged.size) await ctx.store.putObligations([...ctx.obligations.values()]);
}

