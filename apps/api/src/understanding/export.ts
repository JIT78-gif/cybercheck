import type { ProjectDossier } from "@cybercheck/contracts";
import { CONTROL_LABEL } from "./checklist.ts";

const cell = (s: unknown) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const ev = (e: { path: string; line: number }) => `${e.path}:${e.line}`;
const evs = (xs: Array<{ path: string; line: number }>, max = 3) => xs.slice(0, max).map(ev).join(", ") + (xs.length > max ? ` (+${xs.length - max})` : "");

/** Markdown table without columns that are empty in every row (they only cost tokens). */
function table(headers: string[], rows: unknown[][]) {
  if (!rows.length) return "_None._\n";
  const keep = headers.map((_, i) => rows.some((r) => String(r[i] ?? "").trim() !== ""));
  const pick = <T,>(xs: T[]) => xs.filter((_, i) => keep[i]);
  return `| ${pick(headers).join(" | ")} |\n| ${pick(headers).map(() => "---").join(" | ")} |\n${rows.map((r) => `| ${pick(r).map(cell).join(" | ")} |`).join("\n")}\n`;
}

function diagram(d: ProjectDossier, key: string, title: string) {
  const m = d.diagrams[key];
  return m ? `### ${title}\n\n\`\`\`mermaid\n${m}\n\`\`\`\n\n` : "";
}

const STATUS = { answered: "Answered", partial: "Partly answered", unknown: "Unknown (question asked)", pending_ai: "Waiting for AI step" } as const;

