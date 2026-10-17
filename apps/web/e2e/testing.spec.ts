import { expect, test, type Route } from "@playwright/test";
import type { TestingRunDetail } from "@cybercheck/contracts";
import { giveEachTestItsOwnIp, signedInUser } from "./helpers";

giveEachTestItsOwnIp(test);

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const ob = (id: string, status: TestingRunDetail["obligations"][number]["status"], objective: string, reason: string | null = null, layer: TestingRunDetail["obligations"][number]["layer"] = "api") => ({
  id,
  layer,
  asset: { kind: "endpoint" as const, ref: id, label: id.split(":")[1] ?? id },
  objective,
  priority: "high" as const,
  oracle: { source: "http_semantics" as const, expected: "no 5xx response", evidence: [] },
  status,
  reason,
  origin: "dossier" as const,
  executionIds: ["e1"],
  findingIds: [],
});

function run(status: TestingRunDetail["status"]): TestingRunDetail {
  const done = status === "completed";
  return {
    id: "run-1",
    snapshotId: "snap-1",
    projectId: "proj-1",
    status,
    phase: done ? "done" : "executing",
    step: done ? null : "Running build checks, the project's tests and HTTP probes in parallel sandboxes",
    progress: done ? null : 0.4,
    headline: done ? "1 confirmed defect. 4 of 5 planned checks ran; 1 could not run (see Not tested)." : null,
    counts: { obligations: 5, terminal: done ? 5 : 2, failed: 1, confirmedDefects: done ? 1 : 0 },
    error: null,
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    startedAt: new Date(Date.now() - 110_000).toISOString(),
    finishedAt: done ? new Date().toISOString() : null,
    obligations: [
      ob("env:install:.", "passed", "Dependencies install from the lockfile", null, "environment"),
      ob("api:POST /transfers:empty-body", done ? "failed" : "running", "Handles an empty JSON object body without a server error", done ? "server error 500 (POST /transfers)." : null),
      ob("api:GET /health:public", "passed", "Answers without credentials and without a server error"),
      ob("suite:passes:.", done ? "passed" : "planned", "Every existing test passes, consistently across repeated clean runs", done ? "22 test(s) passed in each of 3 clean runs." : null, "existing_suite"),
      { ...ob("req:req-transfer-amount:transfers:missing", done ? "failed" : "planned", "A transfer without an amount is refused", done ? "the amount is required: expected 400, observed 500" : null), requirementIds: ["req-transfer-amount"], scenarioId: "transfers:missing", proofLevel: "response" as const, proofs: done ? [{ requirementId: "req-transfer-amount", assertionId: "refused", scenarioId: "transfers:missing", executionId: "e1", passed: false, expected: 400, observed: 500, targetReached: true, stateVerified: false, excerpt: "500 TypeError" }] : [] },
      ob("integration:Stripe:live", "blocked", "Calls to Stripe work against the real service", "The sandbox has no internet access and no credentials for third-party services.", "integration"),
    ],
    executions: [
      { id: "e1", kind: "probe", label: "Start the app and probe 18 request(s)", workspace: ".", command: "node /cc/harness.mjs /cc/spec.json /out", network: false, sandbox: { provider: "nebius-sandboxes", operationId: "op-1", imageId: "img" }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 6100, exitCode: 0, timedOut: false, outcome: "ok", outputTail: "harness: boot=true probes=18 failed=1", artifacts: [{ name: "output.txt", key: "k", bytes: 10, sha256: "x" }], envNames: ["ADMIN_TOKEN", "PORT"], resources: { cpuSeconds: 2, maxRssKb: 1000 }, retryOf: null },
    ],
    findings: done
      ? [
          { id: "F1", kind: "product_defect", status: "confirmed", severity: "high", confidence: "high", title: "POST /transfers crashes on a body without an amount", expected: "A 400 response for an invalid body", actual: "HTTP 500 with a TypeError", reproduction: "POST /transfers with body {} (signed in as admin)", rootCause: "The handler reads body.amount without validation.", location: { path: "src/routes/transfers.ts", line: 18 }, obligationIds: ["api:POST /transfers:empty-body", "req:req-transfer-amount:transfers:missing"], executionIds: ["e1"], validation: "Failed in 2 of 2 clean run(s). Independent review: confirm.", limitation: null },
          { id: "F2", kind: "environment_failure", status: "confirmed", severity: "info", confidence: "high", title: "Stripe contract test needs the internet", expected: "-", actual: "ENOTFOUND api.stripe.com", reproduction: "npm test", rootCause: null, location: null, obligationIds: [], executionIds: ["e1"], validation: "Offline sandbox.", limitation: null },
        ]
      : [],
    report: done
      ? {
          headline: "1 confirmed defect. 4 of 5 planned checks ran; 1 could not run (see Not tested).",
          verdict: "defects_found",
          totals: { planned: 0, running: 0, passed: 3, failed: 1, flaky: 0, blocked: 1, unsupported: 0, skipped: 0, not_applicable: 0, inconclusive: 0 },
          measures: [{ label: "Obligations with a recorded result", numerator: 5, denominator: 5, note: null }],
          suites: [{ workspace: ".", framework: "vitest", command: "vitest run", verdict: "passed", tests: { total: 22, passed: 22, failed: 0, skipped: 0 }, cases: [{ name: "accounts > creates an account", file: "test/api.test.ts", status: "passed", durationMs: 4, message: null }], executionIds: ["e1"] }],
          untested: [{ reason: "Blocked: The sandbox has no internet access and no credentials for third-party services.", obligations: ["integration:Stripe:live"], count: 1 }],
          environment: { provider: "nebius-sandboxes", image: "docker.io/library/node:22-bookworm", runtime: "v22.23.3", cpus: 4, memoryMb: 4096, network: "on only while installing dependencies", syntheticEnv: ["ADMIN_TOKEN"] },
          performance: { requests: 18, p50Ms: 4, p95Ms: 12, note: "measurement" },
          limitations: ["Configuration and credentials are synthetic test values, never your real secrets."],
          audit: [{ check: "Every pass is backed by a sandbox execution", ok: true, detail: "all passes cite an execution" }],
          schemaVersion: 2,
          profile: "standard",
          assessment: "defects_found",
          release: {
            decision: "not_ready_product_failures",
            gates: [
              { id: "completeness", label: "Testing completeness is at least 90%", ok: false, detail: "54.5% of risk-weighted applicable scope has decisive, strong evidence" },
              { id: "defects", label: "No open critical or high product defect", ok: false, detail: "1 confirmed: POST /transfers crashes on a body without an amount" },
            ],
            reasons: [],
          },
          completeness: { percent: 54.5, earnedWeight: 12, applicableWeight: 22, criticalDecisive: 2, criticalTotal: 2, threshold: 90 },
          productHealth: { percent: 75, passedWeight: 15, decisiveWeight: 20, excluded: { inconclusive: 0, blocked: 1, unsupported: 0, skipped: 0 } },
          claims: [
            { id: "C1", kind: "proved", text: "Install passed (project root)", obligationIds: ["env:install:."] },
            { id: "C2", kind: "problem", text: "1 confirmed product defect", obligationIds: ["api:POST /transfers:empty-body"] },
            { id: "C3", kind: "not_proved", text: "External integrations: not tested (blocked)", obligationIds: ["integration:Stripe:live"] },
          ],
          nextActions: [{ label: "Fix 1 confirmed defect, then rerun the affected checks", kind: "fix", obligationIds: ["api:POST /transfers:empty-body"] }],
          layers: [
            { layer: "environment", planned: 1, decisive: 1, passed: 1, failed: 0, flaky: 0, inconclusive: 0, blocked: 0, unsupported: 0, completeness: 100, confidence: "strong", gap: null, nextAction: null },
            { layer: "api", planned: 2, decisive: 2, passed: 1, failed: 1, flaky: 0, inconclusive: 0, blocked: 0, unsupported: 0, completeness: 52, confidence: "partial", gap: null, nextAction: null },
          ],
          capabilities: [{ name: "Transfers", obligations: 1, decisive: 1, passed: 0, failed: 1, proofClasses: [], existingTests: 3, missing: "No business behaviour was proven" }],
          requirements: [{ id: "req-transfer-amount", capability: "Transfers", source: { kind: "documentation", path: "README.md", line: 12, quote: "A transfer needs a positive amount" }, expectedBehavior: "A transfer without an amount is refused with a 4xx", affectedAssets: ["POST /transfers"], requiredProof: "response", priority: "critical" }],
          inventory: [
            { id: "endpoint:POST /transfers", kind: "endpoint", label: "POST /transfers", location: null, discoveredBy: "express route", executed: true },
            { id: "endpoint:GET /health", kind: "endpoint", label: "GET /health", location: null, discoveredBy: "express route", executed: true },
            { id: "endpoint:DELETE /accounts/:id", kind: "endpoint", label: "DELETE /accounts/:id", location: null, discoveredBy: "express route", executed: false },
            { id: "screen:/", kind: "screen", label: "/", location: null, discoveredBy: "served by the backend (static html)", executed: true },
          ],
          proofSummary: { business: 3, state: 1, response: 1, statusOnly: 1, legacy: 0 },
          databaseStrategy: "api_level",
          screens: [{ path: "/", source: "static_html", location: null, target: "backend_served" }],
          fixtures: { digest: "abc", nodes: [{ id: "admin", label: "Sign in as admin", ok: true, detail: "sign-in answered 200; token captured" }] },
          load: {
            note: "Measured with k6 inside one sandbox.",
            executionId: "e1",
            thresholds: null,
            stages: [
              { name: "smoke", vus: 1, durationSec: 20, requests: 400, rps: 20, errorRatePct: 0, p50Ms: 2, p95Ms: 5, maxMs: 9, verdict: "passed", series: [0, 1, 2, 3].map((t) => ({ t, rps: 20, p50Ms: 2, p95Ms: 5, errorRatePct: 0, vus: 1 })), reportName: "k6-smoke.html" },
              { name: "breakpoint", vus: 120, durationSec: 60, requests: 6000, rps: 100, errorRatePct: 9, p50Ms: 40, p95Ms: 2600, maxMs: 9000, verdict: "measured", limitRps: 180, brokeBy: "errors", reportName: "k6-breakpoint.html", series: [10, 60, 120, 180, 150, 140].map((rps, t) => ({ t, rps, p50Ms: 20, p95Ms: t < 4 ? 80 : 2600, errorRatePct: t < 4 ? 0 : 20, vus: 10 + t * 20 })) },
            ],
          },
        }
      : null,
    usage: { aiCalls: 9, inputTokens: 30000, outputTokens: 9000, costUsd: 0.056, sandboxOperations: 12, sandboxCpuSeconds: 40, models: {} },
  };
}

