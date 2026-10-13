import type { ProjectDossier } from "@cybercheck/contracts";
import type { SnapshotSource } from "../understanding/source.ts";
import { knownEndpoint, type AuthoredFixture } from "./agents.ts";
import { concretePath, paramNames, PARAM_RE, shape, type FixtureNode, type ProbeStep } from "./plan.ts";

/**
 * The fixture graph: everything checks need before they can reach the code under test (seed commands,
 * licence activation, sign-in, records with real ids), as nodes with dependencies. It is validated here,
 * before any sandbox cost: a cycle, an invented endpoint, a guessed setting or a value no earlier node
 * produces makes the node invalid, and checks that need it are reported as blocked instead of being sent.
 */

export type GraphProblem = { id: string; label: string; reason: string };

const PLACEHOLDER = /\{\{(\$?\w+)\}\}/g;
const ENVREF = /\$\{ENV:([A-Z0-9_]+)\}/g;

/** Values a node makes available to later nodes. */
export function produces(n: FixtureNode): string[] {
  const out = new Set<string>(n.exports ?? []);
  for (const s of n.steps ?? []) if (s.capture) out.add(s.capture.name);
  return [...out];
}

function requestsOf(n: FixtureNode): Array<{ method: string; path: string }> {
  const out: Array<{ method: string; path: string }> = [];
  for (const s of n.steps ?? []) out.push(s);
  if (n.auth?.request) out.push(n.auth.request);
  if (n.verify) out.push({ method: n.verify.method, path: n.verify.path });
  return out;
}

/** Topological order (Kahn). Nodes in a cycle are returned separately. */
export function topoSort(nodes: FixtureNode[]): { order: FixtureNode[]; cyclic: FixtureNode[] } {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const indeg = new Map(nodes.map((n) => [n.id, n.dependsOn.filter((d) => byId.has(d)).length]));
  const queue = nodes.filter((n) => indeg.get(n.id) === 0);
  const order: FixtureNode[] = [];
  while (queue.length) {
    const n = queue.shift()!;
    order.push(n);
    for (const m of nodes) {
      if (!m.dependsOn.includes(n.id)) continue;
      indeg.set(m.id, indeg.get(m.id)! - 1);
      if (indeg.get(m.id) === 0) queue.push(m);
    }
  }
  return { order, cyclic: nodes.filter((n) => !order.includes(n)) };
}

/**
 * Keeps the nodes that can work, in dependency order. Every placeholder must be produced by a node it
 * depends on (directly or not), every setting must exist in the code, and every request must hit a real endpoint.
 */
/**
 * A credential header filled with a value nothing produces ("Authorization: Bearer {{admin_token}}",
 * "X-Session-Token: {{session_token}}") means "sign in as that identity": the header is dropped and the step runs
 * as the identity named by the placeholder (admin_token -> admin) or the one that sends that header itself.
 * Returns the identity the steps now run as, if any.
 */
export function bindCredentialPlaceholders(steps: ProbeStep[], nodes: FixtureNode[], produced: Set<string>): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const ids = nodes.filter((n) => n.kind === "identity");
  let bound: string | null = null;
  for (const st of steps) {
    for (const [h, v] of Object.entries(st.headers ?? {})) {
      const name = String(v).match(/\{\{(\w+)\}\}/)?.[1];
      if (!name || produced.has(name) || !/token|jwt|session|auth|key|sid/i.test(`${h} ${name}`)) continue;
      const byName = ids.find((i) => norm(name).startsWith(norm(i.id)) && norm(name).length > norm(i.id).length);
      const byHeader = ids.find((i) => i.auth?.kind === "header" && i.auth.header?.toLowerCase() === h.toLowerCase());
      const bearers = ids.filter((i) => i.auth?.kind === "login" || i.auth?.kind === "bearer");
      const pick = /^authorization$/i.test(h) ? (byName ?? (bearers.length === 1 ? bearers[0] : undefined)) : (byHeader ?? byName);
      if (!pick) continue;
      delete st.headers![h];
      if (!Object.keys(st.headers!).length) delete st.headers;
      st.as = pick.id;
      bound = bound ?? pick.id;
    }
  }
  return bound;
}

