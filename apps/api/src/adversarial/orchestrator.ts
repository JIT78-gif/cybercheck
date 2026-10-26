import { randomUUID } from "node:crypto";
import { buffer } from "node:stream/consumers";
import { and, eq } from "drizzle-orm";
import {
  AD_PROFILE_LIMITS,
  AdversarialPolicyInput,
  type AdversarialApplicability,
  type AdversarialCampaign,
  type AdversarialReport,
  type AiApplicability,
  type AttackSurface,
  type Evidence,
  type ProjectDossier,
  type TestExecution,
  type TestingUsage,
} from "@cybercheck/contracts";
import { db } from "../db/client.ts";
import { snapshot, testingRun, understandingRun } from "../db/schema.ts";
import { runRenderCanary } from "../ai-evaluator/canary.ts";
import { triggerToolNames } from "../ai-evaluator/applicability.ts";
import { detectRenderSinks } from "../ai-evaluator/rendering.ts";
import { selectSecurityRuntime } from "../security/runtime.ts";
import { overlaySource, overlayArchive, type RepairOverlay } from "../security/repair-overlay.ts";
import { CANARY } from "../security/proofs/catalog.ts";
import { planWorkspaces } from "../testing/adapters.ts";
import { planBoot } from "../testing/agents.ts";
import { bootGraph } from "../testing/agents.ts";
import { fixtureSymbols, validateGraph, verifyTarget } from "../testing/fixtures.ts";
import type { Ctx } from "../testing/runtime.ts";
import { endpointKeys } from "../testing/scenarios.ts";
import type { SandboxProvider } from "../testing/sandbox/provider.ts";
import type { RunStore } from "../testing/store.ts";
import type { AiSession } from "../understanding/ai/gateway.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { getSnapshotSource, type SnapshotSource } from "../understanding/source.ts";
import { assessAdversarialApplicability } from "./applicability.ts";
import { buildCampaigns, type CatalogCampaign } from "./catalog.ts";
import { buildGeneralCampaigns, campaignsFromHypotheses } from "./catalog-general.ts";
import { attackerReview, criticReview, proposeAttackHypotheses, type AttackerPlan, type SanitizedSurface } from "./ai.ts";
import { correlateChains } from "./chains.ts";
import { clampRules, compilePlan, type RulesAuthority } from "./compiler.ts";
import { findingsFromCampaigns, type FindingSource } from "./findings.ts";
import { protectedPromptFingerprints } from "./fingerprints.ts";
import { classifyAttackers, AD_CANARY, type AdvIdentity } from "./fixtures.ts";
import { judgeCampaign, type CampaignObservation, type CampaignVerdict } from "./oracle.ts";
import { assessReadiness, generalLaneReadiness, type LaneReadiness } from "./readiness.ts";
import { baseReport, buildAdversarialReport } from "./report.ts";
import { campaignRecord, prepareAdversarialAttack, preflightAdversarialSetup, runAdversarialCampaigns, runGeneralCampaigns } from "./run.ts";
import { loadSecurityFacts, reusedSecuritySummary, findingsFor, unexpectedAccess } from "./security-facts.ts";
import { buildSurface } from "./surface.ts";
import { buildGeneralSurface } from "./surface-general.ts";
import { AD_ENGINE_VERSION } from "./version.ts";
import { freezeCampaignPlan, loadCampaignPlan, type FrozenCampaignPlanRef } from "./campaign-plan.ts";

/** The AI Adversarial engine. Every executable plan is catalogue-only, compiled against server-owned resources,
 * and run through the same isolated sandbox authority as Testing and Security. Optional AI can suggest or challenge
 * future hypotheses, but deterministic evidence remains the only path to confirmation. */

export type AdversarialDeps = { provider: SandboxProvider | null; session: AiSession | null; objects: ObjectStore; signal: AbortSignal };

type StoredPolicy = Record<string, unknown> & { rerun?: { parentRunId: string; campaignIds: string[]; planKey: string; planDigest: string }; repair?: { repairId: string; attempt: number; files: Array<{ path: string; key: string }> } };

const noUsage = (): TestingUsage => ({ aiCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, sandboxOperations: 0, sandboxCpuSeconds: 0, models: {} });
/** Identity roles come from the planner's semantic names. Distinct planned identities are isolated synthetic tenants. */
function plannedIdentities(app: Awaited<ReturnType<typeof planBoot>>["apps"][number] | undefined): AdvIdentity[] {
  return (app?.identities ?? []).map((i) => ({ name: i.name, role: i.name, tenant: `synthetic-${i.name}` }));
}

/** Use only a real value produced by the setup graph; never invent a fallback record id. */
function capturedOrderId(app: Awaited<ReturnType<typeof planBoot>>["apps"][number] | undefined): string | null {
  const captures = (app?.setup ?? []).flatMap((s) => s.steps?.flatMap((st) => st.capture ? [st.capture.name] : []) ?? []);
  const name = captures.find((x) => /(^|_)(other|victim).*order.*id|order.*id/i.test(x));
  return name ? `{{${name}}}` : null;
}

