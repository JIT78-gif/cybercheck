import { and, asc, eq, sql } from "drizzle-orm";
import type { LiveAction, Obligation, TestExecution, TestFinding, TestingPhase } from "@cybercheck/contracts";
import { db } from "../db/client.ts";
import { testExecution, testFinding, testingRun, testObligation, testRunEvent } from "../db/schema.ts";

export class FencedError extends Error {
  constructor() {
    super("This worker no longer owns the run (it was reclaimed or cancelled).");
  }
}

/**
 * All writes for one claimed run. Every write first checks that the run still has the generation
 * this worker claimed, so a stalled worker that wakes up later cannot overwrite a newer attempt.
 */
export class RunStore {
  private seq = 0;
  constructor(
    readonly runId: string,
    readonly generation: number,
  ) {}

  async init() {
    const [r] = await db.select({ max: sql<number>`coalesce(max(${testRunEvent.seq}), 0)` }).from(testRunEvent).where(eq(testRunEvent.runId, this.runId));
    this.seq = Number(r?.max ?? 0);
  }

  private async fenced() {
    const [r] = await db.select({ generation: testingRun.generation, status: testingRun.status }).from(testingRun).where(eq(testingRun.id, this.runId));
    if (!r || r.generation !== this.generation || r.status !== "running") throw new FencedError();
  }

  async event(type: string, message: string, data?: LiveAction) {
    await this.fenced();
    await db.insert(testRunEvent).values({ runId: this.runId, seq: ++this.seq, type, message, data: data ?? null });
  }

  /** Several live actions at once (one sandbox poll), in one insert. */
  async actions(items: Array<{ message: string; data: LiveAction }>) {
    if (!items.length) return;
    await this.fenced();
    await db.insert(testRunEvent).values(items.map((x) => ({ runId: this.runId, seq: ++this.seq, type: "live", message: x.message, data: x.data })));
  }

  /** Usage so far while the run is going (time and AI cost for the live view); the final usage replaces it. */
  async liveUsage(usage: unknown) {
    await this.fenced();
    // Only while running: a tick racing the end of the run must not overwrite the final usage.
    await db.update(testingRun).set({ usage }).where(and(eq(testingRun.id, this.runId), eq(testingRun.generation, this.generation), eq(testingRun.status, "running")));
  }

  async phase(phase: TestingPhase, message: string) {
    await this.fenced();
    await db.update(testingRun).set({ phase }).where(and(eq(testingRun.id, this.runId), eq(testingRun.generation, this.generation)));
    await db.insert(testRunEvent).values({ runId: this.runId, seq: ++this.seq, type: `phase:${phase}`, message });
  }

  async setPlan(plan: unknown) {
    await this.fenced();
    await db.update(testingRun).set({ plan }).where(and(eq(testingRun.id, this.runId), eq(testingRun.generation, this.generation)));
  }

  async putObligations(list: Obligation[], startSeq = 0) {
    await this.fenced();
    if (!list.length) return;
    for (let i = 0; i < list.length; i += 200) {
      const chunk = list.slice(i, i + 200);
      await db
        .insert(testObligation)
        .values(chunk.map((o, j) => ({ runId: this.runId, id: o.id, seq: startSeq + i + j, status: o.status, data: o })))
        .onConflictDoUpdate({ target: [testObligation.runId, testObligation.id], set: { status: sql`excluded.status`, data: sql`excluded.data` } });
    }
  }

  async putExecution(e: TestExecution) {
    await this.fenced();
    await db.insert(testExecution).values({ id: e.id, runId: this.runId, data: e }).onConflictDoUpdate({ target: testExecution.id, set: { data: e } });
  }

  async putFinding(f: TestFinding) {
    await this.fenced();
    await db.insert(testFinding).values({ id: f.id, runId: this.runId, data: f }).onConflictDoUpdate({ target: [testFinding.runId, testFinding.id], set: { data: f } });
  }

  /** A finding merged into another one (same root cause) is removed; its evidence moves to the survivor. */
  async removeFinding(id: string) {
    await this.fenced();
    await db.delete(testFinding).where(and(eq(testFinding.runId, this.runId), eq(testFinding.id, id)));
  }

  async finish(status: "completed" | "partial" | "blocked" | "failed", fields: { report?: unknown; usage?: unknown; error?: string | null }) {
    await this.fenced();
    await db
      .update(testingRun)
      .set({ status, phase: "done", report: fields.report ?? null, usage: fields.usage ?? null, error: fields.error ?? null, finishedAt: new Date() })
      .where(and(eq(testingRun.id, this.runId), eq(testingRun.generation, this.generation)));
  }

  /** A new claim starts from a clean slate (sandbox work is repeatable; events are kept). */
  async reset() {
    await db.delete(testObligation).where(eq(testObligation.runId, this.runId));
    await db.delete(testExecution).where(eq(testExecution.runId, this.runId));
    await db.delete(testFinding).where(eq(testFinding.runId, this.runId));
  }

  async cancelRequested() {
    const [r] = await db.select({ c: testingRun.cancelRequested, g: testingRun.generation }).from(testingRun).where(eq(testingRun.id, this.runId));
    return !r || r.c || r.g !== this.generation;
  }
}

export async function loadEvents(runId: string, after = 0) {
  const rows = await db.select().from(testRunEvent).where(and(eq(testRunEvent.runId, runId), sql`${testRunEvent.seq} > ${after}`)).orderBy(asc(testRunEvent.seq)).limit(500);
  return rows.map((r) => ({ seq: r.seq, type: r.type, message: r.message, at: r.createdAt.toISOString(), ...(r.data ? { data: r.data as LiveAction } : {}) }));
}
