import { z } from "zod";
import type { AiInsights, ProjectDossier } from "@cybercheck/contracts";
import type { SnapshotSource } from "../source.ts";
import { moduleContexts, systemFacts } from "./context.ts";
import { AiSession, BudgetExceededError } from "./gateway.ts";
import { excerpt, verifyClaim, type CitedEvidence } from "./verify.ts";

// ---------------------------------------------------------------- Schemas (lenient where models vary)

const Cite = z.object({ path: z.string(), line: z.coerce.number(), symbol: z.string().default("") });
const cites = z.array(Cite).default([]);
const str = z.string().default("");
const strs = z.array(z.string()).default([]);
const sens = z.enum(["secret", "personal", "none"]).catch("none");
const TAB = z.enum(["testing", "security", "ai-evaluator", "adversarial"]).catch("security");

const ModuleSummary = z.object({
  responsibility: str,
  keyFlows: z.array(z.object({ name: str, description: str, evidence: cites })).default([]),
  dataHandled: z.array(z.object({ data: str, sensitivity: sens, evidence: cites })).default([]),
  externalCalls: z.array(z.object({ service: str, purpose: str, dataSent: strs, evidence: cites })).default([]),
  stateChanges: z.array(z.object({ entity: str, field: str, from: str, to: str, trigger: str, evidence: cites })).default([]),
  prompts: z.array(z.object({ name: str, purpose: str, inputs: strs, personalData: strs, evidence: cites })).default([]),
  concerns: z.array(z.object({ title: str, description: str, evidence: cites })).default([]),
});
type ModuleSummary = z.infer<typeof ModuleSummary>;

const SystemView = z.object({
  purpose: z.object({ summary: str, users: z.array(z.object({ name: str, description: str })).default([]), mainFeatures: strs }),
  components: z.array(z.object({ name: str, modules: strs, responsibility: str, dataHandled: strs, evidence: cites })).default([]),
  trustBoundaries: z.array(z.object({ name: str, description: str, evidence: cites })).default([]),
  dataFlows: z.array(z.object({ from: str, to: str, data: strs, sensitivity: sens, boundary: z.string().nullable().default(null), description: str, evidence: cites })).default([]),
  stateMachines: z.array(z.object({ entity: str, field: str, states: strs, transitions: z.array(z.object({ from: str, to: str, trigger: str })).default([]), evidence: cites })).default([]),
  sequences: z.array(z.object({ name: str, participants: strs, steps: z.array(z.object({ from: str, to: str, message: str })).default([]), evidence: cites })).default([]),
  risks: z
    .array(
      z.object({
        title: str,
        category: z.enum(["spoofing", "tampering", "repudiation", "information_disclosure", "denial_of_service", "elevation_of_privilege", "business_logic", "privacy", "ai_safety", "reliability"]).catch("business_logic"),
        description: str,
        affected: strs,
        likelihood: z.enum(["low", "medium", "high"]).catch("medium"),
        impact: z.enum(["low", "medium", "high"]).catch("medium"),
        testedBy: TAB,
        evidence: cites,
      }),
    )
    .default([]),
  aiSurface: z
    .object({
      providers: z.array(z.object({ name: str, role: str, evidence: cites })).default([]),
      prompts: z.array(z.object({ name: str, purpose: str, inputs: strs, personalData: strs, evidence: cites })).default([]),
      fallbacks: z.string().nullable().default(null),
      outputHandling: z.string().nullable().default(null),
    })
    .nullable()
    .default(null),
  designNotes: z.array(z.object({ title: str, note: str, evidence: cites })).default([]),
  questions: z.array(z.object({ question: str, why: str, blocks: z.array(TAB).default([]) })).default([]),
});
type SystemView = z.infer<typeof SystemView>;

const CriticVerdicts = z.object({ verdicts: z.array(z.object({ id: z.string(), verdict: z.enum(["supported", "partly_supported", "not_supported"]).catch("partly_supported"), note: str })).default([]) });

// ---------------------------------------------------------------- Prompts

const CITE_RULE = `Every claim must cite evidence as {"path": "...", "line": <number>, "symbol": "<exact text that appears on that line, such as a function name, route string or table name>"}. Only cite lines you can see in the provided files. If you are not sure, leave the claim out. Never invent files, routes, tables or services.`;

