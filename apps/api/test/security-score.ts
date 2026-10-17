import type { SecurityFinding, SecurityRunDetail } from "@cybercheck/contracts";
import type { Expected } from "./testing-score.ts";
import { behaviourWords, endpointPattern, type StrictExpected } from "./testing-score-strict.ts";

/**
 * Strict scoring of a Security run against an answer key (Security Round 1).
 *
 * - Only the Security track counts. A key without Security defects is a control, scored pass or fail.
 * - A finding earns credit for a seeded defect only on evidence: the endpoint it names, or a cited code location on
 *   the defect's file within 15 lines, AND the defect's behaviour words in its title, expectation, observation or
 *   category, AND a CWE that belongs to the defect's category (a plain-password finding near an IDOR is not the IDOR).
 * - One finding satisfies at most one defect (best evidence first). Credit: 1 for confirmed, 0.5 for suspected.
 * - Gates count confirmed findings only. A confirmed finding outside the key is NEEDS REVIEW: it blocks the
 *   confirmed-precision gate until a person adjudicates it. A suspected finding outside the key is unadjudicated.
 * - Precision is reported as a range: the lower bound counts every finding outside the key as false, the upper bound
 *   counts only documented non-defects (mustNotReport, notDefects) as false. Targets are judged on the lower bound.
 */

type Defect = NonNullable<Expected["defects"]>[number] & { track?: string; category?: string };
export type SecurityExpected = Omit<StrictExpected, "defects"> & { defects?: Defect[] };
type Target = { name: string; ok: boolean | null; detail: string };

/** CWE families per answer-key category: OWASP Top 10 2021, with the API Top 10 2023 property-level authorization. */
const FAMILIES: Record<string, number[]> = {
  "OWASP-A01-access-control": [22, 23, 35, 59, 200, 201, 284, 285, 352, 359, 425, 552, 566, 639, 668, 862, 863, 915],
  "OWASP-A02-crypto": [256, 259, 261, 296, 310, 319, 321, 326, 327, 328, 329, 330, 331, 335, 759, 760, 916],
  "OWASP-A03-injection": [74, 77, 78, 79, 80, 89, 90, 91, 94, 95, 116, 643, 917, 943, 1336],
  "OWASP-A05-misconfiguration": [16, 209, 215, 260, 315, 434, 489, 497, 526, 538, 548, 611, 614, 693, 756, 942, 1004, 1021],
  "OWASP-A06-components": [937, 1035, 1104, 1395],
  "OWASP-A07-authentication": [204, 287, 288, 290, 294, 307, 345, 347, 384, 521, 522, 613, 620, 640, 798, 1390, 1391],
  "OWASP-A08-integrity": [345, 353, 426, 494, 502, 565, 784, 829, 830, 915],
  "OWASP-A09-logging": [117, 223, 532, 778],
  "OWASP-A10-SSRF": [918],
  "unvalidated-redirect": [601],
};

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const cweNumbers = (f: SecurityFinding) => f.cwe.map((c) => Number(c.replace(/\D/g, ""))).filter((n) => n > 0);
const behaviourText = (f: SecurityFinding) => norm(`${f.title} ${f.expected} ${f.observed} ${f.category}`);
/** Where the finding says the problem is reached: its title, observation and confirmation name the endpoint. */
const operationText = (f: SecurityFinding) => `${f.title} ${f.observed} ${f.confirmation}`;
const places = (f: SecurityFinding) => [f.location, ...f.evidence].filter((e): e is NonNullable<typeof e> => !!e);

/** How strongly a finding matches a seeded defect on evidence; 0 is no match. */
export function securityMatch(f: SecurityFinding, d: Defect): number {
  const family = d.category ? FAMILIES[d.category] : undefined;
  const cwes = cweNumbers(f);
  if (family && cwes.length && !cwes.some((n) => family.includes(n))) return 0;
  const text = behaviourText(f);
  const said = behaviourWords(d).filter((a) => new RegExp(a, "i").test(text));
  if (!said.length) return 0;
  const operation = d.endpoint ? endpointPattern(d.endpoint).test(operationText(f)) : false;
  // An endpoint defect keeps the 15-line window. An endpoint-less defect (a dependency CVE, a repository-wide
  // misconfiguration) has no meaningful single line: a file-level match counts, or a global match when the finding
  // itself has no location (an absence, such as missing headers).
  const located = d.endpoint ? places(f).some((e) => e.path === d.path && Math.abs(e.line - d.line) <= 15) : places(f).length ? places(f).some((e) => e.path === d.path) : true;
  if (!operation && !located) return 0;
  return (operation ? 2 : 0) + (located ? 2 : 0) + said.length;
}

