import type { EntryPoint, Evidence, Obligation, ProjectDossier } from "@cybercheck/contracts";
import type { WorkspacePlan } from "./adapters.ts";

/**
 * The Test Obligation Graph: every testable asset in the dossier gets obligations with an oracle,
 * and every obligation must end with a recorded disposition. Built by rules, no AI.
 */

export type ProbeStep = {
  method: string;
  path: string;
  headers?: Record<string, string>;
  json?: unknown;
  raw?: string;
  form?: Record<string, string>;
  contentType?: string;
  expect: { status?: number[]; statusClass?: string[]; not5xx?: boolean; bodyIncludes?: string; json?: JsonCheck[] };
  capture?: { name: string; path: string };
  /** Another signed-in identity for this one step (a multi-actor flow: the admin creates an item, the customer orders it). */
  as?: string;
  /** Creates data the check needs; its failure makes the check inconclusive, never failed. */
  setup?: boolean;
};
/** needs: fixture graph nodes that must succeed before this probe is sent (the identity is implied). */
export type Probe = { id: string; obligationId: string; app: string; identity: string | null; steps: ProbeStep[]; needs?: string[]; /** The endpoint has no detected guard: if the sign-in fails, send it without credentials rather than not at all. */ optionalIdentity?: boolean };

/**
 * One node of the fixture graph (see fixtures.ts). command: a shell command after the app starts (a seed
 * script) · request: steps that create data and capture ids · identity: a way to sign in, verified by a
 * protected request.
 */
export type FixtureNode = {
  id: string;
  label: string;
  kind: "command" | "request" | "identity";
  dependsOn: string[];
  command?: string;
  /** NAME=value lines the command prints that later nodes may use as {{NAME}}. */
  exports?: string[];
  /** request nodes: the identity they run as. */
  identity?: string | null;
  steps?: ProbeStep[];
  auth?: { kind: "bearer" | "header" | "basic" | "login"; token?: string; header?: string; value?: string; user?: string; pass?: string; request?: { method: string; path: string; json?: unknown; form?: Record<string, string> }; tokenPath?: string };
  verify?: { method: string; path: string } | null;
  /** identity nodes: the protection kinds they get past. */
  appliesTo?: string[];
  /** request nodes that create a record: its route, and which capture fills which path parameter. */
  resource?: string;
  captureFor?: Record<string, string>;
  /** identity nodes (Security proofs): also register a tampered-token variant "<id>#forged" with this claim changed. */
  forge?: { role: string };
  origin: "plan" | "author" | "repair";
};
/** A check on one field of a JSON response: equals a value, exists or not, or is at least a number. */
export type JsonCheck = { path: string; equals?: unknown; exists?: boolean; min?: number };

export const UNKNOWN_UUID = "7f0c2b1e-4a5d-4c3e-9b8a-000000000999";

const PROTECTED = new Set(["session_required", "role_required", "service_token", "handler_check"]);

/** Path segments that only say "this is the API" or a version, never what the route is about. */
const GENERIC_SEGMENT = /^(api|apis|rest|rpc|graphql|v\d+(\.\d+)?|public|internal-api)$/i;