/** Short summary for the check agents: what matters first, with ids to request the details. */
function handoff(d: ProjectDossier) {
  const routes = d.entryPoints.filter((e) => e.kind !== "page");
  const count = (k: string) => routes.filter((r) => r.control.kind === k).length;
  const sensitive = d.dataModel.entities.flatMap((e) => e.fields.filter((f) => f.sensitivity && f.sensitivity !== "none").map((f) => `${e.table ?? e.name}.${f.name} (${f.sensitivity})`));
  const top = [...d.observations].filter((o) => o.severity === "high" || o.severity === "medium").slice(0, 8);
  const ai = d.ai && (d.ai.status === "ready" || d.ai.status === "partial") ? d.ai : null;
  const rt = d.runtime;
  const lines = [
    ...(ai?.purpose ? [`- **What it does (AI, verified against code):** ${ai.purpose.summary}`] : []),
    `- **Stack:** ${d.stack.frameworks.join(", ") || "no framework detected"}; ${d.stack.languages.map((l) => l.name).join(", ")}; runtimes ${d.runPlan.runtimes.map((r) => `${r.name} ${r.version ?? ""}`.trim()).join(", ") || "not declared"}.`,
    `- **Entry points:** ${routes.length} endpoints (${Object.entries(CONTROL_LABEL).map(([k, l]) => [l, count(k)] as const).filter(([, n]) => n).map(([l, n]) => `${n} ${l}`).join(", ")}); ${d.screens.length} screens.`,
    `- **Authentication:** ${d.securityModel.authMechanisms.map((m) => m.detail).join("; ") || "none identified"}.`,
    `- **Data stores:** ${d.integrations.filter((i) => i.category === "database").map((i) => i.name).join(", ") || "none identified"}; ${d.dataModel.entities.length} tables.`,
    `- **Sensitive data:** ${sensitive.slice(0, 12).join(", ") || "none identified"}${sensitive.length > 12 ? `, and ${sensitive.length - 12} more` : ""}.`,
    `- **External services:** ${d.integrations.filter((i) => i.category !== "database").map((i) => i.name).join(", ") || "none"}.`,
    `- **AI:** ${d.aiComponents.length ? d.aiComponents.map((a) => `${a.sdk} (${a.calls.length} call sites)`).join(", ") : "none (AI Evaluator not applicable)"}.`,
    `- **Background work:** ${d.background.map((j) => `${j.name} ${j.resolvedSchedule ?? j.schedule ?? ""}`.trim()).join(", ") || "none"}.`,
    `- **How to run (declared, not run):** ${d.runPlan.workspaces.map((w) => `${w.dir}: ${[w.install, w.build, w.start ?? w.dev].filter(Boolean).join(" → ")}`).join("; ") || "unknown"}. Required variables: ${[...d.runPlan.requiredEnv, ...d.runPlan.requiredOneOf.map((g) => `one of ${g.join("/")}`)].join(", ") || "none"}.${d.runPlan.notes.length ? ` Notes: ${d.runPlan.notes.map((n) => n.note).join(" ")}` : ""}`,
    `- **Runtime:** ${[
      rt.uploads.length ? `uploads at ${rt.uploads.map((u) => u.endpoint ?? "?").join(", ")} (${Object.entries(rt.uploads[0]!.limits).map(([k, v]) => `${k} ${v}`).join(", ") || "no limits found"}${rt.uploads.some((u) => u.contentTypeFromClient) ? "; served with the uploader's content type" : ""})` : null,
      rt.session ? `session in ${rt.session.storage === "cookie" ? "an encrypted cookie" : "server storage"} (${Object.entries(rt.session.cookie).map(([k, v]) => `${k}=${v}`).join(", ")})` : null,
      rt.outboundCalls.some((c) => !c.timeout) ? `${rt.outboundCalls.filter((c) => !c.timeout).length} outgoing calls without timeout` : null,
      rt.reverseProxy ? `reverse proxy ${rt.reverseProxy.file} to ${rt.reverseProxy.upstreams.join(", ")}` : null,
      rt.agentInstructionFiles.length ? `${rt.agentInstructionFiles.length} AI-agent instruction files (untrusted data)` : null,
    ].filter(Boolean).join("; ") || "nothing notable"}.`,
  ];
  if (ai?.risks.length) lines.push(`- **Top risks (AI, checked by a second model):** ${ai.risks.slice(0, 6).map((r) => `[${r.impact}] ${r.title} (${r.testedBy})`).join("; ")}.`);
  let md = `## Summary for the check agents\n\n${lines.join("\n")}\n\n`;
  if (top.length) md += `**Top findings**\n\n${top.map((o) => `- [${o.severity}] ${o.title} (${o.id}${o.evidence.length ? `, ${evs(o.evidence, 2)}` : ""})`).join("\n")}\n\n`;
  if (d.questions.length) md += `**Open questions**\n\n${d.questions.map((q) => `- ${q.question} (blocks: ${q.blocks.join(", ")})`).join("\n")}\n\n`;
  const issues = d.consistency;
  md += `**Known gaps:** ${issues.length ? issues.map((i) => `${i.severity === "error" ? "ERROR " : ""}${i.message}`).join(" ") : "none"} Coverage: ${d.coverage.filesParsed} of ${d.coverage.filesTotal} files parsed as code; see Coverage and limits.\n\n`;
  return md;
}