/**
 * {{menuItemId}} where the setup captured "item_id", {{orderId}} where it captured "order_id": a placeholder
 * nothing produces is renamed to the one produced value with the same name in another style, or the unique one
 * whose name ends the same way. Returns the steps with placeholders renamed.
 */
export function aliasPlaceholders<T>(steps: T, produced: Set<string>): T {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const known = [...produced].filter((x) => x !== "$uid");
  const text = JSON.stringify(steps).replace(/\{\{(\w+)\}\}/g, (m, name: string) => {
    if (produced.has(name) || name === "$uid") return m;
    const same = known.filter((k) => norm(k) === norm(name));
    const ends = known.filter((k) => norm(k).length >= 4 && norm(name).length >= 4 && (norm(name).endsWith(norm(k)) || norm(k).endsWith(norm(name))));
    const pick = same.length === 1 ? same[0] : ends.length === 1 ? ends[0] : null;
    return pick ? `{{${pick}}}` : m;
  });
  return JSON.parse(text) as T;
}

export function validateGraph(nodes: FixtureNode[], d: ProjectDossier, src: SnapshotSource): { nodes: FixtureNode[]; problems: GraphProblem[] } {
  const problems: GraphProblem[] = [];
  const seen = new Set<string>();
  const unique = nodes.filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)));
  const producedAll = new Set(unique.flatMap(produces));
  for (const n of unique) {
    // A token header nothing produces runs the node as the matching sign-in instead.
    if (n.kind === "request" && n.steps?.length) {
      n.steps = aliasPlaceholders(n.steps, new Set([...producedAll].filter((v) => !produces(n).includes(v))));
      const who = bindCredentialPlaceholders(n.steps, unique, producedAll);
      if (who && !n.identity) n.identity = who;
      for (const st of n.steps) delete st.as;
    }
    // Setup only needs success: an exact 2xx code from the planner (200 where the app answers 201) is relaxed to any 2xx.
    for (const st of n.steps ?? []) {
      if (st.expect.status?.length && st.expect.status.every((c) => c >= 200 && c < 300)) st.expect = { ...st.expect, status: undefined, statusClass: ["2xx"] };
    }
    // A data step to a protected endpoint, sent without credentials, runs as the identity that covers that protection.
    if (n.kind === "request" && !n.identity && !(n.steps ?? []).some((st) => Object.keys(st.headers ?? {}).some((h) => /authorization|token|session|api-key/i.test(h)))) {
      const first = n.steps?.[0];
      const ep = first ? d.entryPoints.find((e) => e.method === first.method.toUpperCase() && knownEndpoint({ ...d, entryPoints: [e] }, first.method, first.path)) : undefined;
      const kind = ep?.control?.kind;
      if (kind && ["session_required", "role_required", "service_token", "handler_check"].includes(kind)) {
        const ids = unique.filter((m) => m.kind === "identity");
        const pick = ids.find((m) => m.appliesTo?.includes(kind)) ?? (kind === "role_required" ? ids.find((m) => m.appliesTo?.includes("session_required")) : undefined) ?? (ids.length === 1 ? ids[0] : undefined);
        if (pick) n.identity = pick.id;
      }
    }
    // A data step that needs a role runs as an identity that has it: creating a product as a plain
    // user gets a 403 and leaves every check that needs the product without data.
    if (n.kind === "request" && n.identity) {
      const ids = unique.filter((m) => m.kind === "identity");
      const current = ids.find((m) => m.id === n.identity);
      const needsRole = (n.steps ?? []).some((st) => d.entryPoints.some((e) => e.control?.kind === "role_required" && e.method === st.method.toUpperCase() && knownEndpoint({ ...d, entryPoints: [e] }, st.method, st.path)));
      const better = ids.find((m) => m.appliesTo?.includes("role_required"));
      if (needsRole && current && !current.appliesTo?.includes("role_required") && better) {
        n.dependsOn = n.dependsOn.filter((x) => x !== n.identity);
        n.identity = better.id;
      }
    }
    // A step that runs as an identity depends on that sign-in.
    if (n.identity && !n.dependsOn.includes(n.identity) && unique.some((m) => m.id === n.identity)) n.dependsOn = [...n.dependsOn, n.identity];
    // A guessed literal id ("table_id": 1) where another step captures that very id (tableId) uses the captured
    // value instead: the database starts empty, so a guessed id rarely exists.
    if (n.kind === "request") {
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
      for (const st of n.steps ?? []) {
        const body = st.json;
        if (!body || typeof body !== "object" || Array.isArray(body)) continue;
        for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
          if (!/(_id|Id)$/.test(k) || !(typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v)))) continue;
          const names = [...new Set(unique.filter((m) => m !== n).flatMap(produces))].filter((x) => norm(x) === norm(k));
          if (names.length === 1) (body as Record<string, unknown>)[k] = `{{${names[0]}}}`;
        }
      }
    }
    // A value used here and produced by exactly one other node means this node depends on it, even if the planner forgot to say so.
    const used = [...JSON.stringify({ steps: n.steps, auth: n.auth, verify: n.verify, command: n.command }).matchAll(PLACEHOLDER)].map((m) => m[1]!).filter((v) => v !== "$uid" && !produces(n).includes(v));
    for (const v of used) {
      const makers = unique.filter((m) => m !== n && produces(m).includes(v));
      if (makers.length === 1 && !n.dependsOn.includes(makers[0]!.id)) n.dependsOn = [...n.dependsOn, makers[0]!.id];
    }
  }
  const { order, cyclic } = topoSort(unique);
  for (const n of cyclic) problems.push({ id: n.id, label: n.label, reason: "it depends on itself through other setup steps (a cycle)" });
  const corpus = [...src.files.values()].map((f) => f.text).join("\n");
  const knownEnv = new Set(d.config.envVars.map((e) => e.name));
  const valid = new Map<string, FixtureNode>();
  const available = new Map<string, Set<string>>();
  for (const n of order) {
    // A data step that depends on a sign-in is meant to run as that identity.
    if (n.kind === "request" && !n.identity) {
      const id = n.dependsOn.find((x) => unique.find((u) => u.id === x)?.kind === "identity");
      if (id) n.identity = id;
    }
    const missingDep = n.dependsOn.find((x) => !valid.has(x));
    if (missingDep) {
      problems.push({ id: n.id, label: n.label, reason: unique.some((x) => x.id === missingDep) ? `it needs "${missingDep}", which is invalid` : `it needs "${missingDep}", which does not exist` });
      continue;
    }
    const inherited = new Set<string>();
    const walk = (id: string) => {
      for (const v of available.get(id) ?? []) inherited.add(v);
    };
    n.dependsOn.forEach(walk);
    const text = JSON.stringify({ steps: n.steps, auth: n.auth, verify: n.verify, command: n.command });
    // Values captured inside this node's own earlier steps also count.
    const own = new Set(produces(n));
    const missingVar = [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!).find((v) => v !== "$uid" && !inherited.has(v) && !own.has(v));
    if (missingVar) {
      problems.push({ id: n.id, label: n.label, reason: `it uses {{${missingVar}}}, which no earlier setup step produces` });
      continue;
    }
    // CC_ names are values cybercheck invents for accounts the setup creates; any other name must be a setting the code reads.
    const guessed = [...text.matchAll(ENVREF)].map((m) => m[1]!).find((v) => !v.startsWith("CC_") && !knownEnv.has(v) && !corpus.includes(v));
    if (guessed) {
      problems.push({ id: n.id, label: n.label, reason: `it uses the setting ${guessed}, which appears nowhere in the code` });
      continue;
    }
    const invented = requestsOf(n).find((r) => !r.path.startsWith("/") || !knownEndpoint(d, r.method, r.path));
    if (invented) {
      problems.push({ id: n.id, label: n.label, reason: `${invented.method} ${invented.path} is not an endpoint of this project` });
      continue;
    }
    if (n.kind === "command" && (!n.command || /https?:\/\/(?!127\.0\.0\.1|localhost|\$\{?BASE_URL|\$\{?API_URL)/.test(n.command))) {
      problems.push({ id: n.id, label: n.label, reason: n.command ? "the command reaches outside the sandbox" : "no command given" });
      continue;
    }
    valid.set(n.id, n);
    available.set(n.id, new Set([...inherited, ...produces(n)]));
  }
  return { nodes: order.filter((n) => valid.has(n.id)), problems };
}

/** A protected GET (no path parameters) that proves a sign-in really works. */
export function verifyTarget(d: ProjectDossier, appliesTo: string[]): { method: string; path: string } | null {
  const kinds = appliesTo.length ? appliesTo : ["session_required", "role_required", "service_token", "handler_check"];
  const cands = d.entryPoints
    .filter((e) => e.kind === "http" && e.method === "GET" && kinds.includes(e.control.kind) && !paramNames(e.path).length && !/logout|signout|export|download|stream|events|sse|ws/i.test(e.path))
    .sort((a, b) => a.path.length - b.path.length);
  return cands[0] ? { method: "GET", path: cands[0].path } : null;
}

/** Record fixtures from the probe author become request nodes with unique capture names. */
export function recordNodes(fixtures: AuthoredFixture[], identities: Set<string>, toSteps: (f: AuthoredFixture, idx: number) => ProbeStep[]): FixtureNode[] {
  return fixtures.map((f, i) => {
    const idx = i + 1;
    const raw = toSteps(f, idx);
    const rename = new Map<string, string>();
    for (const st of raw) if (st.capture) rename.set(st.capture.name, `fx${idx}_${st.capture.name}`);
    const sub = (t: string) => t.replace(/\{\{(\w+)\}\}/g, (m, n: string) => (rename.has(n) ? `{{${rename.get(n)}}}` : m));
    const steps: ProbeStep[] = raw.map((st) => ({
      ...st,
      path: sub(st.path),
      json: st.json === undefined ? undefined : JSON.parse(sub(JSON.stringify(st.json))),
      expect: st.expect.status?.length || st.expect.statusClass?.length ? st.expect : { statusClass: ["2xx"], not5xx: true },
      capture: st.capture ? { ...st.capture, name: rename.get(st.capture.name)! } : undefined,
    }));
    const params = paramNames(f.resource);
    const captureFor = Object.fromEntries(params.filter((n) => rename.has(n)).map((n) => [n, rename.get(n)!]));
    // One parameter and one capture with a different name (e.g. :id captured as noteId): they belong together.
    if (params.length === 1 && !captureFor[params[0]!] && rename.size === 1) captureFor[params[0]!] = [...rename.values()][0]!;
    const identity = f.identity && identities.has(f.identity) ? f.identity : null;
    return { id: `record-${idx}`, label: `Create one ${f.resource}`, kind: "request", dependsOn: identity ? [identity] : [], identity, steps, resource: f.resource, captureFor, origin: "author" } satisfies FixtureNode;
  });
}

/** For an endpoint under a resource that has a record node: the concrete path (ids filled from captures) and the node it needs. */
export function withRecord(path: string, nodes: FixtureNode[]): { path: string; needs: string[] } | null {
  const target = shape(path);
  const fx = nodes
    .filter((n) => n.resource && shape(n.resource).includes("{}") && (target === shape(n.resource) || target.startsWith(`${shape(n.resource)}/`)))
    .sort((a, b) => shape(b.resource!).length - shape(a.resource!).length)[0];
  if (!fx) return null;
  const names = paramNames(fx.resource!);
  let i = 0;
  const filled = path.replace(PARAM_RE, (m) => {
    const name = names[i++];
    return name && fx.captureFor?.[name] ? `{{${fx.captureFor[name]}}}` : m;
  });
  return { path: concretePath(filled.replace(/\{\{(\w+)\}\}/g, "@@$1@@")).replace(/@@(\w+)@@/g, "{{$1}}"), needs: [fx.id] };
}

/** Every node a list of nodes needs, transitively (for targeted reruns). */
export function closure(ids: string[], nodes: FixtureNode[]): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  const visit = (id: string) => {
    if (out.has(id) || !byId.has(id)) return;
    out.add(id);
    byId.get(id)!.dependsOn.forEach(visit);
  };
  ids.forEach(visit);
  return [...out];
}