/** The area a route belongs to: its first meaningful segment (/api/v1/orders/:id is "orders", /api/admin/users is "admin"). */
export function routeArea(path: string) {
  return (
    path
      .split("/")
      .filter(Boolean)
      .find((s) => !GENERIC_SEGMENT.test(s) && !/^[:{<[]/.test(s))
      ?.toLowerCase() ?? ""
  );
}

export function obligation(o: Omit<Obligation, "status" | "reason" | "executionIds" | "findingIds" | "origin"> & Partial<Pick<Obligation, "status" | "reason" | "origin">>): Obligation {
  return { status: "planned", reason: null, origin: "dossier", executionIds: [], findingIds: [], ...o };
}

/** A concrete URL for a route pattern: path params become a harmless placeholder value. */
export function concretePath(path: string) {
  return path
    // Flask/Werkzeug style: <id> or <int:id>
    .replace(/<(?:\w+:)?(\w+)>/g, (_m, n: string) => (/id$/i.test(n) ? "999999" : "sample"))
    .replace(/:(\w+)\??/g, (_m, n: string) => (/id$/i.test(n) ? "999999" : "sample"))
    .replace(/\{(\w+)(:[^}]*)?\}/g, (_m, n: string) => (/id$/i.test(n) ? "999999" : "sample"))
    .replace(/\[\[?\.\.\.(\w+)\]?\]/g, "sample")
    .replace(/\[(\w+)\]/g, (_m, n: string) => (/id$/i.test(n) ? "999999" : "sample"))
    .replace(/\*+/g, "sample")
    .replace(/\(\.\*\)|\(\?.*?\)/g, "");
}

const endpointLabel = (e: EntryPoint) => `${e.method} ${e.path}`;
const handlerEvidence = (e: EntryPoint): Evidence[] => [e.handler];

/** Which app (workspace) serves an endpoint: the deepest workspace containing its handler file. */
export function appFor(e: EntryPoint, apps: string[]) {
  const sorted = [...apps].sort((a, b) => b.length - a.length);
  return sorted.find((dir) => dir === "." || e.handler.path.startsWith(`${dir}/`)) ?? null;
}

/** What this run can execute beyond the always-available workers. */
export type PlanOptions = { browser: boolean; database: boolean; load: string[]; viewports: number[] };

export function buildObligations(d: ProjectDossier, workspaces: WorkspacePlan[], opts: PlanOptions = { browser: false, database: false, load: [], viewports: [] }) {
  const out: Obligation[] = [];

  // ---------------------------------------------------------------- environment
  for (const w of workspaces) {
    const label = w.dir === "." ? "project root" : w.dir;
    if (w.install) {
      out.push(obligation({
        id: `env:install:${w.dir}`,
        layer: "environment",
        asset: { kind: "workspace", ref: w.dir, label },
        objective: `Dependencies install from ${w.install.frozen ? "the lockfile" : "the manifest"} (${w.install.command})`,
        priority: "critical",
        oracle: { source: "declared_command", expected: "exit code 0", evidence: [] },
      }));
    }
    for (const s of w.steps) {
      out.push(obligation({
        id: `env:${s.kind}:${w.dir}`,
        layer: "environment",
        asset: { kind: "workspace", ref: w.dir, label },
        objective: s.kind === "build" ? `The project builds (${s.declared})` : s.kind === "typecheck" ? `Types check (${s.declared})` : `Lint passes (${s.declared})`,
        priority: s.kind === "lint" ? "medium" : "high",
        oracle: { source: s.source === "script" ? "declared_command" : "policy", expected: "exit code 0", evidence: [] },
      }));
    }
    for (const s of w.suites) {
      out.push(obligation({
        id: `suite:runs:${w.dir}`,
        layer: "existing_suite",
        asset: { kind: "suite", ref: s.id, label: `${s.framework === "unknown" ? "Test" : s.framework} suite in ${label}` },
        objective: "The project's test suite runs at least one test and finishes in time",
        priority: "critical",
        oracle: { source: "policy", expected: "one or more tests executed; no hang", evidence: [] },
      }));
      out.push(obligation({
        id: `suite:passes:${w.dir}`,
        layer: "existing_suite",
        asset: { kind: "suite", ref: s.id, label: `${s.framework === "unknown" ? "Test" : s.framework} suite in ${label}` },
        objective: "Every existing test passes, consistently across repeated clean runs",
        priority: "critical",
        oracle: { source: "existing_assertion", expected: "all tests pass in every run", evidence: [] },
      }));
    }
    if (!w.suites.length && !w.coveredByRoot) {
      out.push(obligation({
        id: `suite:runs:${w.dir}`,
        layer: "existing_suite",
        asset: { kind: "suite", ref: w.dir, label: `Tests in ${label}` },
        objective: "The project's own tests run",
        priority: "high",
        oracle: { source: "policy", expected: "a declared test command", evidence: [] },
        status: w.orphanTests > 0 ? "blocked" : "not_applicable",
        reason: w.orphanTests > 0 ? `${w.orphanTests} test file(s) exist but no test command is declared, so cybercheck can't tell how they are meant to run.` : "No test suite is declared and no test files were found.",
      }));
    }
  }

  // ---------------------------------------------------------------- endpoints (HTTP behaviour)
  for (const e of d.entryPoints.filter((x) => x.kind === "http" || x.kind === "webhook")) {
    const label = endpointLabel(e);
    const asset = { kind: "endpoint" as const, ref: e.id, label };
    const protectedRoute = PROTECTED.has(e.control.kind);
    // A sign-in, sign-up or activation endpoint answers 401 to bad credentials by design: that is not a guard check.
    const authEntry = isAuthEntry(e);
    // The analysis can miss a guard (an import alias, a router-level dependency): a route under /admin or /staff, or
    // whose sibling routes are protected, is expected to refuse anonymous requests too.
    // Siblings share the first meaningful segment: /api/search and /api/orders are not siblings just because every
    // route of the app sits under /api (a public search next to protected orders is a normal design).
    const prefix = routeArea(e.path);
    const siblingsProtected = Boolean(prefix) && d.entryPoints.some((x) => x !== e && PROTECTED.has(x.control.kind) && routeArea(x.path) === prefix);
    const likelyProtected = !protectedRoute && ["none_found", "unknown", "handler_check"].includes(e.control.kind) && (siblingsProtected || /^(admin|staff|manage|management|dashboard|internal|backoffice)$/.test(prefix));
    if ((protectedRoute || likelyProtected || e.control.kind === "webhook_signature") && !authEntry) {
      out.push(obligation({
        id: `api:${label}:unauthenticated`,
        layer: "api",
        asset,
        objective: e.control.kind === "webhook_signature" ? "Rejects a request without a valid signature" : "Rejects a request without credentials",
        priority: e.mutates ? "critical" : "high",
        oracle: likelyProtected
          ? { source: "policy", expected: `a 4xx or redirect: the other /${prefix} routes require sign-in, and no reason for this one to be open was found`, evidence: handlerEvidence(e) }
          : { source: "code_contract", expected: `a 4xx or redirect, because ${e.control.reason}`, evidence: e.control.evidence.length ? e.control.evidence : handlerEvidence(e) },
      }));
    }
    // Role separation for every route the code marks as role-protected, and for every guarded route under a prefix
    // that names a role (/admin, /staff): a signed-in account of a lower role must be refused.
    const rolePrefix = /^(admin|staff|manage|management|manager|owner|backoffice|internal)$/.test(prefix) && (protectedRoute || likelyProtected);
    if ((e.control.kind === "role_required" || rolePrefix) && !authEntry) {
      out.push(obligation({
        id: `api:${label}:wrong-role`,
        layer: "api",
        asset,
        objective: "Rejects a signed-in user who lacks the required role",
        priority: e.mutates ? "critical" : "high",
        oracle: e.control.kind === "role_required"
          ? { source: "code_contract", expected: `401 or 403 for an account without the role, because ${e.control.reason}`, evidence: e.control.evidence.length ? e.control.evidence : handlerEvidence(e) }
          : { source: "policy", expected: `401 or 403 for an account of a lower role: the route sits under /${prefix}`, evidence: handlerEvidence(e) },
      }));
    }
    if (e.control.kind === "public_intentional" && !e.mutates) {
      out.push(obligation({
        id: `api:${label}:public`,
        layer: "api",
        asset,
        objective: "Answers without credentials and without a server error",
        priority: "medium",
        oracle: { source: "code_contract", expected: `not 401/403 and not 5xx (${e.control.reason})`, evidence: e.control.evidence.length ? e.control.evidence : handlerEvidence(e) },
      }));
    } else if (!e.mutates && /^(WS|WEBSOCKET)$/i.test(e.method)) {
      // A WebSocket answers a plain HTTP request with 400 by design: that proves nothing about the socket.
      out.push(obligation({
        id: `api:${label}:no-server-error`,
        layer: "api",
        asset,
        objective: "The WebSocket accepts a connection and only sends each client its own events",
        priority: "high",
        oracle: { source: "policy", expected: "connects; events stay within the client's own scope", evidence: handlerEvidence(e) },
        status: "unsupported",
        reason: "Checking a WebSocket needs a WebSocket client, which cybercheck does not run yet; a plain HTTP request would only show the upgrade being refused.",
      }));
    } else if (!e.mutates) {
      out.push(obligation({
        id: `api:${label}:no-server-error`,
        layer: "api",
        asset,
        objective: "Answers a normal request (unknown ids included) without a server error",
        priority: "high",
        oracle: { source: "http_semantics", expected: "no 5xx response", evidence: handlerEvidence(e) },
      }));
    }
    if (e.mutates && e.method !== "DELETE") {
      out.push(obligation({
        id: `api:${label}:malformed-body`,
        layer: "api",
        asset,
        objective: "A malformed (not JSON) body does not cause a server error",
        // Usually answered by the framework's body parser before the handler runs: robustness, not business behaviour.
        priority: "medium",
        oracle: { source: "http_semantics", expected: "no 5xx response (ideally 400)", evidence: handlerEvidence(e) },
      }));
      out.push(obligation({
        id: `api:${label}:empty-body`,
        layer: "api",
        asset,
        objective: "Handles an empty JSON object body without a server error",
        priority: "medium",
        oracle: { source: e.inputs.body ? "code_contract" : "http_semantics", expected: e.inputs.body ? `no 5xx; the body is validated by ${e.inputs.body}` : "no 5xx response", evidence: handlerEvidence(e) },
      }));
    }
    // A malformed id in the path ("abc" where a number is expected) must be refused, not crash the handler or the
    // process (an unhandled database error on NaN ends a Node server).
    if (new RegExp(PARAM_RE.source).test(e.path) && !authEntry) {
      out.push(obligation({
        id: `api:${label}:invalid-id`,
        layer: "api",
        asset,
        objective: "A malformed id in the path is refused without a server error or a crash",
        priority: "medium",
        oracle: { source: "http_semantics", expected: "a 4xx (400, 404 or 422); never 5xx, never the app stopping", evidence: handlerEvidence(e) },
      }));
    }
    if (e.method === "DELETE") {
      out.push(obligation({
        id: `api:${label}:missing-target`,
        layer: "api",
        asset,
        objective: "Deleting something that does not exist answers without a server error",
        priority: "medium",
        oracle: { source: "http_semantics", expected: "no 5xx response (404 or similar)", evidence: handlerEvidence(e) },
      }));
    }
  }
  for (const e of d.entryPoints.filter((x) => x.kind === "graphql")) {
    out.push(obligation({
      id: `api:${endpointLabel(e)}:graphql`,
      layer: "api",
      asset: { kind: "endpoint", ref: e.id, label: endpointLabel(e) },
      objective: "GraphQL operations behave as declared",
      priority: "medium",
      oracle: { source: "code_contract", expected: "schema-valid responses", evidence: handlerEvidence(e) },
      status: "unsupported",
      reason: "GraphQL probing is not available yet.",
    }));
  }

  // ---------------------------------------------------------------- screens (browser) and accessibility
  const noBrowser = { status: "unsupported" as const, reason: "Browser testing is not available for this project in this run (no frontend that cybercheck can build and serve)." };
  for (const s of d.screens) {
    const ev = [{ path: s.file, line: 1 }];
    const asset = { kind: "screen" as const, ref: s.file, label: s.url };
    out.push(obligation({
      id: `ui:${s.url}:renders`,
      layer: "ui",
      asset,
      objective: "The screen loads in a real browser without errors, failed requests or crashes",
      priority: s.interactions.mutations > 0 ? "high" : "medium",
      oracle: { source: "http_semantics", expected: "HTTP 2xx, no uncaught exception, no console error, no 5xx from the app's own requests", evidence: ev },
      ...(opts.browser ? {} : noBrowser),
    }));
    out.push(obligation({
      id: `a11y:${s.url}:wcag`,
      layer: "accessibility",
      asset,
      objective: "No serious WCAG 2.2 A or AA violation (automated axe-core rules)",
      // A critical violation blocks the release, so the check carries the weight of one that can.
      priority: "high",
      oracle: { source: "policy", expected: "no critical or serious axe-core violation for WCAG 2.2 A/AA rules", evidence: ev },
      ...(opts.browser ? {} : noBrowser),
    }));
    if (opts.viewports.some((v) => v < 500)) {
      out.push(obligation({
        id: `ui:${s.url}:responsive`,
        layer: "ui",
        asset,
        objective: "Usable at phone width (375 px) without horizontal scrolling",
        priority: "low",
        oracle: { source: "policy", expected: "the page is no wider than the 375 px viewport", evidence: ev },
        ...(opts.browser ? {} : noBrowser),
      }));
    }
  }

  // ---------------------------------------------------------------- database
  const noDb = { status: "unsupported" as const, reason: "Direct database testing was not part of this run's profile; data was only exercised through the API." };
  if (d.dataModel.entities.length) {
    out.push(obligation({
      id: "data:schema:clean-install",
      layer: "data",
      asset: { kind: "project", ref: ".", label: "database schema" },
      objective: "Starting the app on an empty database creates every table the code defines",
      priority: "high",
      oracle: { source: "code_contract", expected: `the ${d.dataModel.entities.length} table(s) found in the code exist after start-up`, evidence: d.dataModel.entities.slice(0, 3).map((e) => e.evidence) },
      ...(opts.database ? {} : noDb),
    }));
  }
  for (const en of d.dataModel.entities) {
    const asset = { kind: "entity" as const, ref: en.id, label: en.table ?? en.name };
    out.push(obligation({
      id: `data:${en.table ?? en.name}:constraints`,
      layer: "data",
      asset,
      objective: "Declared constraints (required fields, uniqueness, foreign keys) are enforced",
      priority: "medium",
      oracle: { source: "code_contract", expected: "a row violating each declared constraint is rejected", evidence: [en.evidence] },
      ...(opts.database ? {} : noDb),
    }));
    out.push(obligation({
      id: `data:${en.table ?? en.name}:roundtrip`,
      layer: "data",
      asset,
      objective: "A valid row can be stored, read back unchanged and deleted",
      priority: "medium",
      oracle: { source: "code_contract", expected: "insert, select and delete succeed inside a rolled-back transaction", evidence: [en.evidence] },
      ...(opts.database ? {} : noDb),
    }));
  }
  if (d.dataModel.sources.some((x) => /migrat|alembic|prisma|drizzle|knex|flyway/i.test(x))) {
    out.push(obligation({
      id: "data:migrations:upgrade",
      layer: "data",
      asset: { kind: "project", ref: ".", label: "migrations" },
      objective: "Migrations upgrade a database from the previous release without losing data",
      priority: "medium",
      oracle: { source: "policy", expected: "upgrade from the prior schema preserves rows", evidence: [] },
      status: "unsupported",
      reason: "Upgrading needs a database from an earlier version of the project, which a single snapshot does not have.",
    }));
  }

  // A schema where most tables carry the same owner key (cafe_id, tenant_id, org_id...) is multi-tenant: one
  // tenant must never read or change another's records. Not automated yet, so it is disclosed, not silently missing.
  const TENANT = /^(tenant|org|organization|organisation|account|company|workspace|team|cafe|shop|store|hotel|restaurant|merchant|business)_?id$/i;
  const tenantKeys = new Map<string, number>();
  for (const en of d.dataModel?.entities ?? []) for (const f of en.fields) if (TENANT.test(f.name)) tenantKeys.set(f.name, (tenantKeys.get(f.name) ?? 0) + 1);
  const tenant = [...tenantKeys].sort((a, b) => b[1] - a[1])[0];
  if (tenant && tenant[1] >= 2 && d.entryPoints.some((e) => PROTECTED.has(e.control.kind))) {
    out.push(obligation({
      id: `api:tenancy:${tenant[0]}`,
      layer: "api",
      asset: { kind: "project", ref: ".", label: `records by ${tenant[0]}` },
      objective: `A signed-in user of one ${tenant[0].replace(/_?id$/i, "")} cannot read or change another one's records`,
      priority: "critical",
      oracle: { source: "policy", expected: `requests for records of another ${tenant[0]} are refused or not found`, evidence: [] },
      status: "unsupported",
      reason: `${tenant[1]} tables carry ${tenant[0]}, so data is separated per ${tenant[0].replace(/_?id$/i, "")}; checking that separation needs a second ${tenant[0].replace(/_?id$/i, "")} with its own accounts, which cybercheck does not create yet.`,
    }));
  }

  // ---------------------------------------------------------------- load (Devast) and reliability
  const http = d.entryPoints.some((e) => e.kind === "http");
  if (http) {
    const stage = (name: string, objective: string, expected: string, priority: Obligation["priority"]) => {
      out.push(obligation({ id: `perf:${name}`, layer: "performance", asset: { kind: "project", ref: ".", label: `${name} load` }, objective, priority, oracle: { source: "policy", expected, evidence: [] }, ...(opts.load.includes(name) ? {} : { status: "skipped" as const, reason: "Not part of this run's profile." }) }));
    };
    stage("smoke", "Answers a steady trickle of requests (1 virtual user for 20 s) with no server error", "0 server errors and 0 timeouts", "high");
    stage("average", "Holds an average load (20 virtual users for 60 s) within the thresholds", "p95 latency and error rate within the thresholds you set (a measurement when none are set)", "medium");
    if (opts.load.includes("stress")) stage("stress", "Survives a stress load (50 virtual users for 60 s)", "error rate and p95 latency measured; the app keeps answering", "low");
    if (opts.load.includes("spike")) stage("spike", "Survives a sudden spike (0 to 100 virtual users in 10 s)", "error rate and p95 latency measured; the app keeps answering", "low");
    if (opts.load.includes("breakpoint")) stage("breakpoint", "Finds the request rate where the app starts failing (raised step by step to twice the best rate the earlier stages reached, at least 400 requests per second)", "the highest rate with errors under 5% and p95 under 2 s is measured; a measurement, not a pass or fail", "low");
    if (opts.load.length) {
      out.push(obligation({ id: "reliability:recovery-after-load", layer: "reliability", asset: { kind: "project", ref: ".", label: "recovery" }, objective: "Answers normally right after the load stops", priority: "medium", oracle: { source: "policy", expected: "the ready path answers below 500 within 10 s after the last load stage", evidence: [] } }));
    }
    out.push(obligation({ id: "reliability:graceful-shutdown", layer: "reliability", asset: { kind: "project", ref: ".", label: "shutdown" }, objective: "Stops cleanly within 3 s of a termination signal (SIGTERM)", priority: "low", oracle: { source: "policy", expected: "the process exits within 3 s of SIGTERM", evidence: [] } }));
  }
  for (const f of d.deployment.dockerfiles) {
    out.push(obligation({ id: `deploy:${f.path}:image`, layer: "deployment", asset: { kind: "project", ref: f.path, label: f.path }, objective: "The container image builds and starts", priority: "medium", oracle: { source: "declared_command", expected: "docker build succeeds", evidence: [{ path: f.path, line: 1 }] }, status: "unsupported", reason: "Building container images is not available inside the sandbox." }));
  }

  // ---------------------------------------------------------------- jobs and integrations
  for (const j of d.background) {
    out.push(obligation({
      id: `job:${j.name}:runs`,
      layer: "job",
      asset: { kind: "job", ref: j.id, label: j.name },
      objective: `The ${j.kind} "${j.name}" runs once without errors and is safe to run twice`,
      priority: "medium",
      oracle: { source: "policy", expected: "no uncaught error; idempotent", evidence: [j.evidence] },
      status: "unsupported",
      reason: "Running background jobs on demand is not available in this version.",
    }));
  }
  for (const i of d.integrations.filter((x) => !["database", "cache", "queue", "backup"].includes(x.category) && x.side === "backend")) {
    // A generic HTTP client used only by developer scripts (a seed script calling the app's own API) is not a
    // third-party integration of the app.
    const scriptsOnly = /http|request|axios|fetch|httpx|urllib/i.test(i.name) && i.usedIn.length > 0 && i.usedIn.every((u) => /(^|\/)(scripts?|tools|bin)\/|(^|\/)[\w-]*(seed|demo|fixture|migrat)[\w-]*\.\w+$/i.test(u.path));
    if (scriptsOnly) {
      out.push(obligation({ id: `integration:${i.name}:live`, layer: "integration", asset: { kind: "integration", ref: i.name, label: i.name }, objective: `Calls to ${i.name} work against the real service`, priority: "low", oracle: { source: "policy", expected: "not applicable", evidence: i.usedIn.slice(0, 3) }, status: "not_applicable", reason: `Only developer scripts use it (${i.usedIn.slice(0, 2).map((u) => u.path).join(", ")}), to call the app's own API; the app itself makes no third-party call through it.` }));
      continue;
    }
    out.push(obligation({
      id: `integration:${i.name}:live`,
      layer: "integration",
      asset: { kind: "integration", ref: i.name, label: i.name },
      objective: `Calls to ${i.name} work against the real service`,
      priority: "medium",
      oracle: { source: "policy", expected: "a successful call with test credentials", evidence: i.usedIn.slice(0, 3) },
      status: "blocked",
      reason: "The sandbox has no internet access and no credentials for third-party services, so live calls were not made (by design: cybercheck never contacts real services).",
    }));
  }

  return out;
}

/** A sign-in, sign-up or activation endpoint: it answers 401 to bad credentials by design. */
export const isAuthEntry = (e: { method: string; path: string }) => e.method === "POST" && /(^|\/)(login|signin|sign-in|register|signup|sign-up|activate|token|auth)(\/|$)/i.test(e.path) && !/logout|refresh/i.test(e.path);

/** Deterministic probes for the planned API obligations. `identityFor` maps a control kind to a signed-in identity. */
export function buildProbes(d: ProjectDossier, obligations: Obligation[], appOf: (e: EntryPoint) => string | null, identityFor: (e: EntryPoint) => string | null, records: (path: string) => { path: string; needs: string[] } | null = () => null, usesUuid: (e: EntryPoint) => boolean = () => false, wrongRole: (e: EntryPoint) => string | null = () => null): Probe[] {
  const byId = new Map(d.entryPoints.map((e) => [e.id, e]));
  const probes: Probe[] = [];
  for (const o of obligations.filter((x) => x.layer === "api" && x.status === "planned" && x.origin === "dossier")) {
    const e = byId.get(o.asset.ref);
    if (!e) continue;
    const app = appOf(e);
    if (!app) continue;
    // Routes that validate UUIDs get a well-formed unknown one, so "unknown id" reaches not-found handling.
    const path = usesUuid(e) ? concretePath(e.path).replace(/999999/g, UNKNOWN_UUID) : concretePath(e.path);
    const kind = o.id.split(":").at(-1);
    const who = identityFor(e);
    const id = `p:${o.id}`;
    if (kind === "unauthenticated") {
      probes.push({ id, obligationId: o.id, app, identity: null, steps: [{ method: e.method, path, json: e.mutates ? {} : undefined, expect: { statusClass: ["4xx", "3xx"] } }] });
    } else if (kind === "wrong-role") {
      // A real record when one can be made, so the answer reflects the role check, not a missing id.
      const fx = records(e.path);
      probes.push({ id, obligationId: o.id, app, identity: wrongRole(e), needs: fx?.needs ?? [], steps: [{ method: e.method, path: fx?.path ?? path, json: e.mutates ? {} : undefined, expect: { status: [401, 403] } }] });
    } else if (kind === "public") {
      probes.push({ id, obligationId: o.id, app, identity: null, steps: [{ method: e.method, path, expect: { not5xx: true } }] });
    } else if (kind === "no-server-error") {
      probes.push({ id, obligationId: o.id, app, identity: who, steps: [{ method: e.method, path, expect: { not5xx: true } }] });
    } else if (kind === "malformed-body" || kind === "empty-body") {
      // On a nested resource, first create a real instance so the body handling is reached (not a 404 for an unknown id).
      const fx = records(e.path);
      const body: Partial<ProbeStep> = kind === "empty-body" ? { json: {} } : { raw: '{"broken": ', contentType: "application/json" };
      probes.push({ id, obligationId: o.id, app, identity: who, needs: fx?.needs ?? [], steps: [{ method: e.method, path: fx?.path ?? path, ...body, expect: { not5xx: true } }] });
    } else if (kind === "missing-target") {
      probes.push({ id, obligationId: o.id, app, identity: who, steps: [{ method: e.method, path, expect: { not5xx: true } }] });
    } else if (kind === "invalid-id") {
      const bad = e.path.replace(new RegExp(PARAM_RE.source, "g"), "abc");
      probes.push({ id, obligationId: o.id, app, identity: who, steps: [{ method: e.method, path: bad, json: e.mutates && e.method !== "DELETE" ? {} : undefined, expect: { statusClass: ["4xx"] } }] });
    }
  }
  // Reads first, deletes last, so destructive probes can't break the others; malformed ids go last of all, since
  // one can stop the app and leave the remaining checks without a server.
  const rank = (p: Probe) => (p.obligationId.endsWith(":invalid-id") ? 10 : 0) + (({ GET: 0, HEAD: 0, OPTIONS: 0, POST: 1, PUT: 2, PATCH: 2, DELETE: 3 } as Record<string, number>)[p.steps[0]!.method] ?? 1);
  const open = new Set(["none_found", "unknown", "public_intentional"]);
  for (const p of probes) {
    const e = byId.get(obligations.find((o) => o.id === p.obligationId)?.asset.ref ?? "");
    if (p.identity && e && open.has(e.control.kind)) p.optionalIdentity = true;
  }
  return probes.sort((a, b) => rank(a) - rank(b));
}

export const PARAM_RE = /:(\w+)\??|\{(\w+)(?::[^}]*)?\}|<(?:\w+:)?(\w+)>|\[(\w+)\]/g;
/** A route with its parameters replaced by {}, e.g. /notes/{}/items. */
export const shape = (p: string) => p.replace(PARAM_RE, "{}").replace(/\/+$/, "");
export const paramNames = (p: string) => [...p.matchAll(PARAM_RE)].map((m) => (m[1] ?? m[2] ?? m[3] ?? m[4])!);

export { PROTECTED };
