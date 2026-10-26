import type { AttackSurface, AttackSurfaceEdge, Evidence, ProjectDossier } from "@cybercheck/contracts";
import type { SecurityFacts } from "./security-facts.ts";

// The general attack-surface graph for any web or API app (not only AI apps). It is built from the analysis dossier
// (routes, controls, data entities) plus the identities the run can stand up and the weaknesses the Security check
// already proved. Every edge cites snapshot-owned evidence. The graph tells the planner where boundaries and protected
// assets are; it never authorizes anything by itself.

type Node = { id: string; kind: string; label: string };
const AUTHED = new Set(["session_required", "role_required", "handler_check", "service_token", "jwt", "bearer_token", "custom_token"]);
const ADMIN = /admin|superuser|root|owner|staff|internal|manage/i;
const MONEY = /order|payment|invoice|charge|refund|balance|wallet|credit|price|coupon|cart|checkout|stock|inventory|transfer/i;

export function buildGeneralSurface(input: { dossier: ProjectDossier; identities: Array<{ name: string; role: string | null; tenant?: string | null }>; security: SecurityFacts | null }): AttackSurface {
  const { dossier: d, identities, security } = input;
  const nodes = new Map<string, Node>();
  const edges: AttackSurfaceEdge[] = [];
  const node = (id: string, kind: string, label: string) => (nodes.has(id) || nodes.set(id, { id, kind, label }), id);
  const edge = (from: string, to: string, kind: AttackSurfaceEdge["kind"], label: string, evidence: Evidence[]) => edges.push({ from, to, kind, label, evidence: evidence.slice(0, 4) });

  const attacker = node("attacker", "attacker", "Attacker");
  const routes = d.entryPoints.filter((e) => e.kind === "http" || e.kind === "webhook" || e.kind === "graphql").slice(0, 40);
  const anyAuth = routes.some((e) => AUTHED.has(e.control.kind));
  const auth = anyAuth ? node("auth", "auth", "Authentication") : null;

  // Identities behind the authentication boundary.
  if (auth) {
    for (const role of [...new Set(identities.map((i) => i.role).filter((r): r is string => Boolean(r)))].slice(0, 5)) edge(auth, node(`role:${role}`, "role", `Role: ${role}`), "role", "A seeded identity holds this role.", []);
    if (identities.some((i) => i.tenant)) edge(auth, node("tenant", "tenant", "Tenant boundary"), "tenant", "Records are separated by tenant.", []);
  }

  // Protected assets from the data model.
  const entities = ((d as { dataModel?: { entities?: Array<{ name?: string; evidence?: Evidence }> } }).dataModel?.entities ?? []).filter((e) => e.name);
  const moneyAsset = entities.some((e) => MONEY.test(e.name ?? "")) || routes.some((e) => MONEY.test(e.path)) ? node("asset:money-state", "asset", "Money, orders or inventory state") : null;
  const adminAsset = routes.some((e) => e.control.kind === "role_required" || ADMIN.test(e.path)) ? node("asset:admin-functions", "asset", "Administrator-only functions") : null;
  const dataAsset = entities.length ? node("asset:user-data", "asset", "Other users' and tenants' records") : null;

  for (const e of routes) {
    const ep = `${e.method} ${e.path}`;
    const entry = node(`entry:${ep}`, "entry", ep);
    edge(attacker, entry, "entry", AUTHED.has(e.control.kind) ? "A route an attacker can reach after signing in." : "An open route.", [e.handler]);
    if (AUTHED.has(e.control.kind) && auth) edge(entry, auth, "auth", e.control.reason || "The route requires a signed-in caller.", e.control.evidence.length ? e.control.evidence : [e.handler]);
    // Wire a route to the assets it can reach.
    if (e.path.includes(":") || /\{[^}]+\}|\[[^\]]+\]/.test(e.path)) { if (dataAsset) edge(entry, dataAsset, "asset", "A parameterised route can read or change a specific record (object authorization).", [e.handler]); }
    if (adminAsset && (e.control.kind === "role_required" || ADMIN.test(e.path))) edge(entry, adminAsset, "asset", "A privileged function (function authorization).", [e.handler]);
    if (moneyAsset && (e.mutates || MONEY.test(e.path))) edge(entry, moneyAsset, "asset", "A route that changes money, order or inventory state (business logic).", [e.handler]);
  }

  // Weaknesses the Security check already proved become reachable-weakness nodes the chains build from.
  for (const f of (security?.findings ?? []).slice(0, 30)) {
    const wn = node(`weakness:${f.id}`, "sink", `${f.status} ${f.category}`);
    edge(attacker, wn, "sink", `${f.title} (from the Security check: ${f.status}).`, f.location ? [f.location] : []);
    const asset = /authoriz|idor|bola|object/i.test(f.category) ? dataAsset : /inject|ssrf/i.test(f.category) ? (moneyAsset ?? dataAsset) : /role|function|privileg/i.test(f.category) ? adminAsset : null;
    if (asset) edge(wn, asset, "asset", "This proven weakness is a foothold toward the asset.", f.location ? [f.location] : []);
  }

  return { nodes: [...nodes.values()], edges };
}
