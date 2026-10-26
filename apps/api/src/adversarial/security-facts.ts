import { and, desc, eq } from "drizzle-orm";
import type { AdversarialReport, SecurityFinding, SecurityReport } from "@cybercheck/contracts";
import { db } from "../db/client.ts";
import { testFinding, testingRun } from "../db/schema.ts";

// The AI Adversarial engine is the chaining layer on top of the Security check: it reuses the weaknesses Security
// already proved per endpoint and sequences them into attack chains, rather than re-proving them. This module loads the
// most recent completed Security run for the same snapshot and exposes its confirmed/suspected findings and its
// authorization matrix as verified starting facts. When no Security run exists, the adversarial run still does its own
// dossier-based recon and records the limitation.

export type AuthMatrix = NonNullable<SecurityReport["authorizationMatrix"]>;
export type SecurityFacts = {
  securityRunId: string;
  findings: SecurityFinding[];
  confirmed: SecurityFinding[];
  suspected: SecurityFinding[];
  authorizationMatrix: AuthMatrix | null;
};

/** The most recent completed Security run for a snapshot, with its confirmed/suspected findings. Null when none. */
export async function loadSecurityFacts(snapshotId: string): Promise<SecurityFacts | null> {
  const [run] = await db
    .select()
    .from(testingRun)
    .where(and(eq(testingRun.check, "security"), eq(testingRun.snapshotId, snapshotId), eq(testingRun.status, "completed")))
    .orderBy(desc(testingRun.createdAt))
    .limit(1);
  if (!run) return null;
  const rows = await db.select().from(testFinding).where(eq(testFinding.runId, run.id));
  const findings = rows.map((r) => r.data as SecurityFinding).filter((f) => f.status === "confirmed" || f.status === "suspected");
  const report = run.report as SecurityReport | null;
  return {
    securityRunId: run.id,
    findings,
    confirmed: findings.filter((f) => f.status === "confirmed"),
    suspected: findings.filter((f) => f.status === "suspected"),
    authorizationMatrix: report?.authorizationMatrix ?? null,
  };
}

/** Security findings in a lane or whose category matches a pattern (e.g. an IDOR, an injection), to chain from. */
export function findingsFor(facts: SecurityFacts | null, match: RegExp): SecurityFinding[] {
  if (!facts) return [];
  return facts.findings.filter((f) => match.test(f.lane) || match.test(f.category) || f.cwe.some((c) => match.test(c)));
}

/** Endpoints where an identity reached a resource it should have been denied (a proven access-control hole to chain). */
export function unexpectedAccess(facts: SecurityFacts | null): Array<{ endpoint: string; identity: string; proofId: string | null }> {
  const m = facts?.authorizationMatrix;
  if (!m) return [];
  const out: Array<{ endpoint: string; identity: string; proofId: string | null }> = [];
  for (const row of m.rows) for (const [identity, cell] of Object.entries(row.cells)) if (cell.outcome === "allowed" && cell.expected === "denied") out.push({ endpoint: row.endpoint, identity, proofId: cell.proofId });
  return out;
}

/** The report's reused-Security summary: what was cited from Security rather than re-proved. */
export function reusedSecuritySummary(facts: SecurityFacts | null, citedFindingIds: string[]): AdversarialReport["reusedSecurity"] {
  if (!facts) return { securityRunId: null, confirmed: 0, suspected: 0, citedFindingIds: [], note: "No completed Security run was found for this snapshot, so the attacker chained only from its own reconnaissance. Run the Security check first for stronger starting evidence." };
  return {
    securityRunId: facts.securityRunId,
    confirmed: facts.confirmed.length,
    suspected: facts.suspected.length,
    citedFindingIds: [...new Set(citedFindingIds)],
    note: `Chained from the Security check's run ${facts.securityRunId.slice(0, 8)} (${facts.confirmed.length} confirmed, ${facts.suspected.length} suspected weakness(es)); those were not re-proved here.`,
  };
}
