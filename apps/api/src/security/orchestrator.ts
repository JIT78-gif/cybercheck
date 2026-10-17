import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { eq } from "drizzle-orm";
import type { ProjectDossier, SecurityFinding, SecurityReport, TestExecution, TestingUsage } from "@cybercheck/contracts";
import { db } from "../db/client.ts";
import { snapshot, testingRun, understandingRun } from "../db/schema.ts";
import { env } from "../env.ts";
import { execute, type Ctx, type Deps } from "../testing/runtime.ts";
import type { RunStore } from "../testing/store.ts";
import { getSnapshotSource } from "../understanding/source.ts";
import { compileObligations } from "./obligations.ts";
import { factFindings, readRuns, SCAN_FILES, scanFindings, scanScript, verdicts, type ToolRun } from "./scan.ts";
import { rulePack, SECURITY_TOOLS, securityToolImage } from "./tools.ts";
import { readinessGate } from "./readiness.ts";
import { buildSecurityReport } from "./report.ts";
import { validateFindings } from "./validate.ts";
import { correlate } from "./correlate.ts";
import { runProofs } from "./proofs/run.ts";
import type { Hypothesis } from "./proofs/catalog.ts";
import { selectSecurityRuntime, type RuntimeChoice } from "./runtime.ts";
import { SandboxUnavailableError, type SandboxProvider } from "../testing/sandbox/provider.ts";

// The Security check (Round 1). It runs on the shared check-run machinery: the worker claims the run, keeps its
// heartbeat and fences late writes; this module decides what Security does. Round 1 needs no AI provider.

/** The Security engine version: recorded on every run and its report. */
export const SECURITY_ENGINE = "2026-10-15.s2";

/** Runtime-provable code patterns and the proof each becomes: a suspected static hit is confirmed only if a proof reproduces it. */
const PROVABLE: Record<string, true> = { "sql-injection": true, "sql-string-built": true, "path-traversal": true, ssrf: true, "open-redirect": true, xss: true, "error-disclosure": true, "token-integrity": true, "command-injection": true, "code-injection": true };
/** The endpoint a scan finding names, from "(GET /path)", "reached from GET /path" or "called by GET /path". */
function endpointOf(f: SecurityFinding): string | null {
  const text = `${f.title} ${f.observed}`;
  const m =
    text.match(/\b(?:reached from|called by|inside the handler of)\s+([A-Z]{3,7}\s+\/\S+)/) ??
    text.match(/\(([A-Z]{3,7}\s+\/[^)]*)\)/) ??
    text.match(/\b([A-Z]{3,7}\s+\/\S+)/);
  return m ? m[1]!.replace(/[).,;]+$/, "").trim() : null;
}

const noUsage = (): TestingUsage => ({ aiCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, sandboxOperations: 0, sandboxCpuSeconds: 0, models: {} });

