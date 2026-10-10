import type { ChecklistItem, ControlKind, Evidence, Observation, Question } from "@cybercheck/contracts";
import type { Facts } from "./analyze.ts";
import type { SnapshotSource } from "./source.ts";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const list = (xs: string[], max = 6) => (xs.length > max ? `${xs.slice(0, max).join(", ")} and ${xs.length - max} more` : xs.join(", "));

export const CONTROL_LABEL: Record<ControlKind, string> = {
  public_intentional: "public by design",
  session_required: "session required",
  role_required: "role required",
  service_token: "service token",
  webhook_signature: "signature verified",
  callback_state: "OAuth state checked",
  handler_check: "check in handler",
  none_found: "no protection found",
  unknown: "undetermined",
};

/** Grade every area of the completeness checklist from the facts. Nothing is left out silently. */
export function buildChecklist(f: Facts, src: SnapshotSource): { checklist: ChecklistItem[]; questions: Question[] } {
  const c: ChecklistItem[] = [];
  const q: Question[] = [];
  const ask = (area: ChecklistItem["area"], question: string, why: string, blocks: Question["blocks"]) => q.push({ id: `q-${area}-${q.length + 1}`, area, question, why, blocks });
  const hasFrontend = f.screens.length > 0 || f.stack.frameworks.some((x) => /React|Next\.js|Vue|Svelte|Angular|Astro|Remix/.test(x));
  const routes = f.entryPoints.filter((e) => e.kind !== "page");
  const byControl = (k: ControlKind) => routes.filter((r) => r.control.kind === k);
  const sm = f.securityModel;

  c.push({ area: "purpose", status: "pending_ai", summary: `${plural(f.screens.length, "screen")} and ${plural(routes.length, "endpoint")} found. A plain-language description of what the product does comes from the AI step.` });

  // Users and roles: only application authorization roles count.
  const appRoles = sm.roles.filter((r) => r.kind === "app_role");
  const otherRoles = sm.roles.filter((r) => r.kind !== "app_role");
  const otherNote = otherRoles.length ? ` (${list(otherRoles.map((r) => `${r.name} is a ${r.kind === "llm_role" ? "language-model message role" : "message direction"}`))}, not a user role)` : "";
  const mechanisms = sm.authMechanisms.filter((m) => m.kind !== "oauth" || /sign-in/.test(m.detail));
  if (appRoles.length) {
    c.push({ area: "users_roles", status: "answered", summary: `Roles defined in code: ${appRoles.map((r) => `${r.name} (${r.values.join(", ")})`).join("; ")}.${otherNote}` });
  } else if (mechanisms.length) {
    // One shared password checked against configuration, and a session holding only a flag: a single-operator app.
    const session = f.runtime.session;
    const userTable = f.dataModel.entities.some((e) => /^(users?|accounts?|members?|profiles?)$/i.test(e.table ?? e.name) && e.fields.some((x) => /password|email/i.test(x.name)));
    const sharedPassword = !userTable && sm.credentialChecks.some((x) => x.kind === "constant_time_compare" || x.kind === "plain_compare") && session && !session.keys.some((k) => /user|uid|account|email|id$/i.test(k));
    if (sharedPassword) {
      c.push({ area: "users_roles", status: "answered", summary: `One operator role: sign-in compares a single shared password from configuration, and the session only stores ${session.keys.join(", ")}. There are no user accounts, roles or per-user audit trail${otherNote}.` });
    } else {
      c.push({ area: "users_roles", status: "partial", summary: `Sign-in: ${list(mechanisms.map((m) => m.detail))}. No application roles were found, so every signed-in user appears to have the same access${otherNote}.` });
      ask("users_roles", "Should different people have different access (for example admin and viewer)?", "No application roles were found. If different people need different access, the Security check will test for missing authorization.", ["security", "adversarial"]);
    }
  } else {
    c.push({ area: "users_roles", status: "unknown", summary: `No sign-in mechanism or role definitions were found${otherNote}.` });
    ask("users_roles", "Who uses this application, and do users sign in? If yes, where is authentication handled?", "No authentication mechanism or roles were found in the code.", ["security", "adversarial"]);
  }

  if (f.screens.length) {
    const withInputs = f.screens.filter((s) => s.interactions.inputs > 0 || s.forms > 0).length;
    c.push({ area: "screens", status: "answered", summary: `${plural(f.screens.length, "screen")} (${[...new Set(f.screens.map((s) => s.framework))].join(", ")}); ${plural(withInputs, "screen")} with editable inputs, ${plural(f.screens.reduce((s, x) => s + x.interactions.mutations, 0), "data-changing call")}.` });
  } else if (hasFrontend) {
    c.push({ area: "screens", status: "partial", summary: "A frontend framework is used, but no page routes were recognised." });
    ask("screens", "How are the app's pages organised (router library or folder)?", "We found a frontend framework but couldn't map its pages.", ["testing"]);
  } else c.push({ area: "screens", status: "answered", summary: "No frontend found: this looks like an API, library or backend-only project." });

  c.push({ area: "architecture", status: "pending_ai", summary: `${plural(f.modules.length, "module")}, ${plural(f.deployment.containers.length, "container definition")}, ${plural(f.integrations.length, "integration")} found. Component responsibilities and the architecture diagram come from the AI step.` });
  c.push({ area: "code_structure", status: f.modules.length ? "answered" : "unknown", summary: f.modules.length ? `${plural(f.modules.length, "module")}, ${plural(f.graph.nodes, "source file")}, ${plural(f.graph.edges, "internal import")}. Most central file: ${f.keyFiles[0]?.path ?? "n/a"}.` : "No parsable source files found." });

  const dbs = f.integrations.filter((i) => i.category === "database").map((i) => i.name);
  const ents = f.dataModel.entities;
  if (ents.length) {
    const sensitive = ents.flatMap((e) => e.fields.filter((x) => x.sensitivity && x.sensitivity !== "none").map((x) => `${e.table ?? e.name}.${x.name}`));
    c.push({ area: "data_structures", status: "answered", summary: `${plural(ents.length, "table", "tables")} from ${list(f.dataModel.sources)} (${plural(ents.reduce((s, e) => s + e.fields.length, 0), "column")}); ${plural(sensitive.length, "sensitive column")}; ${plural(f.dataModel.enums.length, "enum")}; ${plural(f.domainTypes.length, "domain type")}.` });
  } else if (dbs.length) {
    const candidates = src.allPaths.filter((p) => /(schema|migration|models?)\b/i.test(p) && !/node_modules/.test(p));
    c.push({ area: "data_structures", status: "partial", summary: `A database is used (${list(dbs)}) but no table definitions were recognised${candidates.length ? `; candidate files: ${list(candidates, 4)}` : ""}.` });
    ask("data_structures", "Where is the database schema defined (migrations folder, another repository, or created manually)?", "The code talks to a database, but no tables, models or migrations were recognised.", ["testing", "security"]);
  } else c.push({ area: "data_structures", status: f.domainTypes.length ? "answered" : "unknown", summary: f.domainTypes.length ? `No database; ${plural(f.domainTypes.length, "domain type")} found.` : "No database schema or domain types found." });

  c.push({ area: "business_logic", status: "pending_ai", summary: `${plural(f.dataModel.enums.length, "status or enum type")} and ${plural(f.keyFiles.length, "central file")} identified. Business rules and state machines are explained in the AI step.` });

  if (routes.length) {
    const counts = (Object.keys(CONTROL_LABEL) as ControlKind[]).map((k) => [k, byControl(k).length] as const).filter(([, n]) => n);
    c.push({ area: "apis", status: byControl("unknown").length ? "partial" : "answered", summary: `${plural(routes.length, "endpoint")}: ${counts.map(([k, n]) => `${n} ${CONTROL_LABEL[k]}`).join(", ")}.` });
    const openReads = byControl("none_found").filter((r) => !r.mutates && r.kind !== "webhook");
    if (openReads.length) ask("apis", `Are these endpoints meant to be public? ${list(openReads.map((r) => `${r.method} ${r.path}`), 5)}`, "They return data and no protection was found. Knowing the intent tells the Security check what to test.", ["security", "adversarial"]);
  } else c.push({ area: "apis", status: "answered", summary: "No HTTP, GraphQL or webhook endpoints found." });

  c.push({ area: "data_flow", status: "pending_ai", summary: "The data-flow diagram with trust boundaries and sensitive data is built in the AI step from the facts above." });

  // Integrations: the summary uses exactly the records shown in the table and diagram.
  if (f.integrations.length) {
    const byCat = new Map<string, string[]>();
    for (const i of f.integrations) byCat.set(i.category, [...(byCat.get(i.category) ?? []), i.name]);
    c.push({ area: "integrations", status: "partial", summary: `${plural(f.integrations.length, "integration")}: ${[...byCat].map(([cat, names]) => `${cat}: ${names.join(", ")}`).join("; ")}. What data each one receives is described in the AI step.` });
  } else c.push({ area: "integrations", status: "answered", summary: "No third-party integrations found." });

  if (routes.length && !sm.authMechanisms.length && !routes.some((r) => ["session_required", "role_required", "service_token"].includes(r.control.kind))) {
    c.push({ area: "security_model", status: "unknown", summary: "Endpoints exist but no authentication mechanism, session use, token check or guard was found." });
    ask("security_model", "Is this service protected by something outside the code (API gateway, VPN, internal network only)?", "No authentication checks were found on any endpoint.", ["security", "adversarial"]);
  } else {
    const parts = [
      sm.authMechanisms.length ? `authentication: ${list(sm.authMechanisms.map((m) => m.detail), 4)}` : null,
      sm.guards.length ? `guards: ${sm.guards.map((g) => `${g.name} on ${plural(g.endpoints, "endpoint")}`).join(", ")}` : null,
      sm.credentialChecks.length ? `credentials: ${sm.credentialChecks.map((x) => x.detail).join("; ")}` : null,
      sm.validationLibraries.length ? `validation: ${sm.validationLibraries.join(", ")}` : null,
      sm.notDetected.length ? `not detected: ${sm.notDetected.map((n) => n.control.toLowerCase()).join(", ")}` : null,
    ].filter(Boolean);
    c.push({ area: "security_model", status: sm.notDetected.length ? "partial" : "answered", summary: `${parts.join("; ")}.` });
  }

  const aiCalls = f.aiComponents.reduce((s, a) => s + a.calls.length, 0);
  c.push({ area: "ai_components", status: "answered", summary: f.aiComponents.length ? `${f.aiComponents.map((a) => `${a.sdk}: ${plural(a.calls.length, "call site")}${a.toolDefinitions.length ? `, ${plural(a.toolDefinitions.length, "tool definition")}` : ""}`).join("; ")} (${plural(aiCalls, "call site")} in total).` : "No AI model, agent or retrieval component found. The AI Evaluator check does not apply." });

  const jobs = f.background;
  if (jobs.length) {
    const unresolved = jobs.filter((j) => j.kind === "cron" && !j.resolvedSchedule);
    c.push({ area: "background_work", status: unresolved.length ? "partial" : "answered", summary: `${plural(jobs.length, "background job")}: ${list(jobs.map((j) => `${j.name}${j.resolvedSchedule ? ` (${j.resolvedSchedule}${j.timezone ? ` ${j.timezone}` : ""})` : j.schedule ? ` (${j.schedule})` : ""}`), 4)}.` });
  } else c.push({ area: "background_work", status: "answered", summary: "No background jobs, queues or schedules found." });

  const d = f.deployment;
  if (d.dockerfiles.length || d.containers.length || d.ci.length || d.platforms.length) {
    const files = [...new Set(d.containers.map((x) => x.file))];
    c.push({ area: "infrastructure", status: "answered", summary: [d.dockerfiles.length ? plural(d.dockerfiles.length, "Dockerfile") : null, d.containers.length ? `${plural(d.containers.length, "container definition")} in ${plural(files.length, "compose file")} (${list(files)})` : null, d.ci.length ? `CI: ${[...new Set(d.ci.map((x) => x.provider))].join(", ")}` : null, d.platforms.length ? `platforms: ${d.platforms.map((p) => p.name).join(", ")}` : null].filter(Boolean).join("; ") + "." });
  } else {
    c.push({ area: "infrastructure", status: "unknown", summary: "No Dockerfile, compose file, CI workflow or platform config found." });
    ask("infrastructure", "Where and how is this deployed (for example Vercel, a VPS, Docker on AWS)?", "No deployment configuration was found in the snapshot.", ["testing", "adversarial"]);
  }

  const env = f.config.envVars;
  const used = env.filter((e) => e.usedIn.length);
  const undocumented = used.filter((e) => !e.documented);
  const unused = env.filter((e) => e.documented && !e.usedIn.length);
  c.push({
    area: "configuration",
    status: undocumented.length || unused.length ? "partial" : "answered",
    summary: `${plural(env.length, "environment variable")} (names only): ${used.length} read by code or deployment files, ${env.filter((e) => e.required === true).length} required at startup, ${env.filter((e) => e.sensitivity === "secret").length} secret, ${env.filter((e) => e.side === "browser").length} exposed to the browser${undocumented.length ? `; ${undocumented.length} not in an example file` : ""}${unused.length ? `; ${unused.length} documented but never read` : ""}.`,
  });
  c.push({ area: "dependencies", status: "answered", summary: `${plural(f.dependencies.filter((x) => !x.dev).length, "runtime dependency", "runtime dependencies")} and ${plural(f.dependencies.filter((x) => x.dev).length, "development dependency", "development dependencies")}${f.dependencies.some((x) => x.resolved) ? ", with locked versions" : ""}.` });
  c.push({ area: "quality", status: "answered", summary: `${plural(f.quality.testFiles, "test file")}${f.quality.testFrameworks.length ? ` (${f.quality.testFrameworks.join(", ")})` : ""}; ${plural(f.modules.filter((m) => !m.tested).length, "module")} without tests; logging: ${f.quality.logging.join(", ") || "not detected"}; error tracking: ${f.quality.errorTracking.join(", ") || "not detected"}.` });

  const rp = f.runPlan;
  if (rp.workspaces.length) {
    c.push({ area: "how_to_run", status: "answered", summary: `${rp.workspaces.map((w) => `${w.dir}: ${[w.install, w.build, w.start ?? w.dev].filter(Boolean).join(", then ")}`).join("; ")}. Ports: ${rp.ports.map((p) => p.port).join(", ") || "not declared"}. ${plural(rp.requiredEnv.length, "variable")} required at startup. Declared only; not run yet.` });
  } else if (f.runCommands.length) {
    c.push({ area: "how_to_run", status: "partial", summary: `Declared commands: ${list(f.runCommands.map((r) => r.name))}. Declared only; not run yet.` });
  } else {
    c.push({ area: "how_to_run", status: "unknown", summary: "No install, build, test or start commands declared." });
    ask("how_to_run", "How do you install, build, test and start this project?", "No scripts or Makefile targets were found, so checks can't run it automatically.", ["testing", "adversarial"]);
  }
  c.push({ area: "risks_questions", status: "partial", summary: "Evidence-based findings are listed now. The full risk register (threats per trust boundary and business logic) comes from the AI step." });
  return { checklist: c, questions: q };
}

