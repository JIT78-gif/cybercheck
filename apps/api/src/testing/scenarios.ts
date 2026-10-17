import { CompiledScenario, canDefineOracle, isSemantic, proofSuffices, scenarioProofLevel, symbolsIn, type AssertionProof, type FixtureBinding, type Obligation, type ProjectDossier, type TestRequirement } from "@cybercheck/contracts";
import { fixtureSymbols } from "./fixtures.ts";
import type { FixtureNode } from "./plan.ts";

// The typed scenario compiler (the 9+/10 plan, section 3). An AI or a template proposes a scenario; it runs only
// if it compiles: it cites a requirement that may define correct behaviour, calls endpoints the project really
// has, takes every value from a known producer, signs in only as identities that exist, and asserts enough to
// prove what its requirement needs. A status code alone never proves business behaviour.

/** Everything a scenario may draw values from. */
export type ProducerTable = {
  /** Fixture graph nodes and the names each one captures or exports. */
  nodes: Map<string, Set<string>>;
  /** Identities the fixture graph can sign in as. */
  identities: Set<string>;
  /** Setting names the analysis discovered, plus the ones cybercheck provides itself. */
  settings: Set<string>;
};

export type CompileContext = {
  requirements: TestRequirement[];
  /** "METHOD /path" with every parameter written as {}; see routeKey. */
  endpoints: Set<string>;
  producers: ProducerTable;
};

/** A route with its parameters normalized, so /orders/:id, /orders/{orderId} and /orders/<int:id> compare equal. */
export const routeKey = (method: string, path: string) =>
  `${method.toUpperCase()} ${(path.split("?")[0] ?? "")
    .replace(/\/+$/, "")
    .split("/")
    .map((s) => (/^(:|\{|<|\[)/.test(s) ? "{}" : s))
    .join("/") || "/"}`;

/** The producer table of a run: fixture captures and exports, identities, and discovered or provided settings. */
export function producerTable(graph: FixtureNode[], d: Pick<ProjectDossier, "config">, provided: string[] = []): ProducerTable {
  const nodes = new Map<string, Set<string>>(graph.map((n) => [n.id, new Set<string>()]));
  for (const s of fixtureSymbols(graph)) nodes.get(s.nodeId)!.add(s.name);
  return {
    nodes,
    identities: new Set(graph.filter((n) => n.kind === "identity").map((n) => n.id)),
    settings: new Set([...d.config.envVars.map((e) => e.name), ...provided]),
  };
}

/** The endpoints of a dossier as route keys. */
export const endpointKeys = (d: Pick<ProjectDossier, "entryPoints">) => new Set(d.entryPoints.filter((e) => e.kind === "http" || e.kind === "webhook").map((e) => routeKey(e.method, e.path)));

