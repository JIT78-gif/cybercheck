import { createHash } from "node:crypto";
import type { ControlKind, DiagramKey } from "@cybercheck/contracts";
import type { Facts } from "./analyze.ts";

/** Mermaid-safe label text, always used inside double quotes (quotes, brackets and backticks break the parser). */
function label(s: string, max = 60) {
  const t = s.length > max ? `${s.slice(0, max - 1)}…` : s;
  return t
    .replace(/"/g, "#quot;")
    .replace(/[<>]/g, (c) => (c === "<" ? "#lt;" : "#gt;"))
    .replace(/[{}[\]|`]/g, " ");
}
/** A member type for classDiagram members: unions read "a or b", generics use ~, other symbols dropped. */
function memberType(s: string) {
  const t = s
    .replace(/["'`]/g, "")
    .replace(/\s*\|\s*/g, " or ")
    .replace(/\[\]/g, " list")
    .replace(/[<>]/g, "~")
    .replace(/[^\w~,.? ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (t.length > 34 ? t.slice(0, 34).trim() : t) || "unknown";
}
/** Identifiers for erDiagram/classDiagram: letters, digits, underscore. */
function ident(s: string) {
  const t = s.replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "_$1");
  return t || "_";
}
/** Stable, unique node id from an element's full identity (file + name), never from its display name. */
function nid(prefix: string, identity: string) {
  return `${prefix}_${createHash("sha1").update(identity).digest("hex").slice(0, 10)}`;
}

function dependencies(f: Facts): string | null {
  const mods = [...f.modules].sort((a, b) => b.loc - a.loc).slice(0, 24);
  if (mods.length < 2) return null;
  const keep = new Set(mods.map((m) => m.id));
  const lines = ["flowchart LR"];
  for (const m of mods) lines.push(`  ${nid("m", m.id)}["${label(m.id)}<br/><small>${m.files} files · ${m.loc.toLocaleString("en-US")} lines</small>"]`);
  for (const e of f.graph.moduleEdges.filter((x) => keep.has(x.from) && keep.has(x.to)).sort((a, b) => b.weight - a.weight).slice(0, 60)) {
    lines.push(`  ${nid("m", e.from)} -->|${e.weight}| ${nid("m", e.to)}`);
  }
  const central = f.keyFiles[0] ? f.modules.find((m) => m.keyFiles.includes(f.keyFiles[0]!.path)) : undefined;
  if (central && keep.has(central.id)) lines.push(`  style ${nid("m", central.id)} stroke-width:3px`);
  return lines.join("\n");
}

function dataModel(f: Facts): string | null {
  const ents = f.dataModel.entities.slice(0, 40);
  if (!ents.length) return null;
  const names = new Map<string, (typeof ents)[number]>();
  for (const e of ents) {
    names.set(e.name.toLowerCase(), e);
    if (e.table) names.set(e.table.toLowerCase(), e);
  }
  const lines = ["erDiagram"];
  for (const e of ents) {
    lines.push(`  ${nid("e", e.id)}["${label(e.table ?? e.name, 40)}"] {`);
    // Keys, relations and sensitive columns first; the full column list is in the table view.
    const important = (x: (typeof e.fields)[number]) => Number(Boolean(x.primaryKey || x.references || e.relations.some((r) => r.field === x.name))) * 2 + Number(Boolean(x.sensitivity && x.sensitivity !== "none"));
    const shown = [...e.fields].sort((a, b) => important(b) - important(a)).slice(0, 14);
    for (const fld of e.fields.filter((x) => shown.includes(x))) {
      const keys = [fld.primaryKey ? "PK" : null, fld.references ? "FK" : null, fld.unique && !fld.primaryKey ? "UK" : null].filter(Boolean).join(",");
      const note = fld.sensitivity === "secret" ? ` "secret"` : fld.sensitivity === "personal" ? ` "personal data"` : "";
      lines.push(`    ${ident(fld.type.replace(/\(.*\)/, "")) || "unknown"} ${ident(fld.name)}${keys ? ` ${keys}` : ""}${note}`);
    }
    lines.push("  }");
  }
  const seen = new Set<string>();
  for (const e of ents) {
    for (const r of e.relations) {
      const target = names.get(r.to.toLowerCase()) ?? names.get(r.to.replace(/s$/, "").toLowerCase());
      if (!target) continue;
      const key = [e.id, target.id, r.field].join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      // "one" means each row of e points to one row of target. If the pointing column is unique,
      // each target row has at most one e (one-to-zero-or-one); otherwise many.
      const fk = e.fields.find((x) => x.name === r.field);
      const many = r.kind === "one" ? (fk?.unique || fk?.primaryKey ? "|o" : "o{") : "o{";
      lines.push(r.kind === "one" ? `  ${nid("e", target.id)} ||--${many} ${nid("e", e.id)} : "${label(r.field ?? "", 30)}"` : `  ${nid("e", e.id)} ||--o{ ${nid("e", target.id)} : "${label(r.field ?? "", 30)}"`);
    }
  }
  return lines.join("\n");
}

function domainTypes(f: Facts): string | null {
  // Only types that matter to the checks: request schemas and types that mirror stored data.
  // Frontend copies of a backend type with the same name are dropped.
  const singular = (s: string) => s.toLowerCase().replace(/[_-]/g, "").replace(/(ies)$/, "y").replace(/s$/, "");
  const entityNames = new Set(f.dataModel.entities.flatMap((e) => [singular(e.name), singular(e.table ?? "")]));
  const schemaNames = new Set(f.entryPoints.flatMap((e) => [e.requestSchema, e.inputs.body, e.inputs.query, e.inputs.params]).filter((x): x is string => Boolean(x)));
  const relevant = (t: (typeof f.domainTypes)[number]) => schemaNames.has(t.name) || entityNames.has(singular(t.name)) || [...entityNames].some((n) => n && singular(t.name).startsWith(n) && /row|record|detail$/i.test(t.name));
  const seenName = new Set<string>();
  const types = [...f.domainTypes]
    .filter(relevant)
    .sort((a, b) => Number(schemaNames.has(b.name)) - Number(schemaNames.has(a.name)) || b.fields.length - a.fields.length)
    .filter((t) => {
      if (seenName.has(t.name)) return false;
      seenName.add(t.name);
      return true;
    })
    .slice(0, 16);
  if (!types.length) return null;
  const byName = new Map(types.map((t) => [t.name, t]));
  const lines = ["classDiagram"];
  for (const t of types) {
    lines.push(`  class ${nid("t", t.id)}["${label(t.name, 40)}"] {`);
    lines.push(`    <<${t.kind}>>`);
    for (const fld of t.fields.slice(0, 10)) lines.push(`    +${memberType(fld.type)} ${ident(fld.name)}`);
    if (t.fields.length > 10) lines.push(`    +${t.fields.length - 10} more fields`);
    lines.push("  }");
  }
  for (const t of types) {
    for (const base of t.extends) {
      const b = byName.get(base);
      if (b) lines.push(`  ${nid("t", b.id)} <|-- ${nid("t", t.id)}`);
    }
  }
  return lines.join("\n");
}

function groupOf(path: string) {
  const seg = path.split("/").filter(Boolean);
  if (!seg.length) return "/";
  return `/${seg[0] === "api" || seg[0] === "v1" || seg[0] === "v2" ? seg.slice(0, 2).join("/") : seg[0]}`;
}

type Tone = "protected" | "public" | "open" | "unknown";
const TONE: Record<ControlKind, Tone> = {
  session_required: "protected",
  role_required: "protected",
  service_token: "protected",
  webhook_signature: "protected",
  callback_state: "protected",
  handler_check: "protected",
  public_intentional: "public",
  none_found: "open",
  unknown: "unknown",
};
const CLASS_DEFS = [
  "  classDef protected fill:#dcfce7,stroke:#15803d,color:#14532d",
  "  classDef public fill:#e0f2fe,stroke:#0369a1,color:#0c4a6e",
  "  classDef open fill:#fee2e2,stroke:#b91c1c,color:#7f1d1d",
  "  classDef unknown fill:#fef3c7,stroke:#b45309,color:#78350f",
  "  classDef mixed fill:#fef3c7,stroke:#b45309,color:#78350f",
];

function apiMap(f: Facts): string | null {
  const routes = f.entryPoints.filter((e) => e.kind !== "page").slice(0, 80);
  if (!routes.length) return null;
  const groups = new Map<string, typeof routes>();
  for (const r of routes) {
    const g = r.kind === "graphql" ? "GraphQL" : r.method === "ACTION" ? "Server actions" : groupOf(r.path);
    groups.set(g, [...(groups.get(g) ?? []), r]);
  }
  const lines = ["flowchart LR", "  client([Client])"];
  for (const [g, rs] of groups) {
    lines.push(`  subgraph ${nid("g", g)}["${label(g)}"]`);
    for (const r of rs) lines.push(`    ${nid("r", r.id + r.handler.path + r.handler.line)}["${label(`${r.method} ${r.path}`, 50)}"]:::${TONE[r.control.kind]}`);
    lines.push("  end");
    lines.push(`  client --> ${nid("g", g)}`);
  }
  lines.push(...CLASS_DEFS);
  return lines.join("\n");
}

function authMap(f: Facts): string | null {
  const routes = f.entryPoints.filter((e) => e.kind !== "page");
  if (!routes.length) return null;
  const groups = new Map<string, Record<Tone, number> & { via: Set<string> }>();
  for (const r of routes) {
    const g = r.kind === "graphql" ? "GraphQL" : groupOf(r.path);
    const e = groups.get(g) ?? { protected: 0, public: 0, open: 0, unknown: 0, via: new Set<string>() };
    e[TONE[r.control.kind]]++;
    if (TONE[r.control.kind] === "protected") e.via.add(r.control.via[0] ?? r.control.kind.replace(/_/g, " "));
    groups.set(g, e);
  }
  const lines = ["flowchart TB", "  user([Visitor or client])", `  check{"Protection"}`];
  for (const [g, e] of [...groups.entries()].slice(0, 30)) {
    const node = nid("g", g);
    const parts = [e.protected ? `${e.protected} protected` : null, e.public ? `${e.public} public by design` : null, e.open ? `${e.open} no protection found` : null, e.unknown ? `${e.unknown} undetermined` : null].filter(Boolean).join(" · ");
    const tone = e.open && (e.protected || e.public) ? "mixed" : e.open ? "open" : e.unknown ? "unknown" : e.protected ? "protected" : "public";
    lines.push(`  ${node}["${label(g)}<br/><small>${parts}</small>"]:::${tone}`);
    if (e.protected) lines.push(`  user --> check -->|"${label([...e.via].join(", "), 40)}"| ${node}`);
    if (e.public) lines.push(`  user -->|"public by design"| ${node}`);
    if (e.open) lines.push(`  user -.->|"no protection found"| ${node}`);
  }
  lines.push(...CLASS_DEFS);
  return lines.join("\n");
}

function deployment(f: Facts): string | null {
  const d = f.deployment;
  if (!d.containers.length && !d.dockerfiles.length && !d.ci.length && !d.platforms.length) return null;
  const lines = ["flowchart LR"];
  if (d.ci.length) {
    lines.push(`  subgraph ${nid("s", "ci")}["CI / CD"]`);
    for (const c of d.ci.slice(0, 6)) lines.push(`    ${nid("ci", c.path)}["${label(`${c.provider}: ${c.path.split("/").at(-1)}`)}<br/><small>${c.jobs.map((j) => label(j.name, 20)).slice(0, 4).join(", ")}</small>"]`);
    lines.push("  end");
  }
  for (const p of d.platforms) lines.push(`  ${nid("pf", p.name)}[("${label(p.name)}")]`);
  // One subgraph per compose file: the same service name in two files is two deployments.
  const files = [...new Set(d.containers.map((c) => c.file))];
  for (const file of files) {
    lines.push(`  subgraph ${nid("s", file)}["${label(file)}"]`);
    for (const c of d.containers.filter((x) => x.file === file)) {
      const isData = /postgres|mysql|mongo|redis|mariadb|elastic|rabbit|kafka|minio|clickhouse/i.test(`${c.name} ${c.image ?? ""}`);
      const ports = c.ports.length ? ` · published ${c.ports.slice(0, 2).join(", ")}` : c.exposes.length ? ` · internal ${c.exposes.slice(0, 2).join(", ")}` : "";
      const body = `${label(c.name)}<br/><small>${label(c.image ?? (c.build ? `build ${c.build}` : ""), 30)}${label(ports, 40)}</small>`;
      lines.push(isData ? `    ${nid("c", c.id)}[("${body}")]` : `    ${nid("c", c.id)}["${body}"]`);
    }
    lines.push("  end");
    for (const c of d.containers.filter((x) => x.file === file)) {
      for (const dep of c.dependsOn) {
        const target = d.containers.find((x) => x.file === file && x.name === dep);
        if (target) lines.push(`  ${nid("c", c.id)} --> ${nid("c", target.id)}`);
      }
    }
  }
  if (!d.containers.length) {
    for (const df of d.dockerfiles.slice(0, 6)) lines.push(`  ${nid("df", df.path)}["${label(df.path)}<br/><small>${label(df.baseImages.at(-1) ?? "", 30)}${df.exposes.length ? ` · port ${df.exposes.join(", ")}` : ""}</small>"]`);
  }
  // CI only links to what it demonstrably does: publish to a registry or deploy to a platform.
  for (const c of f.runtime.supplyChain.ci.filter((x) => x.publishes)) {
    lines.push(`  ${nid("reg", c.publishes!)}[("${label(`Image registry: ${c.publishes}`)}")]`);
    lines.push(`  ${nid("ci", c.path)} -->|"builds and pushes image"| ${nid("reg", c.publishes!)}`);
  }
  const deploys = f.deployment.ci.some((c) => c.jobs.some((j) => j.steps.some((s) => /deploy|vercel|netlify|fly|railway|render|ssh|kubectl|helm/i.test(s))));
  if (deploys && d.platforms[0]) lines.push(`  ${nid("s", "ci")} -->|"deploys"| ${nid("pf", d.platforms[0].name)}`);
  return lines.join("\n");
}

function integrations(f: Facts): string | null {
  const ints = f.integrations.slice(0, 40);
  if (!ints.length) return null;
  const ui = f.stack.frameworks.filter((x) => /^(React|Vue|Svelte|Angular|Astro|React Native|Expo)$/.test(x));
  const server = f.stack.frameworks.filter((x) => !ui.includes(x));
  const sides = {
    backend: `Backend${server.length ? ` (${server.join(", ")})` : ""}`,
    frontend: `Frontend${ui.length ? ` (${ui.join(", ")})` : ""}`,
    infrastructure: "Deployment configuration",
  } as const;
  const lines = ["flowchart LR"];
  for (const side of ["backend", "frontend", "infrastructure"] as const) if (ints.some((i) => i.side === side)) lines.push(`  ${nid("side", side)}["${label(sides[side])}"]`);
  const byCat = new Map<string, typeof ints>();
  for (const i of ints) byCat.set(i.category, [...(byCat.get(i.category) ?? []), i]);
  for (const [cat, items] of byCat) {
    lines.push(`  subgraph ${nid("cat", cat)}["${label(cat)}"]`);
    for (const i of items) lines.push(`    ${nid("i", i.id)}["${label(i.name, 40)}<br/><small>${i.usedIn.length} place${i.usedIn.length === 1 ? "" : "s"}</small>"]`);
    lines.push("  end");
    for (const i of items) lines.push(`  ${nid("side", i.side)} --> ${nid("i", i.id)}`);
  }
  return lines.join("\n");
}

function testMap(f: Facts): string | null {
  const mods = [...f.modules].sort((a, b) => b.loc - a.loc).slice(0, 30);
  if (!mods.length) return null;
  const lines = ["flowchart TB", `  subgraph ${nid("s", "tested")}["Has tests"]`];
  for (const m of mods.filter((x) => x.tested)) lines.push(`    ${nid("m", m.id)}["${label(m.id)}"]:::ok`);
  lines.push("  end", `  subgraph ${nid("s", "untested")}["No tests found"]`);
  for (const m of mods.filter((x) => !x.tested)) lines.push(`    ${nid("m", m.id)}["${label(m.id)}<br/><small>${m.loc.toLocaleString("en-US")} lines</small>"]:::missing`);
  lines.push("  end");
  lines.push("  classDef ok fill:#dcfce7,stroke:#15803d,color:#14532d");
  lines.push("  classDef missing fill:#fee2e2,stroke:#b91c1c,color:#7f1d1d");
  return lines.join("\n");
}

export function buildDiagrams(f: Facts): Partial<Record<DiagramKey, string>> {
  const out: Partial<Record<DiagramKey, string>> = {};
  const set = (k: DiagramKey, v: string | null) => {
    if (v) out[k] = v;
  };
  set("dependencies", dependencies(f));
  set("data_model", dataModel(f));
  set("domain_types", domainTypes(f));
  set("api_map", apiMap(f));
  set("auth_map", authMap(f));
  set("deployment", deployment(f));
  set("integrations", integrations(f));
  set("test_map", testMap(f));
  return out;
}
