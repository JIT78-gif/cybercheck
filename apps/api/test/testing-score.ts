import type { TestingRunDetail } from "@cybercheck/contracts";

/** Answer key for a benchmark project (test/testing-bench/<name>/expected.json). Never shown to the engine. */
export type Expected = {
  project: string;
  commands: { requiredEnv?: string[] };
  expectedOutcomes: {
    install?: string;
    build?: string;
    typecheck?: string;
    testSuite?: string;
    failingTests?: string[];
    flakyTests?: string[];
    environmentFailingTests?: string[];
    appBoots?: boolean;
  };
  /** Absent for real projects without a defect answer key: recall and precision are then not scored. */
  defects?: Array<{ id: string; kind?: string; summary: string; path: string; line: number; detectableBy: string; endpoint: string | null; observable?: string; title?: string; mustFind: boolean }>;
  notDefects?: string[];
  mustNotReport?: string[];
  // Engine v2 expectations (all optional).
  /** The release decision the report must reach. */
  release?: string;
  /** Testing completeness must fall in this band (percent). */
  completeness?: [number, number];
  /** Findings that must exist with this classification: title regex and kind. */
  classifications?: Array<{ title: string; kind: string }>;
  /** Minimum decisive checks per layer (proves the worker reached the code). */
  layersDecisive?: Record<string, number>;
  /** Share of fixture graph nodes that must succeed (0 to 1). */
  fixtureSuccess?: number;
};

type Check = { name: string; ok: boolean; detail: string };

/** Same test: full name contained, or the test function name itself (last segment) matches. */
const sameTest = (seen: string, wanted: string) => norm(seen).includes(norm(wanted)) || norm(seen).endsWith(norm(wanted.split(/::|>/).pop()!));
const statusOf = (run: TestingRunDetail, prefix: string) => run.obligations.filter((o) => o.id.startsWith(prefix)).map((o) => o.status);
/** Test names compare the same whether written "a > b", "a b" or pytest's "file::name". */
const norm = (s: string) => s.toLowerCase().replace(/[>›]|::/g, " ").replace(/\s+/g, " ").trim();

/** Whether the project's own suite got the expected verdict (passed, failed, flaky, zero tests, timed out, environment). */
export function suiteVerdict(run: TestingRunDetail, want: string) {
  const runs = statusOf(run, "suite:runs:");
  const passes = statusOf(run, "suite:passes:");
  const verdicts = run.report?.suites?.map((s) => s.verdict) ?? [];
  const ok =
    want === "passed" ? passes.length > 0 && passes.every((s) => s === "passed")
    : want === "failed" ? passes.includes("failed") && !passes.includes("flaky")
    : want === "flaky" ? passes.includes("flaky") || run.findings.some((f) => f.kind === "flaky")
    : want === "zero_tests" ? (verdicts.includes("zero_tests") || (passes.length === 0 && runs.every((s) => s === "not_applicable" || s === "blocked"))) && !passes.includes("passed")
    : want === "timed_out" ? verdicts.includes("timed_out") && !passes.includes("passed")
    : want === "partially_failed_environment" ? !passes.includes("passed") && run.findings.some((f) => f.kind === "environment_failure")
    : false;
  return { ok, detail: `expected ${want}; obligations runs=${runs.join(",")} passes=${passes.join(",")}; report=${verdicts.join(",")}` };
}

/** A test the answer key calls flaky was flagged as flaky. */
export const flakyFlagged = (run: TestingRunDetail, test: string) => run.findings.some((f) => f.kind === "flaky" && sameTest(f.title, test));

/**
 * Score out of 10: outcomes 25%, defect recall 20%, precision 20%, classification 10%, release decision and
 * completeness band 10%, layer coverage and fixture success 10%, report integrity (minus contradictions) 5%.
 * A confirmed false positive costs a full precision point each (capped at 0); a suspected one a quarter.
 */
