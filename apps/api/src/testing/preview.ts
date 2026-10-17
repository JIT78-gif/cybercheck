import { and, desc, eq, inArray } from "drizzle-orm";
import type { ProjectDossier, RunOptions, TestingPreview, TestingProfile, TestLayer } from "@cybercheck/contracts";
import { db } from "../db/client.ts";
import { testingRun } from "../db/schema.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { getSnapshotSource } from "../understanding/source.ts";
import { planWorkspaces } from "./adapters.ts";
import { capabilities, planCacheKey } from "./orchestrator.ts";
import { buildObligations } from "./plan.ts";
import { ENGINE_VERSION, LOAD_SECONDS, PROFILES, effectivePolicy } from "./runtime.ts";
import { databaseStrategy } from "./db-strategy.ts";
import { servedScreens } from "./served-pages.ts";
import { detectServices } from "./services.ts";

/**
 * What a run would do, before anything is paid for: the planned obligations by layer, what cannot be
 * tested, an estimate of time and AI cost (from earlier runs when there are some), and whether an
 * identical finished run already exists. Rules only, no AI and no sandbox.
 */
export async function previewOf(input: { snapshotId: string; projectId: string; archiveKey: string; digest: string; d: ProjectDossier; objects: ObjectStore; profile: TestingProfile; options?: RunOptions; identical: { id: string; finishedAt: Date | null } | null }): Promise<TestingPreview> {
  const { d, profile } = input;
  const src = await getSnapshotSource(input.objects, input.archiveKey);
  // Pages the backend serves itself count as screens when no frontend router was found (as in the run).
  if (!d.screens.length) {
    const served = servedScreens(src, d).screens;
    if (served.length) d.screens = served;
  }
  const workspaces = planWorkspaces(d, src);
  const services = detectServices(d, src);
  const caps = capabilities(d, workspaces, services);
  const prof = PROFILES[profile];
  const ep = effectivePolicy({ profile, ...(input.options ?? {}) }, Infinity);
  const browser = ep.browser && prof.browser && caps.frontendWs && d.screens.length > 0;
  const http = d.entryPoints.some((e) => e.kind === "http");
  const loadStages = http ? ep.loadStages : [];
  const obs = buildObligations(d, workspaces, { browser, database: prof.database && (caps.database || databaseStrategy(d, src, services) !== "none"), load: loadStages, viewports: prof.viewports });
  // Load stages run one after another for a known time: added on top of the estimate either way.
  const loadMin = Math.ceil(loadStages.reduce((n, s) => n + LOAD_SECONDS[s] + 2, 0) / 60);
  const layers = [...new Set(obs.map((o) => o.layer))] as TestLayer[];
  const byLayer = layers.map((layer) => ({ layer, planned: obs.filter((o) => o.layer === layer && o.status === "planned").length, unsupported: obs.filter((o) => o.layer === layer && (o.status === "unsupported" || o.status === "blocked")).length }));
  const reasons = new Map<string, number>();
  for (const o of obs.filter((x) => x.status === "unsupported" || x.status === "blocked")) reasons.set(o.reason ?? o.status, (reasons.get(o.reason ?? o.status) ?? 0) + 1);
  const unsupported = [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([r, n]) => `${n} check(s): ${r}`);

  // Estimate from this project's earlier runs with the same profile, else from any runs of this engine, else a rule of thumb.
  const finished = async (projectId: string | null) =>
    (await db.select().from(testingRun).where(and(eq(testingRun.check, "testing"), inArray(testingRun.status, ["completed", "partial"]), ...(projectId ? [eq(testingRun.projectId, projectId)] : []))).orderBy(desc(testingRun.createdAt)).limit(30)).filter((r) => {
      const p = r.policy as { engine?: string; profile?: string };
      return (p.profile ?? "standard") === profile && r.startedAt && r.finishedAt && (!projectId ? p.engine === ENGINE_VERSION : true);
    });
  let basis = "a rule of thumb (no earlier runs to compare with)";
  let minutes: [number, number] = [3 + Math.round(obs.length / 60) + (browser ? 3 : 0) + loadMin, 8 + Math.round(obs.length / 25) + (browser ? 5 : 0) + loadMin + 1];
  let cost: [number, number] = [0.05, 0.4];
  const own = await finished(input.projectId);
  const sample = own.length ? own : await finished(null);
  if (sample.length) {
    const mins = sample.map((r) => (r.finishedAt!.getTime() - r.startedAt!.getTime()) / 60000).sort((a, b) => a - b);
    const usd = sample.map((r) => (r.usage as { costUsd?: number } | null)?.costUsd ?? 0).sort((a, b) => a - b);
    // Earlier runs mostly used the profile default load stages: their load time is swapped for this run's.
    minutes = [Math.max(1, Math.floor(mins[0]!)), Math.ceil(mins.at(-1)! * 1.2)];
    const theirs = Math.ceil((prof.loadDefault ? prof.load : prof.loadOff).reduce((n, s) => n + LOAD_SECONDS[s] + 2, 0) / 60);
    if (loadMin !== theirs) minutes = [Math.max(1, minutes[0] - theirs + loadMin), Math.max(2, minutes[1] - theirs + loadMin)];
    cost = [Math.round(usd[0]! * 100) / 100, Math.round(usd.at(-1)! * 1.2 * 100) / 100];
    basis = own.length ? `your last ${own.length} run(s) of this project with the ${profile} profile` : `${sample.length} recent run(s) of other projects with the ${profile} profile`;
  }
  if (await input.objects.exists(planCacheKey(input.digest, d, browser)).catch(() => false)) {
    cost = [0, Math.max(0.05, Math.round(cost[1] * 0.3 * 100) / 100)];
    basis += "; the AI plan for this exact code is reused, so only failure analysis can cost anything";
  }
  return {
    profile,
    obligations: obs.length,
    byLayer,
    unsupported,
    estimate: { minutes, costUsd: cost, basis },
    identicalRun: input.identical ? { id: input.identical.id, finishedAt: input.identical.finishedAt?.toISOString() ?? null } : null,
  };
}
