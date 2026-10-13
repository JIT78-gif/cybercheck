import type { Evidence, TestExecution } from "@cybercheck/contracts";
import { redactSecrets, type SnapshotSource } from "../understanding/source.ts";
import { OUT, wsPath, type SuitePlan } from "./adapters.ts";
import { codeUnderTest, excerpt, explainProblem, intentContext, testFilesContext, validEvidence } from "./agents.ts";
import { parseJestJson, parseJunit, parseLogSummary, progressFromLog, type ParsedSuite } from "./reports.ts";
import { serviceEnv, startServices } from "./services.ts";
import { stackLocations, testFileOf, type Candidate } from "./triage.ts";
import { CI_ENV, POLICY, PROFILES, TSX, addFinding, execute, setOb, sha, shq, tail, toProjectPaths, type Ctx } from "./runtime.ts";

// The project's own test suites: repeated clean runs, flake detection, zero-test and hang detection.

export type SuiteRun = { exec: TestExecution; parsed: ParsedSuite; timedOut: boolean; exitCode: number | null; output: string };

export async function runSuite(ctx: Ctx, image: string, s: SuitePlan, count = PROFILES[ctx.profile].suiteRuns, offset = 0): Promise<{ runs: SuiteRun[] }> {
  const runs = await Promise.all(
    Array.from({ length: count }, (_v, j) => j + offset).map((i) =>
      execute(ctx, { kind: i === 0 ? "suite" : "suite_rerun", label: `${s.framework === "unknown" ? "Test" : s.framework} suite (${s.workspace}) run ${i + 1}`, workspace: s.workspace, fetch: s.report ? [s.report.path] : [], idleSec: POLICY.suiteIdleSec }, {
        image,
        command: `${startServices(ctx.services)}mkdir -p ${OUT} && cd ${shq(wsPath(s.workspace))} && ${s.command}`,
        network: false,
        keep: Boolean(s.report),
        timeoutSec: POLICY.suiteTimeoutSec,
        env: { ...CI_ENV, ...serviceEnv(ctx.services), FORCE_COLOR: "0", NO_COLOR: "1" },
      }),
    ),
  );
  return {
    runs: runs.map(({ exec, result, files }) => {
      const output = `${result.stdout}\n${result.stderr}`;
      let parsed: ParsedSuite | null = null;
      const report = s.report ? files.get(s.report.path) : undefined;
      if (report) {
        try {
          parsed = s.report!.format === "jest-json" ? parseJestJson(report.toString("utf8")) : parseJunit(report.toString("utf8"));
        } catch {
          parsed = null;
        }
      }
      parsed ??= parseLogSummary(output);
      // Failure details refer to sandbox paths; map them to project paths.
      parsed.failures = parsed.failures.map((f) => ({ ...f, file: f.file ? toProjectPaths(f.file) : null, detail: redactSecrets(toProjectPaths(f.detail)).text }));
      parsed.cases = parsed.cases.map((c) => ({ ...c, file: c.file ? toProjectPaths(c.file) : null }));
      return { exec, parsed, timedOut: exec.outcome === "timed_out", exitCode: exec.exitCode, output };
    }),
  };
}

/** The line of a script in a workspace's package.json, e.g. its "test" script. */
export function scriptLine(src: SnapshotSource, workspace: string, name: string): Evidence | null {
  const path = workspace === "." ? "package.json" : `${workspace}/package.json`;
  const i = src.files.get(path)?.text.split("\n").findIndex((l) => l.includes(`"${name}":`)) ?? -1;
  return i >= 0 ? { path, line: i + 1 } : null;
}

/** The failing test's file in the snapshot: the report's file, else the first test-like stack location. */

export function consistentFailures(runs: SuiteRun[]) {
  if (runs.some((r) => r.timedOut) || !runs.some((r) => r.parsed.cases.length)) return [];
  const counts = new Map<string, number>();
  for (const r of runs) for (const c of r.parsed.cases) if (c.status === "failed" || c.status === "error") counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  return [...counts].filter(([, n]) => n === runs.length).map(([k]) => k);
}

/** Stack locations in a failure that are project files (not node_modules). */