/** Facts worth a closer look, each with evidence and the check that should test it. Not verdicts. */
export function buildObservations(f: Facts, src: SnapshotSource, sensitiveLogs: Evidence[]): Observation[] {
  const o: Observation[] = [];
  const add = (x: Omit<Observation, "id">) => o.push({ ...x, id: `finding-${o.length + 1}` });
  const routes = f.entryPoints.filter((e) => e.kind !== "page");

  const secretFiles = [...src.skipped.entries(), ...src.excluded.entries()].filter(([, r]) => r.startsWith("secret file")).map(([p]) => p);
  if (secretFiles.length) {
    // Never stored or never read, so there is nothing to open in the code viewer.
    add({ status: "observed", title: `${secretFiles.length === 1 ? "A secret file is" : `${secretFiles.length} secret files are`} included in the project`, detail: `${list(secretFiles, 5)}. We never read their contents, but files like these often contain real credentials and shouldn't be committed.`, severity: "high", evidence: [], suggestedCheck: "security" });
  }

  const openMutating = routes.filter((e) => e.control.kind === "none_found" && e.mutates && e.kind !== "webhook" && !/callback/i.test(e.path) && e.method !== "ACTION");
  for (const e of openMutating.slice(0, 10)) {
    add({ status: "observed", title: `${e.method} ${e.path}: changes data with no protection found`, detail: `${e.control.reason}. It may be protected somewhere we can't see (for example a gateway), or be missing a check.`, severity: e.method === "DELETE" ? "high" : "medium", evidence: [e.handler], suggestedCheck: "security" });
  }
  if (openMutating.length > 10) add({ status: "observed", title: `${openMutating.length - 10} more data-changing endpoints with no protection found`, detail: "See the API and payloads section, filter \"No protection found\".", severity: "medium", evidence: [], suggestedCheck: "security" });
  const openReads = routes.filter((e) => e.control.kind === "none_found" && !e.mutates && e.kind !== "webhook" && !/callback/i.test(e.path));
  if (openReads.length) add({ status: "observed", title: `${plural(openReads.length, "endpoint")} ${openReads.length === 1 ? "returns" : "return"} data with no protection found`, detail: `${list(openReads.map((e) => `${e.method} ${e.path}`), 6)}. Confirm these are meant to be public.`, severity: "medium", evidence: openReads.slice(0, 5).map((e) => e.handler), suggestedCheck: "security" });

  for (const e of routes.filter((x) => x.kind === "webhook" && x.control.kind === "none_found" && x.mutates)) {
    // What a forged event can trigger, from what the handler's code does.
    const impact = e.sideEffects.length ? ` A forged event reaches code that ${e.sideEffects.join(", ")}, so an attacker can make the app do those things.` : "";
    add({ status: "observed", title: `Webhook ${e.method} ${e.path}: no signature verification found`, detail: `Anyone who knows the URL can send fake events unless the sender's signature is checked (for Meta webhooks, the X-Hub-Signature-256 header).${impact}`, severity: "high", evidence: [e.handler], suggestedCheck: "security" });
  }
  const rt = f.runtime;
  for (const u of rt.uploads.filter((x) => x.contentTypeFromClient)) {
    add({ status: "inferred", title: `Uploaded files are served back with the Content-Type the uploader chose${u.endpoint ? ` (${u.endpoint})` : ""}`, detail: `The upload stores the file's declared type and later serves the file with it. A file declared as text/html or image/svg+xml would run as a page on the app's own origin (stored cross-site scripting). Limits: ${Object.entries(u.limits).map(([k, v]) => `${k} ${v}`).join(", ") || "none found"}.`, severity: "medium", evidence: u.evidence.slice(0, 3), suggestedCheck: "security" });
  }
  const noTimeout = rt.outboundCalls.filter((c) => !c.timeout);
  if (noTimeout.length) add({ status: "observed", title: `${plural(noTimeout.length, "outgoing HTTP call")} without a timeout`, detail: "If the other service hangs, these requests wait indefinitely and can tie up the app. The Testing check can simulate slow services.", severity: "low", evidence: noTimeout.slice(0, 5).map((c) => c.evidence), suggestedCheck: "testing" });
  if (!rt.errorHandling.globalHandler && routes.length) add({ status: "not_observed", title: "No global error handler found", detail: "Unexpected errors use the framework's default response. Check that stack traces and internal details are not returned to callers.", severity: "low", evidence: [], suggestedCheck: "testing" });
  if (rt.agentInstructionFiles.length) add({ status: "observed", title: `${plural(rt.agentInstructionFiles.length, "file")} with instructions for AI coding agents`, detail: `${list(rt.agentInstructionFiles, 4)}. Check agents treat these as untrusted project content, never as instructions.`, severity: "info", evidence: [], suggestedCheck: "ai-evaluator" });
  const unpinned = rt.supplyChain.images.filter((i) => !i.pinned);
  const ciNoTests = rt.supplyChain.ci.filter((c) => c.publishes && !c.runsTests);
  if (ciNoTests.length) add({ status: "observed", title: `CI publishes to ${ciNoTests.map((c) => c.publishes).join(", ")} without running tests`, detail: `${ciNoTests.map((c) => c.path).join(", ")} builds and publishes without a test, type-check or lint step, so broken builds can be released.`, severity: "low", evidence: ciNoTests.map((c) => ({ path: c.path, line: 1 })), suggestedCheck: "testing" });
  if (unpinned.length) add({ status: "observed", title: `${plural(unpinned.length, "container image")} not pinned to an exact version`, detail: `${list([...new Set(unpinned.map((i) => i.image))])}. Builds can silently pick up new versions.`, severity: "low", evidence: unpinned.slice(0, 3).map((i) => i.evidence), suggestedCheck: "security" });
  for (const e of routes.filter((x) => /callback/i.test(x.path) && x.control.kind === "none_found")) {
    add({ status: "observed", title: `OAuth callback ${e.method} ${e.path}: no state check found`, detail: "Without comparing the returned state with the one stored in the session, an attacker can link their own account to the victim's session (login CSRF).", severity: "medium", evidence: [e.handler], suggestedCheck: "security" });
  }
  if (sensitiveLogs.length) {
    add({ status: "observed", title: `Personal data or request bodies are written to logs (${plural(sensitiveLogs.length, "place")})`, detail: "Logs then contain phone numbers, emails, message text or whatever callers send, including tokens. Logs are usually kept longer and seen by more people than the database.", severity: "high", evidence: sensitiveLogs, suggestedCheck: "security" });
  }
  for (const c of f.securityModel.cors.filter((x) => x.allowsAnyOrigin).slice(0, 3)) {
    add({ status: "observed", title: "CORS allows any origin", detail: "Any website can call this API from a browser. Fine for public read-only APIs; risky with cookies or private data.", severity: "medium", evidence: [c.evidence], suggestedCheck: "security" });
  }
  const pwField = f.dataModel.entities.find((e) => e.fields.some((x) => /^(password|passwd|pwd|password_hash)$/i.test(x.name)));
  if (pwField && !f.securityModel.passwordHashing.length && !f.securityModel.credentialChecks.some((c) => c.kind === "third_party")) {
    add({ status: "inferred", title: `${pwField.table ?? pwField.name} stores a password, and no password hashing library was found`, detail: "Stored passwords must use a slow hash such as bcrypt or argon2.", severity: "high", evidence: [pwField.evidence], suggestedCheck: "security" });
  }
  for (const c of f.securityModel.credentialChecks.filter((x) => x.kind === "plain_compare")) {
    add({ status: "observed", title: "The sign-in password is compared with ===", detail: "A normal comparison can leak timing information; use a constant-time comparison or a password hash.", severity: "low", evidence: c.evidence, suggestedCheck: "security" });
  }
  const tokenCols = f.dataModel.entities.flatMap((e) => e.fields.filter((x) => x.sensitivity === "secret" && /token|secret|api_?key/i.test(x.name)).map((x) => ({ e, x })));
  if (tokenCols.length) {
    add({ status: "observed", title: `Credentials are stored in the database (${list(tokenCols.map(({ e, x }) => `${e.table ?? e.name}.${x.name}`), 4)})`, detail: "Anyone with a copy of the database or its backups can use these tokens. Check whether they are encrypted and how backups are protected.", severity: "medium", evidence: [...new Map(tokenCols.map(({ e }) => [e.id, e.evidence])).values()], suggestedCheck: "security" });
  }
  const signIn = routes.filter((e) => e.control.kind === "public_intentional" && /(log-?in|sign-?in|reset|forgot|otp|token)/i.test(e.path) && e.mutates);
  if (signIn.length && !f.securityModel.rateLimiting.length) {
    add({ status: "inferred", title: "Sign-in endpoints with no rate limiting found", detail: `${list(signIn.map((e) => `${e.method} ${e.path}`))}. ${f.securityModel.notDetected.find((n) => n.control === "Rate limiting")?.scope ?? ""} Without limits, passwords can be guessed quickly.`, severity: "medium", evidence: signIn.slice(0, 3).map((r) => r.handler), suggestedCheck: "security" });
  }
  for (const a of f.aiComponents.filter((x) => x.toolDefinitions.length)) {
    add({ status: "observed", title: `${a.sdk}: the model can call tools`, detail: "Tool-using AI features should be tested for prompt injection and unsafe tool use.", severity: "medium", evidence: a.toolDefinitions.slice(0, 3), suggestedCheck: "ai-evaluator" });
  }
  if (f.aiComponents.length) {
    add({ status: "observed", title: "AI features present", detail: `${list(f.aiComponents.map((a) => a.sdk))} ${f.aiComponents.length === 1 ? "is" : "are"} called from ${plural(f.aiComponents.reduce((s, a) => s + a.calls.length, 0), "place")}. The AI Evaluator check applies: prompts, inputs and what data reaches the provider will be tested.`, severity: "info", evidence: f.aiComponents.flatMap((a) => a.calls.slice(0, 2).map((c) => c.evidence)), suggestedCheck: "ai-evaluator" });
  }
  // A test command that only prints or exits proves nothing, whatever a results file claims.
  const fakeTest = f.runCommands.find((r) => r.name === "test" && /^\s*(echo\b|exit 0|true\b)|&&\s*exit 0\s*$/.test(r.command) && !/\b(vitest|jest|mocha|pytest|playwright|ava|tap|node --test)\b/.test(r.command));
  if (fakeTest) add({ status: "observed", title: "The declared test command does not run any tests", detail: `"${fakeTest.command}" in ${fakeTest.source} only prints a message. Any report saying tests passed cannot be trusted until real tests run.`, severity: "medium", evidence: [{ path: fakeTest.source, line: (src.files.get(fakeTest.source)?.text.split("\n").findIndex((l) => /"test"\s*:/.test(l)) ?? -1) + 1 || 1 }], suggestedCheck: "testing" });
  if (f.quality.testFiles === 0 && f.graph.nodes > 0) add({ status: "not_observed", title: "No automated tests found", detail: `No test files were found among ${plural(f.graph.nodes, "parsed source file")}. The Testing check will report what is untested and can propose tests.`, severity: "medium", evidence: [], suggestedCheck: "testing" });
  const undocumented = f.config.envVars.filter((e) => e.usedIn.length && !e.documented);
  if (undocumented.length && f.config.envVars.some((e) => e.documented)) {
    add({ status: "observed", title: `${plural(undocumented.length, "environment variable")} ${undocumented.length === 1 ? "is" : "are"} read but not documented`, detail: `${list(undocumented.map((e) => e.name))}. Missing configuration is a common cause of failed deployments.`, severity: "low", evidence: undocumented.slice(0, 3).flatMap((e) => e.usedIn.slice(0, 1)), suggestedCheck: "testing" });
  }
  const unlocked = f.dependencies.length > 0 && !f.dependencies.some((d) => d.resolved) && !f.stack.packageManagers.length;
  if (unlocked) add({ status: "not_observed", title: "No lockfile found", detail: "Dependency versions aren't pinned, so builds can change between installs.", severity: "low", evidence: [], suggestedCheck: "security" });
  return o;
}