/** Significant words of a documented non-defect, and whether a finding says most of them. */
function saysNonDefect(f: SecurityFinding, phrase: string) {
  const words = (phrase.toLowerCase().match(/[a-z][a-z-]{4,}/g) ?? []).filter((w) => !["about", "their", "there", "which", "should", "would", "could"].includes(w));
  if (words.length < 2) return false;
  const text = behaviourText(f);
  return words.filter((w) => text.includes(w)).length / words.length >= 0.6;
}

const SERIOUS = new Set(["critical", "high"]);

/**
 * Scores one Security run. `files` maps every snapshot path to its line count: with it, evidence ownership is checked
 * (every cited path exists and every line is in range); without it, that target is not judged.
 */
export function scoreSecurity(run: SecurityRunDetail, exp: SecurityExpected, files?: Map<string, number>) {
  const notes: string[] = [];
  const defects = (exp.defects ?? []).filter((d) => d.track === "security");
  const control = defects.length === 0;
  const reported = run.findings.filter((f) => f.status === "confirmed" || f.status === "suspected");

  // Root causes are merged by the engine; a second finding with the same key is a duplicate, never scored twice.
  const byCause = new Map<string, SecurityFinding>();
  let duplicates = 0;
  for (const f of reported) {
    const prev = byCause.get(f.rootCause);
    if (!prev) byCause.set(f.rootCause, f);
    else {
      duplicates++;
      if (prev.status !== "confirmed" && f.status === "confirmed") byCause.set(f.rootCause, f);
    }
  }
  const findings = [...byCause.values()];

  // One-to-one assignment, strongest evidence first; a confirmed finding wins a tie.
  const pairs = defects.flatMap((d) => findings.map((f) => ({ d, f, s: securityMatch(f, d) }))).filter((p) => p.s > 0);
  pairs.sort((a, b) => b.s - a.s || Number(b.f.status === "confirmed") - Number(a.f.status === "confirmed"));
  const matched = new Map<string, SecurityFinding>();
  const used = new Set<string>();
  for (const p of pairs) {
    if (matched.has(p.d.id) || used.has(p.f.id)) continue;
    matched.set(p.d.id, p.f);
    used.add(p.f.id);
  }

  const rows = defects.map((d) => {
    const f = matched.get(d.id) ?? null;
    const credit = !f ? 0 : f.status === "confirmed" ? 1 : 0.5;
    return { defect: d.id, mustFind: d.mustFind, finding: f?.id ?? null, status: f?.status ?? null, credit };
  });
  for (const r of rows) notes.push(r.finding ? `${r.defect}: ${r.status} by ${r.finding} (credit ${r.credit})` : `${r.defect}: missed${r.mustFind ? " (must find)" : ""}`);

  const outside = findings.filter((f) => !used.has(f.id));
  const nonDefects = [...(exp.mustNotReport ?? []), ...(exp.notDefects ?? [])];
  const knownFalse = outside.filter((f) => nonDefects.some((p) => saysNonDefect(f, p)));
  const needsReview = outside.filter((f) => f.status === "confirmed" && !knownFalse.includes(f));
  const unadjudicated = outside.filter((f) => f.status === "suspected" && !knownFalse.includes(f));
  for (const f of knownFalse) notes.push(`FALSE ${f.status} ${f.id}: "${f.title}" says a documented non-defect`);
  for (const f of needsReview) notes.push(`NEEDS REVIEW confirmed ${f.id} (${f.severity}): "${f.title}" is outside the answer key`);
  for (const f of unadjudicated) notes.push(`unadjudicated suspected ${f.id} (${f.severity}): "${f.title}"`);

  const found = rows.filter((r) => r.finding).length;
  const mustFind = rows.filter((r) => r.mustFind);
  const confirmedTrue = rows.filter((r) => r.status === "confirmed").length;
  const confirmedFalse = knownFalse.filter((f) => f.status === "confirmed").length;
  const recall = defects.length ? found / defects.length : null;
  const weightedRecall = defects.length ? rows.reduce((n, r) => n + r.credit, 0) / defects.length : null;
  const precisionLow = findings.length ? used.size / findings.length : null;
  const precisionHigh = used.size + knownFalse.length ? used.size / (used.size + knownFalse.length) : null;
  const confirmedPrecision = confirmedTrue + confirmedFalse + needsReview.length ? confirmedTrue / (confirmedTrue + confirmedFalse + needsReview.length) : null;

  // Safety and integrity of the run itself.
  // Every execution that runs the project's code or probes it must have the network off. Only the trusted preparation
  // steps (installing dependencies, building the tool image) are allowed the network.
  const PROJECT_EXEC = new Set(["probe", "security_scan", "security_api_proof", "security_browser_proof", "security_canary"]);
  const unsafe = run.executions.filter((e) => PROJECT_EXEC.has(e.kind) && e.network);
  const owned = (e: { path: string; line: number }) => !files || (files.has(e.path) && e.line <= files.get(e.path)!);
  const foreign = reported.flatMap((f) => places(f).filter((e) => !owned(e)).map((e) => `${f.id} ${e.path}:${e.line}`));
  const audit = run.report?.audit ?? [];
  const auditFailed = audit.filter((a) => !a.ok);
  const serious = control ? reported.filter((f) => SERIOUS.has(f.severity)) : knownFalse.filter((f) => SERIOUS.has(f.severity));
  const cov = run.report?.coverage;
  const abstention = cov && cov.applicable ? 1 - cov.decisive / cov.applicable : null;

  const pct = (n: number | null) => (n == null ? "n/a" : `${Math.round(n * 100)}%`);
  const targets: Target[] = [
    { name: "Recall at least 50% (found as suspected or confirmed)", ok: control ? null : recall! >= 0.5, detail: control ? "control" : `${found} of ${defects.length} (${pct(recall)}); weighted by status ${pct(weightedRecall)}` },
    { name: "Precision at least 75% (lower bound)", ok: control || !findings.length ? null : precisionLow! >= 0.75, detail: control ? `control: ${findings.length} finding(s), ${knownFalse.length} of them documented non-defects` : `${used.size} of ${findings.length} reported findings match the key (${pct(precisionLow)} to ${pct(precisionHigh)})` },
    { name: control ? "Control: no critical or high finding" : "No critical or high known-false finding", ok: serious.length === 0, detail: serious.length ? serious.map((f) => `${f.id} ${f.severity} ${f.status}: ${f.title}`).join("; ") : "none" },
    { name: "Confirmed findings adjudicated as true", ok: needsReview.length ? null : confirmedFalse === 0, detail: `${confirmedTrue} true, ${confirmedFalse} false, ${needsReview.length} awaiting review` },
    { name: "Zero unsafe executions (every scan ran with the network off)", ok: unsafe.length === 0, detail: unsafe.length ? unsafe.map((e) => e.id).join(", ") : `${run.executions.filter((e) => e.kind === "security_scan").length} scan execution(s), network off` },
    { name: "Evidence ownership 100%", ok: files ? foreign.length === 0 : null, detail: files ? (foreign.length ? foreign.join(", ") : "every cited path and line is in the snapshot") : "not checked (no file list)" },
    { name: "Report audit clean", ok: run.report ? auditFailed.length === 0 : false, detail: run.report ? (auditFailed.length ? auditFailed.map((a) => a.check).join("; ") : `${audit.length} checks passed`) : "no report" },
  ];

  return {
    control,
    decision: run.report?.decision ?? null,
    rows,
    targets,
    counts: {
      defects: defects.length,
      mustFind: mustFind.length,
      mustFound: mustFind.filter((r) => r.finding).length,
      found,
      confirmedTrue,
      confirmedFalse,
      reported: findings.length,
      needsReview: needsReview.length,
      unadjudicated: unadjudicated.length,
      knownFalse: knownFalse.length,
      duplicates,
    },
    recall,
    weightedRecall,
    precision: { low: precisionLow, high: precisionHigh, confirmed: confirmedPrecision },
    abstention,
    coverage: cov ?? null,
    costUsd: run.usage?.costUsd ?? 0,
    notes,
  };
}
