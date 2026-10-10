import type { ProjectDossier } from "@cybercheck/contracts";
import { redactSecrets, type SnapshotSource } from "../source.ts";

/** Source excerpt with line numbers, secrets redacted, so the model can cite real lines. */
export function numbered(text: string, start = 1, end?: number) {
  const lines = redactSecrets(text).text.split("\n");
  const last = Math.min(end ?? lines.length, lines.length);
  const width = String(last).length;
  return lines.slice(start - 1, last).map((l, i) => `${String(start + i).padStart(width)}| ${l}`).join("\n");
}

const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py)$/;

export type ModuleContext = { id: string; files: string[]; text: string; chars: number };

/**
 * One prompt context per module: its most central files first, with the facts already found in
 * them, within a character budget. Modules are the directory clusters from the deterministic step.
 */
export function moduleContexts(d: ProjectDossier, src: SnapshotSource, opts = { maxModules: 16, maxChars: 60_000, maxParts: 24 }): ModuleContext[] {
  const rank = new Map(d.keyFiles.map((k, i) => [k.path, i]));
  const mods = [...d.modules].filter((m) => m.loc > 0).sort((a, b) => b.loc - a.loc).slice(0, opts.maxModules);
  const out: ModuleContext[] = [];
  for (const m of mods) {
    const files = [...src.files.keys()]
      .filter((p) => CODE.test(p) && (p === m.path || p.startsWith(`${m.path}/`)) && !/\.(test|spec)\./.test(p))
      .sort((a, b) => (rank.get(a) ?? 9999) - (rank.get(b) ?? 9999) || (src.files.get(b)!.lines - src.files.get(a)!.lines));
    const inModule = (p: string) => files.includes(p);
    const facts = [
      ...d.entryPoints.filter((e) => inModule(e.handler.path)).map((e) => `endpoint ${e.method} ${e.path} (${e.control.kind}) at ${e.handler.path}:${e.handler.line}`),
      ...d.dataModel.entities.filter((e) => inModule(e.evidence.path)).map((e) => `table ${e.table ?? e.name} at ${e.evidence.path}:${e.evidence.line}`),
      ...d.integrations.filter((i) => i.usedIn.some((u) => inModule(u.path))).map((i) => `uses ${i.name}`),
      ...d.background.filter((j) => inModule(j.evidence.path)).map((j) => `scheduled job ${j.name} (${j.resolvedSchedule ?? j.schedule ?? "?"}) at ${j.evidence.path}:${j.evidence.line}`),
      ...d.config.envVars.filter((e) => e.usedIn.some((u) => inModule(u.path))).map((e) => `reads env ${e.name}`),
    ];
    // Large modules are split into parts so every file is read; a single huge file is cut at the budget.
    const header = (part: number) => `Module: ${m.path}${part ? ` (part ${part + 1})` : ""} (${m.files} files, ${m.loc} lines)\nKnown facts:\n${facts.map((f) => `- ${f}`).join("\n") || "- none"}\n\n`;
    let part = 0;
    let text = header(0);
    let used: string[] = [];
    const flush = () => {
      if (used.length) out.push({ id: part ? `${m.id} (part ${part + 1})` : m.id, files: used, text, chars: text.length });
      part++;
      text = header(part);
      used = [];
    };
    for (const p of files) {
      const f = src.files.get(p)!;
      let block = `<file path="${p}">\n${numbered(f.text)}\n</file>\n`;
      if (header(0).length + block.length > opts.maxChars) block = `<file path="${p}" truncated="true">\n${numbered(f.text, 1, Math.floor((opts.maxChars - header(0).length) / 60))}\n</file>\n`;
      if (text.length + block.length > opts.maxChars) flush();
      text += block;
      used.push(p);
    }
    flush();
    if (out.length >= opts.maxParts) break;
  }
  return out.slice(0, opts.maxParts);
}

