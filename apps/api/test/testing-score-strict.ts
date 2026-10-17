import type { Obligation, TestFinding, TestingRunDetail } from "@cybercheck/contracts";
import { flakyFlagged, suiteVerdict, type Expected } from "./testing-score.ts";

/**
 * Strict scoring of a Testing run against an answer key (the 9+/10 plan, section 1).
 *
 * - Only the Testing track counts toward recall: security, AI and adversarial defects belong to other tabs.
 * - Repeated reports of one root cause are merged first; the duplicates are counted, never scored twice.
 * - A finding earns credit for a seeded defect only on evidence: the operation it executed (method and path)
 *   or, without an endpoint, the layer that observed it, AND the violated behaviour in its title, expectation or
 *   observation. A file and line close by can propose a match but never award one.
 * - One finding cluster satisfies at most one seeded defect.
 * - A finding that matches no seeded defect is unadjudicated, not a false positive. Only findings that match a
 *   documented non-defect (mustNotReport, notDefects) or an offline/prompt failure are known false positives.
 * - Hard gates cap the score at 8.9 when any of them fails. Gates count confirmed findings only: a suspected match
 *   earns half recall credit but never passes a gate, and a confirmed finding nobody has adjudicated blocks the
 *   precision gate until it is reviewed.
 * - A key without Testing defects is a control: it is scored as "no false positive" (pass or fail), never 0 to 10.
 */

type Defect = NonNullable<Expected["defects"]>[number] & { track?: string; category?: string };
export type StrictExpected = Expected & { defects?: Defect[]; screens?: string[] };

type Cluster = { key: string; findings: TestFinding[]; lead: TestFinding };
type Gate = { name: string; ok: boolean | null; detail: string };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const STOP = new Set(["about", "their", "there", "these", "those", "which", "while", "where", "should", "would", "could", "report", "reports", "missing", "passing", "by", "design"]);

