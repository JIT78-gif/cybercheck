import { eq } from "drizzle-orm";
import type { AiEvaluationCase, AiEvaluationFinding } from "@cybercheck/contracts";
import { aiRepairScope, caseIdsToRun } from "../ai-evaluator/repair.ts";
import { db } from "../db/client.ts";
import { aiEvaluationCase } from "../db/schema.ts";
import { aiRunForUser } from "./ai-evaluator.ts";
import { checkReviewRoutes } from "./check-review.ts";

/** Human review and approved sandbox repair for AI Evaluator findings (reproduced by AI cases and the browser canary). */
export const aiEvaluatorReviewRoutes = checkReviewRoutes<AiEvaluationFinding>({
  path: "ai-evaluation-runs",
  label: "AI Evaluator",
  key: "ai_evaluator",
  runForUser: aiRunForUser,
  machineConfirmed: (f) => f.status === "confirmed",
  scopeFor: async (run, f) => aiRepairScope(f, (await db.select().from(aiEvaluationCase).where(eq(aiEvaluationCase.runId, run.id))).map((c) => c.data as AiEvaluationCase)),
  auditMachine: (f) => ({ status: f.status, severity: f.severity, category: f.category, mode: f.mode, basis: f.basis }),
  // The browser canary is not a case: it only runs when at least one case produces a reply, so a case must be rerunnable.
  runnable: caseIdsToRun,
});
