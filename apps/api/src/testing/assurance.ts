import { RISK_WEIGHT, type Obligation, type OracleStrength, type ProofClass, type ProjectDossier, type TestFinding, type TestingReport } from "@cybercheck/contracts";

/**
 * Assurance arithmetic, kept apart from the report so every number is a pure function of the ledger.
 * Three separate answers, never merged into one percentage:
 * - Testing Completeness: how much risk-weighted scope received decisive, strong evidence.
 * - Product Health: what share of the decisive scope passed.
 * - Release decision: whether the mandatory gates allow a release.
 */

/** The completeness target when the run has none of its own (old runs and direct calls); runs take theirs from the policy. */
export const COMPLETENESS_THRESHOLD = 90;

const DECISIVE = new Set(["passed", "failed", "flaky"]);
export const isDecisive = (o: Obligation) => DECISIVE.has(o.status);
export const isApplicable = (o: Obligation) => o.status !== "not_applicable";
export const weightOf = (o: Obligation) => o.riskWeight ?? RISK_WEIGHT[o.priority];

/** decisive = 1, inconclusive = 0.25 (something ran), blocked, unsupported or skipped = 0. */
export function testedFactor(o: Obligation) {
  if (isDecisive(o)) return 1;
  if (o.status === "inconclusive") return 0.25;
  return 0;
}

