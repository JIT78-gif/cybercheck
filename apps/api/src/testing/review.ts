import type { FindingHumanReview, Obligation, ReleaseDecision, ReviewedReport, ReviewPrecision, TestFinding, TestingReport } from "@cybercheck/contracts";
import { completeness as completenessOf, productHealth as healthOf, releaseDecision } from "./assurance.ts";

/**
 * Human review of Testing findings, as pure functions over the immutable machine result and the review history.
 * A review never changes a finding, an obligation or the stored report: it produces a new, reviewed version.
 */

/** Below this many confirmed-or-rejected findings, no precision percentage is shown (it would mislead). */
export const MIN_PRECISION_SAMPLE = 5;

/** The findings a human is asked to review: every machine product problem, suspected or confirmed. */
export const reviewable = (f: TestFinding) => f.kind === "product_defect" && f.status !== "rejected";

/** The effective review of each finding: the latest one (reviews are append-only and never edited). */
export function latestReviews(reviews: FindingHumanReview[]): Map<string, FindingHumanReview> {
  const out = new Map<string, FindingHumanReview>();
  for (const r of [...reviews].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) out.set(r.findingId, r);
  return out;
}

/**
 * Of the machine product findings people reviewed, how many they confirmed rather than rejected.
 * Unsure, accepted-risk and unreviewed findings are left out of the denominator.
 */
export function reviewPrecision(findings: TestFinding[], reviews: FindingHumanReview[]): ReviewPrecision {
  const latest = latestReviews(reviews);
  let confirmed = 0;
  let rejected = 0;
  for (const f of findings.filter(reviewable)) {
    const d = latest.get(f.id)?.decision;
    if (d === "confirmed") confirmed++;
    else if (d === "rejected") rejected++;
  }
  const reviewed = confirmed + rejected;
  const percent = reviewed >= MIN_PRECISION_SAMPLE ? Math.round((confirmed / reviewed) * 100) : null;
  const text =
    percent == null
      ? reviewed
        ? `Not enough reviewed findings to estimate precision (${confirmed} of ${reviewed} confirmed so far; ${MIN_PRECISION_SAMPLE} needed)`
        : "Not enough reviewed findings to estimate precision"
      : `${confirmed} of ${reviewed} reviewed findings confirmed (${percent}%)`;
  return { confirmed, rejected, reviewed, percent, minSample: MIN_PRECISION_SAMPLE, text };
}

const BLOCKING = new Set(["critical", "high"]);

/**
 * The run after human review. Rules:
 * - confirmed: the problem is real (it stays, as confirmed);
 * - rejected: no longer an open product problem; its failed checks become "no verdict", never "passed";
 * - unsure: still open (a suspected problem), and worth a targeted evidence run;
 * - accepted risk: real, not fixed now; a high or critical one allows "ready with accepted risk" only when the
 *   run's policy allows it and nothing else blocks the release.
 * Completeness can only stay or fall through review: nothing more was tested.
 */