function producerProblem(b: FixtureBinding, t: ProducerTable): string | null {
  const p = b.producer;
  if (p.kind === "fixture") {
    const names = t.nodes.get(p.nodeId);
    if (!names) return `${b.symbol}: fixture "${p.nodeId}" does not exist in the setup graph`;
    const field = p.jsonPath.replace(/^\$\.?/, "").split(/[.[]/)[0];
    // A node's capture or export name, or a field of the record a request node created.
    if (field && names.size && !names.has(field) && !names.has(b.symbol.split(".").pop()!)) return `${b.symbol}: fixture "${p.nodeId}" produces ${[...names].join(", ")}, not "${field}"`;
    return null;
  }
  if (p.kind === "setting") return t.settings.has(p.name) ? null : `${b.symbol}: the setting ${p.name} was not found in the project or provided by cybercheck (invented settings are refused)`;
  if (p.kind === "generated_credential") return t.identities.has(p.identity) ? null : `${b.symbol}: there is no identity "${p.identity}" to generate a credential for`;
  return null;
}

export type CompileResult = { ok: true; scenario: CompiledScenario; proof: Record<string, ReturnType<typeof scenarioProofLevel>> } | { ok: false; problems: string[] };

/** Compile a proposed scenario, or say exactly why it cannot run. Nothing is repaired silently. */
export function compileScenario(proposal: unknown, ctx: CompileContext): CompileResult {
  const parsed = CompiledScenario.safeParse(proposal);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".") || "scenario"}: ${i.message}`) };
  const s = parsed.data;
  const problems: string[] = [];
  const reqs = new Map(ctx.requirements.map((r) => [r.id, r]));

  // 1. Requirements exist, and only a source that may define correct behaviour backs a semantic assertion.
  for (const id of s.requirementIds) if (!reqs.has(id)) problems.push(`requirement ${id} is not in the requirement inventory`);
  for (const a of s.assertions) {
    const r = reqs.get(a.requirementId);
    if (r && isSemantic(a) && !canDefineOracle(r)) problems.push(`assertion ${a.id}: requirement ${r.id} comes only from the implementation, which cannot define correct behaviour`);
  }
  // 2. Endpoints and methods the project really has.
  for (const r of s.requests) if (!ctx.endpoints.has(routeKey(r.method, r.path))) problems.push(`request ${r.id}: ${r.method} ${r.path} is not an endpoint of this project`);
  // 3 and 4. Every value from a known producer; identities that exist.
  for (const b of s.bindings) {
    const p = producerProblem(b, ctx.producers);
    if (p) problems.push(p);
  }
  for (const r of s.requests) if (r.as && !ctx.producers.identities.has(r.as)) problems.push(`request ${r.id}: there is no identity "${r.as}" in the setup graph`);
  // Credentials are never written into a scenario: a header or body that names a secret setting must bind it.
  for (const r of s.requests) {
    const literal = JSON.stringify([r.headers, r.body, r.query]);
    const named = literal.match(/\b[A-Z][A-Z0-9]*_(PASSWORD|TOKEN|SECRET|KEY)\b/g) ?? [];
    for (const n of named) if (!ctx.producers.settings.has(n)) problems.push(`request ${r.id}: ${n} is not a setting of this project (invented settings are refused)`);
  }
  // Templates: the values must be able to expose the bug the template is about.
  for (const id of s.requirementIds) {
    const r = reqs.get(id);
    if (r?.template) problems.push(...templateProblems(s, r.template).map((p) => `requirement ${id} (${r.template}): ${p}`));
  }
  // 7 and 8. Enough proof for what each requirement needs.
  const proof: Record<string, ReturnType<typeof scenarioProofLevel>> = {};
  for (const id of s.requirementIds) {
    const r = reqs.get(id);
    proof[id] = scenarioProofLevel(s, id);
    if (r && ["response", "state", "integrity"].includes(r.requiredProof) && !proofSuffices(proof[id]!, r.requiredProof)) {
      problems.push(
        proof[id] === "availability"
          ? `requirement ${id} needs ${r.requiredProof} proof, but the scenario only checks status codes`
          : `requirement ${id} needs ${r.requiredProof} proof: add a readback that reads the changed record (or a changed_by against an earlier read)`,
      );
    }
  }
  return problems.length ? { ok: false, problems } : { ok: true, scenario: s, proof };
}

const numbersUnder = (v: unknown, key: RegExp, out: number[] = [], k = ""): number[] => {
  if (Array.isArray(v)) v.forEach((x) => numbersUnder(x, key, out, k));
  else if (v && typeof v === "object") for (const [kk, x] of Object.entries(v)) numbersUnder(x, key, out, kk);
  else if (typeof v === "number" && key.test(k)) out.push(v);
  return out;
};
const DATE = /\b\d{4}-\d{1,2}-\d{1,2}\b/g;

/**
 * Whether a scenario's values can expose what its template is about. Quantity 1 cannot show a missing
 * multiplication; one page cannot show a skipped one; a single date cannot show a wrong comparison.
 */
export function templateProblems(s: CompiledScenario, template: NonNullable<TestRequirement["template"]>): string[] {
  const actions = s.requests.filter((r) => r.role === "action");
  const all = JSON.stringify(s.requests.map((r) => [r.body, r.query, r.pathParams]));
  switch (template) {
    case "calculation": {
      // With a quantity in play it must be one that exposes a missing multiplication; either way the computed number
      // itself (a total, a discount, a balance) must be asserted, not only that the request succeeded.
      const qty = numbersUnder(s.requests.map((r) => r.body), /^(qty|quantity|count|units)$/i);
      if (qty.length && !qty.some((n) => n >= 2 && n !== 10)) return ["use a quantity of 3 (not 1, and not 10, whose results look alike), so a missing multiplication shows in the result"];
      const computed = s.assertions.some((a) => a.target.from === "body" && (JSON.stringify(a.expected ?? null).includes("$expr") || (["equals", "changed_by"].includes(a.op) && typeof a.expected === "number")));
      return computed ? [] : ["assert the computed number itself (a total, a discount, a balance, a stock level) with its exact expected value, not only that the request succeeded"];
    }
    case "pagination": {
      const pages = s.requests.flatMap((r) => r.query.filter((q) => /page|offset|cursor|skip|start/i.test(q.name)).map((q) => JSON.stringify(q.value)));
      return new Set(pages).size >= 2 ? [] : ["read at least two consecutive pages (and compare them with each other or with the full list), so a skipped or repeated record shows"];
    }
    case "state_transition": {
      const refusal = s.assertions.some((a) => a.target.from === "status" && /\b4\d\d\b/.test(JSON.stringify(a.expected ?? null)));
      const readback = s.requests.some((r) => r.role === "readback");
      return refusal && readback ? [] : ["move the record forward, then try a forbidden move (backward or skipping a state): assert it is refused with a 4xx and read the record back to show its state did not change"];
    }
    case "date_boundary": {
      const dates = new Set([...all.matchAll(DATE)].map((m) => m[0]));
      const generated = /days_from_today/.test(all);
      return dates.size >= 2 || generated || (dates.size === 1 && /-\d-|-\d\b/.test([...dates][0]!)) ? [] : ["use dates on both sides of the boundary, written so a text comparison and a date comparison disagree (for example 2026-2-01 against 2026-10-15)"];
    }
    case "idempotency": {
      const keys = actions.map((r) => `${r.method} ${r.path} ${JSON.stringify(r.body)}`);
      return keys.length >= 2 && new Set(keys).size < keys.length ? [] : ["send the identical request twice (the same id or idempotency key), then assert the second is refused or does nothing and read back that only one exists"];
    }
    case "referential_integrity": {
      // The related records are read back after the delete, or the delete's own answer reports them (an orphan count).
      const deletes = s.requests.filter((r) => r.method === "DELETE").map((r) => r.id);
      const reportsOwn = s.assertions.some((a) => deletes.includes(a.requestId) && a.target.from === "body");
      return deletes.length && (s.requests.some((r) => r.role === "readback") || reportsOwn) ? [] : ["delete a parent that has children, then read the children (or the related list) back to show none is left pointing at the deleted parent, or assert the delete is refused"];
    }
    default:
      return [];
  }
}

/** What the harness reports for one scenario. */
export type ScenarioRun = {
  scenarioId: string;
  status: "passed" | "failed" | "inconclusive";
  reason: string;
  targetReached: boolean;
  proofs: Array<Omit<AssertionProof, "executionId" | "scenarioId">>;
};

/**
 * The proof gate: what a scenario run lets an obligation claim. Business proof only from semantic assertions that
 * ran on a reached target; a write counts as strong only when its stored state was read back.
 */
export function obligationFromScenario(s: CompiledScenario, run: ScenarioRun, requirementId: string, executionId: string): Pick<Obligation, "status" | "reason" | "reachedTarget" | "stateVerified" | "oracleStrength" | "proofLevel" | "proofs" | "requirementIds" | "scenarioId"> {
  const level = scenarioProofLevel(s, requirementId);
  const mine = run.proofs.filter((p) => p.requirementId === requirementId);
  const stateVerified = level === "state" && run.targetReached && mine.some((p) => p.stateVerified && p.passed);
  // In a failed scenario, a requirement whose own assertions all held passed; a crash (no failed assertion) fails all.
  const crashed = run.status === "failed" && !run.proofs.some((p) => !p.passed);
  const own = run.status === "failed" && !crashed && mine.length > 0 && mine.every((p) => p.passed);
  return {
    status: own ? "passed" : run.status,
    reason: own ? `All ${mine.length} of its assertion(s) held (another requirement checked by the same scenario did not).` : run.reason,
    reachedTarget: run.targetReached,
    stateVerified,
    proofLevel: level,
    oracleStrength: level === "availability" ? "weak" : level === "state" ? (stateVerified ? "strong" : "moderate") : "strong",
    proofs: mine.slice(0, 40).map((p) => ({ ...p, executionId, scenarioId: s.id })),
    requirementIds: [requirementId],
    scenarioId: s.id,
  };
}

/** Symbols a scenario needs from outside (fixtures, settings, credentials): what the harness must be given. */
export const externalSymbols = (s: CompiledScenario) => {
  const captured = new Set(s.requests.flatMap((r) => r.captures.map((c) => c.symbol)));
  return [...new Set([...symbolsIn(s.requests.map((r) => [r.pathParams, r.query, r.headers, r.body])), ...symbolsIn(s.assertions.map((a) => a.expected ?? null))])].filter((x) => !captured.has(x));
};
