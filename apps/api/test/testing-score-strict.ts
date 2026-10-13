import type { TestFinding, TestingRunDetail } from "@cybercheck/contracts";
import type { Expected } from "./testing-score.ts";

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
 * - Hard gates cap the score at 8.9 when any of them fails.
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
export const genericInput = (f: Pick<TestFinding, "title">) => /malformed|not json|invalid json|empty json|empty body|json body|malformed id|unparseable/i.test(f.title);
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
  for (const f of findings) {
    const same = clusters.find((c) =>
      c.findings.some(
        (g) =>
          (f.location && g.location && f.location.path === g.location.path && Math.abs(f.location.line - g.location.line) <= 3 && f.layer === g.layer) ||
          titleKey(g) === titleKey(f) ||
          (genericInput(f) && genericInput(g) && f.layer === g.layer),
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
  const pairs = testing.flatMap((d) => clusters.map((c) => ({ d, c, s: Math.max(...c.findings.map((f) => evidenceMatch(f, d))) }))).filter((p) => p.s > 0);
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
  const precision = confirmedTrue + confirmedFalse ? confirmedTrue / (confirmedTrue + confirmedFalse) : null;

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
  const screensOpened = new Set(run.obligations.filter((o) => o.layer === "ui" && o.asset.kind === "screen" && ["passed", "failed"].includes(o.status)).map((o) => o.asset.ref.replace(/\/$/, "") || "/"));
  for (const s of exp.screens ?? []) disc.push({ name: `screen ${s} opened`, ok: screensOpened.has(s.replace(/\/$/, "") || "/"), detail: [...screensOpened].join(", ") || "none" });
  const discovery = disc.length ? disc.filter((g) => g.ok).length / disc.length : 1;

  // Execution and fixtures: the project's own steps behave as expected, and setup succeeds.
  const o = exp.expectedOutcomes;
  const steps: Gate[] = [];
  const st = (prefix: string) => run.obligations.filter((x) => x.id.startsWith(prefix)).map((x) => x.status);
  if (o.install) steps.push({ name: "install", ok: st("env:install:").length > 0 && st("env:install:").every((s) => (o.install === "passed" ? s === "passed" : s !== "passed")), detail: st("env:install:").join(",") });
  if (o.appBoots !== undefined) steps.push({ name: "app boots", ok: o.appBoots ? st("env:boot:").includes("passed") : !st("env:boot:").includes("passed"), detail: st("env:boot:").join(",") || "none" });
  if (o.testSuite === "passed") steps.push({ name: "own suite passes", ok: st("suite:passes:").length > 0 && st("suite:passes:").every((s) => s === "passed"), detail: st("suite:passes:").join(",") || "none" });
  const nodes = run.report?.fixtures?.nodes ?? [];
  const fixtureShare = nodes.length ? nodes.filter((n) => n.ok).length / nodes.length : null;
  const reliability = (steps.length ? steps.filter((g) => g.ok).length / steps.length : 1) * 0.5 + (fixtureShare ?? (exp.fixtureSuccess != null ? 0 : 1)) * 0.5;

  // Report integrity: the report's own audit, and the release decision it reached.
  const audit = run.report?.audit ?? [];
  const auditShare = run.report ? audit.filter((a) => a.ok).length / Math.max(1, audit.length) : 0;
  const releaseOk = exp.release ? run.report?.release?.decision === exp.release : null;
  const integrity = releaseOk == null ? auditShare : (auditShare + Number(releaseOk)) / 2;

  const cost = run.usage?.costUsd ?? 0;
  const deep = (run.report?.profile ?? run.profile) === "deep";
  const unsupported = run.obligations.filter((x) => x.status === "unsupported" && ["api", "ui", "accessibility", "data", "existing_suite", "performance"].includes(x.layer));
  const gates: Gate[] = [
    { name: `all ${mandatory.length} mandatory Testing defects found`, ok: mandatory.every((d) => byDefect.has(d.id)), detail: `${mandatory.filter((d) => byDefect.has(d.id)).length} of ${mandatory.length} (${mandatory.filter((d) => byDefect.get(d.id)?.lead.status === "confirmed").length} confirmed)` },
    { name: `at least ${Math.max(0, testing.length - 1)} of ${testing.length} Testing defects found`, ok: testing.filter((d) => byDefect.has(d.id)).length >= testing.length - 1, detail: `${testing.filter((d) => byDefect.has(d.id)).length} found` },
    { name: "no known confirmed false positive", ok: confirmedFalse === 0, detail: `${confirmedFalse}` },
    { name: "confirmed-finding precision at least 95%", ok: precision == null ? null : precision >= 0.95, detail: precision == null ? "no adjudicated confirmed finding" : `${Math.round(precision * 100)}%` },
    { name: "no business behaviour passed on a status code alone", ok: statusOnly.length === 0, detail: statusOnly.slice(0, 4).map((x) => x.id).join(", ") || "none" },
    { name: "all expected screens opened", ok: exp.screens?.length ? (exp.screens ?? []).every((s) => screensOpened.has(s.replace(/\/$/, "") || "/")) : null, detail: exp.screens?.length ? `${[...screensOpened].join(", ") || "none"}` : "the answer key lists no screens" },
    { name: "fixture success at least 95%", ok: fixtureShare == null ? null : fixtureShare >= 0.95, detail: fixtureShare == null ? "no fixture graph" : `${nodes.filter((n) => n.ok).length} of ${nodes.length}` },
    { name: "no unsupported result in a supported layer", ok: unsupported.length === 0, detail: unsupported.slice(0, 4).map((x) => x.id).join(", ") || "none" },
    { name: "no duplicated finding for one root cause", ok: duplicates.length === 0, detail: `${duplicates.length}` },
    { name: "Deep run AI cost at most $1", ok: deep ? cost <= 1 : null, detail: `$${cost.toFixed(3)}${deep ? "" : " (not a Deep run)"}` },
  ];
  for (const g of gates) notes.push(`${g.ok === null ? "n/a" : g.ok ? "GATE ok" : "GATE FAILED"} ${g.name}: ${g.detail}`);
  for (const g of [...disc, ...steps]) notes.push(`${g.ok ? "ok" : "WRONG"} ${g.name}: ${g.detail}`);

  const parts = {
    mandatoryRecall: mandatory.length ? mandatoryCredit / mandatory.length : 1,
    totalRecall: testing.length ? totalCredit / testing.length : 1,
    precision: precision ?? 1,
    oracle,
    discovery,
    reliability,
    integrity,
  };
  const composite = 10 * (0.3 * parts.mandatoryRecall + 0.15 * parts.totalRecall + 0.2 * parts.precision + 0.1 * parts.oracle + 0.1 * parts.discovery + 0.1 * parts.reliability + 0.05 * parts.integrity);
  const failedGates = gates.filter((g) => g.ok === false).length;
  const applicable = run.obligations.filter((x) => x.status !== "not_applicable");
  return {
    score: failedGates ? Math.min(composite, 8.9) : composite,
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
