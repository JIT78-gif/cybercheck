import { EventEmitter } from "node:events";
import { and, eq, gt, sql } from "drizzle-orm";
import type { IntakeEvent } from "@cybercheck/contracts";
import { db } from "../db/client.ts";
import { intakeEvent } from "../db/schema.ts";

/** Persisted progress events (source of truth) plus an in-process bus for live SSE. */
const bus = new EventEmitter();
bus.setMaxListeners(0);

export const TERMINAL_EVENTS = new Set(["baselined", "rejected", "failed"]);

export async function emitIntakeEvent(snapshotId: string, type: string, payload: Record<string, unknown> = {}) {
  // One pipeline writes per snapshot, so max(seq)+1 is safe; the primary key guards it anyway.
  const [row] = await db
    .insert(intakeEvent)
    .values({
      snapshotId,
      seq: sql`(select coalesce(max(${intakeEvent.seq}), 0) + 1 from ${intakeEvent} where ${intakeEvent.snapshotId} = ${snapshotId})`,
      type,
      payload,
    })
    .returning();
  const event = toEvent(row!);
  bus.emit(snapshotId, event);
  return event;
}

export async function listIntakeEvents(snapshotId: string, after = 0): Promise<IntakeEvent[]> {
  const rows = await db
    .select()
    .from(intakeEvent)
    .where(and(eq(intakeEvent.snapshotId, snapshotId), gt(intakeEvent.seq, after)))
    .orderBy(intakeEvent.seq);
  return rows.map(toEvent);
}

export function subscribeIntake(snapshotId: string, fn: (e: IntakeEvent) => void) {
  bus.on(snapshotId, fn);
  return () => bus.off(snapshotId, fn);
}

function toEvent(row: typeof intakeEvent.$inferSelect): IntakeEvent {
  return {
    seq: row.seq,
    type: row.type,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  };
}