export async function runSecurity(store: RunStore, deps: Deps, onProgress: (step: string) => void) {
  const [run] = await db.select().from(testingRun).where(eq(testingRun.id, store.runId));
  if (!run) throw new Error("run not found");
  const step = async (phase: Parameters<RunStore["phase"]>[0], text: string) => {
    onProgress(text);
    await store.phase(phase, text);
  };
  const blocked = async (reason: string) => {
    await store.event("admission", reason);
    await store.finish("blocked", { error: reason, usage: noUsage() });
    return { status: "blocked" as const, report: null };
  };

  // ---------------- admission: the same identity rules as Testing (a baselined snapshot and its own ready analysis)
  await step("admission", "Checking the snapshot and its analysis");
  const [snap] = await db.select().from(snapshot).where(eq(snapshot.id, run.snapshotId));
  const [ur] = run.understandingRunId ? await db.select().from(understandingRun).where(eq(understandingRun.id, run.understandingRunId)) : [];
  const d = ur?.dossier as ProjectDossier | null;
  if (!snap?.archiveObjectKey || !snap.contentDigest || snap.status !== "BASELINED") return blocked("The snapshot is not baselined.");
  if (!d || ur?.status !== "ready" || d.ai?.status === "running") return blocked("The project analysis is not ready. Wait until the project shows Ready.");
  if (d.meta?.contentDigest !== snap.contentDigest) return blocked("The analysis belongs to different content than this snapshot.");

  // ---------------- Phase Zero: the Analyze consistency and readiness gate (nothing from Analyze is trusted unchecked)
  await step("readiness", "Checking the project analysis against the snapshot before relying on it");
  const src = await getSnapshotSource(deps.objects, snap.archiveObjectKey);
  const gate = readinessGate({ raw: ur!.dossier, src, snapshotId: snap.id, contentDigest: snap.contentDigest, engine: SECURITY_ENGINE });
  const keys: Record<string, string> = {};
  for (const [name, text] of Object.entries(gate.artifacts)) {
    keys[name] = `security/${run.id}/${name}`;
    await deps.objects.put(keys[name]!, Readable.from([text]));
  }
  const { readiness } = gate;
  await store.setPlan({ engine: SECURITY_ENGINE, readiness, artifacts: keys, facts: gate.facts.length, evidence: gate.evidence.length });
  const errors = readiness.issues.filter((i) => i.severity === "error");
  await store.event("readiness", `Analysis readiness: ${readiness.level}. ${gate.facts.length} fact(s) from code and configuration, ${gate.manifest.evidence.verified} of ${gate.manifest.evidence.cited} citation(s) verified in this snapshot${errors.length ? `; ${errors.length} contradiction(s): ${errors.slice(0, 3).map((i) => i.rule).join(", ")}` : ""}${readiness.level === "PARTIALLY_READY" ? `; only these lanes may run: ${readiness.runnableLanes.join(", ")}` : ""}`);
  if (readiness.level === "BLOCKED") return blocked(`The project analysis cannot be used: ${readiness.issues.map((i) => i.message).join(" ")}`);

  // ---------------- the obligation graph: fixed requirements compiled by code from the checked facts
  await step("planning", "Compiling the security checklist from the checked facts");
  // A targeted rerun re-checks only the obligations it names (a focused run against a fresh snapshot; the original
  // run is a separate record and is never touched). Everything downstream scopes naturally to this set.
  const rerun = (run.policy as { rerun?: { parentRunId: string; obligationIds: string[] } } | null)?.rerun ?? null;
  const focus = rerun ? new Set(rerun.obligationIds) : null;
  let obligations = compileObligations({ dossier: gate.dossier!, facts: gate.facts, readiness, src });
  if (focus) obligations = obligations.filter((o) => focus.has(o.id));
  if (focus && !obligations.length) return blocked("None of the obligations named for this focused rerun exist in the current analysis.");
  await store.putObligations(obligations);
  const count = (s: string) => obligations.filter((o) => o.status === s).length;
  await store.event("planning", `${obligations.length} security obligation(s): ${count("planned")} for the scanners and rules, ${count("unsupported")} needing a runtime proof (Round 2), ${count("inconclusive")} inconclusive because the analysis contradicts itself, ${count("not_applicable")} not applicable`);

  // ---------------- choose the runtime: Nebius, local Docker, or analysis only (the project's code never runs on the host)
  const policy = (run.policy ?? {}) as { runtime?: RuntimeChoice };
  const selection = await selectSecurityRuntime(policy.runtime ?? "auto", (deps.provider as SandboxProvider | null) ?? null);
  await store.setPlan({ engine: SECURITY_ENGINE, readiness, artifacts: keys, facts: gate.facts.length, evidence: gate.evidence.length, runtime: { selected: selection.selected, fallbackReason: selection.fallbackReason, health: selection.health } });
  await store.event("preparing", selection.provider ? `Runtime: ${selection.selected}${selection.fallbackReason ? ` (${selection.fallbackReason})` : " (network off for every scan and proof)"}` : `No runtime available, analysis only: ${selection.fallbackReason}`);
  const ISOLATION: Record<typeof selection.selected, string> = {
    nebius: "An ephemeral Nebius sandbox; the network was off for every scan and proof.",
    local: "A disposable local container with no host project mount; the network was off for scans and proofs, capabilities were dropped and no-new-privileges was set.",
    static: "Analysis only; the project's code was never executed.",
  };
  const preferredHealth = selection.health.nebius ?? selection.health.local ?? { ok: selection.selected !== "static", status: selection.selected === "static" ? "not_configured" : "available", detail: null };
  const environment: SecurityReport["environment"] = {
    requested: policy.runtime ?? "auto",
    selected: selection.selected,
    provider: selection.provider?.name ?? null,
    fallbackReason: selection.fallbackReason,
    health: { ok: preferredHealth.ok, status: preferredHealth.status, detail: preferredHealth.detail ?? null },
    isolation: ISOLATION[selection.selected],
  };
  if (!selection.provider) {
    // Analysis only: readiness and the checklist, but nothing was executed, so no scanner or runtime obligation can
    // pass; they are inconclusive, and the decision is environment-blocked.
    const decided = obligations.map((o) => (["passed", "failed", "not_applicable"].includes(o.status) ? o : { ...o, status: "inconclusive" as const, reason: o.reason ?? "No runtime was available to execute this check; analysis only." }));
    await store.putObligations(decided);
    const report = buildSecurityReport({ engine: SECURITY_ENGINE, readiness, obligations: decided, findings: [], proofs: [], executions: [], runs: [], versions: null, toolImage: null, rulePackHash: rulePack().hash, scanExecutionId: null, scanTruncated: false, unsupportedLanguages: gate.manifest.unsupportedLanguages, skippedTestFileMatches: 0, validationNotes: 0 , environment });
    await store.finish("completed", { report, usage: noUsage() });
    return { status: "completed" as const, report };
  }
  const provider = selection.provider;

  // ---------------- the scanners: a pinned tool image (network on, trusted stage), then one offline scan of the snapshot
  // execute() records every sandbox command as an execution of this run, like Testing's.
  // services stays empty in Round 2: the proofs boot the app with its own storage (the Gauntlet uses in-memory), and
  // the proving harness reads ctx.services when it builds the boot command.
  const ctx = { ...deps, provider, store, runId: run.id, services: [], d: gate.dossier!, executions: [], sandboxOps: 0, sandboxCpu: 0 } as unknown as Ctx;
  const usage = (): TestingUsage => ({ ...noUsage(), sandboxOperations: ctx.sandboxOps, sandboxCpuSeconds: Math.round(ctx.sandboxCpu) });
  const pack = rulePack();
  let runs: ToolRun[] = [];
  let scanExec: string | null = null;
  let scanTruncated = false;
  let tools: Awaited<ReturnType<typeof securityToolImage>>;
  // If the runtime fails after execution has begun (e.g. Nebius returns HTTP 402 mid-run), keep the evidence gathered
  // so far and finish environment-blocked; never silently re-run mutations on another provider.
  try {
    await step("preparing", "Preparing the security tools (pinned versions, checksums verified)");
    tools = await securityToolImage(provider, async (label, req) => {
      const r = await execute(ctx, { kind: "security_tools", label, workspace: null }, req);
      return { ok: r.exec.outcome === "ok", image: r.result.resultImage, stdout: `${r.result.stdout}\n${r.result.stderr}`, executionId: r.exec.id };
    });
    if (tools.image === null) {
      const reason = tools.reason;
      await store.event("preparing", reason);
      runs = (["gitleaks", "semgrep", "osv", "trivy"] as const).map((name) => ({ name, ok: false, exitCode: null, output: null, problem: reason }));
    } else {
      await store.event("preparing", `Security tools ${tools.cached ? "reused" : "installed"}: Semgrep ${tools.versions.semgrep}, Gitleaks ${tools.versions.gitleaks}, OSV-Scanner ${tools.versions.osvScanner} (database ${tools.versions.osvDatabaseAt}), Trivy ${tools.versions.trivy}; rule pack ${pack.hash}`);
      await step("scanning", "Scanning the snapshot for secrets, vulnerable dependencies, risky code and configuration (network off)");
      const archive = await buffer(deps.objects.get(snap.archiveObjectKey));
      const files = [{ path: "/in/snapshot.tgz", fileId: await provider.upload(archive) }, ...(await Promise.all(pack.files.map(async (f) => ({ path: `/cc-rules/${f.name}`, fileId: await provider.upload(Buffer.from(f.text)) }))))];
      const r = await execute(ctx, { kind: "security_scan", label: "Scan the snapshot (secrets, dependencies, code rules, configuration)", workspace: null }, { image: tools.image, command: scanScript(), network: false, keep: true, timeoutSec: 1800, files });
      scanExec = r.exec.id;
      scanTruncated = r.result.truncated;
      // Read the outputs directly: the raw secret report must never become a stored artifact.
      const out = new Map<string, Buffer>();
      if (r.result.resultImage) for (const path of SCAN_FILES) {
        const body = await provider.readFile(r.result.resultImage, path).catch(() => null);
        if (body) out.set(path, body);
      }
      runs = readRuns(out);
    }
  } catch (err) {
    if (!(err instanceof SandboxUnavailableError)) throw err;
    await store.event("preparing", `The ${selection.selected} runtime became unavailable mid-run: ${err.message} Finishing with the evidence gathered so far.`);
    const decided = obligations.map((o) => (["passed", "failed", "not_applicable"].includes(o.status) ? o : { ...o, status: "inconclusive" as const, reason: `The runtime became unavailable before this check ran: ${err.message}` }));
    await store.putObligations(decided);
    const report = buildSecurityReport({ engine: SECURITY_ENGINE, readiness, obligations: decided, findings: [], proofs: [], executions: (ctx as unknown as { executions: TestExecution[] }).executions, runs: [], versions: null, toolImage: null, rulePackHash: pack.hash, scanExecutionId: null, scanTruncated: false, unsupportedLanguages: gate.manifest.unsupportedLanguages, skippedTestFileMatches: 0, validationNotes: 0 , environment });
    await store.finish("partial", { report, usage: usage() });
    return { status: "partial" as const, report };
  }

  // ---------------- findings and verdicts
  await step("validating", "Turning tool results into findings and verdicts");
  const salt = env.SECURITY_FINGERPRINT_SALT ?? createHash("sha256").update(`cybercheck-fingerprint:${env.BETTER_AUTH_SECRET}`).digest("hex");
  const versions = tools.image === null ? { semgrep: SECURITY_TOOLS.semgrep, gitleaks: SECURITY_TOOLS.gitleaks, osvScanner: SECURITY_TOOLS.osvScanner, trivy: SECURITY_TOOLS.trivy, osvDatabaseAt: "", trivyChecksAt: "" } : tools.versions;
  const scanned = scanFindings(runs, { d: gate.dossier!, src, rules: pack.rules, versions, rulePackHash: pack.hash, salt, executionId: scanExec ?? "" });
  // A focused rerun keeps only findings that belong to an obligation it is re-checking; the scanners still run in
  // full (they are holistic), so the drafts are scoped here to match the focused obligation set.
  const drafts = [...scanned.findings, ...factFindings(gate.dossier!, src, obligations, salt)].filter((f) => !focus || f.obligationIds.some((id) => focus.has(id)));
  // Obligations a configuration file needs but the compiler did not know about (a file only the scanner saw).
  for (const f of drafts) for (const id of f.obligationIds) if (!obligations.some((o) => o.id === id) && id.startsWith("sec:iac:")) obligations.push({ id, lane: "infrastructure", category: "infrastructure", asset: { kind: "config", ref: f.location?.path ?? id, label: f.location?.path ?? id }, requirement: `${f.location?.path ?? id} passes the configuration checks`, expectedControl: "No failing configuration check", applicabilityEvidence: f.evidence, standards: ["ASVS-5.0:V13 Configuration", "CWE-16"], priority: "medium", proofStrategy: "iac_scan", dependencies: [], status: "planned", reason: null, executionIds: [], findingIds: [] });
  // Validation before anything is stored: evidence must belong to this snapshot and run, statuses follow the class rules.
  const executions = (ctx as unknown as { executions: TestExecution[] }).executions;
  const validated = validateFindings(drafts.map((f, i) => ({ ...f, id: `S${i + 1}` })), src, executions);
  const findings: SecurityFinding[] = validated.findings;
  const codeFiles = [...src.files.keys()].filter((p) => /\.(c|m)?[jt]sx?$|\.py$/.test(p)).length;
  let decided = verdicts(obligations, findings, runs, { codeFiles, rulePackHash: pack.hash, versions }, scanExec);

  // ---------------- runtime proofs: boot the app in the sandbox and try to confirm the suspected code patterns
  let proofs: Awaited<ReturnType<typeof runProofs>>["proofs"] = [];
  let correlatedFindings = findings;
  const provableLanes = new Set(["injection", "access_control", "auth"]);
  const canProve = readiness.runnableLanes.some((l) => provableLanes.has(l));
  if (canProve) {
    await step("proving", "Proving the suspected weaknesses against the running app (network off during proofs)");
    const hypotheses: Hypothesis[] = findings.filter((f) => f.status === "suspected" && PROVABLE[f.category]).map((f) => ({ category: f.category, endpointRef: endpointOf(f) }));
    try {
      const archive = await buffer(deps.objects.get(snap.archiveObjectKey));
      const r = await runProofs(ctx, gate.dossier!, src, archive, hypotheses, decided, (m) => store.event("proving", m));
      proofs = r.proofs;
      for (let i = 0; i < proofs.length; i++) await store.putProof(proofs[i]!, i + 1);
      await store.event("proving", r.appBooted ? `${proofs.length} proof(s) ran. ${r.bootNote} ${proofs.filter((p) => p.verdict === "failed").length} reproduced a weakness, ${proofs.filter((p) => p.verdict === "passed").length} held, ${proofs.filter((p) => p.verdict === "blocked" || p.verdict === "inconclusive").length} could not be settled.` : `No runtime proof ran: ${r.bootNote}`);
      const endpointEvidence = new Map(gate.dossier!.entryPoints.map((e) => [`${e.method} ${e.path}`, e.handler]));
      const c = correlate(findings, proofs, decided, endpointEvidence);
      correlatedFindings = c.findings;
      decided = c.obligations;
      // A runtime obligation no proof could exercise is not left silently unsupported: it is marked not_applicable
      // with the precise reason the catalogue gave, so coverage reflects only what was genuinely applicable.
      const naReason = new Map(r.notApplicable.map((x) => [x.obligationId, x.reason]));
      decided = decided.map((o) => (o.proofStrategy === "runtime_proof" && (o.status === "unsupported" || o.status === "planned") && naReason.has(o.id) ? { ...o, status: "not_applicable" as const, reason: naReason.get(o.id)! } : o));
    } catch (err) {
      await store.event("proving", `Runtime proving did not run: ${(err as Error).message}. Static results stand.`);
    }
  }
  for (const f of correlatedFindings) await store.putFinding(f);
  await store.putObligations(decided);
  const findingsForReport = correlatedFindings;
  const summary = { tools: runs.map((t) => ({ name: t.name, ok: t.ok, exitCode: t.exitCode, problem: t.problem })), versions, rulePack: pack.hash, skippedTestFileMatches: scanned.skippedTestFiles, semgrepErrors: scanned.semgrepErrors };
  await deps.objects.put(`security/${run.id}/scan-summary.json`, Readable.from([JSON.stringify(summary, null, 2)]));
  const confirmed = findingsForReport.filter((f) => f.status === "confirmed").length;
  const failedTools = runs.filter((t) => !t.ok).map((t) => t.name);
  await store.event("validating", `${findingsForReport.length} finding(s): ${confirmed} confirmed, ${findingsForReport.filter((f) => f.status === "suspected").length} suspected${failedTools.length ? `; did not finish: ${failedTools.join(", ")}` : ""}${scanned.skippedTestFiles ? `; ${scanned.skippedTestFiles} match(es) in test files left out` : ""}`);

  // ---------------- the report: decision, coverage with both numbers, tools and data, what did not run, and the audit
  await step("reporting", "Writing the report and the release decision");
  const report = buildSecurityReport({
    engine: SECURITY_ENGINE,
    readiness,
    obligations: decided,
    findings: findingsForReport,
    proofs,
    executions,
    runs,
    versions: tools.image === null ? null : tools.versions,
    toolImage: tools.image,
    rulePackHash: pack.hash,
    scanExecutionId: scanExec,
    scanTruncated,
    unsupportedLanguages: gate.manifest.unsupportedLanguages,
    skippedTestFileMatches: scanned.skippedTestFiles,
    validationNotes: validated.notes.length,
    environment,
  });
  const status = failedTools.length ? ("partial" as const) : ("completed" as const);
  await store.finish(status, { report, usage: usage() });
  return { status, report };
}