export async function judgeSuite(ctx: Ctx, s: SuitePlan, runs: SuiteRun[], candidates: Candidate[]) {
  const runsOb = `suite:runs:${s.workspace}`;
  const passOb = `suite:passes:${s.workspace}`;
  const execIds = runs.map((r) => r.exec.id);
  // Per-test results from the richest run, for the report table.
  const richest = [...runs].sort((a, b) => b.parsed.total - a.parsed.total)[0]!.parsed;
  const worst = runs.map((r) => r.parsed).sort((a, b) => b.failed - a.failed)[0]!;
  const cases = richest.cases.map((c) => ({ ...c, status: runs.some((r) => r.parsed.cases.some((x) => x.name === c.name && (x.status === "failed" || x.status === "error"))) ? ("failed" as const) : c.status }));
  ctx.suiteSummaries.push({ workspace: s.workspace, framework: s.framework, command: s.declared, tests: { total: richest.total, passed: cases.filter((c) => c.status === "passed").length || richest.passed, failed: Math.max(worst.failed, cases.filter((c) => c.status === "failed").length), skipped: richest.skipped }, cases: cases.slice(0, 400) });
  const label = `${s.framework === "unknown" ? "test" : s.framework} suite${s.workspace === "." ? "" : ` in ${s.workspace}`}`;

  if (runs.every((r) => r.exec.outcome === "error")) {
    for (const id of [runsOb, passOb]) await setOb(ctx, id, { status: "blocked", reason: "The sandbox could not run the suite.", executionIds: execIds });
    return;
  }
  const timedOut = runs.filter((r) => r.timedOut);
  if (timedOut.length) {
    const prog = progressFromLog(timedOut[0]!.output);
    await setOb(ctx, runsOb, { status: "failed", reason: `The suite did not finish in ${timedOut.length} of ${runs.length} runs and was stopped (limit ${POLICY.suiteTimeoutSec}s, or ${POLICY.suiteIdleSec}s without any output).`, executionIds: execIds });
    await setOb(ctx, passOb, { status: "inconclusive", reason: "The suite was stopped before it finished, so results are incomplete.", executionIds: execIds });
    // Which test hangs and why: explained from the runner's progress and the test code (the verdict is already fixed).
    const hang = ctx.session ? await explainProblem(ctx.session, [`The suite was stopped after ${POLICY.suiteTimeoutSec}s.`, `Tests reported as passed before it stopped: ${prog.passed.slice(-40).join("; ") || "none"}`, `Tests reported as failed: ${prog.failed.join("; ") || "none"}`, `Runner output (end):\n${tail(redactSecrets(toProjectPaths(timedOut[0]!.output)).text, 2500)}`, ...testFilesContext(ctx.src, s.workspace), intentContext(ctx.src, 3_000)].join("\n\n")) : null;
    await addFinding(ctx, {
      kind: "suite_integrity",
      status: "confirmed",
      severity: "medium",
      confidence: timedOut.length === runs.length ? "high" : "medium",
      title: `The ${label} hangs`,
      expected: `The suite finishes (limit ${POLICY.suiteTimeoutSec}s; stopped earlier after ${POLICY.suiteIdleSec}s without output)`,
      // Only claim progress numbers when the runner's output was actually captured.
      actual: `Stopped in ${timedOut.length} of ${runs.length} runs. ${prog.passed.length + prog.failed.length ? `${prog.passed.length} test(s) had passed and ${prog.failed.length} failed before it stopped${prog.passed.length ? ` (last passed: "${prog.passed.at(-1)}")` : ""}.` : "The runner's progress output was not captured, so how many tests finished first is unknown."} A test or open handle keeps the runner alive.`,
      reproduction: s.command,
      rootCause: hang?.rootCause ? `${hang.test ? `Test "${hang.test}": ` : ""}${hang.rootCause}` : null,
      location: hang?.location ? (validEvidence(ctx.src, [hang.location])[0] ?? null) : null,
      obligationIds: [runsOb, passOb],
      executionIds: execIds,
      validation: "Timeout enforced and reported by the sandbox platform.",
      limitation: "Which test hangs is inferred from the runner's progress output.",
    });
    return;
  }

  const counts = runs.map((r) => r.parsed);
  const zero = counts.every((p) => p.total === 0);
  if (zero) {
    const exited0 = runs.every((r) => r.exitCode === 0);
    const unreadable = counts.every((p) => p.source === "none");
    if (unreadable && !exited0) {
      // Nothing parseable and a failure exit: a crash before tests ran.
      await setOb(ctx, runsOb, { status: "failed", reason: `The suite exited with code ${runs[0]!.exitCode} before reporting any test.`, executionIds: execIds });
      await setOb(ctx, passOb, { status: "inconclusive", reason: "No test results were produced.", executionIds: execIds });
      candidates.push({ source: "suite", label: `${label} fails to start`, obligationIds: [runsOb], executionIds: execIds, reproduced: runs.length, of: runs.length, context: `The ${label} (${s.command}) exited with code ${runs[0]!.exitCode} before any test ran, in all ${runs.length} runs.\nOutput (last part):\n${tail(redactSecrets(toProjectPaths(runs[0]!.output)).text, 3000)}`, locations: stackLocations(ctx.src, s.workspace, runs[0]!.output), workspace: s.workspace });
      return;
    }
    if (unreadable && exited0) {
      await setOb(ctx, runsOb, { status: "inconclusive", reason: "The test command exited 0 but printed no result summary cybercheck recognizes, so it is unknown whether any test ran.", executionIds: execIds });
      await setOb(ctx, passOb, { status: "inconclusive", reason: "Results could not be read.", executionIds: execIds });
      return;
    }
    await setOb(ctx, runsOb, { status: "failed", reason: `The suite ran 0 tests${exited0 ? " but still exited with code 0" : ""}.`, executionIds: execIds });
    await setOb(ctx, passOb, { status: "inconclusive", reason: "No tests ran, so nothing could pass.", executionIds: execIds });
    await addFinding(ctx, {
      kind: "suite_integrity",
      status: "confirmed",
      severity: "medium",
      confidence: "high",
      title: `The ${label} runs no tests${exited0 ? " yet reports success" : ""}`,
      expected: "At least one test runs",
      actual: `0 tests ran in ${runs.length} of ${runs.length} runs${exited0 ? "; the command still exited with code 0, so CI would show it as passing" : ""}.`,
      reproduction: s.command,
      rootCause: `The test command "${s.declared}" found no test files (wrong pattern, or no tests written)${/passWithNoTests|--pass-with-no-tests|exit 0||| true/.test(s.declared) ? ", and it is set up to report success when nothing runs" : ""}.`,
      location: scriptLine(ctx.src, s.workspace, "test"),
      obligationIds: [runsOb, passOb],
      executionIds: execIds,
      validation: counts[0]!.source === "report" ? "Counted from the runner's machine-readable report." : "Counted from the runner's summary output.",
      limitation: null,
    });
    return;
  }

  await setOb(ctx, runsOb, { status: "passed", reason: null, executionIds: execIds });
  // Per test: how many runs it failed in.
  const names = new Set(counts.flatMap((p) => p.cases.map((c) => c.name)));
  const failedIn = new Map<string, number>();
  for (const p of counts) for (const c of p.cases) if (c.status === "failed" || c.status === "error") failedIn.set(c.name, (failedIn.get(c.name) ?? 0) + 1);
  const consistent = [...failedIn].filter(([, n]) => n === runs.length).map(([k]) => k);
  const flaky = [...failedIn].filter(([, n]) => n < runs.length).map(([k]) => k);
  const anyFailNoCases = counts.some((p) => p.failed > 0 && p.cases.length === 0);
  const total = Math.max(...counts.map((p) => p.total));

  if (!failedIn.size && !anyFailNoCases && runs.every((r) => r.exitCode === 0)) {
    await setOb(ctx, passOb, { status: "passed", reason: `${total} test(s) passed in each of ${runs.length} clean runs.`, executionIds: execIds });
    return;
  }
  if (!failedIn.size && !anyFailNoCases) {
    await setOb(ctx, passOb, { status: "inconclusive", reason: `All reported tests passed but the command exited with code ${runs.find((r) => r.exitCode !== 0)?.exitCode} (a failure outside the tests, such as a coverage threshold or teardown error).`, executionIds: execIds });
    return;
  }
  // Failures without per-test results (the runner only printed a summary): judge by the runs themselves.
  if (!failedIn.size && anyFailNoCases) {
    const failingRuns = counts.filter((p) => p.failed > 0).length;
    const consistentFail = failingRuns === runs.length;
    await setOb(ctx, passOb, {
      status: consistentFail ? "failed" : "flaky",
      reason: consistentFail ? `Tests failed in all ${runs.length} runs (the runner reported counts but not which tests).` : `Tests failed in ${failingRuns} of ${runs.length} runs (the runner reported counts but not which tests).`,
      executionIds: execIds,
    });
    if (consistentFail) {
      const out = runs[0]!.output;
      candidates.push({ source: "suite", label: `The ${label} fails`, obligationIds: [passOb], executionIds: execIds, reproduced: runs.length, of: runs.length, context: [`The project's ${label} (${s.command}) reported failing tests in all ${runs.length} clean runs; per-test results were not available.`, `Output (last part):\n${tail(redactSecrets(toProjectPaths(out)).text, 3500)}`, ...stackLocations(ctx.src, s.workspace, out).map((l) => excerpt(ctx.src, l.path, l.line, 15, 15)).filter(Boolean)].join("\n\n"), locations: stackLocations(ctx.src, s.workspace, out), workspace: s.workspace });
    }
    return;
  }

  for (const name of flaky) {
    const n = failedIn.get(name)!;
    const detail = counts.flatMap((p) => p.failures).find((x) => x.name === name)?.detail ?? "";
    const locs = stackLocations(ctx.src, s.workspace, detail);
    const why = ctx.session && detail ? await explainProblem(ctx.session, [`This test failed in ${n} of ${runs.length} identical clean runs and passed in the others: ${name}`, `Failure output:\n${tail(detail, 2000)}`, ...locs.map((l) => excerpt(ctx.src, l.path, l.line, 20, 20)).filter(Boolean), ...codeUnderTest(ctx.src, testFileOf(ctx.src, null, locs), 8_000), intentContext(ctx.src, 3_000)].join("\n\n")) : null;
    await addFinding(ctx, {
      kind: "flaky",
      status: "confirmed",
      severity: "medium",
      confidence: "high",
      title: `Flaky test: ${name}`,
      expected: "The same test gives the same result on identical code and environment",
      actual: `Failed in ${n} of ${runs.length} identical clean runs and passed in the others.`,
      reproduction: `${s.command} (repeat several times)`,
      rootCause: why?.rootCause ?? (detail.split("\n")[0] || null),
      location: why?.location ? (validEvidence(ctx.src, [why.location])[0] ?? locs[0] ?? null) : (locs[0] ?? null),
      obligationIds: [passOb],
      executionIds: execIds,
      validation: `${runs.length} parallel runs from the same installed image disagreed.`,
      limitation: "A flaky test is not proof of a product defect; it may depend on time, randomness or ordering.",
    });
  }

  // Consistent failures go to triage, grouped by their first failure line.
  const failures = counts[0]!.failures.filter((f) => consistent.includes(f.name));
  const groups = new Map<string, typeof failures>();
  for (const f of failures) {
    const sig = `${f.file ?? ""}::${f.detail.split("\n").find((l) => l.trim())?.replace(/\d+/g, "N").slice(0, 120) ?? ""}`;
    groups.set(sig, [...(groups.get(sig) ?? []), f]);
  }
  for (const group of groups.values()) {
    const f = group[0]!;
    const locs = stackLocations(ctx.src, s.workspace, f.detail);
    candidates.push({
      source: "suite",
      label: group.length > 1 ? `${group.length} tests fail the same way (first: ${f.name})` : f.name,
      obligationIds: [passOb],
      executionIds: execIds,
      reproduced: runs.length,
      of: runs.length,
      context: [
        `An existing ${s.framework} test of the project failed in all ${runs.length} clean runs.`,
        `Test${group.length > 1 ? "s" : ""}: ${group.map((g) => g.name).join("; ")}`,
        `Failure output:\n${tail(f.detail, 2500)}`,
        ...locs.map((l) => excerpt(ctx.src, l.path, l.line, 15, 15)).filter(Boolean),
        "Product code this test exercises:",
        ...codeUnderTest(ctx.src, testFileOf(ctx.src, f.file, locs)),
      ].join("\n\n"),
      locations: locs,
      workspace: s.workspace,
      testNames: group.map((g) => g.name),
    });
  }
  const status = consistent.length ? "failed" : "flaky";
  await setOb(ctx, passOb, {
    status,
    reason: consistent.length ? `${consistent.length} of ${total} test(s) failed in every run${flaky.length ? `; ${flaky.length} more failed only sometimes` : ""}.` : `${flaky.length} test(s) failed in some runs but not others.`,
    executionIds: execIds,
  });
}

