// Shared by the evaluation scripts (eval-testing, eval-security): pack a benchmark folder, take it in as a snapshot the
// way a user upload would, and wait for its analysis. Answer keys are never read here.
import { randomUUID } from "node:crypto";
import { createWriteStream, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import tar from "tar-stream";
import { eq } from "drizzle-orm";
import type { ProjectDossier } from "@cybercheck/contracts";
import { db } from "../src/db/client.ts";
import { project, snapshot, user, workspace, workspaceMember } from "../src/db/schema.ts";
import { startIntake } from "../src/intake/pipeline.ts";
import { INTAKE_POLICY_VERSION } from "../src/intake/policy.ts";
import { ensureUnderstanding } from "../src/understanding/run.ts";

const SKIP = /(^|\/)(node_modules|\.git|dist|build|coverage|\.venv|venv|__pycache__|\.pytest_cache|\.next)(\/|$)/;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function walk(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const rel = relative(base, full).replace(/\\/g, "/");
    if (SKIP.test(rel)) return [];
    return statSync(full).isDirectory() ? walk(full, base) : [rel];
  });
}

export async function packDir(dir: string) {
  const out = join(tmpdir(), `cc-eval-${randomUUID()}.tar.gz`);
  const pack = tar.pack();
  const files = walk(dir);
  const done = pipeline(pack, createGzip(), createWriteStream(out));
  for (const f of files) {
    const body = readFileSync(join(dir, f));
    await new Promise<void>((res, rej) => pack.entry({ name: f, size: body.length, mode: 0o644 }, body, (e) => (e ? rej(e) : res())));
  }
  pack.finalize();
  await done;
  return out;
}

export async function evalUser() {
  const email = "eval-testing@cybercheck.local";
  let [u] = await db.select().from(user).where(eq(user.email, email));
  if (!u) [u] = await db.insert(user).values({ id: randomUUID(), name: "Testing evaluation", email, emailVerified: true }).returning();
  let [ws] = await db.select().from(workspace).where(eq(workspace.createdBy, u!.id));
  if (!ws) {
    [ws] = await db.insert(workspace).values({ id: randomUUID(), name: "Evaluation", personal: true, createdBy: u!.id }).returning();
    await db.insert(workspaceMember).values({ workspaceId: ws!.id, userId: u!.id, role: "owner" });
  }
  return { userId: u!.id, workspaceId: ws!.id };
}

export async function snapshotOf(dir: string, name: string, who: { userId: string; workspaceId: string }, round: string) {
  const [p] = await db.insert(project).values({ id: randomUUID(), workspaceId: who.workspaceId, name: `${name}-r${round}-${Date.now().toString(36)}`, sourceType: "archive", createdBy: who.userId }).returning();
  const [s] = await db.insert(snapshot).values({ id: randomUUID(), projectId: p!.id, status: "RECEIVED", sourceType: "archive", sourceRef: `${name}.tar.gz`, intakePolicyVersion: INTAKE_POLICY_VERSION, ownershipAttestedAt: new Date(), attestedBy: who.userId }).returning();
  startIntake(s!.id, await packDir(dir));
  for (let i = 0; i < 120; i++) {
    const [now] = await db.select().from(snapshot).where(eq(snapshot.id, s!.id));
    if (now!.status === "BASELINED") return now!;
    if (now!.status === "REJECTED" || now!.status === "FAILED") throw new Error(`${name}: snapshot ${now!.status}: ${JSON.stringify(now!.rejectionReasons ?? now!.error)}`);
    await sleep(500);
  }
  throw new Error(`${name}: intake timed out`);
}

export async function readyUnderstanding(snapId: string, name: string) {
  for (let i = 0; i < 400; i++) {
    const run = await ensureUnderstanding(snapId);
    const d = run.dossier as ProjectDossier | null;
    if (run.status === "failed") throw new Error(`${name}: analysis failed`);
    if (run.status === "ready" && d && d.ai?.status !== "running") return run;
    await sleep(3000);
  }
  throw new Error(`${name}: analysis timed out`);
}