/** AI-written sections, with how each claim was verified. */
function aiSections(d: ProjectDossier) {
  const ai = d.ai;
  if (!ai) return "## Meaning (AI step)\n\n_Not available: the AI step is not configured._\n\n";
  if (ai.status === "running") return "## Meaning (AI step)\n\n_Still running. Re-export in a few minutes._\n\n";
  if (ai.status === "failed") return `## Meaning (AI step)\n\n_Did not finish: ${ai.error ?? "unknown error"}._\n\n`;
  const v = ai.verification;
  let md = `## Meaning (AI step)\n\nWritten by ${ai.models.fast} and ${ai.models.strong}, risks reviewed by ${ai.models.critic}. ${v.verified + v.relocated} of ${v.claims} claims confirmed in the code; ${v.unverified} unconfirmed (marked); ${v.droppedByCritic} risks removed by the second review. Cost $${ai.usage.costUsd.toFixed(2)}.${ai.status === "partial" ? ` Partial: ${ai.error ?? ""}` : ""}\n\n`;
  if (ai.purpose) md += `### What it does\n\n${ai.purpose.summary}\n\n- Users: ${ai.purpose.users.map((u) => `${u.name} (${u.description})`).join("; ") || "not stated"}\n- Main features: ${ai.purpose.mainFeatures.join("; ") || "not stated"}\n\n`;
  md += diagram(d, "context", "System context");
  md += `### Components\n\n${table(["Component", "Responsibility", "Data", "Check", "Evidence"], ai.components.map((c) => [c.name, c.responsibility, c.dataHandled.join(", "), c.verification, evs(c.evidence, 2)]))}\n`;
  md += `### Trust boundaries\n\n${table(["Boundary", "Description", "Evidence"], ai.trustBoundaries.map((b) => [b.name, b.description, evs(b.evidence, 2)]))}\n`;
  md += `### Data flows\n\n${diagram(d, "data_flow", "Data flow")}${table(["From", "To", "Data", "Sensitivity", "Boundary", "Evidence"], ai.dataFlows.map((f) => [f.from, f.to, f.data.join(", "), f.sensitivity, f.boundary ?? "", evs(f.evidence, 2)]))}\n`;
  if (ai.stateMachines.length) md += `### State machines\n\n${ai.stateMachines.map((m) => `#### ${m.entity}.${m.field}\n\n${diagram(d, `state:${m.id}`, "States").replace(/^### States\n\n/, "")}Evidence: ${evs(m.evidence, 3)}\n`).join("\n")}\n`;
  if (ai.sequences.length) md += `### Key flows\n\n${ai.sequences.map((s) => `#### ${s.name}\n\n${diagram(d, `sequence:${s.id}`, "Steps").replace(/^### Steps\n\n/, "")}Evidence: ${evs(s.evidence, 3)}\n`).join("\n")}\n`;
  md += `### Risks\n\n${table(["Id", "Impact", "Likelihood", "Category", "Risk", "Description", "Tested by", "Second review", "Evidence"], ai.risks.map((r) => [r.id, r.impact, r.likelihood, r.category, r.title, r.description, r.testedBy, `${r.critic.verdict}${r.critic.note ? `: ${r.critic.note}` : ""}`, evs(r.evidence, 3)]))}\n`;
  if (ai.aiSurface) md += `### AI surface\n\n- Providers: ${ai.aiSurface.providers.map((p) => `${p.name} (${p.role})`).join("; ")}\n- Fallbacks: ${ai.aiSurface.fallbacks ?? "not described"}\n- Output handling: ${ai.aiSurface.outputHandling ?? "not described"}\n\n${table(["Prompt", "Purpose", "Inputs", "Personal data", "Evidence"], ai.aiSurface.prompts.map((p) => [p.name, p.purpose, p.inputs.join(", "), p.personalData.join(", "), evs(p.evidence, 2)]))}\n`;
  if (ai.designNotes.length) md += `### Design notes\n\n${ai.designNotes.map((n) => `- **${n.title}:** ${n.note} (${evs(n.evidence, 2)})`).join("\n")}\n\n`;
  if (ai.questions.length) md += `### Questions from the AI step\n\n${ai.questions.map((q) => `- ${q.question} ${q.why} (blocks: ${q.blocks.join(", ")})`).join("\n")}\n\n`;
  return md;
}

