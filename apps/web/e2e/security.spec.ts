import { expect, test, type Route } from "@playwright/test";
import type { SecurityFinding, SecurityObligation, SecurityRunDetail } from "@cybercheck/contracts";
import { giveEachTestItsOwnIp, signedInUser } from "./helpers";

giveEachTestItsOwnIp(test);

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const SECRET_TAIL = "AbCdEfGhIjKlMnOpQrStUvWx";

const ob = (id: string, lane: SecurityObligation["lane"], status: SecurityObligation["status"], requirement: string, reason: string | null): SecurityObligation => ({
  id,
  lane,
  category: lane,
  asset: { kind: "repository", ref: ".", label: "." },
  requirement,
  expectedControl: "c",
  applicabilityEvidence: [],
  standards: ["CWE-1"],
  priority: "high",
  proofStrategy: lane === "secrets" ? "secret_scan" : lane === "injection" ? "runtime_proof" : "sast_rule",
  dependencies: [],
  status,
  reason,
  executionIds: status === "passed" || status === "failed" ? ["e1"] : [],
  findingIds: [],
});

const finding = (over: Partial<SecurityFinding>): SecurityFinding => ({
  id: "S1",
  status: "confirmed",
  severity: "critical",
  lane: "secrets",
  category: "secrets",
  title: "Stripe Access Token committed in src/keys.js",
  cwe: ["CWE-798"],
  owasp: ["A07:2021"],
  expected: "Credentials and keys are not committed with the code",
  observed: "A value matching the stripe-access-token pattern is in the code (shown only as a fingerprint).",
  impact: "Anyone with read access to the code can use the credential until it is rotated.",
  location: { path: "src/keys.js", line: 1 },
  evidence: [{ path: "src/keys.js", line: 1 }],
  trust: "tool_observation",
  detector: { tool: "gitleaks", version: "8.21.2", rule: "stripe-access-token" },
  secret: { type: "stripe-access-token", preview: "sk_live_… (32 characters)", fingerprint: "3f9a1c0d2b7e4a51" },
  confirmation: "Detected in the committed code: confirmed on detection.",
  obligationIds: ["sec:secrets:repository"],
  executionIds: ["e1"],
  remediation: "Rotate the key, then remove it from the code and its history.",
  rootCause: "secret:3f9a1c0d2b7e4a51",
  ...over,
});

function run(status: SecurityRunDetail["status"]): SecurityRunDetail {
  const done = status === "completed";
  return {
    id: "sec-1",
    snapshotId: "snap-1",
    projectId: "proj-1",
    status,
    phase: done ? "done" : "scanning",
    step: done ? null : "Scanning for secrets, vulnerable dependencies, risky code and configuration",
    progress: done ? null : 0.6,
    headline: done ? "Not ready: confirmed security findings. 3 of 5 applicable obligations produced decisive evidence (1 of 2 critical); 1 confirmed finding(s); 1 suspected risk(s) to review." : null,
    decision: done ? "not_ready_security_findings" : null,
    counts: { obligations: 5, terminal: done ? 5 : 1, confirmed: done ? 1 : 0, suspected: done ? 1 : 0 },
    error: null,
    createdAt: new Date(Date.now() - 90_000).toISOString(),
    startedAt: new Date(Date.now() - 80_000).toISOString(),
    finishedAt: done ? new Date().toISOString() : null,
    obligations: [
      ob("sec:secrets:repository", "secrets", done ? "failed" : "planned", "No credential or key is committed in the repository", done ? "1 confirmed finding(s)." : null),
      ob("sec:sast:sql", "sast", done ? "passed" : "planned", "Database queries do not build SQL from request input", done ? "No match in 6 JavaScript, TypeScript and Python file(s) for Cybercheck's rule pack 0a1b2c3d4e5f6a7b; static rules cover known patterns only." : null),
      ob("sec:sast:xss", "sast", done ? "inconclusive" : "planned", "Request input is escaped before it is written into HTML", done ? "1 suspected match(es): they need a runtime proof (Round 2) or a review." : null),
      ob("sec:endpoint:GET /api/notes/:id:object-authorization", "access_control", "unsupported", "A caller cannot read another user's note", "Needs a runtime proof against the running app, which arrives in Round 2; counted as not yet tested."),
      ob("sec:endpoint:GET /health:authentication", "auth", "not_applicable", "GET /health requires authentication", "Public by design: Health and status checks are meant for load balancers and monitors. A public route is never reported for being public."),
    ],
    executions: [
      { id: "e1", kind: "security_scan", label: "Scan the snapshot", workspace: ".", command: "bash scan", network: false, sandbox: { provider: "nebius-sandboxes", operationId: "op-1", imageId: "img" }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), durationMs: 21000, exitCode: 0, timedOut: false, outcome: "ok", outputTail: "scan finished", artifacts: [], envNames: [], resources: { cpuSeconds: 30, maxRssKb: 1000 }, retryOf: null },
    ],
    proofs: [],
    findings: done
      ? [
          finding({}),
          finding({ id: "S2", status: "suspected", severity: "high", lane: "injection", category: "xss", title: "Request input is written into an HTML response without escaping (GET /api/search)", cwe: ["CWE-79"], secret: null, detector: { tool: "semgrep", version: "1.95.0", rule: "cc.js.xss" }, confirmation: "Strong trace: request input reaches the sink inside the handler of GET /api/search. Injection is confirmed only by a runtime proof, which arrives in Round 2.", location: { path: "src/app.js", line: 73 }, evidence: [{ path: "src/app.js", line: 73 }], rootCause: "sast:xss:GET /api/search" }),
        ]
      : [],
    report: done
      ? {
          schemaVersion: 1,
          engine: "2026-10-14.s1",
          decision: "not_ready_security_findings",
          headline: "Not ready: confirmed security findings. 3 of 5 applicable obligations produced decisive evidence (1 of 2 critical); 1 confirmed finding(s); 1 suspected risk(s) to review.",
          readiness: { level: "PARTIALLY_READY", issues: [{ rule: "auth-negative-contradiction", severity: "error", message: "The security model says no authentication was found while endpoints are protected.", evidence: [], blocks: ["auth", "access_control"] }], runnableLanes: ["secrets", "dependencies", "sast"] },
          coverage: { decisive: 3, applicable: 5, criticalDecisive: 1, criticalApplicable: 2 },
          totals: { planned: 0, running: 0, passed: 1, failed: 1, inconclusive: 1, unsupported: 1, blocked: 0, not_applicable: 1 },
          findings: { confirmed: 1, suspected: 1, confirmedCriticalHigh: 1 },
          tools: [
            { name: "gitleaks", version: "8.21.2", rulePack: null, databaseAt: null, image: "img", command: "gitleaks dir", exitCode: 0, truncated: false, executionId: "e1" },
            { name: "semgrep", version: "1.95.0", rulePack: "0a1b2c3d4e5f6a7b", databaseAt: null, image: "img", command: "semgrep scan", exitCode: 0, truncated: false, executionId: "e1" },
            { name: "osv-scanner", version: "1.9.1", rulePack: null, databaseAt: "2026-10-14T12:04:03Z", image: "img", command: "osv-scanner", exitCode: 0, truncated: false, executionId: "e1" },
          ],
          skipped: [{ capability: "AI threat modelling and triage", reason: "Arrives in Round 2." }],
          limitations: ["Static rules find known patterns only; a clean scan is not proof that the code is secure."],
          audit: [{ check: "Every scanner verdict cites an execution", ok: true, detail: "all do" }],
        }
      : null,
    usage: { aiCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, sandboxOperations: 2, sandboxCpuSeconds: 30, models: {} },
  } as SecurityRunDetail;
}

