// Debug helper (local only): runs the boot planner for one snapshot and prints the plan or the error.
// Usage (from apps/api): node --env-file-if-exists=../../.env --import tsx scripts/debug-boot.ts <snapshotId>
import { desc, eq } from "drizzle-orm";
import type { ProjectDossier } from "@cybercheck/contracts";
import { db, pool } from "../src/db/client.ts";
import { snapshot, understandingRun } from "../src/db/schema.ts";
import { objectStore } from "../src/storage/object-store.ts";
import { getSnapshotSource } from "../src/understanding/source.ts";
import { planWorkspaces } from "../src/testing/adapters.ts";
import { planBoot } from "../src/testing/agents.ts";
import { sessionFor } from "../src/testing/worker.ts";

const id = process.argv[2]!;
const [snap] = await db.select().from(snapshot).where(eq(snapshot.id, id));
const [ur] = await db.select().from(understandingRun).where(eq(understandingRun.snapshotId, id)).orderBy(desc(understandingRun.createdAt)).limit(1);
const d = ur!.dossier as ProjectDossier;
const src = await getSnapshotSource(objectStore, snap!.archiveObjectKey!);
const ws = planWorkspaces(d, src);
const session = sessionFor();
const plan = await planBoot(session, d, src, ws);
console.log(JSON.stringify(plan, null, 1).slice(0, 6000));
console.log("usage", session?.usage.map((u) => `${u.purpose} ${u.model} ok=${u.ok} $${u.costUsd.toFixed(4)}`));
await pool.end();