test("a finished run shows defects with evidence, untested scope and the full ledger", async ({ page }) => {
  await signedInUser(page, "Ledger Tester");
  await page.route("**/v1/testing-runs/run-1/events**", (r) => json(r, { events: [{ seq: 1, type: "phase:done", message: "Done", at: new Date().toISOString() }] }));
  await page.route("**/v1/testing-runs/run-1", (r) => json(r, { run: run("completed") }));
  await page.goto("/app/projects/proj-1/testing/run-1");

  await expect(page.getByRole("heading", { name: "Testing run", level: 1 })).toBeVisible();
  const sections = page.getByRole("tablist", { name: "Run sections" });
  await expect(sections.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
  // Overview: the release decision leads; workflow completion is neutral, never a green "passed".
  await expect(page.getByRole("heading", { name: "Not ready: confirmed product defects" })).toBeVisible();
  await expect(page.getByText("Workflow finished", { exact: true })).toBeVisible();
  await expect(page.getByText("54.5%", { exact: true })).toBeVisible();
  await expect(page.getByText("Testing completeness is at least 90%:")).toBeVisible();
  await expect(page.getByText("Install passed (project root)")).toBeVisible();
  await expect(page.getByText("External integrations: not tested (blocked)")).toBeVisible();
  await expect(page.getByRole("region", { name: "What to do next" })).toBeVisible();
  const evidence = page.getByRole("region", { name: "Evidence behind this result" });
  await expect(evidence.getByText("2 of 3 tested")).toBeVisible();
  await expect(evidence.getByText(/1 saw only a status code/)).toBeVisible();
  await expect(evidence.getByText(/in memory inside the app process/)).toBeVisible();
  // At a glance: every check by result and by layer, with the numbers next to each chart.
  const glance = page.getByRole("region", { name: "At a glance" });
  await expect(glance.getByText("All checks")).toBeVisible();
  await expect(glance.getByText("Results by layer")).toBeVisible();
  await expect(glance.getByRole("table", { name: "Checks by layer" })).toBeAttached();

  // Problems: the first one is open beside the list, with expected vs actual, how to reproduce and how it was verified.
  await sections.getByRole("tab", { name: /Problems/ }).click();
  await expect(page).toHaveURL(/tab=problems/);
  await expect(page.getByText("A 400 response for an invalid body")).toBeVisible();
  await expect(page.getByText("POST /transfers with body {} (signed in as admin)")).toBeVisible();
  await expect(page.getByText(/Independent review: confirm/)).toBeVisible();
  await expect(page.getByRole("button", { name: /src\/routes\/transfers\.ts:18/ })).toBeVisible();
  // A failed assertion shows what it expected and what it saw.
  await expect(page.getByText("What the checks expected and saw")).toBeVisible();
  await expect(page.getByText("refused", { exact: true })).toBeVisible();
  // Environment blockers are a separate group, never mixed with product defects.
  await page.getByRole("tablist", { name: "Problem groups" }).getByRole("tab", { name: /Environment/ }).click();
  await expect(page.getByText("Stripe contract test needs the internet").first()).toBeVisible();

  // Checks: coverage by layer and capability, missing evidence, and the ledger, filterable by status and by layer.
  await sections.getByRole("tab", { name: /Checks/ }).click();
  await expect(page.getByRole("heading", { name: "Coverage by capability" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Missing evidence" })).toBeVisible();
  await page.getByRole("group", { name: "Filters" }).getByRole("button", { name: /^Failed/ }).click();
  await expect(page.getByRole("row").filter({ hasText: "server error" })).toHaveCount(1);
  await expect(page.getByRole("row").filter({ hasText: "Dependencies install" })).toHaveCount(0);
  // Requirements: what the docs say, where, and what the check found.
  await page.getByRole("tablist", { name: "Layers" }).getByRole("tab", { name: /Requirements/ }).click();
  await expect(page.getByText("A transfer without an amount is refused with a 4xx")).toBeVisible();
  await expect(page.getByText(/“A transfer needs a positive amount”/)).toBeVisible();
  await page.getByRole("tablist", { name: "Layers" }).getByRole("tab", { name: /Install, build and start/ }).click();
  await expect(page.getByRole("row").filter({ hasText: "Dependencies install" })).toHaveCount(1);

  // Load: the measured stages.
  await sections.getByRole("tab", { name: "Load" }).click();
  await expect(page.getByRole("heading", { name: "Load and capacity" })).toBeVisible();
  // The breakpoint answer leads: the rate the app handles, and what gave way above it.
  const breakpoint = page.getByRole("region", { name: "Breakpoint" });
  await expect(breakpoint).toContainText("About 180 requests per second");
  await expect(breakpoint).toContainText("more than 5% of requests failed");
  // Second by second, for the stage picked (the breakpoint first, then any other).
  const timeline = page.getByRole("region", { name: "Second by second" });
  await expect(timeline.getByRole("button", { name: "Breakpoint" })).toHaveAttribute("aria-pressed", "true");
  await expect(timeline.getByRole("table", { name: "Breakpoint stage, second by second" })).toBeAttached();
  await timeline.getByRole("button", { name: "Smoke" }).click();
  await expect(timeline.getByRole("table", { name: "Smoke stage, second by second" })).toBeAttached();
  await expect(page.getByRole("table", { name: "Load stages" })).toBeAttached();
  await expect(page.getByText("limit about 180/s")).toBeVisible();
  // k6's own HTML report of each stage downloads from the load execution.
  await expect(page.getByRole("link", { name: /Breakpoint k6 report/i })).toHaveAttribute("href", "/v1/testing-runs/run-1/executions/e1/artifacts/k6-breakpoint.html");

  // Details: downloads, sign-in setup, and what ran with platform exit codes.
  await sections.getByRole("tab", { name: "Details" }).click();
  await expect(page.getByRole("link", { name: "Report (Markdown)" })).toHaveAttribute("href", "/v1/testing-runs/run-1/export?format=md");
  await expect(page.getByRole("link", { name: "Full data (JSON)" })).toHaveAttribute("href", "/v1/testing-runs/run-1/export?format=json");
  await expect(page.getByText("Sign in as admin")).toBeVisible();
  await page.locator("summary").filter({ hasText: "Start the app and probe 18 request(s)" }).click();
  await expect(page.getByText("harness: boot=true probes=18 failed=1")).toBeVisible();
  await expect(page.getByText("ADMIN_TOKEN, PORT")).toBeVisible();
});

test("a running run shows live progress and can be cancelled", async ({ page }) => {
  await signedInUser(page, "Cancel Tester");
  let status: TestingRunDetail["status"] = "running";
  const at = new Date().toISOString();
  const liveEvents = [
    { seq: 1, type: "phase:executing", message: "Running build checks", at },
    { seq: 2, type: "live", message: "POST /api/orders answered 500", at, data: { k: "req", method: "POST", path: "/api/orders", status: 500, ms: 31, ok: false, as: "admin", check: null } },
  ];
  await page.route("**/v1/testing-runs/run-1/events**", (r) => {
    const after = Number(new URL(r.request().url()).searchParams.get("after") ?? 0);
    return json(r, { events: liveEvents.filter((e) => e.seq > after) });
  });
  await page.route("**/v1/testing-runs/run-1/cancel", (r) => {
    status = "cancelled";
    return json(r, { run: { ...run("cancelled"), phase: "done" } }, 202);
  });
  await page.route("**/v1/testing-runs/run-1", (r) => json(r, { run: { ...run(status), ...(status === "cancelled" ? { phase: "done", step: null } : {}) } }));
  await page.goto("/app/projects/proj-1/testing/run-1");

  // The live view: the current step, the counters, each action as it happens, the browser and every check.
  await expect(page.getByText("Running build checks, the project's tests").first()).toBeVisible();
  await expect(page.getByText("2 of 5", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "What cybercheck is doing" })).toBeVisible();
  const feed = page.getByRole("list", { name: "Activity, newest first" });
  await expect(feed.getByText("/api/orders")).toBeVisible();
  await expect(feed.getByText("not as expected")).toBeVisible();
  await page.getByRole("button", { name: /Problems only/ }).click();
  await expect(feed.getByText("/api/orders")).toBeVisible();
  await expect(feed.getByText("Running build checks")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "What the browser sees" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Every check" })).toBeVisible();
  await expect(page.getByText("Your code runs only in an isolated cloud sandbox")).toBeVisible();
  // No download while the run is still going.
  await expect(page.getByRole("link", { name: "Report (Markdown)" })).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel run" }).click();
  await expect(page.getByText("Cancelled")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel run" })).toHaveCount(0);
});

test("a member reviews each finding: one confirmed, one rejected, with honest precision and two assessments", async ({ page }) => {
  await signedInUser(page, "Review Tester");
  const base = run("completed");
  const suspected = { ...base.findings[0]!, id: "F3", status: "suspected" as const, severity: "medium" as const, title: "GET /orders lists another table's orders", obligationIds: ["api:GET /health:public"], validation: "Failed in 2 of 2 clean runs; not analysed." };
  const detail = { ...base, findings: [...base.findings, suspected] };
  const decisions = new Map<string, { decision: string; reason: string | null; at: string; id: string }>();
  const reviewedNow = () => {
    const presented = ["F1", "F3"];
    const latest = (id: string) => decisions.get(id) ?? null;
    const confirmed = presented.filter((id) => latest(id)?.decision === "confirmed").length;
    const rejected = presented.filter((id) => latest(id)?.decision === "rejected").length;
    const text = confirmed + rejected >= 5 ? "" : "Not enough reviewed findings to estimate precision" + (confirmed + rejected ? ` (${confirmed} of ${confirmed + rejected} confirmed so far; 5 needed)` : "");
    const precision = { confirmed, rejected, reviewed: confirmed + rejected, percent: null, minSample: 5, text };
    return {
      runId: "run-1",
      basedOnReportOf: "run-1",
      reviewIds: [...decisions.values()].map((d) => d.id),
      machine: { decision: "not_ready_product_failures", completeness: 54.5, productHealth: 75, openDefects: 2 },
      reviewed: { decision: "not_ready_product_failures", reasons: ["No open critical or high product defect: 1 confirmed"], completeness: latest("F3")?.decision === "rejected" ? 50 : 54.5, productHealth: 75, openDefects: 2 - rejected, acceptedRisks: 0, unsure: 0, awaitingReview: presented.filter((id) => !latest(id)).length },
      findings: presented.map((id) => {
        const d = latest(id);
        return {
          findingId: id,
          review: d ? { id: d.id, findingId: id, runId: "run-1", projectId: "proj-1", snapshotId: "snap-1", reviewerUserId: "u", reviewerName: "Review Tester", reviewerRole: "owner", decision: d.decision, reason: d.reason, createdAt: d.at, supersedesReviewId: null } : null,
          history: d ? 1 : 0,
          queue: !d ? "awaiting" : d.decision === "confirmed" ? "confirmed" : d.decision === "rejected" ? "rejected" : "accepted_or_unsure",
          repairEligible: d?.decision === "confirmed",
        };
      }),
      precision: { run: precision, project: precision },
      canReview: true,
      allowAcceptedRisk: true,
    };
  };
  await page.route("**/v1/testing-runs/run-1/events**", (r) => json(r, { events: [] }));
  await page.route("**/v1/testing-runs/run-1/reviewed-report", (r) => json(r, { reviewed: reviewedNow() }));
  await page.route("**/v1/testing-runs/run-1/findings/*/reviews", async (r) => {
    const id = r.request().url().split("/findings/")[1]!.split("/")[0]!;
    const body = r.request().postDataJSON() as { decision: string; reason: string | null };
    expect(r.request().headers()["idempotency-key"]).toBeTruthy();
    decisions.set(id, { ...body, at: new Date().toISOString(), id: `R-${id}` });
    return json(r, { review: reviewedNow().findings.find((f) => f.findingId === id)!.review, reviewed: reviewedNow() }, 201);
  });
  await page.route("**/v1/testing-runs/run-1", (r) => json(r, { run: detail }));
  await page.goto("/app/projects/proj-1/testing/run-1");

  // Two assessments, clearly labelled, and no precision percentage from a tiny sample.
  await expect(page.getByRole("region", { name: "Machine assessment" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Human-reviewed assessment" })).toBeVisible();
  await expect(page.getByText("Not enough reviewed findings to estimate precision").first()).toBeVisible();
  const sections = page.getByRole("tablist", { name: "Run sections" });
  const groups = page.getByRole("tablist", { name: "Problem groups" });
  await sections.getByRole("tab", { name: /Problems/ }).click();
  await expect(groups.getByRole("tab", { name: /To review/ })).toHaveAttribute("aria-selected", "true");
  const awaiting = page.getByRole("list", { name: "To review" });
  await expect(awaiting.getByText("POST /transfers crashes on a body without an amount")).toBeVisible();
  await expect(awaiting.getByText("GET /orders lists another table's orders")).toBeVisible();

  // Confirm the first, with a reason: it moves to Confirmed, where the sandbox repair is right there.
  await awaiting.getByRole("button", { name: /POST \/transfers crashes/ }).click();
  await page.getByPlaceholder("For example: reproduced it on staging").fill("Reproduced it locally");
  await page.getByRole("group", { name: "Decision" }).getByRole("button", { name: /Confirm/ }).click();
  await expect(groups.getByRole("tab", { name: /Confirmed/ })).toHaveAttribute("aria-selected", "true");
  const problem = page.getByLabel("Problem F1");
  await expect(problem.getByRole("button", { name: "Try repair in sandbox" })).toBeVisible();
  await expect(problem.getByText("Reproduced it locally")).toBeVisible();

  // Reject the second, with a reason: it moves to Rejected, and it is not a pass.
  await groups.getByRole("tab", { name: /To review/ }).click();
  await page.getByRole("list", { name: "To review" }).getByRole("button", { name: /GET \/orders lists another/ }).click();
  await page.getByPlaceholder("For example: reproduced it on staging").fill("Intended: the endpoint is per cafe");
  await page.getByRole("group", { name: "Decision" }).getByRole("button", { name: /Reject/ }).click();
  await expect(groups.getByRole("tab", { name: /Rejected/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("list", { name: "Rejected" }).getByText("GET /orders lists another table's orders")).toBeVisible();
  await expect(page.getByText(/never counted as passed/)).toBeVisible();
  await expect(groups.getByRole("tab", { name: /To review/ })).toContainText("0");

  // The overview shows both assessments and honest precision.
  await sections.getByRole("tab", { name: "Overview" }).click();
  await expect(page.getByRole("region", { name: "Machine assessment" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Human-reviewed assessment" })).toBeVisible();
  await expect(page.getByText("Not enough reviewed findings to estimate precision (1 of 2 confirmed so far; 5 needed)").first()).toBeVisible();
});

test("a confirmed finding can be repaired in a sandbox after explicit approval, with before and after evidence", async ({ page }) => {
  await signedInUser(page, "Repair Tester");
  const detail = run("completed");
  const review = { id: "R1", findingId: "F1", runId: "run-1", projectId: "proj-1", snapshotId: "snap-1", reviewerUserId: "u", reviewerName: "Repair Tester", reviewerRole: "owner", decision: "confirmed", reason: "Reproduced", createdAt: new Date().toISOString(), supersedesReviewId: null };
  const precision = { confirmed: 1, rejected: 0, reviewed: 1, percent: null, minSample: 5, text: "Not enough reviewed findings to estimate precision (1 of 1 confirmed so far; 5 needed)" };
  const reviewed = {
    runId: "run-1", basedOnReportOf: "run-1", reviewIds: ["R1"],
    machine: { decision: "not_ready_product_failures", completeness: 54.5, productHealth: 75, openDefects: 1 },
    reviewed: { decision: "not_ready_product_failures", reasons: [], completeness: 54.5, productHealth: 75, openDefects: 1, acceptedRisks: 0, unsure: 0, awaitingReview: 0 },
    findings: [{ findingId: "F1", review, history: 1, queue: "confirmed", repairEligible: true }],
    precision: { run: precision, project: precision }, canReview: true, allowAcceptedRisk: true,
  };
  const scope = { files: ["src/routes/transfers.ts"], reproduction: ["api:POST /transfers:empty-body"], regression: ["env:install:.", "suite:passes:."], maxAttempts: 2, estimate: { minutes: [4, 20], costUsd: [0.03, 0.5] } };
  let repair: Record<string, unknown> | null = null;
  const verified = () => ({
    ...repair!, status: "verified",
    attempts: [{ n: 1, status: "verified", summary: "Validate the amount before using it.", diff: "--- a/src/routes/transfers.ts\n+++ b/src/routes/transfers.ts\n@@ -18,1 +18,2 @@\n-  const amount = body.amount.value;\n+  if (!body.amount) return res.status(400).end();\n+  const amount = body.amount.value;", patchDigest: "abc123def456", filesChanged: ["src/routes/transfers.ts"], rejectedBecause: [], validationRunId: "run-2", checks: [{ obligationId: "api:POST /transfers:empty-body", label: "Handles an empty JSON object body without a server error", role: "reproduction", before: "failed", after: "passed" }, { obligationId: "suite:passes:.", label: "Every existing test passes", role: "regression", before: "passed", after: "passed" }], regressions: [], costUsd: 0.041, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }],
  });
  let approved = false;
  await page.route("**/v1/testing-runs/run-1/events**", (r) => json(r, { events: [] }));
  await page.route("**/v1/testing-runs/run-1/reviewed-report", (r) => json(r, { reviewed }));
  await page.route("**/v1/testing-runs/run-1/repairs", (r) => json(r, { repairs: repair ? [approved ? verified() : repair] : [] }));
  await page.route("**/v1/testing-runs/run-1/findings/F1/repairs", (r) => {
    repair = { id: "rep-1", runId: "run-1", findingId: "F1", projectId: "proj-1", snapshotId: "snap-1", status: "awaiting_approval", requestedBy: "u", approvedBy: null, scope, attempts: [], error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    return json(r, { repair }, 201);
  });
  await page.route("**/v1/testing-runs/run-1/findings/F1/repair-approvals", (r) => {
    expect(r.request().headers()["idempotency-key"]).toBeTruthy();
    expect(r.request().postDataJSON()).toMatchObject({ repairId: "rep-1" });
    approved = true;
    return json(r, { repair: { ...repair!, status: "running", approvedBy: "u" } }, 202);
  });
  await page.route("**/v1/testing-runs/run-1", (r) => json(r, { run: detail }));
  await page.goto("/app/projects/proj-1/testing/run-1");

  // The "what to do next" card leads straight to the confirmed problem and its repair button.
  await page.getByRole("region", { name: "What to do next" }).getByRole("button", { name: /Try a sandbox repair/ }).click();
  await expect(page).toHaveURL(/tab=problems&sub=confirmed/);
  await page.getByLabel("Problem F1").getByRole("button", { name: "Try repair in sandbox" }).click();
  // The scope and cost are shown first, and nothing runs until approval.
  const box = page.getByLabel("Sandbox repair");
  await expect(box.getByText("Waiting for your approval")).toBeVisible();
  await expect(box.getByText("src/routes/transfers.ts")).toBeVisible();
  await expect(box.getByText(/only inside fresh, isolated sandboxes/)).toBeVisible();
  await box.getByRole("button", { name: "Approve repair" }).click();
  // The verified result: before and after, the patch, and nothing applied to the project.
  await expect(box.getByText("Repair verified")).toBeVisible();
  await expect(box.getByText("+  if (!body.amount) return res.status(400).end();")).toBeVisible();
  await expect(box.getByRole("row").filter({ hasText: "Handles an empty JSON object body" })).toContainText("failed");
  await expect(box.getByRole("row").filter({ hasText: "Handles an empty JSON object body" })).toContainText("passed");
  await expect(box.getByText(/Nothing was applied to your project/)).toBeVisible();
  // Before and after, as a chart with the numbers beside it: the failed check now passes, nothing broke.
  await expect(box.getByText("1 → 2")).toBeVisible();
  await expect(box.getByText("1 → 0")).toBeVisible();
  // Every repair of the run is also listed in its own tab.
  await page.getByRole("tablist", { name: "Run sections" }).getByRole("tab", { name: /Repairs/ }).click();
  await expect(page.getByText("F1 · POST /transfers crashes on a body without an amount")).toBeVisible();
});

test("the Testing tab lists every project: tested, new code since the last test, and not tested yet", async ({ page }) => {
  await signedInUser(page, "Status Tester");
  const now = new Date().toISOString();
  const snap = (id: string, projectId: string) => ({ id, projectId, status: "BASELINED", sourceType: "archive", sourceRef: null, resolvedRevision: null, contentDigest: "d".repeat(64), fileCount: 3, totalBytes: 100, detection: null, warnings: [], rejectionReasons: [], exclusions: [], error: null, createdAt: now, baselinedAt: now });
  const proj = (id: string, name: string, snapId: string) => ({ id, workspaceId: "w", name, description: null, sourceType: "archive", githubRepo: null, createdAt: now, latestSnapshot: snap(snapId, id), analysis: { stage: "ready", step: null, progress: null, error: null } });
  const projects = [proj("p-tested", "Cafe app", "s-a"), proj("p-old", "Hotel app", "s-new"), proj("p-new", "Shop app", "s-c")];
  const summary = (id: string, projectId: string, snapshotId: string, defects: number) => ({ id, snapshotId, projectId, purpose: "check", status: "completed", phase: "done", step: null, progress: null, headline: null, counts: { obligations: 40, terminal: 40, failed: defects, confirmedDefects: defects }, error: null, createdAt: now, startedAt: now, finishedAt: now });
  await page.route("**/v1/workspaces/*/projects", (r) => (r.request().method() === "GET" ? json(r, { projects }) : r.fallback()));
  await page.route("**/v1/workspaces/*/testing-status", (r) =>
    json(r, {
      projects: [
        { projectId: "p-tested", latest: summary("run-a", "p-tested", "s-a", 7), decision: "not_ready_product_failures", active: false, history: [{ runId: "run-0", createdAt: now, problems: 10 }, { runId: "run-a", createdAt: now, problems: 7 }] },
        { projectId: "p-old", latest: summary("run-b", "p-old", "s-old", 0), decision: "ready", active: false, history: [{ runId: "run-b", createdAt: now, problems: 0 }] },
        { projectId: "p-new", latest: null, decision: null, active: false, history: [] },
      ],
    }),
  );
  await page.goto("/app/checks/testing");
  const list = page.getByRole("region", { name: "Your projects" });
  await expect(list.getByText("1 tested · 0 testing now · 2 to test")).toBeVisible();
  await expect(list.getByText("Cafe app")).toBeVisible();
  await expect(list.getByText("7 problems")).toBeVisible();
  await expect(list.getByRole("img", { name: "Problems over the last 2 tests: 10, 7" })).toBeVisible();
  await expect(list.getByText("down from 10")).toBeVisible();
  await expect(list.getByText(/New code since the last test/)).toBeVisible();
  await expect(list.getByText("Not tested yet")).toBeVisible();
  await expect(list.getByRole("link", { name: /Open results/ }).first()).toHaveAttribute("href", "/app/projects/p-tested/testing/run-a");
});