test("a finished Security run shows the decision, confirmed and suspected findings, coverage, untested checks and tools", async ({ page }) => {
  await signedInUser(page, "Security Tester");
  await page.route("**/v1/security-runs/sec-1/events**", (r) => json(r, { events: [{ seq: 1, type: "phase:done", message: "Done", at: new Date().toISOString() }] }));
  await page.route("**/v1/security-runs/sec-1", (r) => json(r, { run: run("completed") }));
  await page.goto("/app/projects/proj-1/security/sec-1");

  await expect(page.getByRole("heading", { name: "Security check", level: 1 })).toBeVisible();
  await expect(page.getByText("Not ready: confirmed security findings", { exact: true })).toBeVisible();
  await expect(page.getByText(/3 of 5 applicable obligations produced decisive evidence/).first()).toBeVisible();
  await expect(page.getByText("not a promise that the app cannot be attacked", { exact: false })).toBeVisible();
  await expect(page.getByText("What the check did not trust in the analysis")).toBeVisible();
  await expect(page.getByRole("link", { name: "Markdown" })).toHaveAttribute("href", "/v1/security-runs/sec-1/export?format=md");
  await expect(page.getByRole("link", { name: "JSON" })).toHaveAttribute("href", "/v1/security-runs/sec-1/export?format=json");

  const sections = page.getByRole("tablist", { name: "Security results" });
  await sections.getByRole("tab", { name: /Confirmed findings/ }).click();
  await expect(page.getByRole("heading", { name: "Stripe Access Token committed in src/keys.js" })).toBeVisible();
  await expect(page.getByText("sk_live_… (32 characters)")).toBeVisible();
  await expect(page.getByRole("button", { name: /src\/keys\.js:1/ })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(SECRET_TAIL);

  await sections.getByRole("tab", { name: /Suspected risks/ }).click();
  await expect(page.getByText(/Strong trace: request input reaches the sink/)).toBeVisible();

  await sections.getByRole("tab", { name: "Security coverage" }).click();
  await expect(page.getByText(/static rules cover known patterns only/)).toBeVisible();
  await expect(page.getByText(/A public route is never reported for being public/)).toBeVisible();

  await sections.getByRole("tab", { name: /Untested and blocked/ }).click();
  await expect(page.getByText("A caller cannot read another user's note")).toBeVisible();
  await expect(page.getByText(/arrives in Round 2; counted as not yet tested/)).toBeVisible();

  await sections.getByRole("tab", { name: "Cost and environment" }).click();
  await expect(page.getByRole("cell", { name: "gitleaks" })).toBeVisible();
  await expect(page.getByText("AI threat modelling and triage", { exact: false })).toBeVisible();
});

test("a running Security run shows its phase and live events", async ({ page }) => {
  await signedInUser(page, "Security Tester");
  await page.route("**/v1/security-runs/sec-1/events**", (r) => json(r, { events: [{ seq: 1, type: "scanning", message: "Running gitleaks, semgrep, osv-scanner and trivy with the network off", at: new Date().toISOString() }] }));
  await page.route("**/v1/security-runs/sec-1", (r) => json(r, { run: run("running") }));
  await page.goto("/app/projects/proj-1/security/sec-1");

  await expect(page.getByText("In progress")).toBeVisible();
  await expect(page.getByRole("list", { name: "Phases" }).locator("[aria-current=step]")).toHaveText("Scan");
  await expect(page.getByText("Running gitleaks, semgrep, osv-scanner and trivy with the network off")).toBeVisible();
  await expect(page.getByRole("link", { name: "Markdown" })).toHaveCount(0);
});