/** Create conservative valid-control examples from analyzed request models. Identifiers come only from setup captures. */
function requestBodyExamples(dossier: ProjectDossier, symbols: string[]): Record<string, Record<string, unknown>> {
  const normalized = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const valueFor = (name: string, type: string): unknown => {
    if (/(^|_)(id|uuid)$|Id$/.test(name)) {
      const matches = symbols.filter((s) => normalized(s) === normalized(name) || normalized(s) === `${normalized(name)}id` || `${normalized(s)}id` === normalized(name));
      return matches.length === 1 ? `{{${matches[0]}}}` : undefined;
    }
    if (/bool/i.test(type)) return false;
    if (/int|float|double|number|decimal/i.test(type)) return 1;
    if (/\[\]|array|list|set/i.test(type)) return [];
    if (/email/i.test(name)) return "cybercheck@example.test";
    if (/pass(word)?|pwd/i.test(name)) return "Cybercheck-Valid-7!";
    if (/quantity|count|amount|price|total/i.test(name)) return 1;
    return "cybercheck-control";
  };
  const out: Record<string, Record<string, unknown>> = {};
  for (const e of dossier.entryPoints.filter((x) => x.inputs.body)) {
    const model = dossier.domainTypes.find((t) => t.id === e.inputs.body || t.name === e.inputs.body || t.id.endsWith(`#${e.inputs.body}`));
    if (!model) continue;
    const body: Record<string, unknown> = {};
    for (const f of model.fields) {
      const value = valueFor(f.name, f.type);
      if (value !== undefined) body[f.name] = value;
    }
    if (Object.keys(body).length) out[`${e.method} ${e.path}`] = body;
  }
  return out;
}

/** Combine the AI and general lane readiness, deduplicating the lanes both tracks share (keep an available verdict). */
function mergeLanes(ai: LaneReadiness[], general: LaneReadiness[]): LaneReadiness[] {
  const out = new Map<string, LaneReadiness>();
  for (const l of [...ai, ...general]) {
    const prev = out.get(l.lane);
    if (!prev || (!prev.available && l.available)) out.set(l.lane, l);
  }
  return [...out.values()];
}

/** Combine the AI and general attack-surface graphs, deduplicating nodes by id. */
function mergeSurface(a: AttackSurface, b: AttackSurface): AttackSurface {
  const nodes = new Map<string, AttackSurface["nodes"][number]>();
  for (const n of [...a.nodes, ...b.nodes]) if (!nodes.has(n.id)) nodes.set(n.id, n);
  return { nodes: [...nodes.values()], edges: [...a.edges, ...b.edges] };
}

function scopedApplicability(all: AiApplicability, componentId: string | null): { applicability: AiApplicability; selected: AiApplicability["targets"][number] | null; error: string | null } {
  if (all.status !== "applicable") return { applicability: all, selected: null, error: null };
  const selected = componentId ? all.targets.find((x) => x.target.componentId === componentId) ?? null : all.targets.length === 1 ? all.targets[0]! : null;
  if (!selected) {
    const reason = componentId
      ? `The requested AI component "${componentId}" has no owned, reachable target.`
      : `The analysis found ${all.targets.length} reachable AI targets; choose a component before running an attack.`;
    return { applicability: { ...all, status: "no_target", reason, targets: [] }, selected: null, error: reason };
  }
  return { applicability: { ...all, reason: `Selected ${selected.target.componentId} at ${selected.target.method ?? "POST"} ${selected.target.path}.`, targets: [selected] }, selected, error: null };
}

function browserObservation(campaign: CatalogCampaign, result: Awaited<ReturnType<typeof runRenderCanary>>, evidence: CampaignObservation["evidence"]): CampaignObservation {
  const executionIds = result.executionId ? [result.executionId] : [];
  return {
    ran: result.ran,
    preconditions: { appBooted: result.ran, targetReached: result.ran, fixtureReady: result.ran, oracleReady: result.ran && result.reflected },
    turns: result.ran ? [{ as: campaign.steps[0]?.asIdentity ?? null, status: 200, reply: "[redacted browser canary result]", body: null }] : [],
    toolCalls: [],
    citations: [],
    canaryHits: 0,
    xssExecuted: result.executed,
    xssReflected: result.reflected,
    retrievalReached: false,
    toolSurfaceReached: false,
    responseOwned: null,
    stateAfter: {},
    reset: true,
    resetRequired: true,
    executionIds,
    evidence,
  };
}