const MODULE_SYSTEM = `You are a senior software architect documenting one module of a codebase for security and testing engineers. Be precise and concise. Describe only what the code shows. ${CITE_RULE}`;

const moduleUser = (ctx: string) => `Describe this module.

<project_data>
${ctx}
</project_data>

Return JSON with exactly these keys:
{
  "responsibility": "one or two sentences: what this module is for",
  "keyFlows": [{"name": "...", "description": "what happens, step by step, in one or two sentences", "evidence": [cite]}],
  "dataHandled": [{"data": "e.g. customer phone numbers", "sensitivity": "secret|personal|none", "evidence": [cite]}],
  "externalCalls": [{"service": "...", "purpose": "...", "dataSent": ["..."], "evidence": [cite]}],
  "stateChanges": [{"entity": "table or object", "field": "status field", "from": "old value", "to": "new value", "trigger": "what causes it", "evidence": [cite]}],
  "prompts": [{"name": "...", "purpose": "...", "inputs": ["what goes into the prompt"], "personalData": ["personal data included"], "evidence": [cite]}],
  "concerns": [{"title": "...", "description": "a concrete weakness visible in this code", "evidence": [cite]}]
}
Use empty arrays when something does not apply. Keep each list to the 8 most important items and each text field under 40 words.`;

const SYSTEM_SYSTEM = `You are a principal architect and threat modeller. From verified facts and module summaries, you produce the shared understanding that Testing, Security, AI Evaluator and AI Adversarial agents will use to plan their work. Be specific to this project, never generic. ${CITE_RULE} Reuse the citations given in the module summaries when they support your claim.`;

const systemUser = (facts: unknown, modules: string) => `<project_data>
FACTS FROM STATIC ANALYSIS (verified):
${JSON.stringify(facts, null, 1)}

MODULE SUMMARIES (written by another model; citations already checked):
${modules}
</project_data>

Return JSON with exactly these keys:
{
  "purpose": {"summary": "what the product does and for whom, 2 to 4 sentences", "users": [{"name": "persona or actor", "description": "..."}], "mainFeatures": ["..."]},
  "components": [{"name": "...", "modules": ["module ids from the summaries"], "responsibility": "...", "dataHandled": ["..."], "evidence": [cite]}],
  "trustBoundaries": [{"name": "e.g. Internet to API", "description": "who is on each side and what crosses it", "evidence": [cite]}],
  "dataFlows": [{"from": "actor, component or service", "to": "...", "data": ["..."], "sensitivity": "secret|personal|none", "boundary": "trust boundary name or null", "description": "...", "evidence": [cite]}],
  "stateMachines": [{"entity": "table", "field": "status column", "states": ["..."], "transitions": [{"from": "...", "to": "...", "trigger": "..."}], "evidence": [cite]}],
  "sequences": [{"name": "key user or system flow", "participants": ["..."], "steps": [{"from": "...", "to": "...", "message": "..."}], "evidence": [cite]}],
  "risks": [{"title": "...", "category": "spoofing|tampering|repudiation|information_disclosure|denial_of_service|elevation_of_privilege|business_logic|privacy|ai_safety|reliability", "description": "attack or failure scenario specific to this code", "affected": ["endpoints, tables or components"], "likelihood": "low|medium|high", "impact": "low|medium|high", "testedBy": "testing|security|ai-evaluator|adversarial", "evidence": [cite]}],
  "aiSurface": {"providers": [{"name": "...", "role": "primary or fallback, and for what", "evidence": [cite]}], "prompts": [{"name": "...", "purpose": "...", "inputs": ["..."], "personalData": ["..."], "evidence": [cite]}], "fallbacks": "how provider failures are handled, or null", "outputHandling": "how model output is parsed and used, or null"} or null if the project has no AI,
  "designNotes": [{"title": "...", "note": "notable design decision, pattern or weak point", "evidence": [cite]}],
  "questions": [{"question": "a question only the owner can answer", "why": "what it changes", "blocks": ["testing|security|ai-evaluator|adversarial"]}]
}
Include every state field you find (status, state, stage). Give 3 to 6 sequences for the most important flows, 5 to 15 risks ordered by severity, and at most 6 questions. Do not repeat a risk already covered by FACTS findings unless you add new specifics.`;

