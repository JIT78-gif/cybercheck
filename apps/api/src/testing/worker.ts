import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, pool } from "../db/client.ts";
import { testingRepair, testingRun } from "../db/schema.ts";
import { env, providers } from "../env.ts";
import { objectStore } from "../storage/object-store.ts";
import { AiSession } from "../understanding/ai/gateway.ts";
import { runSecurity } from "../security/orchestrator.ts";
import { runAiEvaluation } from "../ai-evaluator/orchestrator.ts";
import { runAdversarial } from "../adversarial/orchestrator.ts";
// Side-effect imports: register the AI Adversarial and AI Evaluator repair adapters before any repair is processed.
import "../adversarial/repair.ts";
import "../ai-evaluator/repair.ts";
import { runTesting } from "./orchestrator.ts";
import { processRepair } from "./repair.ts";
import { NebiusSandboxProvider } from "./sandbox/nebius.ts";
import type { SandboxProvider } from "./sandbox/provider.ts";
import { FencedError, RunStore } from "./store.ts";

/**
 * The check worker: a separate process from the API (npm run worker). It claims queued runs of every check (Testing,
 * Security), keeps a heartbeat, and hands each run to its engine. A run whose worker stops heartbeating is reclaimed
 * by another worker with a higher generation; the old worker's late writes are rejected (see RunStore).
 */

