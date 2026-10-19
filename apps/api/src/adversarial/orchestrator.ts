import { randomUUID } from "node:crypto";
import { buffer } from "node:stream/consumers";
import { and, eq } from "drizzle-orm";
import {
  AD_PROFILE_LIMITS,
  AdversarialPolicyInput,
  type AdversarialCampaign,
  type AdversarialReport,
  type AiApplicability,
  type ProjectDossier,
  type TestExecution,
  type TestingUsage,
} from "@cybercheck/contracts";
import { db } from "../db/client.ts";
import { snapshot, testingRun, understandingRun } from "../db/schema.ts";
import { assessApplicability } from "../ai-evaluator/applicability.ts";
import { runRenderCanary } from "../ai-evaluator/canary.ts";
import { detectRenderSinks } from "../ai-evaluator/rendering.ts";
import { selectSecurityRuntime } from "../security/runtime.ts";
import { CANARY } from "../security/proofs/catalog.ts";
import { planWorkspaces } from "../testing/adapters.ts";
import { planBoot } from "../testing/agents.ts";
import { seededAccounts } from "../testing/fixtures.ts";
import type { Ctx } from "../testing/runtime.ts";
import { endpointKeys } from "../testing/scenarios.ts";
import type { SandboxProvider } from "../testing/sandbox/provider.ts";
import type { RunStore } from "../testing/store.ts";
import type { AiSession } from "../understanding/ai/gateway.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import { getSnapshotSource, type SnapshotSource } from "../understanding/source.ts";
import { buildCampaigns, type CatalogCampaign } from "./catalog.ts";
import { attackerReview, criticReview } from "./ai.ts";
import { correlateChains } from "./chains.ts";
import { clampRules, compilePlan, type RulesAuthority } from "./compiler.ts";
import { findingsFromCampaigns } from "./findings.ts";
import { classifyAttackers, AD_CANARY, type AdvIdentity } from "./fixtures.ts";
import { judgeCampaign, type CampaignObservation, type CampaignVerdict } from "./oracle.ts";
import { assessReadiness } from "./readiness.ts";
import { baseReport, buildAdversarialReport } from "./report.ts";
import { campaignRecord, runAdversarialCampaigns } from "./run.ts";
import { buildSurface } from "./surface.ts";
import { AD_ENGINE_VERSION } from "./version.ts";

/** The AI Adversarial engine. Every executable plan is catalogue-only, compiled against server-owned resources,
 * and run through the same isolated sandbox authority as Testing and Security. Optional AI can suggest or challenge
 * future hypotheses, but deterministic evidence remains the only path to confirmation. */

export type AdversarialDeps = { provider: SandboxProvider | null; session: AiSession | null; objects: ObjectStore; signal: AbortSignal };

type StoredPolicy = Record<string, unknown> & { rerun?: { parentRunId: string; campaignIds: string[] } };

const noUsage = (): TestingUsage => ({ aiCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, sandboxOperations: 0, sandboxCpuSeconds: 0, models: {} });
const isAdmin = (role: string | null) => /admin|superuser|root|owner|staff/i.test(role ?? "");

/** Names must match buildIdentities(): two members followed by one administrator. */
function syntheticIdentities(src: SnapshotSource): AdvIdentity[] {
  const accounts = seededAccounts(src);
  const admins = accounts.filter((a) => isAdmin(a.role));
  const members = accounts.filter((a) => !isAdmin(a.role));
  return [
    ...members.slice(0, 2).map((a, i) => ({ name: i === 0 ? "customer" : `customer-${i + 1}`, role: a.role, tenant: i === 0 ? "tenant-a" : "tenant-b" })),
    ...admins.slice(0, 1).map((a) => ({ name: "admin", role: a.role, tenant: "tenant-admin" })),
  ];
}