/** A seeded endpoint as a pattern: route parameters match one path segment, and the path must end there. */
export function endpointPattern(endpoint: string) {
  const [method, path] = endpoint.split(/\s+/, 2);
  const body = path!
    .split("/")
    .map((seg) => (seg.startsWith(":") || /^\{.+\}$/.test(seg) ? "[^/\\s?:]+" : seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`\\b${method}\\s+${body}(?=$|[\\s?:"'),;])`, "i");
}

/** What the finding says it executed: its reproduction, the checks it failed, and its grouped evidence. */
const operationText = (f: TestFinding) => `${f.reproduction} ${f.obligationIds.join(" ")} ${(f.groupedFrom ?? []).join(" ")} ${f.title}`;
/** What the finding says went wrong: the violated expectation and the observation. */
const behaviourText = (f: TestFinding) => norm(`${f.title} ${f.expected} ${f.actual}`);

/** A failure on malformed or empty input: one generic root cause (the body parser or route validation), never a business behaviour. */
// "Malformed" counts only when it describes the request (its JSON, body or an id), not data the app holds ("the expiry
// date string is malformed, so it compares as text" is a business defect).
export const genericInput = (f: Pick<TestFinding, "title">) => /malformed (json|request|body|payload|input)|malformed[\w -]{0,20}\bid\b|non-numeric id|not json|invalid json|empty json|empty body|json body|unparseable/i.test(f.title);
const INPUT_DEFECT = /malform|json|valid|body|input|pars|400/i;

/**
 * The words of a seeded defect that name the violated behaviour. Words that only name the endpoint's subject
 * ("coupon" for /api/coupons) say what was called, not what went wrong, so they do not count when others remain.
 */
export function behaviourWords(d: Pick<Defect, "title" | "endpoint">) {
  const all = (d.title ?? "").split("|").map((a) => a.trim()).filter(Boolean);
  const segments = (d.endpoint?.split(/\s+/)[1] ?? "").toLowerCase().split("/").filter((s) => s && !s.startsWith(":"));
  const behaviour = all.filter((a) => !segments.some((s) => s.includes(a.toLowerCase()) || a.toLowerCase().includes(s)));
  return behaviour.length ? behaviour : all;
}

/** How strongly a finding matches a seeded defect on evidence; 0 is no match. */
export function evidenceMatch(f: TestFinding, d: Defect): number {
  if (genericInput(f) && !INPUT_DEFECT.test(d.title ?? "")) return 0;
  const alternatives = (d.title ?? "").split("|").map((a) => a.trim()).filter(Boolean);
  const behaviour = behaviourText(f);
  const said = alternatives.filter((a) => new RegExp(a, "i").test(behaviour));
  if (!said.length) return 0;
  // A build or typecheck error is evidence at its file and line: the compiler's message is the assertion.
  if (d.kind && d.kind !== "product_defect") return f.location?.path === d.path && Math.abs(f.location.line - d.line) <= 15 ? 1 + said.length : 0;
  const operation = d.endpoint ? endpointPattern(d.endpoint).test(operationText(f)) : false;
  const observedBy =
    d.detectableBy === "browser" ? ["ui", "accessibility"].includes(f.layer ?? "")
    : d.detectableBy === "database" ? f.layer === "data"
    : false;
  if (!operation && !observedBy) return 0;
  return (operation ? 2 : 1) + said.length;
}

/**
 * Repeated manifestations of one root cause: the same place in the code, the same normalized title, or the same
 * generic input failure (every malformed-body 500 comes from one missing parser error handler).
 */
export function clusterFindings(findings: TestFinding[]): Cluster[] {
  const clusters: Cluster[] = [];
  const titleKey = (f: TestFinding) => norm(f.title).replace(/\d+/g, "#");
  // Words every finding of a kind shares say nothing about which problem it is.
  const FILLER = new Set(["must", "have", "accessibility", "screen", "screens", "should", "page", "pages", "returns", "error", "server"]);
  const words = (f: TestFinding) => new Set((f.title.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP.has(w) && !FILLER.has(w)));
  const similar = (a: TestFinding, b: TestFinding) => {
    const x = words(a);
    const y = words(b);
    const shared = [...x].filter((w) => y.has(w)).length;
    return shared / Math.max(1, Math.min(x.size, y.size)) >= 0.5;
  };
  // Generic input failures share a cause only within one kind: a malformed JSON body, an empty body, a bad id.
  const inputKind = (f: TestFinding) => (/malformed[\w -]{0,20}\bid\b|non-numeric id|invalid id|bad id/i.test(f.title) ? "id" : /empty/i.test(f.title) ? "empty" : "json");
  for (const f of findings) {
    const same = clusters.find((c) =>
      c.findings.some(
        (g) =>
          // The same place in the code is one cause only when the findings also say the same thing (three different
          // accessibility rules on one page are three problems).
          (f.location && g.location && f.location.path === g.location.path && Math.abs(f.location.line - g.location.line) <= 3 && f.layer === g.layer && similar(f, g)) ||
          titleKey(g) === titleKey(f) ||
          (genericInput(f) && genericInput(g) && f.layer === g.layer && inputKind(f) === inputKind(g)),
      ),
    );
    if (same) {
      same.findings.push(f);
      if (same.lead.status !== "confirmed" && f.status === "confirmed") same.lead = f;
    } else clusters.push({ key: f.id, findings: [f], lead: f });
  }
  return clusters;
}

/** Significant words of a documented non-defect, and whether a finding says most of them. */
function saysNonDefect(f: TestFinding, phrase: string) {
  const words = (phrase.toLowerCase().match(/[a-z][a-z-]{4,}/g) ?? []).filter((w) => !STOP.has(w));
  if (words.length < 2) return false;
  const text = behaviourText(f);
  return words.filter((w) => text.includes(w)).length / words.length >= 0.6;
}

const OFFLINE = /ENOTFOUND|EAI_AGAIN|fonts\.googleapis|configure ESLint|ERR_ABORTED/i;

export function scoreStrict(run: TestingRunDetail, exp: StrictExpected) {
  const notes: string[] = [];
  const all = (exp.defects ?? []) as Defect[];
  const testing = all.filter((d) => (d.track ?? "testing") === "testing");
  const others = all.filter((d) => (d.track ?? "testing") !== "testing");
  const buildExpected = exp.expectedOutcomes.build === "failed" || exp.expectedOutcomes.typecheck === "failed";
  const candidates = run.findings.filter((f) => f.kind === "product_defect" && f.status !== "rejected" && (f.layer !== "environment" || buildExpected || all.some((d) => d.kind && d.kind !== "product_defect")));
  const clusters = clusterFindings(candidates);
  const duplicates = clusters.filter((c) => c.findings.length > 1);
  for (const c of duplicates) notes.push(`DUPLICATE root cause reported ${c.findings.length} times: ${c.findings.map((f) => f.id).join(", ")} "${c.lead.title}"`);

  // One-to-one assignment, strongest evidence first.
  // Location never awards credit, but between two evidenced matches it decides which seeded defect a finding is about.
  const near = (c: Cluster, d: Defect) => c.findings.some((f) => f.location?.path === d.path && Math.abs(f.location.line - d.line) <= 15);
  const pairs = testing
    .flatMap((d) => clusters.map((c) => ({ d, c, s: Math.max(...c.findings.map((f) => evidenceMatch(f, d))) })))
    .filter((p) => p.s > 0)
    .map((p) => ({ ...p, s: p.s + (near(p.c, p.d) ? 0.5 : 0) }));
  pairs.sort((a, b) => b.s - a.s || Number(b.c.lead.status === "confirmed") - Number(a.c.lead.status === "confirmed"));
  const byDefect = new Map<string, Cluster>();
  const usedCluster = new Set<string>();
  for (const p of pairs) {
    if (byDefect.has(p.d.id) || usedCluster.has(p.c.key)) continue;
    byDefect.set(p.d.id, p.c);
    usedCluster.add(p.c.key);
  }
  // A cluster that was the best evidence for a second defect too: one finding cannot prove two behaviours.
  for (const d of testing) {
    if (byDefect.has(d.id)) continue;
    const taken = pairs.find((p) => p.d.id === d.id && usedCluster.has(p.c.key));
    if (taken) notes.push(`one finding for two defects: ${taken.c.lead.id} already credited elsewhere, so ${d.id} gets no credit from it`);
  }

  const credit = (c: Cluster | undefined) => (!c ? 0 : c.lead.status === "confirmed" ? 1 : 0.5);
  const mandatory = testing.filter((d) => d.mustFind);
  const mandatoryCredit = mandatory.reduce((n, d) => n + credit(byDefect.get(d.id)), 0);
  const totalCredit = testing.reduce((n, d) => n + credit(byDefect.get(d.id)), 0);
  for (const d of testing) {
    const c = byDefect.get(d.id);
    notes.push(`defect ${d.id} (${d.mustFind ? "must find" : "stretch"}, ${d.detectableBy}): ${c ? `${c.lead.status} as ${c.lead.id} "${c.lead.title}"` : "MISSED"}`);
  }

  // Adjudicate everything else: another track's real defect, a documented non-defect, or unknown.
  const knownFalse: Cluster[] = [];
  const outOfTrack: Cluster[] = [];
  const unadjudicated: Cluster[] = [];
  for (const c of clusters.filter((x) => !usedCluster.has(x.key))) {
    const nonDefect = [...(exp.mustNotReport ?? []), ...(exp.notDefects ?? [])].find((p) => c.findings.some((f) => saysNonDefect(f, p)));
    const offline = c.findings.some((f) => f.status === "confirmed" && OFFLINE.test(`${f.actual} ${f.rootCause ?? ""}`));
    if (nonDefect || offline) {
      knownFalse.push(c);
      notes.push(`FALSE POSITIVE (${c.lead.status}) ${c.lead.id}: ${c.lead.title}; ${nonDefect ? `documented as not a defect: "${nonDefect}"` : "an offline or prompt failure, not the product"}`);
    } else if (others.some((d) => c.findings.some((f) => evidenceMatch(f, d) > 0))) {
      outOfTrack.push(c);
      notes.push(`true finding outside the Testing track ${c.lead.id}: ${c.lead.title}`);
    } else {
      unadjudicated.push(c);
      notes.push(`unadjudicated ${c.lead.status} ${c.lead.id}: ${c.lead.title}`);
    }
  }
  const confirmedTrue = [...byDefect.values(), ...outOfTrack].filter((c) => c.lead.status === "confirmed").length;
  const confirmedFalse = knownFalse.filter((c) => c.lead.status === "confirmed").length;
  const needsReview = unadjudicated.filter((c) => c.lead.status === "confirmed");
  for (const c of needsReview) notes.push(`NEEDS REVIEW confirmed ${c.lead.id}: ${c.lead.title} (not in the answer key: a real defect or a false positive?)`);
  // Adjudicated precision, and its lower bound counting every unreviewed confirmed finding as false: the part uses the bound.
  const precision = confirmedTrue + confirmedFalse ? confirmedTrue / (confirmedTrue + confirmedFalse) : null;
  const precisionLow = confirmedTrue + confirmedFalse + needsReview.length ? confirmedTrue / (confirmedTrue + confirmedFalse + needsReview.length) : null;

  // Semantic oracles: a check that passed while asserting a seeded defect's behaviour accepted the bug as correct.
  const relevant = run.obligations.filter((o) => ["passed", "failed"].includes(o.status) && testing.some((d) => d.endpoint && endpointPattern(d.endpoint).test(`${o.id} ${o.asset.label}`) && behaviourWords(d).some((w) => new RegExp(w, "i").test(`${o.objective} ${o.oracle.expected}`))));
  const wrongOracle = relevant.filter((o) => o.status === "passed" && ["business_behavior", "state_change"].includes(o.proofClass ?? ""));
  for (const o of wrongOracle) notes.push(`WRONG ORACLE ${o.id}: passed while asserting a seeded defect's behaviour`);
  const oracle = relevant.length ? 1 - wrongOracle.length / relevant.length : 1;
  // Business behaviour proven by a status code alone is not proof.
  const statusOnly = run.obligations.filter((o) => o.status === "passed" && ["business_behavior", "state_change"].includes(o.proofClass ?? "") && (o.oracle.source === "http_semantics" || o.oracleStrength === "weak" || (o.proofClass === "state_change" && o.stateVerified === false)));

  // Discovery: decisive checks per layer the answer key requires, and the expected screens.
  const disc: Gate[] = Object.entries(exp.layersDecisive ?? {}).map(([layer, min]) => {
    const n = run.obligations.filter((x) => x.layer === layer && ["passed", "failed", "flaky"].includes(x.status)).length;
    return { name: `decisive ${layer} checks`, ok: n >= min, detail: `${n} (need ${min})` };
  });
  // A screen is named by its route (ui:/admin:renders, label "/admin"); its ref may be the file that serves it.
  const routeOf = (o: Obligation) => o.id.match(/^ui:(\/[^:]*):/)?.[1] ?? (o.asset.label.startsWith("/") ? o.asset.label : o.asset.ref);
  const screensOpened = new Set(run.obligations.filter((o) => o.layer === "ui" && o.asset.kind === "screen" && ["passed", "failed"].includes(o.status)).map((o) => routeOf(o).replace(/\/$/, "") || "/"));
  for (const s of exp.screens ?? []) disc.push({ name: `screen ${s} opened`, ok: screensOpened.has(s.replace(/\/$/, "") || "/"), detail: [...screensOpened].join(", ") || "none" });
  const discovery = disc.length ? disc.filter((g) => g.ok).length / disc.length : 1;

  // Execution and fixtures: the project's own steps behave as expected, and setup succeeds.
  const o = exp.expectedOutcomes;
  const steps: Gate[] = [];
  const st = (prefix: string) => run.obligations.filter((x) => x.id.startsWith(prefix)).map((x) => x.status);
  if (o.install) steps.push({ name: "install", ok: st("env:install:").length > 0 && st("env:install:").every((s) => (o.install === "passed" ? s === "passed" : s !== "passed")), detail: st("env:install:").join(",") });
  if (o.appBoots !== undefined) steps.push({ name: "app boots", ok: o.appBoots ? st("env:boot:").includes("passed") : !st("env:boot:").includes("passed"), detail: st("env:boot:").join(",") || "none" });
  if (o.testSuite) {
    const v = suiteVerdict(run, o.testSuite);
    steps.push({ name: `own suite ${o.testSuite}`, ok: v.ok, detail: v.detail });
  }
  for (const t of o.flakyTests ?? []) steps.push({ name: `flaky test flagged: ${t}`, ok: flakyFlagged(run, t), detail: flakyFlagged(run, t) ? "flagged" : "not flagged" });
  // Every planned setup step counts, also the invalid ones never used. Older reports left those out of the list;
  // their number is in cybercheck's own finding about them.
  const nodes = run.report?.fixtures?.nodes ?? [];
  const listedInvalid = nodes.filter((n) => n.invalid).length;
  const reportedInvalid = Math.max(0, ...run.findings.map((f) => Number(f.title.match(/^(\d+) planned setup step\(s\) were invalid/)?.[1] ?? 0)));
  const invalidNodes = Math.max(listedInvalid, reportedInvalid);
  const plannedNodes = nodes.length + invalidNodes - listedInvalid;
  const workedNodes = nodes.filter((n) => n.ok === true).length;
  const fixtureShare = plannedNodes ? workedNodes / plannedNodes : null;
  const fixtureBlocked = run.obligations.filter((x) => x.blockedBy === "fixture" && !["passed", "failed", "flaky"].includes(x.status));
  const criticalBlocked = fixtureBlocked.filter((x) => x.priority === "critical");
  const reliability = (steps.length ? steps.filter((g) => g.ok).length / steps.length : 1) * 0.5 + (fixtureShare ?? (exp.fixtureSuccess != null ? 0 : 1)) * 0.5;

  // Report integrity: the report's own audit, and the release decision it reached.
  const audit = run.report?.audit ?? [];
  const auditShare = run.report ? audit.filter((a) => a.ok).length / Math.max(1, audit.length) : 0;
  const releaseOk = exp.release ? run.report?.release?.decision === exp.release : null;
  const integrity = releaseOk == null ? auditShare : (auditShare + Number(releaseOk)) / 2;

  const cost = run.usage?.costUsd ?? 0;
  const deep = (run.report?.profile ?? run.profile) === "deep";
  const unsupported = run.obligations.filter((x) => x.status === "unsupported" && ["api", "ui", "accessibility", "data", "existing_suite", "performance"].includes(x.layer));
  const confirmedFor = (d: Defect) => byDefect.get(d.id)?.lead.status === "confirmed";
  const gates: Gate[] = [
    { name: `all ${mandatory.length} mandatory Testing defects confirmed`, ok: mandatory.every(confirmedFor), detail: `${mandatory.filter(confirmedFor).length} of ${mandatory.length} confirmed (${mandatory.filter((d) => byDefect.has(d.id) && !confirmedFor(d)).length} only suspected)` },
    { name: `at least ${Math.max(0, testing.length - 1)} of ${testing.length} Testing defects confirmed`, ok: testing.filter(confirmedFor).length >= testing.length - 1, detail: `${testing.filter(confirmedFor).length} confirmed, ${testing.filter((d) => byDefect.has(d.id)).length} found` },
    { name: "no known confirmed false positive", ok: confirmedFalse === 0, detail: `${confirmedFalse}` },
    {
      name: "confirmed-finding precision at least 95%, every confirmed finding adjudicated",
      ok: needsReview.length ? false : precision == null ? null : precision >= 0.95,
      detail: needsReview.length ? `${needsReview.length} confirmed finding(s) need review: ${needsReview.map((c) => c.lead.id).join(", ")}` : precision == null ? "no adjudicated confirmed finding" : `${Math.round(precision * 100)}%`,
    },
    { name: "no business behaviour passed on a status code alone", ok: statusOnly.length === 0, detail: statusOnly.slice(0, 4).map((x) => x.id).join(", ") || "none" },
    { name: "all expected screens opened", ok: exp.screens?.length ? (exp.screens ?? []).every((s) => screensOpened.has(s.replace(/\/$/, "") || "/")) : null, detail: exp.screens?.length ? `${[...screensOpened].join(", ") || "none"}` : "the answer key lists no screens" },
    {
      name: "fixture success at least 95%, no critical check blocked by setup",
      ok: fixtureShare == null ? (criticalBlocked.length ? false : null) : fixtureShare >= 0.95 && criticalBlocked.length === 0,
      detail: `${fixtureShare == null ? "no fixture graph" : `${workedNodes} of ${plannedNodes} planned step(s) worked${invalidNodes ? ` (${invalidNodes} invalid, never used)` : ""}`}; ${fixtureBlocked.length} check(s) blocked by setup (${criticalBlocked.length} critical)`,
    },
    { name: "no unsupported result in a supported layer", ok: unsupported.length === 0, detail: unsupported.slice(0, 4).map((x) => x.id).join(", ") || "none" },
    { name: "no duplicated finding for one root cause", ok: duplicates.length === 0, detail: `${duplicates.length}` },
    { name: "Deep run AI cost at most $1", ok: deep ? cost <= 1 : null, detail: `$${cost.toFixed(3)}${deep ? "" : " (not a Deep run)"}` },
  ];
  for (const g of gates) notes.push(`${g.ok === null ? "n/a" : g.ok ? "GATE ok" : "GATE FAILED"} ${g.name}: ${g.detail}`);
  for (const g of [...disc, ...steps]) notes.push(`${g.ok ? "ok" : "WRONG"} ${g.name}: ${g.detail}`);

  const parts = {
    mandatoryRecall: mandatory.length ? mandatoryCredit / mandatory.length : 1,
    totalRecall: testing.length ? totalCredit / testing.length : 1,
    precision: precisionLow ?? 1,
    oracle,
    discovery,
    reliability,
    integrity,
  };
  const composite = 10 * (0.3 * parts.mandatoryRecall + 0.15 * parts.totalRecall + 0.2 * parts.precision + 0.1 * parts.oracle + 0.1 * parts.discovery + 0.1 * parts.reliability + 0.05 * parts.integrity);
  const failedGates = gates.filter((g) => g.ok === false).length;
  const applicable = run.obligations.filter((x) => x.status !== "not_applicable");
  // A control project has no Testing defect to find: it answers one question, whether anything false was confirmed.
  const control = testing.length === 0 ? { ok: confirmedFalse === 0 && needsReview.length === 0, detail: confirmedFalse || needsReview.length ? `${confirmedFalse} known false positive(s), ${needsReview.length} confirmed finding(s) to review` : "no confirmed finding to question" } : null;
  if (control) notes.unshift(`CONTROL (no seeded Testing defect): ${control.ok ? "passed" : "FAILED"}, ${control.detail}`);
  const compileFailures = run.findings.reduce((n, f) => n + Number(f.title.match(/^(\d+) behaviour scenario\(s\) cybercheck wrote did not compile/)?.[1] ?? 0), 0);
  return {
    /** Null for a control project: see control. */
    score: control ? null : failedGates ? Math.min(composite, 8.9) : composite,
    control,
    /** What the run was: engine, where its plan came from, and the success criteria of the review of rounds 43 to 45. */
    meta: {
      engine: run.report?.environment?.engine ?? null,
      planSource: run.usage?.planSource ?? null,
      planSourceRunId: run.usage?.planSourceRunId ?? null,
      invalidFixtureNodes: invalidNodes,
      fixtureBlocked: fixtureBlocked.length,
      requirementChecks: run.obligations.filter((x) => x.id.startsWith("req:")).length,
      compileFailures,
      templatesNotBuilt: run.obligations.filter((x) => /^req:.+:template$/.test(x.id)).length,
      journeys: run.obligations.filter((x) => x.id.startsWith("ui:journey:")).length,
    },
    composite,
    failedGates,
    parts,
    gates,
    counts: {
      testingDefects: testing.length,
      found: testing.filter((d) => byDefect.has(d.id)).length,
      mandatory: mandatory.length,
      mandatoryFound: mandatory.filter((d) => byDefect.has(d.id)).length,
      confirmedTrue,
      confirmedFalse,
      needsReview: needsReview.length,
      unadjudicated: unadjudicated.length,
      outOfTrack: outOfTrack.length,
      duplicates: duplicates.length,
      statusOnly: statusOnly.length,
    },
    /** Share of applicable checks that gave no verdict (inconclusive, blocked, skipped, unsupported). */
    abstention: applicable.length ? applicable.filter((x) => ["inconclusive", "blocked", "skipped", "unsupported"].includes(x.status)).length / applicable.length : 0,
    coverage: run.report?.completeness?.percent ?? null,
    costUsd: cost,
    notes,
  };
}
