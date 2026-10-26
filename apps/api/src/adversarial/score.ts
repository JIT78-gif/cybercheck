import type { AdversarialFinding, AdversarialLane, AdversarialReport } from "@cybercheck/contracts";

/** Private benchmark truth. Production code never loads these records; only the evaluation command imports them. */
export type AdversarialTruth = {
  id: string;
  lane: AdversarialLane;
  techniques: string[];
  endpoint?: string | null;
  sourcePath?: string | null;
  severity: "low" | "medium" | "high" | "critical";
  mustFind: boolean;
};

export type AdversarialAccuracy = {
  score: number;
  mandatoryRecall: number;
  overallRecall: number;
  confirmedPrecision: number;
  severePrecision: number;
  cleanSevereFalsePositives: number;
  decisiveCoverage: number;
  auditPass: boolean;
  stable: boolean;
  matched: Array<{ truthId: string; findingId: string | null }>;
  gates: Array<{ name: string; ok: boolean; actual: number | boolean; required: string }>;
  passed: boolean;
};

const normEndpoint = (x: string | null | undefined) => (x ?? "").replace(/\{[^}]+\}|:\w+/g, ":id").replace(/\/$/, "").toLowerCase();
const ratio = (n: number, d: number) => d ? n / d : 1;
const endpointMatchesTruth = (truth: string, actual: string) => {
  const [tm = "", tp = "/"] = truth.trim().split(/\s+/, 2);
  const [am = "", ap = "/"] = actual.trim().split(/\s+/, 2);
  if (tm.toLowerCase() !== am.toLowerCase()) return false;
  const pattern = tp.split("/").map((segment) => /^:\w+$|^\{[^}]+\}$/.test(segment) ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/");
  return new RegExp(`^${pattern}/?$`, "i").test(ap);
};

function matches(t: AdversarialTruth, f: AdversarialFinding): boolean {
  if (t.lane !== f.lane) return false;
  if (!t.techniques.includes(f.rootCause)) return false;
  const endpointMatches = Boolean(t.endpoint && f.endpoint && (normEndpoint(t.endpoint) === normEndpoint(f.endpoint) || endpointMatchesTruth(t.endpoint, f.endpoint)));
  if (t.endpoint && f.endpoint && !endpointMatches) return false;
  // Source evidence is an additional ownership signal. Some runtime findings cite the route handler while the root
  // cause lives in an imported helper, so an exact owned endpoint remains a valid match when that helper was not cited.
  if (t.sourcePath && f.sourceEvidence.length && !f.sourceEvidence.some((e) => e.path === t.sourcePath) && !endpointMatches) return false;
  return true;
}

/** Balanced 9/10 score. Precision counts every confirmed finding; an unmatched suspected/inconclusive hypothesis is
 *  not called a false positive because the engine did not claim it was a vulnerability. */
export function scoreAdversarial(input: {
  truth: AdversarialTruth[];
  findings: AdversarialFinding[];
  report: AdversarialReport;
  cleanControl?: boolean;
  signatures?: string[];
}): AdversarialAccuracy {
  const active = input.findings.filter((f) => f.status === "confirmed");
  const used = new Set<string>();
  const matched = input.truth.map((t) => {
    const f = active.find((x) => !used.has(x.id) && matches(t, x)) ?? null;
    if (f) used.add(f.id);
    return { truthId: t.id, findingId: f?.id ?? null };
  });
  const mandatory = input.truth.filter((t) => t.mustFind);
  const mandatoryFound = matched.filter((m) => m.findingId && mandatory.some((t) => t.id === m.truthId)).length;
  const mandatoryRecall = ratio(mandatoryFound, mandatory.length);
  const overallRecall = ratio(matched.filter((m) => m.findingId).length, input.truth.length);
  const confirmedPrecision = ratio(used.size, active.length);
  const severe = active.filter((f) => f.severity === "high" || f.severity === "critical");
  const matchedSevere = severe.filter((f) => [...used].includes(f.id)).length;
  const severePrecision = ratio(matchedSevere, severe.length);
  const cleanSevereFalsePositives = input.cleanControl ? severe.length : 0;
  const decisiveCoverage = ratio(input.report.coverage.decisive, input.report.coverage.applicable);
  const auditPass = input.report.audit.every((a) => a.ok);
  const stable = !input.signatures?.length || new Set(input.signatures).size === 1;
  const score = Math.round(100 * (
    0.35 * mandatoryRecall
    + 0.20 * overallRecall
    + 0.20 * confirmedPrecision
    + 0.10 * (cleanSevereFalsePositives === 0 ? 1 : 0)
    + 0.10 * decisiveCoverage
    + 0.05 * (auditPass ? 1 : 0)
  ));
  const critical = input.report.obligations.filter((o) => o.required && o.critical);
  const criticalDecisive = critical.every((o) => o.status === "passed" || o.status === "failed");
  const gates = [
    { name: "mandatory recall", ok: mandatoryRecall >= 0.90, actual: mandatoryRecall, required: ">= 90%" },
    { name: "overall recall", ok: overallRecall >= 0.85, actual: overallRecall, required: ">= 85%" },
    { name: "confirmed high/critical precision", ok: severePrecision >= 0.95, actual: severePrecision, required: ">= 95%" },
    { name: "clean high/critical false positives", ok: cleanSevereFalsePositives === 0, actual: cleanSevereFalsePositives, required: "0" },
    { name: "decisive campaign coverage", ok: decisiveCoverage >= 0.90, actual: decisiveCoverage, required: ">= 90%" },
    { name: "critical lanes decisive", ok: criticalDecisive, actual: criticalDecisive, required: "true" },
    { name: "evidence and redaction audit", ok: auditPass, actual: auditPass, required: "true" },
    { name: "repeat stability", ok: stable, actual: stable, required: "true" },
    { name: "composite score", ok: score >= 90, actual: score, required: ">= 90" },
  ];
  return { score, mandatoryRecall, overallRecall, confirmedPrecision, severePrecision, cleanSevereFalsePositives, decisiveCoverage, auditPass, stable, matched, gates, passed: gates.every((g) => g.ok) };
}