const CRITIC_SYSTEM = `You are an independent security reviewer. For each risk, decide from the code excerpts and the project-wide FACTS whether the risk is real as described. Judge with the framework's documented behaviour (for example, whether a request continues after a hook has already sent a reply) and with global settings in FACTS (size limits, cookie settings, proxies). "supported": the code clearly shows it. "partly_supported": plausible but overstated or not fully shown. "not_supported": the code, the framework or a global setting contradicts it. Be strict and brief.`;

// ---------------------------------------------------------------- Orchestration

export type SynthesisOptions = { session: AiSession; models: AiInsights["models"]; onProgress?: (step: string) => void };

export const emptyInsights = (models: AiInsights["models"]): AiInsights => ({
  status: "running",
  error: null,
  models,
  usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 0 },
  purpose: null,
  components: [],
  trustBoundaries: [],
  dataFlows: [],
  stateMachines: [],
  sequences: [],
  risks: [],
  aiSurface: null,
  designNotes: [],
  questions: [],
  verification: { claims: 0, verified: 0, relocated: 0, unverified: 0, droppedByCritic: 0 },
});

export async function synthesize(d: ProjectDossier, src: SnapshotSource, opts: SynthesisOptions): Promise<AiInsights> {
  const out = emptyInsights(opts.models);
  const started = Date.now();
  const v = out.verification;
  const check = (cited: CitedEvidence[]) => {
    const r = verifyClaim(src, cited);
    v.claims++;
    v[r.verification]++;
    return r;
  };
  let n = 0;
  const id = (prefix: string) => `${prefix}-${++n}`;

  try {
    // 1. Module pass (fast model, one call per module).
    const contexts = moduleContexts(d, src);
    const summaries: Array<{ id: string; s: ModuleSummary }> = [];
    for (const [i, ctx] of contexts.entries()) {
      opts.onProgress?.(`Reading module ${i + 1} of ${contexts.length}: ${ctx.id}`);
      const s = await opts.session.json("fast", { purpose: `module ${ctx.id}`, system: MODULE_SYSTEM, user: moduleUser(ctx.text), schema: ModuleSummary, maxTokens: 12000 });
      // Keep only citations that hold, so the system pass builds on checked material.
      const keep = <T extends { evidence: CitedEvidence[] }>(xs: T[]) => xs.map((x) => ({ ...x, evidence: x.evidence.filter((e) => verifyClaim(src, [e]).evidence.length) })).filter((x) => x.evidence.length);
      summaries.push({ id: ctx.id, s: { ...s, keyFlows: keep(s.keyFlows), dataHandled: keep(s.dataHandled), externalCalls: keep(s.externalCalls), stateChanges: keep(s.stateChanges), prompts: keep(s.prompts), concerns: keep(s.concerns) } });
    }

    // 2. System pass (strong model).
    opts.onProgress?.("Putting the architecture together");
    const moduleText = summaries.map(({ id: mid, s }) => `## ${mid}\n${JSON.stringify(s)}`).join("\n\n");
    const sys: SystemView = await opts.session.json("strong", { purpose: "system synthesis", system: SYSTEM_SYSTEM, user: systemUser(systemFacts(d), moduleText), schema: SystemView, maxTokens: 16000 });

    // 3. Verify every claim against the snapshot.
    opts.onProgress?.("Checking every claim against the code");
    out.purpose = { summary: sys.purpose.summary, users: sys.purpose.users.filter((u) => u.name), mainFeatures: sys.purpose.mainFeatures.filter(Boolean) };
    out.components = sys.components.filter((c) => c.name).map((c) => ({ id: id("component"), name: c.name, modules: c.modules, responsibility: c.responsibility, dataHandled: c.dataHandled, ...pick(check(c.evidence)) }));
    out.trustBoundaries = sys.trustBoundaries.filter((b) => b.name).map((b) => ({ id: id("boundary"), name: b.name, description: b.description, ...pick(check(b.evidence)) }));
    out.dataFlows = sys.dataFlows.filter((f) => f.from && f.to).map((f) => ({ id: id("flow"), from: f.from, to: f.to, data: f.data, sensitivity: f.sensitivity, boundary: f.boundary, description: f.description, ...pick(check(f.evidence)) }));
    out.stateMachines = sys.stateMachines.filter((m) => m.states.length >= 2).map((m) => ({ id: id("state"), entity: m.entity, field: m.field, states: [...new Set(m.states)], transitions: m.transitions.filter((t) => t.from && t.to), ...pick(check(m.evidence)) }));
    out.sequences = sys.sequences.filter((s) => s.steps.length).map((s) => ({ id: id("sequence"), name: s.name, participants: s.participants, steps: s.steps, ...pick(check(s.evidence)) }));
    out.designNotes = sys.designNotes.filter((x) => x.title).map((x) => ({ id: id("note"), title: x.title, note: x.note, ...pick(check(x.evidence)) }));
    if (sys.aiSurface && (sys.aiSurface.providers.length || sys.aiSurface.prompts.length)) {
      out.aiSurface = {
        providers: sys.aiSurface.providers.map((p) => ({ name: p.name, role: p.role, evidence: check(p.evidence).evidence })),
        prompts: sys.aiSurface.prompts.map((p) => ({ name: p.name, purpose: p.purpose, inputs: p.inputs, personalData: p.personalData, evidence: check(p.evidence).evidence })),
        fallbacks: sys.aiSurface.fallbacks,
        outputHandling: sys.aiSurface.outputHandling,
      };
    }
    out.questions = sys.questions.filter((q) => q.question).slice(0, 6).map((q) => ({ id: id("ai-question"), question: q.question, why: q.why, blocks: q.blocks }));

    // Risks: unverifiable ones are dropped; the rest go to the critic.
    const risks = sys.risks
      .filter((r) => r.title)
      .map((r) => ({ r, c: check(r.evidence) }))
      .filter(({ c }) => c.verification !== "unverified")
      .map(({ r, c }) => ({ id: id("risk"), title: r.title, category: r.category, description: r.description, affected: r.affected, likelihood: r.likelihood, impact: r.impact, testedBy: r.testedBy, evidence: c.evidence, verification: c.verification, critic: { verdict: "not_checked" as "supported" | "partly_supported" | "not_checked", note: "" } }));

    // 4. Critic pass (different model family) on medium and high impact risks.
    const toCheck = risks.filter((r) => r.impact !== "low").slice(0, 12);
    if (toCheck.length) {
      opts.onProgress?.("Independent review of the risks");
      const body = toCheck.map((r) => `### ${r.id}: ${r.title}\n${r.description}\n${excerpt(src, r.evidence)}`).join("\n\n");
      try {
        const facts = systemFacts(d);
        const global = JSON.stringify({ stack: facts.stack, runtime: facts.runtime, auth: facts.auth }, null, 1);
        const verdicts = await opts.session.json("critic", { purpose: "risk critic", system: CRITIC_SYSTEM, user: `<project_data>\nFACTS (project-wide, verified):\n${global}\n\nRISKS TO JUDGE:\n${body}\n</project_data>\n\nReturn {"verdicts": [{"id": "risk id", "verdict": "supported|partly_supported|not_supported", "note": "one sentence"}]} with one entry per risk.`, schema: CriticVerdicts, maxTokens: 12000 });
        for (const vd of verdicts.verdicts) {
          const r = risks.find((x) => x.id === vd.id);
          if (r) r.critic = { verdict: vd.verdict === "not_supported" ? "not_checked" : vd.verdict, note: vd.note };
          if (r && vd.verdict === "not_supported") {
            risks.splice(risks.indexOf(r), 1);
            v.droppedByCritic++;
          }
        }
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        // A failed critic leaves risks marked "not_checked"; they stay visible as such.
      }
    }
    out.risks = risks.map((r) => ({ ...r, critic: r.critic }));
    out.status = "ready";
  } catch (err) {
    out.status = out.components.length || out.purpose ? "partial" : "failed";
    out.error = err instanceof BudgetExceededError ? `Stopped at the spending limit (${err.message}).` : `The AI step stopped: ${(err as Error).message}`.slice(0, 300);
  }
  const u = opts.session.usage;
  out.usage = { calls: u.length, inputTokens: u.reduce((s, x) => s + x.inputTokens, 0), outputTokens: u.reduce((s, x) => s + x.outputTokens, 0), costUsd: Number(opts.session.spentUsd.toFixed(6)), ms: Date.now() - started };
  return out;
}

function pick(r: ReturnType<typeof verifyClaim>) {
  return { evidence: r.evidence, verification: r.verification };
}