/** Compact facts for the system pass (the deterministic dossier, minus bulk tables). */
export function systemFacts(d: ProjectDossier) {
  const routes = d.entryPoints.filter((e) => e.kind !== "page");
  return {
    stack: { languages: d.stack.languages.map((l) => l.name), frameworks: d.stack.frameworks, runtimes: d.runPlan.runtimes.map((r) => `${r.name} ${r.version ?? ""}`.trim()) },
    endpoints: routes.map((e) => `${e.method} ${e.path} [${e.control.kind}]${e.sideEffects.length ? ` does: ${e.sideEffects.join(", ")}` : ""}${e.inputs.body ? ` body: ${e.inputs.body}` : ""}${e.inputs.files ? " accepts files" : ""} ${e.handler.path}:${e.handler.line}`),
    runtime: {
      uploads: d.runtime.uploads.map((u) => `${u.endpoint ?? "upload"} via ${u.library}; limits ${JSON.stringify(u.limits)}; stored in ${u.storage ?? "?"}; content type from client: ${u.contentTypeFromClient}`),
      session: d.runtime.session ? `${d.runtime.session.library}, stored in ${d.runtime.session.storage}, cookie ${JSON.stringify(d.runtime.session.cookie)}, keys ${d.runtime.session.keys.join(", ")}` : null,
      limits: d.runtime.limits.map((l) => `${l.name} = ${l.value}`),
      outboundWithoutTimeout: d.runtime.outboundCalls.filter((c) => !c.timeout).map((c) => `${c.target} at ${c.evidence.path}:${c.evidence.line}`),
      globalErrorHandler: d.runtime.errorHandling.globalHandler,
      reverseProxy: d.runtime.reverseProxy,
      frontend: d.runtime.frontend,
      ci: d.runtime.supplyChain.ci,
      runNotes: d.runPlan.notes.map((n) => n.note),
    },
    screens: d.screens.map((s) => `${s.route} (${s.file}; inputs ${s.interactions.inputs}, data-changing calls ${s.interactions.mutations})`),
    tables: d.dataModel.entities.map((e) => `${e.table ?? e.name}(${e.fields.map((f) => `${f.name}${f.sensitivity && f.sensitivity !== "none" ? `[${f.sensitivity}]` : ""}`).join(", ")}) at ${e.evidence.path}:${e.evidence.line}${e.relations.length ? `; references ${e.relations.map((r) => r.to).join(", ")}` : ""}`),
    enums: d.dataModel.enums.map((e) => `${e.name}: ${e.values.join(" | ")} (${e.evidence.path}:${e.evidence.line})`),
    integrations: d.integrations.map((i) => `${i.name} [${i.category}, ${i.side}] used in ${i.usedIn.slice(0, 3).map((u) => `${u.path}:${u.line}`).join(", ")}`),
    ai: d.aiComponents.map((a) => `${a.sdk}: ${a.calls.length} calls at ${a.calls.slice(0, 8).map((c) => `${c.evidence.path}:${c.evidence.line}`).join(", ")}`),
    auth: { mechanisms: d.securityModel.authMechanisms.map((m) => m.detail), guards: d.securityModel.guards.map((g) => `${g.name} on ${g.endpoints} endpoints`), credentialChecks: d.securityModel.credentialChecks.map((c) => c.detail), notDetected: d.securityModel.notDetected.map((n) => n.control) },
    jobs: d.background.map((j) => `${j.name}: ${j.resolvedSchedule ?? j.schedule ?? "?"} ${j.timezone ?? ""} runs ${j.handler ?? "?"} (${j.evidence.path}:${j.evidence.line})`),
    deployment: { containers: d.deployment.containers.map((c) => `${c.name} in ${c.file}${c.image ? ` image ${c.image}` : ""}${c.ports.length ? ` published ${c.ports.join(",")}` : ""}`), ci: d.deployment.ci.map((c) => `${c.provider} ${c.path}`) },
    config: d.config.envVars.filter((e) => e.usedIn.length).map((e) => `${e.name}${e.required ? " (required)" : ""}${e.sensitivity === "secret" ? " (secret)" : ""}`),
    findings: d.observations.map((o) => `[${o.severity}] ${o.title}`),
    gaps: d.consistency.map((c) => c.message),
  };
}