export async function runAdversarial(store: RunStore, deps: AdversarialDeps, onProgress: (step: string) => void) {
  const started = Date.now();
  const aiUsageStart = deps.session?.usage.length ?? 0;
  const [run] = await db.select().from(testingRun).where(eq(testingRun.id, store.runId));
  if (!run) throw new Error("run not found");
  const step = async (phase: Parameters<RunStore["phase"]>[0], text: string) => {
    onProgress(text);
    await store.phase(phase, text);
  };
  const blocked = async (reason: string) => {
    await store.event("admission", reason);
    await store.finish("blocked", { error: reason, usage: noUsage() });
  };

  await step("admission", "Checking the snapshot and its analysis");
  const [snap] = await db.select().from(snapshot).where(eq(snapshot.id, run.snapshotId));
  const [understanding] = run.understandingRunId
    ? await db.select().from(understandingRun).where(and(eq(understandingRun.id, run.understandingRunId)))
    : [];
  const dossier = understanding?.dossier as ProjectDossier | null;
  if (!snap?.archiveObjectKey || !snap.contentDigest || snap.status !== "BASELINED") return blocked("The snapshot is not baselined.");
  if (!dossier || understanding?.status !== "ready") return blocked("The project analysis is not ready. Wait until the project shows Ready.");
  if (snap.projectId !== run.projectId) return blocked("The snapshot does not belong to this run's project.");

  const stored = (run.policy ?? {}) as StoredPolicy;
  const { rerun, repair, engine: _engine, catalogue: _catalogue, compiler: _compiler, ...rawPolicy } = stored;
  const policy = AdversarialPolicyInput.parse(rawPolicy);
  let src = await getSnapshotSource(deps.objects, snap.archiveObjectKey);
  // A repair rerun replays the parent's attack plan (readiness, surface, render sinks) from the original source, so the
  // same campaigns exist even when the patch removes what made them applicable; only execution sees the patch.
  const planSrc = src;
  // Repair validation: apply the approved patch as an overlay to this disposable run only. The uploaded snapshot and
  // the real project are never changed; patched files come from the repair's own object-store keys.
  let repairOverlay: RepairOverlay | null = null;
  if (repair?.files?.length) {
    repairOverlay = new Map();
    for (const f of repair.files) repairOverlay.set(f.path, (await buffer(await deps.objects.get(f.key))).toString("utf8"));
    src = overlaySource(src, repairOverlay);
    await store.event("admission", `Validating a repair: ${repairOverlay.size} patched file(s) are overlaid in this isolated run only; the snapshot is unchanged.`);
  }
  const adv = assessAdversarialApplicability({ dossier, src, contentDigest: snap.contentDigest });
  if (!adv.ownershipOk) return blocked(adv.applicability.reason);
  if (adv.applicability.status === "not_applicable") {
    const report = baseReport({ decision: "not_applicable", headline: adv.applicability.reason, applicability: adv.applicability, profile: policy.profile, snapshotDigest: snap.contentDigest, claims: ["There was no reachable HTTP endpoint and no AI component to attack in this snapshot.", "Per-endpoint weakness testing remains in the Security check."] });
    await store.finish("completed", { report, usage: noUsage() });
    return;
  }
  const wantsAi = adv.tracks.includes("ai");
  const wantsGeneral = adv.tracks.includes("general");
  // The AI attacker track needs a single bound target; the general track does not. When no AI target binds but the
  // general track applies, drop the AI track and continue general-only; only when neither can run is it insufficient.
  const scoped = wantsAi ? scopedApplicability(adv.ai, policy.targetComponentId) : null;
  const aiActive = Boolean(scoped?.selected && scoped.applicability.status === "applicable");
  if (wantsAi && !aiActive && !wantsGeneral) {
    const readiness = assessReadiness({ applicability: scoped!.applicability, src: planSrc, target: null, runtimeAvailable: false, appStartable: false });
    const report = baseReport({ decision: "not_ready_insufficient_evidence", headline: scoped!.error ?? "An AI component was found but no reachable target could be bound.", applicability: readiness.applicability, profile: policy.profile, snapshotDigest: snap.contentDigest, limitations: readiness.notes });
    await store.finish("completed", { report, usage: noUsage() });
    return;
  }
  const selectedTarget = aiActive ? scoped!.selected!.target : null;
  const applicabilityReport: AdversarialApplicability = { ...adv.applicability, targets: aiActive ? [{ target: scoped!.selected!.target, boundBy: scoped!.selected!.boundBy, auxiliary: (scoped!.selected!.auxiliary ?? {}) as Record<string, unknown> }] : adv.applicability.targets };

  await step("readiness", "Checking the attack surface and selecting an isolated runtime");
  const selection = await selectSecurityRuntime(policy.runtime, deps.provider);
  // One authoritative boot plan drives readiness, fixture discovery, preflight, and every campaign sandbox.
  const boot = await planBoot(deps.session, dossier, src, planWorkspaces(dossier, src)).catch((error: Error) => ({ apps: [], frontends: [], source: "rules" as const, error: error.message }));
  const bootApp = boot.apps[0];
  const runtimeAvailable = Boolean(selection.provider);
  const appStartable = Boolean(bootApp);
  const aiReadiness = aiActive ? assessReadiness({ applicability: scoped!.applicability, src: planSrc, target: selectedTarget, runtimeAvailable, appStartable }) : null;
  const securityFacts = await loadSecurityFacts(run.snapshotId).catch(() => null);

  const endpoints = endpointKeys(dossier);
  const identities = plannedIdentities(bootApp);
  const attackers = classifyAttackers(identities);
  const attackableRoutes = dossier.entryPoints.filter((e) => e.kind === "http" || e.kind === "webhook" || e.kind === "graphql");
  const graphValidation = validateGraph(bootApp ? bootGraph(bootApp, (applies) => verifyTarget(dossier, applies)) : [], dossier, src);
  const plannedGraph = graphValidation.nodes;
  const plannedSymbols = fixtureSymbols(plannedGraph).map((s) => s.name);
  const requestBodies = requestBodyExamples(dossier, plannedSymbols);
  // The general catalogue is built before lane readiness so a general lane is "available" exactly when it has a campaign.
  const generalBase = wantsGeneral ? buildGeneralCampaigns({ routes: attackableRoutes, attackers, identities, security: securityFacts, endpoints, fixtureSymbols: plannedSymbols, requestBodies }) : [];
  // Phase 2: the optional AI attacker reverse-engineers the sanitized surface + reused Security weaknesses and proposes
  // project-specific hypotheses. Each becomes a typed campaign built by deterministic code and still gated by the
  // compiler. It runs only when a runtime is available; `off` makes zero model calls; no provider falls back cleanly.
  let attackerPlan: AttackerPlan = { status: policy.aiAttacker === "off" ? "off" : "unavailable", model: null, hypotheses: [], proposed: 0, reason: policy.aiAttacker === "off" ? "The optional AI attacker was disabled; only the deterministic catalogue ran." : "The optional AI attacker did not run; the deterministic catalogue still ran." };
  let aiHypothesisCampaigns: CatalogCampaign[] = [];
  if (wantsGeneral && runtimeAvailable && appStartable && policy.aiAttacker === "auto" && deps.session) {
    const sanitized: SanitizedSurface = {
      endpoints: attackableRoutes.map((e) => `${e.method} ${e.path}`),
      identities: identities.map((i) => ({ name: i.name, role: i.role })),
      securityFindings: (securityFacts?.findings ?? []).slice(0, 40).map((f) => ({ lane: f.lane, category: f.category, status: f.status, endpoint: f.location?.path ?? null })),
      assets: ["administrator-only functions", "other users' and tenants' records", "money, orders or inventory state", "the database"],
    };
    attackerPlan = await proposeAttackHypotheses(deps.session, policy.aiAttacker, sanitized);
    aiHypothesisCampaigns = campaignsFromHypotheses(attackerPlan.hypotheses, { routes: attackableRoutes, attackers, fixtureSymbols: plannedSymbols, requestBodies });
  }
  const generalCatalogue = [...generalBase, ...aiHypothesisCampaigns];
  const generalLanes = wantsGeneral ? generalLaneReadiness(generalCatalogue, runtimeAvailable, appStartable) : [];
  const lanes = mergeLanes(aiReadiness?.lanes ?? [], generalLanes);

  const environment: AdversarialReport["environment"] = {
    requested: policy.runtime,
    selected: selection.selected,
    provider: selection.provider?.name ?? null,
    fallbackReason: selection.fallbackReason,
    isolation: "The application runs in a disposable sandbox with outbound network disabled; attacks use synthetic identities, records, files, and loopback canaries only.",
  };
  await store.setPlan({ engine: AD_ENGINE_VERSION, applicability: applicabilityReport, lanes, runtime: { selected: selection.selected, fallbackReason: selection.fallbackReason, health: selection.health }, rerun: rerun ?? null });
  await store.event("readiness", aiReadiness?.reason ?? adv.applicability.reason);
  if (!runtimeAvailable || !appStartable) {
    const reason = !runtimeAvailable ? selection.fallbackReason ?? "No sandbox runtime is available." : "No startable application was found.";
    const report = baseReport({ decision: "not_ready_environment_blocked", headline: reason, applicability: applicabilityReport, profile: policy.profile, snapshotDigest: snap.contentDigest, environment, limitations: aiReadiness?.notes ?? [], untested: lanes.filter((l) => !l.available).map((l) => ({ what: l.label, reason: l.reason })) });
    await store.finish("completed", { report, usage: noUsage() });
    return;
  }

  const component = aiActive ? scoped!.applicability.components.find((c) => c.id === selectedTarget!.componentId) ?? null : null;
  if (aiActive && !component) return blocked(`The selected component ${selectedTarget!.componentId} is not present in the owned analysis.`);

  await step("surface_mapping", "Mapping entries, identities, tools, sinks, boundaries, and protected assets");
  const aiSurface = aiActive ? buildSurface({ applicability: scoped!.applicability, dossier, src: planSrc, target: selectedTarget! }) : { nodes: [], edges: [] };
  const generalSurface = wantsGeneral ? buildGeneralSurface({ dossier, identities, security: securityFacts }) : { nodes: [], edges: [] };
  const surface = mergeSurface(aiSurface, generalSurface);
  const tools = new Set([
    ...(component?.tools ?? []).map((t) => t.name).filter((x): x is string => Boolean(x)),
    ...(component ? triggerToolNames(component) : []),
  ]);
  const files = new Set([`../${AD_CANARY.traversalFile}`]);
  const authority: RulesAuthority = {
    allowedEndpoints: [...endpoints],
    allowedIdentities: ["anonymous", ...identities.map((i) => i.name)],
    allowedTools: [...tools],
    allowedFiles: [...files],
    allowedDataClasses: ["synthetic_message", "synthetic_document", "synthetic_order", "synthetic_memory"],
    allowedMutationTypes: ["synthetic_document_upload", "synthetic_memory_write", "synthetic_order_action"],
    canaries: ["loopback-http", "out-of-root-file", "browser-xss"],
  };
  const rules = clampRules(policy.rulesOfEngagement, policy.profile, authority);
  await store.setPlan({ engine: AD_ENGINE_VERSION, applicability: applicabilityReport, lanes, surface, rulesOfEngagement: rules, runtime: { selected: selection.selected, fallbackReason: selection.fallbackReason, health: selection.health }, rerun: rerun ?? null });
  await store.event("surface_mapping", `Mapped ${surface.nodes.length} nodes, ${surface.edges.length} evidence-backed edges, ${endpoints.size} endpoints, ${identities.length} identities, and ${tools.size} tools.`);

  await step("planning", "Building deterministic attacks from the approved capability catalogue");
  const aiCatalogue = aiActive ? buildCampaigns({
    target: selectedTarget!,
    component: component!,
    attackers,
    surface: aiReadiness!.surface,
    auxiliary: scoped!.selected!.auxiliary,
    endpoints,
    otherOrderId: capturedOrderId(bootApp),
    tenant: identities.find((i) => i.name === attackers.user)?.tenant ?? null,
    promptFingerprints: protectedPromptFingerprints(src, component!.systemPrompts),
  }) : [];
  const generatedCatalogue = [...generalCatalogue, ...aiCatalogue];
  let selectedCatalogue: CatalogCampaign[];
  if (rerun?.campaignIds?.length) {
    const frozen = await loadCampaignPlan(deps.objects, { key: rerun.planKey, digest: rerun.planDigest }, snap.contentDigest);
    const byId = new Map(frozen.campaigns.map((c) => [c.id, c]));
    const missing = rerun.campaignIds.filter((id) => !byId.has(id));
    if (missing.length) return blocked(`The targeted rerun cannot reconstruct ${missing.length} frozen campaign(s): ${missing.join(", ")}. Run a new full adversarial check.`);
    selectedCatalogue = rerun.campaignIds.map((id) => byId.get(id)!);
  } else selectedCatalogue = generatedCatalogue;
  const generalIds = new Set(selectedCatalogue.filter((c) => c.track === "general" || (!c.track && c.target.componentId === "app")).map((c) => c.id));
  // A targeted rerun answers only the selected campaign(s). Do not turn all lanes deliberately left out of that
  // scope into new "unsupported" failures; the original run remains the full-project decision of record.
  const selectedLanes = new Set(selectedCatalogue.map((c) => c.lane));
  const reportLanes = rerun?.campaignIds?.length
    ? lanes.map((lane) => selectedLanes.has(lane.lane) ? lane : { ...lane, available: false, reason: "Outside the scope of this targeted rerun; see the parent run for the full-project result." })
    : lanes;

  await step("compiling", "Validating typed operations, ownership, rules of engagement, and safety budgets");
  const compiled = compilePlan(selectedCatalogue, { roe: rules, endpoints, identities: new Set(authority.allowedIdentities), tools, files, maxCampaigns: AD_PROFILE_LIMITS[policy.profile].campaigns });
  const compiledIds = new Set(compiled.campaigns.map((c) => c.id));
  let executable = selectedCatalogue.filter((c) => compiledIds.has(c.id));
  const untested = [
    ...compiled.rejected.map((x) => ({ what: x.id, reason: `Safety compiler rejected the campaign: ${x.reasons.join("; ")}` })),
    ...compiled.overBudget.map((x) => ({ what: x.id, reason: x.reason })),
    ...graphValidation.problems.map((x) => ({ what: x.id, reason: `Setup compiler rejected the node: ${x.reason}` })),
    ...policy.attackPackIds.map((id) => ({ what: `Attack pack ${id}`, reason: "The pack is project-owned, but custom pack execution is not enabled in this engine version." })),
    ...lanes.filter((l) => !l.available).map((l) => ({ what: l.label, reason: l.reason })),
  ];
  await store.event("compiling", `${executable.length} of ${selectedCatalogue.length} catalogue campaigns passed the safety compiler.`);
  const attacker = await attackerReview(deps.session, policy.aiAttacker, executable);
  if (attacker.campaignIds.length) {
    const rank = new Map(attacker.campaignIds.map((id, i) => [id, i]));
    executable = [...executable].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }
  // Raw payloads and oracle internals live only in this private object-store artifact. User-facing campaign rows remain
  // redacted, while targeted reruns can recompile these exact definitions instead of regenerating a drifting catalogue.
  const campaignPlan = await freezeCampaignPlan(deps.objects, run.id, snap.contentDigest, executable);
  await store.setPlan({ engine: AD_ENGINE_VERSION, applicability: applicabilityReport, lanes, surface, rulesOfEngagement: rules, runtime: { selected: selection.selected, fallbackReason: selection.fallbackReason, health: selection.health }, rerun: rerun ?? null, boot: { source: boot.source, error: boot.error, app: bootApp }, campaignPlan });
  await store.event("planning", `Optional AI attacker: ${attackerPlan.status}; ${attackerPlan.proposed} hypothesis(es) proposed, ${aiHypothesisCampaigns.length} compiled into campaigns. Ranking review: ${attacker.status}. ${attacker.reason}`);

  const ctx = { ...deps, provider: selection.provider, store, runId: run.id, services: [], d: dossier, src, executions: [], findings: [], obligations: new Map(), sandboxOps: 0, sandboxCpu: 0, suiteSummaries: [], profile: "standard", thresholds: null } as unknown as Ctx;
  let archive = await buffer(await deps.objects.get(snap.archiveObjectKey));
  if (repairOverlay) archive = Buffer.from(await overlayArchive(archive, repairOverlay));
  const generalExec = executable.filter((c) => generalIds.has(c.id));
  const aiExec = executable.filter((c) => !generalIds.has(c.id));
  const apiCampaigns = aiExec.filter((c) => !c.steps.some((s) => s.operation === "open_known_page"));
  const browserCampaigns = aiExec.filter((c) => c.steps.some((s) => s.operation === "open_known_page"));
  // General findings cite the attacked route's own handler (and any Security finding at that endpoint) as evidence.
  const routeHandlers: Evidence[] = attackableRoutes.map((e) => e.handler).filter((x): x is Evidence => Boolean(x));
  const routeByEp = new Map(attackableRoutes.map((e) => [`${e.method} ${e.path}`, e]));
  const generalEvidenceFor = (c: CatalogCampaign): Evidence[] => {
    const ev: Evidence[] = [];
    const r = routeByEp.get(c.target.endpoint);
    if (r?.handler) ev.push(r.handler);
    for (const f of securityFacts?.findings ?? []) if (f.location?.path && c.target.endpoint.includes(f.location.path)) ev.push(f.location);
    return (ev.length ? ev : routeHandlers).slice(0, 4);
  };

  const records: AdversarialCampaign[] = [];
  const verdicts = new Map<string, CampaignVerdict>();
  const executionIds: string[] = [];
  const bootNotes: string[] = [];
  let setup: AdversarialReport["setup"] = [];
  let attempted = 0;
  let renderEvidence: Evidence[] = [];

  await step("preparing", "Preparing a reusable application image and resettable synthetic fixtures");
  const prep = bootApp && (generalExec.length || apiCampaigns.length)
    ? await prepareAdversarialAttack(ctx, { dossier, src, archive, app: bootApp, graph: plannedGraph })
    : null;
  const preflight = prep?.ok ? await (async () => {
    await step("fixtures", `Validating ${prep.prepared.graph.length} setup and identity node(s) before attacks`);
    return preflightAdversarialSetup(ctx, prep.prepared, rules.limits.timeoutSec);
  })() : null;
  if (preflight) {
    for (const problem of graphValidation.problems) {
      const failed = { name: problem.id, kind: "fixture" as const, ok: false, detail: problem.reason };
      preflight.setup.push(failed);
      preflight.byNode.set(problem.id, failed);
    }
    setup = preflight.setup;
    executionIds.push(...preflight.executionIds);
    if (!preflight.appBooted) bootNotes.push(preflight.bootNote);
    const failed = preflight.setup.filter((s) => !s.ok);
    await store.event("fixtures", failed.length ? `${failed.length} setup node(s) failed; only dependent campaigns will be blocked.` : "The adversarial setup graph passed preflight.");
  } else if (prep && !prep.ok) bootNotes.push(prep.note);

  if (generalExec.length && prep?.ok && preflight) {
    await step("campaigning", `Running ${generalExec.length} general attacker campaign(s) with network isolation`);
    const gr = await runGeneralCampaigns(ctx, { prepared: prep.prepared, preflight, campaigns: generalExec, rules, profile: policy.profile, evidence: routeHandlers, onEvent: (message) => store.event("campaigning", message) });
    records.push(...gr.records);
    for (const [k, v] of gr.verdicts) verdicts.set(k, v);
    executionIds.push(...gr.executionIds);
    if (gr.setup.length) setup = gr.setup;
    attempted += gr.attempted;
    if (!gr.appBooted) bootNotes.push(gr.bootNote);
  }
  if (apiCampaigns.length && aiActive && prep?.ok && preflight) {
    await step("campaigning", `Running ${apiCampaigns.length} AI API and tool campaign(s) with network isolation`);
    const runResult = await runAdversarialCampaigns(ctx, { prepared: prep.prepared, preflight, target: selectedTarget!, component: component!, campaigns: apiCampaigns, endpoints, rules, profile: policy.profile, onEvent: (message) => store.event("campaigning", message) });
    records.push(...runResult.records);
    for (const [k, v] of runResult.verdicts) verdicts.set(k, v);
    executionIds.push(...runResult.executionIds);
    if (!setup.length && runResult.setup.length) setup = runResult.setup;
    attempted += runResult.attempted;
    if (!runResult.appBooted || !runResult.records.length) bootNotes.push(runResult.bootNote);
  }

  if (browserCampaigns.length && aiActive) {
    await step("browser_campaigning", "Running the browser output canary against detected render sinks");
    const sinkOpts = { routePaths: [selectedTarget!.path, ...component!.endpoints.map((e) => e.split(" ").pop() ?? "")], replySelector: selectedTarget!.responseSelector };
    const now = detectRenderSinks(src, sinkOpts);
    const seen = new Set(now.map((e) => `${e.path}:${e.line}`));
    // A repair rerun also probes the pages the original had, so a removed sink is proven inert in a real browser.
    const sinks = repairOverlay ? [...now, ...detectRenderSinks(planSrc, sinkOpts).filter((e) => !seen.has(`${e.path}:${e.line}`))] : now;
    renderEvidence = sinks;
    for (const campaign of browserCampaigns) {
      const rendered = await runRenderCanary(ctx, { d: dossier, src, archive, applicability: scoped!.applicability, sinks, nonce: `CCXSS${randomUUID().replace(/-/g, "").slice(0, 18)}`, executionKind: "adversarial_browser" }).catch((error: Error) => ({ ran: false, executed: false, reflected: false, page: null, detail: error.message, executionId: null }));
      const observation = browserObservation(campaign, rendered, sinks);
      const verdict = judgeCampaign(campaign, observation);
      verdicts.set(campaign.id, verdict);
      records.push(campaignRecord(campaign, verdict, records.length + 1));
      if (rendered.ran) attempted++;
      if (rendered.executionId) executionIds.push(rendered.executionId);
      await store.event("browser_campaigning", `${campaign.title}: ${verdict.status}.`);
    }
  }

  // A compiled campaign may still be impossible to translate into the harness. Preserve it explicitly; never let it
  // disappear from coverage or look like a pass.
  for (const campaign of executable) {
    if (verdicts.has(campaign.id)) continue;
    const evidence = generalIds.has(campaign.id) ? generalEvidenceFor(campaign) : component?.evidence.slice(0, 4) ?? [];
    const reason = prep && !prep.ok ? prep.note : bootNotes.at(-1) ?? "The compiled campaign could not be translated into an executable attack.";
    const observation: CampaignObservation = { ran: false, blockedReason: reason, preconditions: { appBooted: Boolean(preflight?.appBooted), targetReached: false, fixtureReady: false, oracleReady: false }, turns: [], toolCalls: [], citations: [], canaryHits: 0, xssExecuted: false, xssReflected: false, retrievalReached: false, toolSurfaceReached: false, responseOwned: null, stateAfter: {}, reset: false, resetRequired: campaign.resetStrategy !== "none", executionIds: preflight?.executionIds ?? [], evidence };
    const verdict = judgeCampaign(campaign, observation);
    verdicts.set(campaign.id, verdict);
    records.push(campaignRecord(campaign, verdict, records.length + 1));
  }
  records.forEach((r, i) => { r.seq = i + 1; });

  await step("validating", "Correlating campaigns into evidence-backed findings and attack chains");
  const findingSource: FindingSource = (c) => generalIds.has(c.id)
    ? { componentId: "app", evidence: generalEvidenceFor(c) }
    : c.techniqueId === "unsafe-output-rendering" && renderEvidence.length
      ? { componentId: component?.id ?? "app", evidence: renderEvidence.slice(0, 4) }
      : { componentId: component?.id ?? "app", evidence: component?.evidence.slice(0, 4) ?? [] };
  const findings = findingsFromCampaigns(executable, records, verdicts, findingSource);
  const aiHypothesisIds = new Set(aiHypothesisCampaigns.map((c) => c.id));
  const attackerUniqueFindings = findings.filter((f) => f.status === "confirmed" && f.campaignIds.some((id) => aiHypothesisIds.has(id))).length;
  const chains = correlateChains(executable, verdicts);
  for (const chain of chains) {
    const related = findings.filter((f) => f.campaignIds.some((id) => chain.campaignIds.includes(id)));
    chain.findingIds = related.map((f) => f.id);
    for (const finding of related) if (!finding.chainIds.includes(chain.id)) finding.chainIds.push(chain.id);
  }
  await step("critic", policy.aiCritic === "off" ? "Running deterministic evidence audits" : "Running deterministic evidence audits; optional AI critic is best-effort");
  const critic = await criticReview(deps.session, policy.aiCritic, findings);
  await store.event("critic", `Optional critic review: ${critic.status}. ${critic.reason}`);
  for (const record of records) await store.putAdversarialCampaign(record);
  for (const chain of chains) await store.putAdversarialChain(chain);
  for (const finding of findings) await store.putFinding(finding);

  const reusedSecurity = reusedSecuritySummary(securityFacts, [
    ...findingsFor(securityFacts, /inject|sqli|nosql|CWE-89|CWE-78/i).map((f) => f.id),
    ...(securityFacts ? unexpectedAccess(securityFacts).map((h) => h.proofId).filter((x): x is string => Boolean(x)) : []),
  ]);
  const limitations = [
    ...(rerun?.campaignIds?.length ? [`Targeted rerun of ${rerun.campaignIds.length} selected campaign(s) from parent run ${rerun.parentRunId}; this result does not replace or recalculate the full-project decision.`] : []),
    ...(aiReadiness?.notes ?? []),
    ...bootNotes,
    ...(wantsAi && !aiActive && scoped?.error ? [scoped.error] : []),
    ...(wantsGeneral && reusedSecurity && reusedSecurity.securityRunId == null ? [reusedSecurity.note] : []),
    ...(policy.aiAttacker === "auto" && !deps.session ? ["The optional AI attacker was unavailable; the deterministic catalogue still ran."] : []),
    ...(policy.aiCritic === "auto" && !deps.session ? ["The optional AI critic was unavailable; deterministic validation remained authoritative."] : []),
  ];
  const aiCalls = deps.session?.usage.slice(aiUsageStart) ?? [];
  const aiUsage = {
    modelRequests: aiCalls.length,
    tokensIn: aiCalls.reduce((n, x) => n + x.inputTokens, 0),
    tokensOut: aiCalls.reduce((n, x) => n + x.outputTokens, 0),
    costUsd: aiCalls.reduce((n, x) => n + x.costUsd, 0),
  };
  await step("reporting", "Building the decision, coverage, evidence audit, and redacted report");
  const report = buildAdversarialReport({ applicability: applicabilityReport, surface, rules, lanes: reportLanes, catalogue: executable, campaigns: records, verdicts, chains, findings, profile: policy.profile, snapshotDigest: snap.contentDigest, environment, executionIds: [...new Set(executionIds)], aiAttacker: policy.aiAttacker, aiCritic: policy.aiCritic, attackerReview: attacker, criticReview: critic, aiUsage, limitations, untested, reusedSecurity, setup, accounting: { selected: selectedCatalogue.length, compiled: executable.length, attempted, decisive: records.filter((c) => c.status === "passed" || c.status === "failed").length, blocked: records.filter((c) => c.status === "blocked").length, compilerRejected: selectedCatalogue.length - executable.length }, campaignPlanDigest: campaignPlan.digest, attackerHypotheses: attackerPlan.status === "ran" ? attackerPlan.proposed : undefined, attackerUniqueFindings, attackerPlanReason: attackerPlan.status === "ran" ? attackerPlan.reason : undefined, durationMs: Date.now() - started });
  const executions = (ctx as unknown as { executions: TestExecution[] }).executions;
  const models = Object.fromEntries(Object.entries(deps.session?.opts.models ?? {}));
  const usage: TestingUsage = { aiCalls: aiUsage.modelRequests, inputTokens: aiUsage.tokensIn, outputTokens: aiUsage.tokensOut, costUsd: aiUsage.costUsd, sandboxOperations: ctx.sandboxOps, sandboxCpuSeconds: Math.round(ctx.sandboxCpu), models };
  const terminal = report.audit.every((a) => a.ok) ? "completed" : "partial";
  await store.finish(terminal, { report, usage, error: terminal === "partial" ? report.headline : null });
  void executions;
  void CANARY;
}