export function scoreRun(run: TestingRunDetail, exp: Expected) {
  const checks: Check[] = [];
  const o = exp.expectedOutcomes;
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  if (o.install) add("install", statusOf(run, "env:install:").every((s) => (o.install === "passed" ? s === "passed" : s !== "passed")) && statusOf(run, "env:install:").length > 0, statusOf(run, "env:install:").join(","));
  for (const step of ["build", "typecheck"] as const) {
    const want = o[step];
    if (!want) continue;
    const got = statusOf(run, `env:${step}:`);
    if (want === "not_declared") add(step, got.length === 0 || got.every((s) => s === "not_applicable"), got.join(",") || "none planned");
    else add(step, got.length > 0 && (want === "passed" ? got.every((s) => s === "passed" || s === "not_applicable") : got.some((s) => s === want)), `expected ${want}, got ${got.join(",") || "none planned"}`);
  }
  if (o.testSuite) {
    const v = suiteVerdict(run, o.testSuite);
    add("test suite verdict", v.ok, v.detail);
  }
  const failedCases = new Set((run.report?.suites ?? []).flatMap((s) => s.cases.filter((c) => c.status === "failed" || c.status === "error").map((c) => norm(c.name))));
  for (const t of o.failingTests ?? []) add(`failing test seen: ${t}`, [...failedCases].some((c) => sameTest(c, t)), [...failedCases].slice(0, 6).join(" | ") || "no failed cases");
  for (const t of o.flakyTests ?? []) {
    const flagged = run.findings.some((f) => f.kind === "flaky" && sameTest(f.title, t));
    // A flaky test that happened to pass in every run is a miss, but not a wrong claim.
    add(`flaky test flagged: ${t}`, flagged, flagged ? "flagged" : "not flagged");
  }
  for (const t of o.environmentFailingTests ?? []) {
    const asDefect = run.findings.some((f) => f.kind === "product_defect" && f.status === "confirmed" && norm(`${f.title} ${f.reproduction}`).includes(norm(t)));
    add(`offline test not called a defect: ${t}`, !asDefect, asDefect ? "reported as confirmed product defect" : "ok");
  }
  if (o.appBoots !== undefined) {
    const boot = statusOf(run, "env:boot:");
    add("app boots", o.appBoots ? boot.includes("passed") : !boot.includes("passed"), boot.join(",") || "no boot obligation");
  }
  const outcomes = checks.length ? checks.filter((c) => c.ok).length / checks.length : 1;

  // Defects: a confirmed (or, for half credit, suspected) product-defect finding near the right place.
  const defects = run.findings.filter((f) => f.kind === "product_defect" && f.layer !== "environment" && f.status !== "rejected");
  const buildFindings = run.findings.filter((f) => f.kind === "product_defect" && f.layer === "environment");
  const matches = (f: (typeof defects)[number], d: NonNullable<Expected["defects"]>[number]) => {
    const near = f.location && f.location.path === d.path && Math.abs(f.location.line - d.line) <= 15;
    const ep = d.endpoint && norm(`${f.title} ${f.reproduction} ${f.obligationIds.join(" ")}`).includes(norm(d.endpoint));
    const sameFile = f.location?.path === d.path;
    const titled = d.title ? new RegExp(d.title, "i").test(f.title) : false;
    return Boolean(near || titled || (ep && (sameFile || !f.location)) || (ep && d.detectableBy === "api_probe"));
  };
  const notes: string[] = [];
  let found = 0;
  let needed = 0;
  const used = new Set<string>();
  for (const d of exp.defects ?? []) {
    const pool = d.kind && d.kind !== "product_defect" ? buildFindings : defects;
    const hit = pool.filter((f) => matches(f, d)).sort((a, b) => (a.status === "confirmed" ? -1 : 1) - (b.status === "confirmed" ? -1 : 1))[0];
    if (hit) for (const f of pool.filter((x) => matches(x, d))) used.add(f.id);
    const credit = hit ? (hit.status === "confirmed" ? 1 : 0.5) : 0;
    if (d.mustFind) {
      needed++;
      found += credit;
    } else if (credit) {
      notes.push(`stretch defect ${d.id} found (${hit!.status})`);
    }
    notes.push(`defect ${d.id} (${d.mustFind ? "must find" : "stretch"}, ${d.detectableBy}): ${hit ? `${hit.status} as ${hit.id} "${hit.title}"` : "MISSED"}`);
  }
  const recall = needed ? found / needed : 1;
  const extraConfirmed = defects.filter((f) => !used.has(f.id) && f.status === "confirmed");
  const extraSuspected = defects.filter((f) => !used.has(f.id) && f.status === "suspected");
  for (const f of extraConfirmed) notes.push(`FALSE POSITIVE (confirmed) ${f.id}: ${f.title} @ ${f.location ? `${f.location.path}:${f.location.line}` : "?"}`);
  for (const f of extraSuspected) notes.push(`unexpected suspected ${f.id}: ${f.title}`);
  const expectsBuildFailure = o.build === "failed" || o.typecheck === "failed";
  const extraBuild = expectsBuildFailure ? [] : run.findings.filter((f) => f.kind === "product_defect" && f.layer === "environment" && f.status === "confirmed" && !used.has(f.id));
  for (const f of extraBuild) notes.push(`FALSE POSITIVE (build) ${f.id}: ${f.title}`);
  // A passing AI-written check whose cited oracle is the very line of a confirmed defect asserted the defect as correct.
  // Only when the pass is about the same behaviour: it shares the defect's distinctive words ("total", "quantity"),
  // not just the handler (placing an order passes legitimately while the order total is wrong).
  const confirmed = run.findings.filter((f) => f.kind === "product_defect" && f.status === "confirmed" && f.location);
  const COMMON = new Set(["accepts", "returns", "instead", "rejecting", "endpoint", "request", "should", "without", "screen", "screens", "server", "error", "errors"]);
  const words = (f: { title: string }): string[] => f.title.toLowerCase().match(/[a-z]{5,}/g)?.filter((w) => !COMMON.has(w)) ?? [];
  const contradictions = run.obligations.filter((ob) => ob.origin === "authored" && ob.status === "passed" && ob.oracle.evidence.some((e) => confirmed.some((f) => {
    const l = f.location!;
    if (l.path !== e.path || Math.abs(l.line - e.line) > 3) return false;
    const text = `${ob.objective} ${ob.oracle.expected}`.toLowerCase();
    return words(f).filter((w) => !ob.asset.label.toLowerCase().includes(w)).some((w) => text.includes(w));
  })));
  for (const c of contradictions) notes.push(`contradiction ${c.id}: passed while asserting the behaviour of a confirmed defect at the same line`);
  const precision = exp.defects ? Math.max(0, 1 - extraConfirmed.length - extraBuild.length - 0.25 * extraSuspected.length) : 1;

  const audit = run.report?.audit ?? [];
  const integrity = run.report ? audit.filter((a) => a.ok).length / Math.max(1, audit.length) : 0;
  for (const a of audit.filter((x) => !x.ok)) notes.push(`audit failed: ${a.check}: ${a.detail}`);
  for (const c of checks) notes.push(`${c.ok ? "ok" : "WRONG"} ${c.name}: ${c.detail}`);

  // Classification: expected kinds, and no offline or interactive failure ever called a product defect.
  const cls: Check[] = [];
  for (const c of exp.classifications ?? []) {
    const f = run.findings.find((x) => new RegExp(c.title, "i").test(x.title));
    cls.push({ name: `classified ${c.title}`, ok: Boolean(f && f.kind === c.kind), detail: f ? `${f.kind}` : "no such finding" });
  }
  const misclassified = run.findings.filter((f) => f.kind === "product_defect" && f.status === "confirmed" && /ENOTFOUND|EAI_AGAIN|fonts\.googleapis|configure ESLint|ERR_ABORTED/i.test(`${f.actual} ${f.rootCause ?? ""}`));
  cls.push({ name: "no offline or prompt failure called a product defect", ok: misclassified.length === 0, detail: misclassified.map((f) => f.id).join(",") || "none" });
  const classification = cls.filter((c) => c.ok).length / cls.length;
  // Decision and completeness band.
  const dec: Check[] = [];
  if (exp.release) dec.push({ name: "release decision", ok: run.report?.release?.decision === exp.release, detail: `expected ${exp.release}, got ${run.report?.release?.decision ?? "none"}` });
  if (exp.completeness) {
    const pct = run.report?.completeness?.percent ?? -1;
    dec.push({ name: "completeness in band", ok: pct >= exp.completeness[0] && pct <= exp.completeness[1], detail: `${pct}% (band ${exp.completeness.join("-")})` });
  }
  const decision = dec.length ? dec.filter((c) => c.ok).length / dec.length : 1;
  // Coverage: decisive checks per layer, and fixture success.
  const cov: Check[] = [];
  for (const [layer, min] of Object.entries(exp.layersDecisive ?? {})) {
    const n = run.obligations.filter((x) => x.layer === layer && ["passed", "failed", "flaky"].includes(x.status)).length;
    cov.push({ name: `decisive ${layer} checks`, ok: n >= min, detail: `${n} (need ${min})` });
  }
  const nodes = run.report?.fixtures?.nodes ?? [];
  if (exp.fixtureSuccess != null) {
    const share = nodes.length ? nodes.filter((n) => n.ok).length / nodes.length : 0;
    cov.push({ name: "fixture success", ok: share >= exp.fixtureSuccess, detail: `${nodes.filter((n) => n.ok).length} of ${nodes.length}` });
  }
  const coverage = cov.length ? cov.filter((c) => c.ok).length / cov.length : 1;
  for (const c of [...cls, ...dec, ...cov]) notes.push(`${c.ok ? "ok" : "WRONG"} ${c.name}: ${c.detail}`);
  // Contradictions now cost integrity: each one is a claim the report cannot stand behind.
  const integrityScored = Math.max(0, integrity - 0.1 * contradictions.length);

  const score = 10 * (0.25 * outcomes + 0.2 * recall + 0.2 * precision + 0.1 * classification + 0.1 * decision + 0.1 * coverage + 0.05 * integrityScored);
  return { score, outcomes, recall, precision, integrity: integrityScored, classification, decision, coverage, notes };
}