/** strong with the target reached (and, for writes, the state read back) = 1, moderate = 0.7, weak = 0.35. */
export function evidenceFactor(o: Obligation) {
  const s = o.oracleStrength ?? "moderate";
  if (s === "weak") return 0.35;
  if (s === "moderate") return 0.7;
  if (o.reachedTarget === false) return 0.7;
  if (o.proofClass === "state_change" && !o.stateVerified) return 0.7;
  return 1;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function completeness(obs: Obligation[], target = COMPLETENESS_THRESHOLD): NonNullable<TestingReport["completeness"]> {
  const applicable = obs.filter(isApplicable);
  const applicableWeight = applicable.reduce((s, o) => s + weightOf(o), 0);
  const earnedWeight = applicable.reduce((s, o) => s + weightOf(o) * testedFactor(o) * evidenceFactor(o), 0);
  const critical = applicable.filter((o) => o.priority === "critical");
  return {
    percent: applicableWeight ? round1((earnedWeight / applicableWeight) * 100) : 0,
    earnedWeight: round1(earnedWeight),
    applicableWeight,
    criticalDecisive: critical.filter(isDecisive).length,
    criticalTotal: critical.length,
    threshold: target,
  };
}

export function productHealth(obs: Obligation[]): NonNullable<TestingReport["productHealth"]> {
  const decisive = obs.filter(isDecisive);
  const passedWeight = decisive.filter((o) => o.status === "passed").reduce((s, o) => s + weightOf(o), 0);
  const decisiveWeight = decisive.reduce((s, o) => s + weightOf(o), 0);
  const count = (st: Obligation["status"]) => obs.filter((o) => o.status === st).length;
  return {
    percent: decisiveWeight ? round1((passedWeight / decisiveWeight) * 100) : null,
    passedWeight,
    decisiveWeight,
    excluded: { inconclusive: count("inconclusive"), blocked: count("blocked"), unsupported: count("unsupported"), skipped: count("skipped") },
  };
}

// ---------------------------------------------------------------- proof classes

/** The proof an obligation gives when it passes, from its id pattern (planning rules). Workers may refine it. */
export function classify(o: Obligation): { proofClass: ProofClass; oracleStrength: OracleStrength } {
  const id = o.id;
  const kind = id.split(":").at(-1) ?? "";
  if (/^env:boot:/.test(id)) return { proofClass: "availability", oracleStrength: "strong" };
  if (/^env:/.test(id)) return { proofClass: "static", oracleStrength: "strong" };
  if (/^suite:runs:/.test(id)) return { proofClass: "static", oracleStrength: "moderate" };
  if (/^suite:passes:/.test(id)) return { proofClass: "business_behavior", oracleStrength: "strong" };
  if (o.layer === "api") {
    if (kind === "unauthenticated") return { proofClass: "guard", oracleStrength: "moderate" };
    if (kind === "wrong-role") return { proofClass: "guard", oracleStrength: "strong" };
    if (kind === "malformed-body" || kind === "empty-body" || kind === "invalid-id") return { proofClass: "validation", oracleStrength: "moderate" };
    if (kind === "public" || kind === "no-server-error" || kind === "missing-target") return { proofClass: "availability", oracleStrength: "weak" };
    return { proofClass: "business_behavior", oracleStrength: "moderate" };
  }
  if (o.layer === "unit") return { proofClass: "business_behavior", oracleStrength: "strong" };
  if (o.layer === "ui") return kind === "journey" || /:journey:/.test(id) ? { proofClass: "journey", oracleStrength: "strong" } : { proofClass: "availability", oracleStrength: "moderate" };
  if (o.layer === "accessibility") return { proofClass: "accessibility", oracleStrength: "strong" };
  if (o.layer === "data") return { proofClass: /schema/.test(id) ? "static" : "data_integrity", oracleStrength: "strong" };
  if (o.layer === "performance") return { proofClass: "capacity", oracleStrength: "strong" };
  if (o.layer === "reliability") return { proofClass: "reliability", oracleStrength: "strong" };
  if (o.layer === "job" || o.layer === "integration") return { proofClass: "business_behavior", oracleStrength: "moderate" };
  return { proofClass: "availability", oracleStrength: "moderate" };
}

/** Fills the assurance fields of a planned obligation (risk weight, proof class, strength, capability). */
export function withAssurance(o: Obligation, capability: string | null): Obligation {
  const c = classify(o);
  return {
    ...o,
    riskWeight: o.riskWeight ?? RISK_WEIGHT[o.priority],
    proofClass: o.proofClass ?? c.proofClass,
    oracleStrength: o.oracleStrength ?? c.oracleStrength,
    reachedTarget: o.reachedTarget ?? null,
    stateVerified: o.stateVerified ?? false,
    dependsOn: o.dependsOn ?? [],
    fixtureRefs: o.fixtureRefs ?? [],
    blockedBy: o.blockedBy ?? null,
    capability: o.capability !== undefined ? o.capability : capability,
  };
}

// ---------------------------------------------------------------- capabilities (user goals)

const STRUCTURAL = new Set(["api", "rest", "graphql", "internal", "public", "private", "app", "web", "v1", "v2", "v3", "v4"]);
const SIGN_IN = /^(auth|login|logout|signin|sign-in|signup|sign-up|register|session|sessions|activate|token|oauth|password|me|account)$/i;
const PARAM = /^(:|\{|<|\[)|^\*$/;

const title = (s: string) => s.replace(/[-_]+/g, " ").replace(/\.\w+$/, "").replace(/^\w/, (c) => c.toUpperCase());

/** Role words used as path prefixes (/admin/menu, /staff/orders) are not capabilities. */
export function roleWords(d: ProjectDossier): Set<string> {
  const out = new Set(["admin", "staff", "customer", "user", "manager", "owner", "dashboard", "portal", "backoffice"]);
  for (const r of d.securityModel?.roles ?? []) if (r.kind === "app_role") for (const v of r.values) out.add(v.toLowerCase());
  return out;
}

/** The capability a route or screen path belongs to, e.g. /admin/menu/items/:id becomes "Menu". */
export function capabilityOfPath(path: string, roles: Set<string>): string {
  const segs = path.split("?")[0]!.split("/").filter(Boolean);
  while (segs.length && STRUCTURAL.has(segs[0]!.toLowerCase())) segs.shift();
  if (segs.length > 1 && roles.has(segs[0]!.toLowerCase())) segs.shift();
  const first = segs.find((s) => !PARAM.test(s) && s.length > 2);
  if (!segs.length) return "Home";
  if (SIGN_IN.test(segs[0]!)) return "Sign-in";
  if (!first) return roles.has(segs[0]!.toLowerCase()) ? title(segs[0]!) : "Pages";
  if (SIGN_IN.test(first)) return "Sign-in";
  return title(first);
}

const stem = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "").replace(/(ies)$/, "y").replace(/s$/, "");

/** Capability for an obligation, consistent across layers (an entity "order_items" joins "Orders"). */
export function capabilityOf(o: Obligation, d: ProjectDossier, known: string[], roles = roleWords(d)): string | null {
  if (o.layer === "environment" || o.layer === "existing_suite" || o.layer === "performance" || o.layer === "reliability" || o.layer === "deployment") return null;
  if (o.asset.kind === "endpoint") return capabilityOfPath(o.asset.label.replace(/^[A-Z]+\s+/, ""), roles);
  if (o.asset.kind === "screen") return capabilityOfPath(o.asset.label, roles);
  if (o.asset.kind === "entity") {
    const s = stem(o.asset.label.split(/[_\s]/)[0]!);
    return known.find((k) => stem(k) === s || stem(k).startsWith(s) || s.startsWith(stem(k))) ?? title(o.asset.label);
  }
  if (o.asset.kind === "function") {
    const base = o.asset.ref.split("/").pop()!.replace(/\.\w+$/, "").replace(/[-_.]?(service|logic|utils?|lib|helpers?|domain)$/i, "");
    return known.find((k) => stem(k) === stem(base)) ?? title(base || "Logic");
  }
  if (o.asset.kind === "job") return "Background jobs";
  if (o.asset.kind === "integration") return "Integrations";
  return null;
}

/** Existing test cases whose file or name mentions a capability (mapped by name, a heuristic). */
export function testsForCapability(name: string, cases: Array<{ name: string; file: string | null }>) {
  const s = stem(name.split(" ")[0]!);
  if (s.length < 3) return 0;
  return cases.filter((c) => stem(`${c.file ?? ""}`).includes(s) || c.name.toLowerCase().replace(/[^a-z]/g, "").includes(s)).length;
}

// ---------------------------------------------------------------- release policy

type Gate = NonNullable<TestingReport["release"]>["gates"][number];

/** The deterministic release policy. No model can override it. */
export function releaseDecision(input: {
  obs: Obligation[];
  findings: TestFinding[];
  completeness: NonNullable<TestingReport["completeness"]>;
  auditOk: boolean;
  thresholdsSet: boolean;
}): NonNullable<TestingReport["release"]> {
  const { obs, findings, completeness: c } = input;
  const open = (f: TestFinding) => f.status !== "rejected";
  const confirmedBlocking = findings.filter((f) => f.kind === "product_defect" && f.status === "confirmed" && (f.severity === "critical" || f.severity === "high"));
  const suspectedBlocking = findings.filter((f) => f.kind === "product_defect" && f.status === "suspected" && (f.severity === "critical" || f.severity === "high"));
  const toolProblems = findings.filter((f) => f.kind === "tool_failure" && open(f));
  const envFindings = findings.filter((f) => f.kind === "environment_failure" && open(f));
  const gates: Gate[] = [];
  const add = (id: string, label: string, ok: boolean | null, detail: string) => gates.push({ id, label, ok, detail });

  add("completeness", `Testing completeness reached the ${c.threshold}% target`, c.percent >= c.threshold, `${c.percent}% of risk-weighted applicable scope has decisive, strong evidence (target ${c.threshold}%, chosen for this run)`);
  add("critical", "Every critical obligation is decisive", c.criticalTotal === 0 ? null : c.criticalDecisive === c.criticalTotal, c.criticalTotal ? `${c.criticalDecisive} of ${c.criticalTotal} critical checks gave a pass or fail verdict` : "no critical obligations");

  const journeys = obs.filter((o) => o.proofClass === "journey" && o.priority === "critical");
  const screens = obs.some((o) => o.layer === "ui");
  add("journeys", "Critical user journeys passed", journeys.length ? journeys.every((o) => o.status === "passed") : screens ? false : null, journeys.length ? `${journeys.filter((o) => o.status === "passed").length} of ${journeys.length} critical journeys passed` : screens ? "the project has screens but no critical journey was proven" : "the project has no screens");

  add("defects", "No open critical or high product defect", confirmedBlocking.length + suspectedBlocking.length === 0, confirmedBlocking.length ? `${confirmedBlocking.length} confirmed: ${confirmedBlocking.slice(0, 3).map((f) => f.title).join("; ")}` : suspectedBlocking.length ? `${suspectedBlocking.length} suspected and not yet reviewed` : "none");

  const core = obs.filter((o) => /^env:(install|build|typecheck|boot):/.test(o.id));
  const coreBad = core.filter((o) => o.status !== "passed");
  add("build", "Install, build, typecheck and start passed", core.length ? coreBad.length === 0 : null, coreBad.length ? coreBad.map((o) => `${o.asset.label}: ${o.id.split(":")[1]} ${o.status}`).join("; ") : core.length ? `${core.length} of ${core.length} passed` : "nothing to build or start");

  // Checks left without a verdict by cybercheck's own problems (its setup, its scenarios, its tools): above a
  // tenth of the applicable weight the testing system, not the product, decides too much of the result.
  const engineIds = new Set(findings.filter((f) => (f.kind === "test_defect" || f.kind === "tool_failure") && f.status !== "rejected").flatMap((f) => f.obligationIds));
  const engineLost = obs.filter((o) => isApplicable(o) && (o.status === "inconclusive" || o.status === "blocked") && (engineIds.has(o.id) || o.blockedBy === "fixture" || /^The check itself was wrong/.test(o.reason ?? "")));
  const allWeight = obs.filter(isApplicable).reduce((s, o) => s + weightOf(o), 0);
  const lostShare = allWeight ? engineLost.reduce((s, o) => s + weightOf(o), 0) / allWeight : 0;
  const integrityOk = toolProblems.length === 0 && input.auditOk && lostShare <= 0.1;
  add("integrity", "Testing-system problems within allowance (at most 10% of the weight) and no report contradiction", integrityOk, toolProblems.length ? `${toolProblems.length} testing-system failure(s): ${toolProblems.slice(0, 2).map((f) => f.title).join("; ")}` : !input.auditOk ? "a report check failed" : lostShare > 0.1 ? `${engineLost.length} check(s) (${Math.round(lostShare * 100)}% of the applicable weight) got no verdict because of cybercheck's own setup or scenarios` : engineLost.length ? `report checks passed; ${engineLost.length} check(s) without a verdict because of cybercheck (${Math.round(lostShare * 100)}% of the weight, within the 10% allowance)` : "report checks passed");

  const a11y = obs.filter((o) => o.layer === "accessibility");
  const a11yFindings = findings.filter((f) => f.layer === "accessibility" && f.status === "confirmed" && (f.severity === "critical" || f.severity === "high"));
  const seriousA11y = findings.filter((f) => f.layer === "accessibility" && f.status === "confirmed" && f.severity === "medium").length;
  add("accessibility", "No critical accessibility violation", a11y.length ? a11yFindings.length === 0 && a11y.some(isDecisive) : null, a11y.length ? (a11yFindings.length ? `${a11yFindings.length} critical rule violation(s)` : `${a11y.filter(isDecisive).length} screen check(s) decisive${seriousA11y ? `; ${seriousA11y} serious violation(s) reported as findings, not blocking` : ""}`) : "no screens were checked");

  const perf = obs.filter((o) => o.layer === "performance" && !/:smoke$/.test(o.id));
  add("performance", "Load thresholds met", input.thresholdsSet && perf.length ? perf.every((o) => o.status === "passed") : null, !input.thresholdsSet ? "no thresholds were set, so load results are measurements" : perf.length ? `${perf.filter((o) => o.status === "passed").length} of ${perf.length} load stages within thresholds` : "no load stage ran");

  const unknowns = obs.filter((o) => !["passed", "failed", "flaky", "not_applicable"].includes(o.status));
  add("unknowns", "Every unknown has a reason", unknowns.every((o) => Boolean(o.reason)), `${unknowns.length} check(s) without a verdict, each with its reason`);

  const failed = gates.filter((g) => g.ok === false);
  const coreEnv = coreBad.some((o) => o.status === "blocked" || o.findingIds.some((id) => envFindings.some((f) => f.id === id)));
  const nothingDecisive = !obs.some(isDecisive);
  // A failed install, build, typecheck or start caused by the code itself is a product failure, whatever its severity.
  const coreDefect = coreBad.some((o) => o.status === "failed" && o.findingIds.some((id) => findings.some((f) => f.id === id && f.kind === "product_defect" && f.status === "confirmed")));
  const decision: NonNullable<TestingReport["release"]>["decision"] = confirmedBlocking.length || coreDefect
    ? "not_ready_product_failures"
    : nothingDecisive || coreEnv
      ? "not_ready_environment_blocked"
      : failed.length
        ? "not_ready_insufficient_evidence"
        : "ready";
  return { decision, gates, reasons: failed.map((g) => `${g.label}: ${g.detail}`) };
}

export const DECISION_LABEL: Record<NonNullable<TestingReport["release"]>["decision"], string> = {
  ready: "Ready to release",
  ready_with_accepted_risk: "Ready with accepted risk",
  not_ready_product_failures: "Not ready: confirmed product defects",
  not_ready_insufficient_evidence: "Not ready: insufficient evidence",
  not_ready_environment_blocked: "Not ready: the environment blocked testing",
};

export function assessment(decision: NonNullable<TestingReport["release"]>["decision"], obs: Obligation[], findings: TestFinding[]): NonNullable<TestingReport["assessment"]> {
  if (!obs.some(isDecisive)) return "could_not_test";
  if (findings.some((f) => f.kind === "product_defect" && f.status === "confirmed")) return "defects_found";
  if (findings.some((f) => f.kind === "tool_failure" && f.status !== "rejected")) return "testing_system_problem";
  return decision === "ready" ? "ready_with_evidence" : "insufficient_evidence";
}