/** Prefer a clearly foreign order id from owned source; otherwise use a synthetic id that can only affect fixtures. */
function syntheticOtherOrderId(src: SnapshotSource): string {
  for (const file of src.files.values()) {
    const preferred = file.text.match(/\b(?:GLOBEX|OTHER|TENANT[_-]?B)[_-][A-Z0-9_-]{3,40}\b/i)?.[0];
    if (preferred) return preferred;
  }
  return "CC-OTHER-2002";
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
  const { rerun, engine: _engine, catalogue: _catalogue, compiler: _compiler, ...rawPolicy } = stored;
  const policy = AdversarialPolicyInput.parse(rawPolicy);
  const src = await getSnapshotSource(deps.objects, snap.archiveObjectKey);
  const detected = assessApplicability({ dossier, src, contentDigest: snap.contentDigest });
  if (detected.status === "ownership_failed") return blocked(detected.reason);

  const scoped = scopedApplicability(detected, policy.targetComponentId);
  if (scoped.applicability.status === "not_applicable") {
    const readiness = assessReadiness({ applicability: scoped.applicability, src, target: null, runtimeAvailable: false, appStartable: false });
    const report = baseReport({ decision: "not_applicable", headline: "No AI component was found, so AI Adversarial does not apply.", applicability: readiness.applicability, profile: policy.profile, snapshotDigest: snap.contentDigest, claims: ["Broad non-AI penetration testing remains in the Security check."] });
    await store.finish("completed", { report, usage: noUsage() });
    return;
  }
  if (scoped.applicability.status === "no_target" || !scoped.selected) {
    const readiness = assessReadiness({ applicability: scoped.applicability, src, target: null, runtimeAvailable: false, appStartable: false });
    const report = baseReport({ decision: "not_ready_insufficient_evidence", headline: scoped.error ?? "An AI component was found but no reachable target could be bound.", applicability: readiness.applicability, profile: policy.profile, snapshotDigest: snap.contentDigest, limitations: readiness.notes });
    await store.finish("completed", { report, usage: noUsage() });
    return;
  }

  await step("readiness", "Checking the attack surface and selecting an isolated runtime");
  const selection = await selectSecurityRuntime(policy.runtime, deps.provider);
  const boot = await planBoot(null, dossier, src, planWorkspaces(dossier, src)).catch(() => ({ apps: [] }));
  const readiness = assessReadiness({ applicability: scoped.applicability, src, target: scoped.selected.target, runtimeAvailable: Boolean(selection.provider), appStartable: boot.apps.length > 0 });
  const environment: AdversarialReport["environment"] = {
    requested: policy.runtime,
    selected: selection.selected,
    provider: selection.provider?.name ?? null,
    fallbackReason: selection.fallbackReason,
    isolation: "The application runs in a disposable sandbox with outbound network disabled; attacks use synthetic identities, records, files, and loopback canaries only.",
  };
  await store.setPlan({ engine: AD_ENGINE_VERSION, applicability: readiness.applicability, lanes: readiness.lanes, runtime: { selected: selection.selected, fallbackReason: selection.fallbackReason, health: selection.health }, rerun: rerun ?? null });
  await store.event("readiness", readiness.reason);
  if (!selection.provider || !boot.apps.length) {
    const reason = !selection.provider ? selection.fallbackReason ?? "No sandbox runtime is available." : "No startable application was found.";
    const report = baseReport({ decision: "not_ready_environment_blocked", headline: reason, applicability: readiness.applicability, profile: policy.profile, snapshotDigest: snap.contentDigest, environment, limitations: readiness.notes, untested: readiness.lanes.filter((l) => !l.available).map((l) => ({ what: l.label, reason: l.reason })) });
    await store.finish("completed", { report, usage: noUsage() });
    return;
  }

  const target = scoped.selected.target;
  const component = scoped.applicability.components.find((c) => c.id === target.componentId);
  if (!component) return blocked(`The selected component ${target.componentId} is not present in the owned analysis.`);

  await step("surface_mapping", "Mapping entries, identities, tools, sinks, boundaries, and protected assets");
  const surface = buildSurface({ applicability: scoped.applicability, dossier, src, target });
  const endpoints = endpointKeys(dossier);
  const identities = syntheticIdentities(src);
  const attackers = classifyAttackers(identities);
  const tools = new Set(component.tools.map((t) => t.name).filter((x): x is string => Boolean(x)));
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
  await store.setPlan({ engine: AD_ENGINE_VERSION, applicability: readiness.applicability, lanes: readiness.lanes, surface, rulesOfEngagement: rules, runtime: { selected: selection.selected, fallbackReason: selection.fallbackReason, health: selection.health }, rerun: rerun ?? null });
  await store.event("surface_mapping", `Mapped ${surface.nodes.length} nodes, ${surface.edges.length} evidence-backed edges, ${endpoints.size} endpoints, ${identities.length} identities, and ${tools.size} tools.`);

  await step("planning", "Building deterministic attacks from the approved capability catalogue");
  const catalogue = buildCampaigns({
    target,
    component,
    attackers,
    surface: readiness.surface,
    auxiliary: scoped.selected.auxiliary,
    endpoints,
    otherOrderId: syntheticOtherOrderId(src),
    tenant: identities.find((i) => i.name === attackers.user)?.tenant ?? null,
  });
  const selectedCatalogue = rerun?.campaignIds?.length ? catalogue.filter((c) => rerun.campaignIds.includes(c.id)) : catalogue;

  await step("compiling", "Validating typed operations, ownership, rules of engagement, and safety budgets");
  const compiled = compilePlan(selectedCatalogue, { roe: rules, endpoints, identities: new Set(authority.allowedIdentities), tools, files, maxCampaigns: AD_PROFILE_LIMITS[policy.profile].campaigns });
  const compiledIds = new Set(compiled.campaigns.map((c) => c.id));
  let executable = selectedCatalogue.filter((c) => compiledIds.has(c.id));
  const untested = [
    ...compiled.rejected.map((x) => ({ what: x.id, reason: `Safety compiler rejected the campaign: ${x.reasons.join("; ")}` })),
    ...compiled.overBudget.map((x) => ({ what: x.id, reason: x.reason })),
    ...policy.attackPackIds.map((id) => ({ what: `Attack pack ${id}`, reason: "The pack is project-owned, but custom pack execution is not enabled in this engine version." })),
    ...readiness.lanes.filter((l) => !l.available).map((l) => ({ what: l.label, reason: l.reason })),
  ];
  await store.event("compiling", `${executable.length} of ${selectedCatalogue.length} catalogue campaigns passed the safety compiler.`);
  const attacker = await attackerReview(deps.session, policy.aiAttacker, executable);
  if (attacker.campaignIds.length) {
    const rank = new Map(attacker.campaignIds.map((id, i) => [id, i]));
    executable = [...executable].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }
  await store.event("planning", `Optional attacker review: ${attacker.status}. ${attacker.reason}`);

  const ctx = { ...deps, provider: selection.provider, store, runId: run.id, services: [], d: dossier, src, executions: [], findings: [], obligations: new Map(), sandboxOps: 0, sandboxCpu: 0, suiteSummaries: [], profile: "standard", thresholds: null } as unknown as Ctx;
  const archive = await buffer(await deps.objects.get(snap.archiveObjectKey));
  const apiCampaigns = executable.filter((c) => !c.steps.some((s) => s.operation === "open_known_page"));
  const browserCampaigns = executable.filter((c) => c.steps.some((s) => s.operation === "open_known_page"));

  await step("preparing", "Preparing a reusable application image and resettable synthetic fixtures");
  await step("campaigning", `Running ${apiCampaigns.length} API and tool campaigns with network isolation`);
  const runResult = await runAdversarialCampaigns(ctx, { dossier, src, archive, target, component, campaigns: apiCampaigns, endpoints, rules, profile: policy.profile, onEvent: (message) => store.event("campaigning", message) });
  const records: AdversarialCampaign[] = [...runResult.records];
  const verdicts = new Map<string, CampaignVerdict>(runResult.verdicts);
  const executionIds = [...runResult.executionIds];

  if (browserCampaigns.length) {
    await step("browser_campaigning", "Running the browser output canary against detected render sinks");
    const sinks = detectRenderSinks(src, { routePaths: [target.path, ...component.endpoints.map((e) => e.split(" ").pop() ?? "")], replySelector: target.responseSelector });
    for (const campaign of browserCampaigns) {
      const rendered = await runRenderCanary(ctx, { d: dossier, src, archive, applicability: scoped.applicability, sinks, nonce: `CCXSS${randomUUID().replace(/-/g, "").slice(0, 18)}`, executionKind: "adversarial_browser" }).catch((error: Error) => ({ ran: false, executed: false, reflected: false, page: null, detail: error.message, executionId: null }));
      const observation = browserObservation(campaign, rendered, sinks);
      const verdict = judgeCampaign(campaign, observation);
      verdicts.set(campaign.id, verdict);
      records.push(campaignRecord(campaign, verdict, records.length + 1));
      if (rendered.executionId) executionIds.push(rendered.executionId);
      await store.event("browser_campaigning", `${campaign.title}: ${verdict.status}.`);
    }
  }

  // A compiled campaign may still be impossible to translate into the harness. Preserve it explicitly; never let it
  // disappear from coverage or look like a pass.
  for (const campaign of executable) {
    if (verdicts.has(campaign.id)) continue;
    const observation: CampaignObservation = { ran: false, preconditions: { appBooted: false, targetReached: false, fixtureReady: false, oracleReady: false }, turns: [], toolCalls: [], citations: [], canaryHits: 0, xssExecuted: false, xssReflected: false, retrievalReached: false, toolSurfaceReached: false, responseOwned: null, stateAfter: {}, reset: false, resetRequired: campaign.resetStrategy !== "none", executionIds: [], evidence: component.evidence.slice(0, 4) };
    const verdict = judgeCampaign(campaign, observation);
    verdicts.set(campaign.id, verdict);
    records.push(campaignRecord(campaign, verdict, records.length + 1));
  }

  await step("validating", "Correlating campaigns into evidence-backed findings and attack chains");
  const findings = findingsFromCampaigns(executable, records, verdicts, component);
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

  const limitations = [
    ...readiness.notes,
    ...(runResult.appBooted ? [] : [runResult.bootNote]),
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
  const report = buildAdversarialReport({ applicability: readiness.applicability, surface, rules, lanes: readiness.lanes, catalogue: executable, campaigns: records, verdicts, chains, findings, profile: policy.profile, snapshotDigest: snap.contentDigest, environment, executionIds: [...new Set(executionIds)], aiAttacker: policy.aiAttacker, aiCritic: policy.aiCritic, attackerReview: attacker, criticReview: critic, aiUsage, limitations, untested, durationMs: Date.now() - started });
  const executions = (ctx as unknown as { executions: TestExecution[] }).executions;
  const models = Object.fromEntries(Object.entries(deps.session?.opts.models ?? {}));
  const usage: TestingUsage = { aiCalls: aiUsage.modelRequests, inputTokens: aiUsage.tokensIn, outputTokens: aiUsage.tokensOut, costUsd: aiUsage.costUsd, sandboxOperations: ctx.sandboxOps, sandboxCpuSeconds: Math.round(ctx.sandboxCpu), models };
  const terminal = report.audit.every((a) => a.ok) ? "completed" : "partial";
  await store.finish(terminal, { report, usage, error: terminal === "partial" ? report.headline : null });
  void executions;
  void CANARY;
}
