import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, pool } from "../src/db/client.ts";
import { adversarialCampaign, adversarialChain, adversarialStep, project, snapshot, testingRun, understandingRun, user, workspace } from "../src/db/schema.ts";

// AI Adversarial Step 3: the persistence tables. These confirm a campaign/step/chain round-trips and, crucially, that
// a step can never reference a campaign from another run (the composite foreign key blocks cross-run evidence).

const ids = { user: `u-${randomUUID()}`, ws: `ws-${randomUUID()}`, project: `p-${randomUUID()}`, snap: `s-${randomUUID()}`, ur: `ur-${randomUUID()}`, runA: `run-${randomUUID()}`, runB: `run-${randomUUID()}` };

async function makeRun(id: string) {
  await db.insert(testingRun).values({ id, check: "adversarial", snapshotId: ids.snap, projectId: ids.project, understandingRunId: ids.ur, requestedBy: ids.user, policy: { engine: "test", profile: "standard" }, status: "running", generation: 1, startedAt: new Date(), heartbeatAt: new Date() });
}

beforeAll(async () => {
  await db.insert(user).values({ id: ids.user, name: "Adversarial persistence", email: `${ids.user}@test.local`, emailVerified: true });
  await db.insert(workspace).values({ id: ids.ws, name: "advp", createdBy: ids.user });
  await db.insert(project).values({ id: ids.project, workspaceId: ids.ws, name: `advp-${randomUUID().slice(0, 6)}`, sourceType: "archive", createdBy: ids.user });
  await db.insert(snapshot).values({ id: ids.snap, projectId: ids.project, status: "BASELINED", sourceType: "archive", sourceRef: "x.tgz", intakePolicyVersion: "1", ownershipAttestedAt: new Date(), attestedBy: ids.user });
  await db.insert(understandingRun).values({ id: ids.ur, snapshotId: ids.snap, analyzerVersion: "test", status: "ready" });
  await makeRun(ids.runA);
  await makeRun(ids.runB);
});

afterAll(async () => {
  await db.delete(testingRun).where(eq(testingRun.id, ids.runA));
  await db.delete(testingRun).where(eq(testingRun.id, ids.runB));
  await db.delete(project).where(eq(project.id, ids.project)); // cascades snapshot + understanding
  await db.delete(workspace).where(eq(workspace.id, ids.ws));
  await db.delete(user).where(eq(user.id, ids.user));
  await pool.end();
});

describe("AI Adversarial persistence", () => {
  it("round-trips a campaign, a step and a chain within one run", async () => {
    await db.insert(adversarialCampaign).values({ runId: ids.runA, id: "c-leak", seq: 1, lane: "leakage", techniqueId: "system-prompt-leak", status: "failed", data: { title: "System prompt leak", severity: "critical" } });
    await db.insert(adversarialStep).values({ runId: ids.runA, campaignId: "c-leak", seq: 1, operation: "send_message", executionId: "exec-1", result: "crossed", data: { inputClass: "extraction request" } });
    await db.insert(adversarialChain).values({ runId: ids.runA, id: "chain-1", seq: 1, verdict: "confirmed", data: { campaignIds: ["c-leak"], reachedAsset: "system prompt" } });

    const [c] = await db.select().from(adversarialCampaign).where(and(eq(adversarialCampaign.runId, ids.runA), eq(adversarialCampaign.id, "c-leak")));
    expect((c!.data as { severity: string }).severity).toBe("critical");
    const steps = await db.select().from(adversarialStep).where(eq(adversarialStep.runId, ids.runA));
    expect(steps).toHaveLength(1);
    expect(steps[0]!.operation).toBe("send_message");
    const [chain] = await db.select().from(adversarialChain).where(eq(adversarialChain.runId, ids.runA));
    expect(chain!.verdict).toBe("confirmed");
  });

  it("rejects a step that references a campaign from another run (no cross-run evidence)", async () => {
    // Run B has no campaign "c-leak"; the composite (run_id, campaign_id) foreign key must refuse the step.
    await expect(db.insert(adversarialStep).values({ runId: ids.runB, campaignId: "c-leak", seq: 1, operation: "send_message", result: "crossed", data: {} })).rejects.toThrow();
  });

  it("rejects two campaigns with the same sequence in one run", async () => {
    await expect(db.insert(adversarialCampaign).values({ runId: ids.runA, id: "c-other", seq: 1, lane: "tools_approval", techniqueId: "x", status: "passed", data: {} })).rejects.toThrow();
  });

  it("cascades campaigns, steps and chains when the run is deleted", async () => {
    const tmp = `run-${randomUUID()}`;
    await makeRun(tmp);
    await db.insert(adversarialCampaign).values({ runId: tmp, id: "c1", seq: 1, lane: "prompt", techniqueId: "t", status: "failed", data: {} });
    await db.insert(adversarialStep).values({ runId: tmp, campaignId: "c1", seq: 1, operation: "send_message", result: "crossed", data: {} });
    await db.delete(testingRun).where(eq(testingRun.id, tmp));
    expect(await db.select().from(adversarialStep).where(eq(adversarialStep.runId, tmp))).toHaveLength(0);
    expect(await db.select().from(adversarialCampaign).where(eq(adversarialCampaign.runId, tmp))).toHaveLength(0);
  });
});
