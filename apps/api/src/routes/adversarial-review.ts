import { eq } from "drizzle-orm";
import type { AdversarialCampaign, AdversarialFinding } from "@cybercheck/contracts";
import { adversarialRepairScope } from "../adversarial/repair.ts";
import { db } from "../db/client.ts";
import { adversarialCampaign } from "../db/schema.ts";
import { adversarialRunForUser } from "./adversarial.ts";
import { checkReviewRoutes } from "./check-review.ts";

/** Human review and approved sandbox repair for AI Adversarial findings (reproduced by attack campaigns). */
export const adversarialReviewRoutes = checkReviewRoutes<AdversarialFinding>({
  path: "adversarial-runs",
  label: "AI Adversarial",
  key: "adversarial",
  runForUser: adversarialRunForUser,
  machineConfirmed: (f) => f.status === "confirmed",
  scopeFor: async (run, f) => adversarialRepairScope(f, (await db.select().from(adversarialCampaign).where(eq(adversarialCampaign.runId, run.id))).map((c) => c.data as AdversarialCampaign)),
  auditMachine: (f) => ({ status: f.status, severity: f.severity, lane: f.lane }),
});
