import type { SecurityFinding, TestExecution } from "@cybercheck/contracts";
import type { SnapshotSource } from "../understanding/source.ts";

// Finding validation (Security Round 1, step 5): before a finding is stored, its evidence must belong to this run and
// this snapshot, and its status must follow the class rules. Nothing a tool printed can bypass this.

/** Classes the plan says only a differential runtime proof may confirm. */
const RUNTIME_ONLY = new Set(["sql-injection", "command-injection", "code-injection", "xss", "path-traversal", "ssrf", "open-redirect", "unsafe-deserialization", "mass-assignment", "authorization"]);

export type ValidationNote = { findingId: string; note: string };

export function validateFindings(findings: SecurityFinding[], src: SnapshotSource, executions: TestExecution[]): { findings: SecurityFinding[]; notes: ValidationNote[] } {
  const execIds = new Set(executions.map((e) => e.id));
  const exists = (e: { path: string; line: number }) => {
    const f = src.files.get(e.path);
    return Boolean(f && e.line >= 1 && e.line <= f.lines);
  };
  const notes: ValidationNote[] = [];
  const out: SecurityFinding[] = [];
  for (const f of findings) {
    const evidence = f.evidence.filter(exists);
    const location = f.location && exists(f.location) ? f.location : (evidence[0] ?? null);
    const executionIds = f.executionIds.filter((id) => execIds.has(id));
    let status = f.status;
    let confirmation = f.confirmation;
    if (evidence.length < f.evidence.length) notes.push({ findingId: f.id, note: `${f.evidence.length - evidence.length} evidence reference(s) are not in this snapshot and were dropped.` });
    if (executionIds.length < f.executionIds.length) notes.push({ findingId: f.id, note: "An execution it cited does not belong to this run and was dropped." });
    // A confirmed finding needs evidence of its own kind: a location in this snapshot, an execution of this run, or the
    // intake record (a secret file is never read, so it has neither).
    const intakeRecord = f.trust === "source_evidence" && f.category === "secrets" && f.rootCause.startsWith("secret-file:");
    if (status === "confirmed" && !evidence.length && !intakeRecord) {
      status = "suspected";
      confirmation = `${confirmation} Downgraded: none of its evidence could be verified in this snapshot.`;
      notes.push({ findingId: f.id, note: "Downgraded to suspected: no verifiable evidence." });
    }
    if (status === "confirmed" && f.trust !== "controlled_reproduction" && RUNTIME_ONLY.has(f.category)) {
      status = "suspected";
      confirmation = `${confirmation} Downgraded: this class is confirmed only by a runtime proof.`;
      notes.push({ findingId: f.id, note: "Downgraded to suspected: injection and authorization need a runtime proof." });
    }
    if (status === "confirmed" && f.trust === "tool_observation" && !executionIds.length) {
      status = "suspected";
      confirmation = `${confirmation} Downgraded: the tool run it came from is not recorded.`;
      notes.push({ findingId: f.id, note: "Downgraded to suspected: its tool run is not recorded in this run." });
    }
    out.push({ ...f, evidence, location, executionIds, status, confirmation });
  }
  return { findings: out, notes };
}