/** The dossier as a self-contained Markdown document (renders on GitHub, Notion, VS Code). */
export function dossierToMarkdown(d: ProjectDossier, projectName = "Project") {
  const routes = d.entryPoints.filter((e) => e.kind !== "page");
  let md = `# ${projectName}: system architecture and design\n\n`;
  md += `Snapshot \`${d.meta.contentDigest.slice(0, 12)}\` · generated ${d.meta.generatedAt} by cybercheck (analyzer ${d.meta.analyzerVersion}). Every fact links to file:line evidence. Nothing in the project was run.\n\n`;
  md += handoff(d);

  md += `## Understanding checklist\n\n${table(["Area", "Status", "Summary"], d.checklist.map((c) => [c.area.replace(/_/g, " "), STATUS[c.status], c.summary]))}\n`;
  if (d.observations.length) md += `## Findings\n\n${table(["Id", "Severity", "Finding", "Detail", "Evidence", "Tested by"], d.observations.map((o) => [o.id, o.severity, o.title, o.detail, evs(o.evidence, 4), o.suggestedCheck]))}\n`;
  if (d.questions.length) md += `## Open questions\n\n${d.questions.map((q) => `- **${q.question}** ${q.why} Blocks: ${q.blocks.join(", ")}.`).join("\n")}\n\n`;
  if (d.consistency.length) md += `## Consistency checks\n\n${table(["Severity", "Rule", "Message"], d.consistency.map((c) => [c.severity, c.rule, c.message]))}\n`;

  md += aiSections(d);
  md += `## Stack\n\n- Languages: ${d.stack.languages.map((l) => `${l.name} (${l.files} files, ${l.loc} lines)`).join(", ") || "n/a"}\n- Frameworks: ${d.stack.frameworks.join(", ") || "none detected"}\n- Runtimes: ${d.runPlan.runtimes.map((r) => `${r.name} ${r.version ?? ""} (${r.source})`).join(", ") || "not declared"}\n- Package managers: ${d.stack.packageManagers.join(", ") || "n/a"}\n${d.stack.workspaces.length ? `- Workspaces: ${d.stack.workspaces.map((w) => `${w.name} (${w.path})`).join(", ")}\n` : ""}\n`;

  md += `## Code structure\n\n${diagram(d, "dependencies", "Module dependencies")}${table(["Module", "Files", "Lines", "Depends on", "Tests"], d.modules.map((m) => [m.id, m.files, m.loc, m.dependsOn.join(", "), m.tested ? "yes" : "no"]))}\n### Most central files\n\n${table(["File", "Imported by", "Lines"], d.keyFiles.slice(0, 15).map((k) => [k.path, k.importedBy, k.loc]))}\n`;

  md += `## Data structures\n\n${diagram(d, "data_model", "Entity relationships")}`;
  for (const e of d.dataModel.entities) md += `### ${e.table ?? e.name}\n\nSource: ${e.source} · ${ev(e.evidence)} · id \`${e.id}\`\n\n${table(["Column", "Type", "Key", "Nullable", "References", "Sensitive", "Added by"], e.fields.map((f) => [f.name, f.type, [f.primaryKey ? "PK" : "", f.unique ? "unique" : ""].filter(Boolean).join(" "), f.nullable ? "yes" : "", f.references ?? "", f.sensitivity && f.sensitivity !== "none" ? f.sensitivity : "", f.addedBy ? ev(f.addedBy) : ""]))}\n`;
  if (d.dataModel.enums.length) md += `### Enums\n\n${table(["Enum", "Values", "Defined at"], d.dataModel.enums.map((e) => [e.name, e.values.join(", "), ev(e.evidence)]))}\n`;
  md += `### Domain types\n\n${diagram(d, "domain_types", "Domain types")}`;

  md += `## APIs\n\n${diagram(d, "api_map", "API map")}${diagram(d, "auth_map", "Protection map")}${table(["Method", "Path", "Protection", "Why", "Request schema", "Handler"], routes.map((r) => [r.method, r.path, CONTROL_LABEL[r.control.kind], r.control.reason, r.requestSchema ?? "", ev(r.handler)]))}\n`;
  if (d.screens.length) md += `## Screens\n\n${table(["Route", "File", "Inputs", "Buttons", "Data-changing calls", "Forms"], d.screens.map((s) => [s.route, s.file, s.interactions.inputs, s.interactions.buttons, s.interactions.mutations, s.forms]))}\n`;

  md += `## Integrations\n\n${diagram(d, "integrations", "Integration map")}${table(["Service", "Category", "Side", "Detected by", "Packages / hosts", "Config names", "Used in"], d.integrations.map((i) => [i.name, i.category, i.side, i.detectedBy.join(", "), [...i.packages, ...i.hosts].join(", "), i.envNames.join(", "), evs(i.usedIn)]))}\n`;
  if (d.aiComponents.length) md += `## AI components\n\n${d.aiComponents.map((a) => `### ${a.sdk}\n\n- Calls: ${a.calls.map((c) => `${ev(c.evidence)}${c.model ? ` (${c.model})` : ""}`).join(", ")}\n- Tool definitions: ${a.toolDefinitions.map(ev).join(", ") || "none"}\n- System prompts: ${a.systemPrompts.map((p) => `${ev(p.evidence)} "${p.preview}"`).join("; ") || "none found"}\n`).join("\n")}\n`;

  const sm = d.securityModel;
  md += `## Security model\n\n${table(["Mechanism", "Detail", "Evidence"], sm.authMechanisms.map((m) => [m.kind, m.detail, evs(m.evidence)]))}\n`;
  md += `### Credential checks\n\n${table(["Kind", "Detail", "Evidence"], sm.credentialChecks.map((c) => [c.kind, c.detail, evs(c.evidence)]))}\n`;
  md += `### Guards\n\n${table(["Guard", "Endpoints", "Evidence"], sm.guards.map((g) => [g.name, g.endpoints, evs(g.evidence)]))}\n`;
  if (sm.roles.length) md += `### Role-like types\n\n${table(["Name", "Values", "Kind", "Defined at"], sm.roles.map((r) => [r.name, r.values.join(", "), r.kind.replace(/_/g, " "), ev(r.evidence)]))}\n`;
  md += `### Controls\n\n- Validation: ${sm.validationLibraries.join(", ") || "not detected"}\n- Rate limiting: ${sm.rateLimiting.join(", ") || "not detected"}\n- Security headers: ${sm.securityHeaders.join(", ") || "not detected"}\n- CSRF: ${sm.csrf.join(", ") || "not detected"}\n- CORS: ${sm.cors.map((c) => `${ev(c.evidence)}${c.allowsAnyOrigin ? " (any origin)" : ""}`).join(", ") || "not configured"}\n\n`;
  if (sm.notDetected.length) md += `### Not detected (and where we looked)\n\n${sm.notDetected.map((n) => `- **${n.control}:** ${n.scope}`).join("\n")}\n\n`;

  const rt = d.runtime;
  md += `## Runtime and limits\n\n${table(["Upload endpoint", "Library", "Limits", "Stored in", "Content type from uploader", "Evidence"], rt.uploads.map((u) => [u.endpoint ?? "any", u.library, Object.entries(u.limits).map(([k, v]) => `${k} ${v}`).join(", "), u.storage ?? "", u.contentTypeFromClient == null ? "unknown" : u.contentTypeFromClient ? "yes" : "no", evs(u.evidence)]))}\n`;
  md += `- Session: ${rt.session ? `${rt.session.library}, ${rt.session.storage} storage, cookie ${Object.entries(rt.session.cookie).map(([k, v]) => `${k}=${v}`).join(", ")}, stores ${rt.session.keys.join(", ")} (${evs(rt.session.evidence, 1)})` : "none"}\n- Limits: ${rt.limits.map((l) => `${l.name} ${l.value}`).join("; ") || "none found"}\n- Global error handler: ${rt.errorHandling.globalHandler ? "yes" : "not found"}\n- Reverse proxy: ${rt.reverseProxy ? `${rt.reverseProxy.file}: ${rt.reverseProxy.sites.join(", ")} → ${rt.reverseProxy.upstreams.join(", ")}` : "none in the repository"}\n- Frontend: ${rt.frontend ? `basename ${rt.frontend.basename ?? "none"}; dev server ${rt.frontend.devServer?.port ?? "n/a"} proxying ${rt.frontend.devServer?.proxy.join(", ") || "nothing"}; API client ${rt.frontend.apiClient ? `${rt.frontend.apiClient.file} (cookies; ${rt.frontend.apiClient.on401 ?? "no 401 handling"})` : "none found"}; third-party assets ${rt.frontend.thirdPartyAssets.map((a) => a.host).join(", ") || "none"}` : "none"}\n- Outgoing calls without timeout: ${rt.outboundCalls.filter((c) => !c.timeout).map((c) => ev(c.evidence)).join(", ") || "none"}\n- Images: ${rt.supplyChain.images.map((i) => `${i.image}${i.pinned ? "" : " (unpinned)"}`).join(", ") || "none"}; installs: ${rt.supplyChain.installs.map((i) => `${i.command}${i.locked ? "" : " (lockfile not enforced)"}`).join(", ") || "none"}; CI: ${rt.supplyChain.ci.map((c) => `${c.path} tests=${c.runsTests} typecheck=${c.runsTypecheck} lint=${c.runsLint} publishes=${c.publishes ?? "no"}`).join("; ") || "none"}\n- AI-agent instruction files (untrusted): ${rt.agentInstructionFiles.join(", ") || "none"}\n\n`;
  md += `## Background work\n\n${table(["Kind", "Name", "Schedule as written", "Resolved", "How resolved", "Timezone", "Runs", "Where"], d.background.map((b) => [b.kind, b.name, b.schedule ?? "", b.resolvedSchedule ?? "unresolved", b.scheduleNote ?? "", b.timezone ?? "", b.handler ?? "", ev(b.evidence)]))}\n`;
  md += `## Infrastructure\n\n${diagram(d, "deployment", "Deployment")}${table(["Service", "Compose file", "Image / build", "Published ports", "Internal ports", "Depends on"], d.deployment.containers.map((c) => [c.name, c.file, c.image ?? c.build ?? "", c.ports.join(", "), c.exposes.join(", "), c.dependsOn.join(", ")]))}\n`;
  md += `## Configuration (names only, values never read)\n\n${table(["Variable", "Required", "Default", "Sensitivity", "Side", "Documented", "Read via", "Used in"], d.config.envVars.map((e) => [e.name, e.required == null ? "unknown" : e.required ? "yes" : "no", e.hasDefault == null ? "" : e.hasDefault ? "yes" : "no", e.sensitivity, e.side, e.documented ? "yes" : "no", e.readVia.join(", "), evs(e.usedIn, 2)]))}\n`;
  md += `## Dependencies\n\n${table(["Package", "Ecosystem", "Declared", "Locked", "Dev", "Manifest"], d.dependencies.map((x) => [x.name, x.ecosystem, x.declared, x.resolved ?? "", x.dev ? "yes" : "", x.manifest]))}\n`;
  md += `## Quality\n\n${diagram(d, "test_map", "Test map")}- Test files: ${d.quality.testFiles} (${d.quality.testFrameworks.join(", ") || "no framework detected"})\n- Logging: ${d.quality.logging.join(", ") || "not detected"}\n- Error tracking: ${d.quality.errorTracking.join(", ") || "not detected"}\n- TODO/FIXME markers: ${d.quality.todoCount}\n\n${table(["Complexity hotspot", "Lines", "Branches"], d.quality.hotspots.slice(0, 10).map((h) => [h.path, h.loc, h.complexity]))}\n`;
  const rp = d.runPlan;
  md += `## How to run (declared, not run yet)\n\n${table(["Directory", "Package manager", "Install", "Build", "Test", "Start", "Dev"], rp.workspaces.map((w) => [w.dir, w.packageManager, w.install ?? "", w.build ?? "", w.test ?? "", w.start ?? "", w.dev ?? ""]))}\n- Ports: ${rp.ports.map((p) => `${p.port} (${p.note})`).join(", ") || "not declared"}\n- Required at startup: ${rp.requiredEnv.join(", ") || "none"}\n\n`;
  md += `## Coverage and limits\n\n${d.coverage.filesParsed} of ${d.coverage.filesTotal} files were parsed as source code. Every file is counted once below.\n\n${table(["Category", "Files", "Examples"], d.coverage.categories.map((c) => [c.label, c.count, c.examples.slice(0, 4).join(", ")]))}\nStatic analysis can miss code generated at runtime, loaded dynamically, or configured outside the repository. Checks confirm behaviour by running the project in a sandbox.\n`;
  return md;
}