export function reviewedAssessment(input: {
  runId: string;
  report: TestingReport;
  obligations: Obligation[];
  findings: TestFinding[];
  reviews: FindingHumanReview[];
  projectReviews: { findings: TestFinding[]; reviews: FindingHumanReview[] };
  allowAcceptedRisk: boolean;
  canReview: boolean;
}): ReviewedReport {
  const { report, obligations, findings, reviews } = input;
  const latest = latestReviews(reviews);
  const decisionOf = (f: TestFinding) => (reviewable(f) ? (latest.get(f.id)?.decision ?? null) : null);

  // Findings as they stand after review (copies; the originals are untouched).
  const accepted = new Set<string>();
  const reviewedFindings = findings.map((f): TestFinding => {
    const d = decisionOf(f);
    if (d === "confirmed") return { ...f, status: "confirmed" };
    if (d === "rejected") return { ...f, status: "rejected" };
    if (d === "unsure") return { ...f, status: "suspected" };
    if (d === "accepted_risk") {
      accepted.add(f.id);
      // When accepting risk is allowed, an accepted problem no longer blocks; otherwise it blocks like any other.
      return input.allowAcceptedRisk ? { ...f, status: "confirmed", severity: BLOCKING.has(f.severity) ? "medium" : f.severity } : { ...f, status: "confirmed" };
    }
    return f;
  });

  // A failed check whose only explanation was rejected has no verdict now: it is not turned into a pass.
  const rejectedIds = new Set(findings.filter((f) => decisionOf(f) === "rejected").map((f) => f.id));
  const stillExplained = (o: Obligation) => o.findingIds.some((id) => !rejectedIds.has(id) && reviewedFindings.find((f) => f.id === id)?.status !== "rejected");
  const reviewedObligations = obligations.map((o): Obligation => {
    if (o.status !== "failed" || !o.findingIds.some((id) => rejectedIds.has(id)) || stillExplained(o)) return o;
    return { ...o, status: "inconclusive", reason: `The finding that explained this failure was rejected by a reviewer, so the check has no verdict now (it is not counted as passed). Machine result: ${o.reason ?? "failed"}` };
  });

  const target = report.completeness?.threshold;
  const comp = completenessOf(reviewedObligations, target);
  const health = healthOf(reviewedObligations);
  const auditOk = (report.audit ?? []).every((c) => c.ok);
  const thresholdsSet = report.release?.gates.find((g) => g.id === "performance")?.ok != null;
  const release = releaseDecision({ obs: reviewedObligations, findings: reviewedFindings, completeness: comp, auditOk, thresholdsSet });

  const acceptedBlocking = findings.filter((f) => accepted.has(f.id) && BLOCKING.has(f.severity));
  let decision: ReleaseDecision = release.decision;
  const reasons = [...release.reasons];
  if (decision === "ready" && acceptedBlocking.length && input.allowAcceptedRisk) {
    decision = "ready_with_accepted_risk";
    reasons.push(`${acceptedBlocking.length} high or critical problem(s) were accepted as a known risk by a reviewer: ${acceptedBlocking.map((f) => f.id).join(", ")}`);
  }
  if (acceptedBlocking.length && !input.allowAcceptedRisk) reasons.push("This run's policy does not allow accepting the risk of high or critical problems, so accepted ones still block the release.");

  // Open product problems: confirmed or still suspected, and neither rejected nor accepted as a risk.
  const open = (list: TestFinding[]) => list.filter((f) => f.kind === "product_defect" && f.status !== "rejected" && !accepted.has(f.id)).length;
  const queueOf = (f: TestFinding): ReviewedReport["findings"][number]["queue"] => {
    const d = decisionOf(f);
    return d === "confirmed" ? "confirmed" : d === "rejected" ? "rejected" : d === "unsure" || d === "accepted_risk" ? "accepted_or_unsure" : "awaiting";
  };
  const presented = findings.filter(reviewable);

  return {
    runId: input.runId,
    basedOnReportOf: input.runId,
    reviewIds: reviews.map((r) => r.id),
    machine: {
      decision: report.release?.decision ?? "not_ready_insufficient_evidence",
      completeness: report.completeness?.percent ?? 0,
      productHealth: report.productHealth?.percent ?? null,
      openDefects: open(findings),
    },
    reviewed: {
      decision,
      reasons,
      completeness: comp.percent,
      productHealth: health.percent,
      openDefects: open(reviewedFindings),
      acceptedRisks: accepted.size,
      unsure: presented.filter((f) => decisionOf(f) === "unsure").length,
      awaitingReview: presented.filter((f) => decisionOf(f) == null).length,
    },
    findings: presented.map((f) => ({
      findingId: f.id,
      review: latest.get(f.id) ?? null,
      history: reviews.filter((r) => r.findingId === f.id).length,
      queue: queueOf(f),
      repairEligible: decisionOf(f) === "confirmed",
    })),
    precision: { run: reviewPrecision(findings, reviews), project: reviewPrecision(input.projectReviews.findings, input.projectReviews.reviews) },
    canReview: input.canReview,
    allowAcceptedRisk: input.allowAcceptedRisk,
  };
}