const WORKER_ID = `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
const STALE_SECONDS = 120;
const CONCURRENCY = Number(process.env.TESTING_WORKER_CONCURRENCY ?? 2);

export const TESTING_MODELS = () =>
  env.TESTING_AI_PROVIDER === "gemini"
    ? { author: env.GEMINI_MODEL_AUTHOR, triage: env.GEMINI_MODEL_TRIAGE, critic: env.GEMINI_MODEL_CRITIC }
    : { author: env.TESTING_MODEL_AUTHOR, triage: env.TESTING_MODEL_TRIAGE, critic: env.TESTING_MODEL_CRITIC };

export function sandboxProvider(): SandboxProvider | null {
  return providers.sandbox ? new NebiusSandboxProvider({ apiKey: env.NEBIUS_API_KEY!, projectId: env.NEBIUS_PROJECT_ID!, baseUrl: env.NEBIUS_SANDBOX_URL }) : null;
}

export async function claimNext(workerId = WORKER_ID): Promise<{ id: string; generation: number } | null> {
  const res = await pool.query<{ id: string; generation: number }>(
    `update testing_run set status = 'running', generation = generation + 1, worker_id = $1, heartbeat_at = now(), started_at = coalesce(started_at, now())
     where id = (
       select id from testing_run
       where (status = 'queued' and not cancel_requested) or (status = 'running' and heartbeat_at < now() - make_interval(secs => $2))
       order by created_at for update skip locked limit 1)
     returning id, generation`,
    [workerId, STALE_SECONDS],
  );
  return res.rows[0] ?? null;
}

/** Runs one claimed run to the end. Exported for tests (which pass a fake provider and session). */
export async function processRun(claim: { id: string; generation: number }, deps: { provider: SandboxProvider | null; session: AiSession | null; onProgress?: (s: string) => void }) {
  const store = new RunStore(claim.id, claim.generation);
  await store.init();
  if (claim.generation > 1) {
    await store.reset();
    await store.event("worker", "Restarted after the previous worker stopped responding; starting from a clean slate");
  }
  const controller = new AbortController();
  const beat = setInterval(async () => {
    try {
      const [r] = await db
        .update(testingRun)
        .set({ heartbeatAt: new Date() })
        .where(and(eq(testingRun.id, claim.id), eq(testingRun.generation, claim.generation)))
        .returning({ cancel: testingRun.cancelRequested });
      if (!r || r.cancel) controller.abort();
    } catch {
      // the next beat retries
    }
  }, 5000);
  try {
    // The run's own check decides the engine; claiming, heartbeat, fencing and cancellation are shared.
    const [row] = await db.select({ check: testingRun.check }).from(testingRun).where(eq(testingRun.id, claim.id));
    const check = row?.check ?? "testing";
    // The AI Evaluator chooses its own runtime (Nebius, local Docker or none): a project with no AI component is
    // finished without any sandbox, and a missing Nebius falls back to Docker.
    if (check === "ai-evaluator") {
      await runAiEvaluation(store, { provider: deps.provider, session: deps.session, objects: objectStore, signal: controller.signal }, deps.onProgress ?? (() => {}));
      return;
    }
    // AI Adversarial chooses its own runtime (Nebius, local Docker or none), like the AI Evaluator.
    if (check === "adversarial") {
      await runAdversarial(store, { provider: deps.provider, session: deps.session, objects: objectStore, signal: controller.signal }, deps.onProgress ?? (() => {}));
      return;
    }
    // Security performs its own live runtime selection: Nebius, local Docker, then an honest analysis-only report.
    // A missing Nebius provider must not stop the worker before that fallback can run.
    if (check === "security") {
      await runSecurity(store, { provider: deps.provider as SandboxProvider, session: deps.session, objects: objectStore, signal: controller.signal }, deps.onProgress ?? (() => {}));
      return;
    }
    if (!deps.provider) {
      await store.finish("failed", { error: `${check === "security" ? "Security" : "Testing"} needs Nebius Sandboxes. Set NEBIUS_API_KEY and NEBIUS_PROJECT_ID in .env.` });
      return;
    }
    const engineDeps = { provider: deps.provider, session: deps.session, objects: objectStore, signal: controller.signal };
    if (check === "testing") await runTesting(store, engineDeps, deps.onProgress ?? (() => {}));
    else await store.finish("failed", { error: `No engine exists for the "${check}" check.` });
  } catch (err) {
    if (err instanceof FencedError) return;
    const cancelled = controller.signal.aborted;
    console.error(`[testing] run ${claim.id} ${cancelled ? "cancelled" : "failed"}:`, cancelled ? "" : err);
    await db
      .update(testingRun)
      .set({ status: cancelled ? "cancelled" : "failed", phase: "done", error: cancelled ? null : `The run stopped: ${(err as Error).message.slice(0, 300)}`, finishedAt: new Date() })
      .where(and(eq(testingRun.id, claim.id), eq(testingRun.generation, claim.generation)));
  } finally {
    clearInterval(beat);
  }
}

/** An approved repair that nobody is working on (or whose worker stopped reporting). */
export async function claimRepair(workerId = WORKER_ID): Promise<string | null> {
  const res = await pool.query<{ id: string }>(
    `update testing_repair set worker_id = $1, heartbeat_at = now()
     where id = (
       select id from testing_repair
       where status = 'running' and not cancel_requested
         and ((worker_id is null and updated_at < now() - interval '10 seconds') or heartbeat_at < now() - make_interval(secs => $2))
       order by created_at for update skip locked limit 1)
     returning id`,
    [workerId, STALE_SECONDS],
  );
  return res.rows[0]?.id ?? null;
}

/** Runs one repair: patch proposals and their validation runs share one AI session, so each attempt's cost is complete. */
export async function runRepair(repairId: string, deps: { provider?: SandboxProvider | null; session?: AiSession | null; propose?: Parameters<typeof processRepair>[1]["propose"] } = {}) {
  const provider = deps.provider === undefined ? sandboxProvider() : deps.provider;
  const session = deps.session === undefined ? sessionFor() : deps.session;
  // Claimed by whoever runs it, so no other worker picks the same repair up.
  await db.update(testingRepair).set({ workerId: WORKER_ID, heartbeatAt: new Date() }).where(eq(testingRepair.id, repairId));
  const beat = setInterval(() => {
    void db.update(testingRepair).set({ heartbeatAt: new Date() }).where(eq(testingRepair.id, repairId)).catch(() => {});
  }, 20_000);
  try {
    return await processRepair(repairId, { provider, session, objects: objectStore, propose: deps.propose, runValidation: (id) => processRun({ id, generation: 1 }, { provider, session }) });
  } finally {
    clearInterval(beat);
  }
}

export function sessionFor(): AiSession | null {
  if (!providers.testingAi) return null;
  const models = TESTING_MODELS();
  if (env.TESTING_AI_PROVIDER === "gemini") {
    // Conservative standard-tier prices keep the pre-flight budget guard safe. Google does not expose prices from
    // its OpenAI-compatible /models response. Update these when selecting a differently priced Gemini model.
    const modelPrices = {
      [models.author]: { inputUsdPerMillion: 1.5, outputUsdPerMillion: 7.5 },
      [models.triage]: { inputUsdPerMillion: 1.5, outputUsdPerMillion: 7.5 },
      [models.critic]: { inputUsdPerMillion: 2.5, outputUsdPerMillion: 15 },
    };
    return new AiSession({ apiKey: env.GEMINI_API_KEY!, baseUrl: env.GEMINI_BASE_URL, models, modelPrices, budgetUsd: env.TESTING_RUN_BUDGET_USD, timeoutMs: 300_000, extraBody: { reasoning_effort: env.GEMINI_REASONING_EFFORT } });
  }
  return new AiSession({ apiKey: env.NEBIUS_API_KEY!, baseUrl: env.NEBIUS_BASE_URL, models, budgetUsd: env.TESTING_RUN_BUDGET_USD, timeoutMs: 300_000 });
}

export async function startWorker() {
  console.log(`[testing] worker ${WORKER_ID} started (sandbox: ${providers.sandbox ? "Nebius" : "NOT CONFIGURED"}, AI: ${providers.testingAi ? env.TESTING_AI_PROVIDER : "off"}, concurrency ${CONCURRENCY}, profiles: fast, standard, deep)`);
  const active = new Set<Promise<void>>();
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  while (!stopping) {
    if (active.size < CONCURRENCY) {
      const claim = await claimNext().catch((err) => {
        console.error("[testing] claim failed:", (err as Error).message);
        return null;
      });
      if (claim) {
        console.log(`[testing] claimed run ${claim.id} (generation ${claim.generation})`);
        const p = processRun(claim, { provider: sandboxProvider(), session: sessionFor() }).finally(() => active.delete(p));
        active.add(p);
        continue;
      }
      const repairId = await claimRepair().catch(() => null);
      if (repairId) {
        console.log(`[testing] claimed repair ${repairId}`);
        const p: Promise<void> = runRepair(repairId)
          .then(() => undefined)
          .catch((err) => console.error(`[testing] repair ${repairId} failed:`, (err as Error).message))
          .finally(() => active.delete(p));
        active.add(p);
        continue;
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  await Promise.allSettled(active);
  await pool.end();
}

export { WORKER_ID };
