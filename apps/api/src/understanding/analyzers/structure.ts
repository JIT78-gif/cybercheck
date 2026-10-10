import { posix } from "node:path";
import type { Node } from "web-tree-sitter";
import type { ModuleInfo } from "@cybercheck/contracts";
import { line, stringValue, walk, type Parsed } from "../parse.ts";
import type { Ctx } from "./context.ts";

const TS_EXT = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

export type ImportRef = { spec: string; line: number; names: string[] };

/** Raw import specifiers in a parsed file (ES imports, re-exports, require, dynamic import, Python imports). */
export function importsOf(p: Parsed): ImportRef[] {
  const out: ImportRef[] = [];
  const root = p.tree.rootNode;
  if (p.lang === "python") {
    for (const n of walk(root)) {
      if (n.type === "import_statement") {
        for (const c of n.namedChildren) {
          const name = c?.type === "aliased_import" ? c.childForFieldName("name")?.text : c?.type === "dotted_name" ? c.text : null;
          if (name) out.push({ spec: name, line: line(n), names: [] });
        }
      } else if (n.type === "import_from_statement") {
        const mod = n.childForFieldName("module_name");
        if (!mod) continue;
        const names = n.childrenForFieldName("name").map((c) => (c?.type === "aliased_import" ? c.childForFieldName("name")?.text : c?.text) ?? "").filter(Boolean);
        out.push({ spec: mod.text, line: line(n), names });
      }
    }
    return out;
  }
  for (const n of walk(root)) {
    if (n.type === "import_statement" || n.type === "export_statement") {
      const src = stringValue(n.childForFieldName("source"));
      if (src) {
        const names: string[] = [];
        for (const c of walk(n)) if (c.type === "import_specifier" || c.type === "export_specifier") names.push(c.childForFieldName("name")?.text ?? c.text);
        const clause = n.namedChildren.find((c) => c?.type === "import_clause");
        const def = clause?.namedChildren.find((c) => c?.type === "identifier");
        if (def) names.push(def.text);
        out.push({ spec: src, line: line(n), names });
      }
    } else if (n.type === "call_expression") {
      const fn = n.childForFieldName("function");
      if (fn && (fn.text === "require" || fn.type === "import")) {
        const arg = n.childForFieldName("arguments")?.namedChildren[0];
        const v = stringValue(arg);
        if (v) out.push({ spec: v, line: line(n), names: [] });
      }
    }
  }
  return out;
}

/** Package name of a bare import ("@scope/pkg/sub" -> "@scope/pkg", "lodash/fp" -> "lodash", "os.path" -> "os"). */
export function packageOf(spec: string, python: boolean): string | null {
  if (python) return spec.startsWith(".") ? null : spec.split(".")[0]!;
  if (spec.startsWith(".") || spec.startsWith("/")) return null;
  if (spec.startsWith("node:")) return spec;
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

type AliasRule = { prefix: string; targets: string[]; exact: boolean };

function stripJsonComments(s: string) {
  return s.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? "").replace(/,(\s*[}\]])/g, "$1");
}

/** tsconfig "paths" aliases (with baseUrl), resolved relative to each tsconfig's folder. */
function aliasRules(ctx: Ctx): Array<{ dir: string; rules: AliasRule[] }> {
  const out: Array<{ dir: string; rules: AliasRule[] }> = [];
  for (const [path, f] of ctx.src.files) {
    if (!/(^|\/)(tsconfig|jsconfig)[\w.-]*\.json$/.test(path)) continue;
    try {
      const cfg = JSON.parse(stripJsonComments(f.text)) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
      const dir = posix.dirname(path) === "." ? "" : posix.dirname(path);
      const base = posix.join(dir, cfg.compilerOptions?.baseUrl ?? ".");
      const rules: AliasRule[] = Object.entries(cfg.compilerOptions?.paths ?? {}).map(([k, v]) => ({
        prefix: k.replace(/\*$/, ""),
        exact: !k.endsWith("*"),
        targets: v.map((t) => posix.normalize(posix.join(base, t.replace(/\*$/, "")))),
      }));
      if (rules.length) out.push({ dir, rules });
    } catch {
      // unparsable config: ignore
    }
  }
  return out.sort((a, b) => b.dir.length - a.dir.length);
}

export class Resolver {
  private alias: Array<{ dir: string; rules: AliasRule[] }>;
  private workspacePkgs = new Map<string, string>();
  private pyRoots: string[];

  constructor(private ctx: Ctx) {
    this.alias = aliasRules(ctx);
    for (const w of ctx.workspaces) this.workspacePkgs.set(w.name, w.path);
    // Python import roots: project root, src/, and folders with a top-level package.
    const roots = new Set<string>([""]);
    for (const p of ctx.src.files.keys()) if (p.startsWith("src/") && p.endsWith(".py")) roots.add("src");
    this.pyRoots = [...roots];
  }

  private firstExisting(base: string): string | null {
    const has = (p: string) => this.ctx.src.files.has(p);
    if (has(base)) return base;
    const noJs = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
    for (const ext of TS_EXT) if (has(noJs + ext)) return noJs + ext;
    for (const ext of TS_EXT) if (has(`${base}/index${ext}`)) return `${base}/index${ext}`;
    return null;
  }

  resolve(from: string, spec: string, python: boolean): string | null {
    if (python) return this.resolvePy(from, spec);
    if (spec.startsWith(".")) return this.firstExisting(posix.normalize(posix.join(posix.dirname(from), spec)));
    for (const { dir, rules } of this.alias) {
      if (dir && !from.startsWith(dir + "/")) continue;
      for (const r of rules) {
        if (r.exact ? spec !== r.prefix : !spec.startsWith(r.prefix)) continue;
        for (const t of r.targets) {
          const hit = this.firstExisting(r.exact ? t : posix.join(t, spec.slice(r.prefix.length)));
          if (hit) return hit;
        }
      }
    }
    const pkg = packageOf(spec, false);
    if (pkg && this.workspacePkgs.has(pkg)) {
      const dir = this.workspacePkgs.get(pkg)!;
      const sub = spec.slice(pkg.length).replace(/^\//, "");
      return (
        this.firstExisting(posix.join(dir, sub || "src/index")) ??
        this.firstExisting(posix.join(dir, sub || "index")) ??
        this.firstExisting(posix.join(dir, "src", sub))
      );
    }
    return null;
  }

  private resolvePy(from: string, spec: string): string | null {
    const has = (p: string) => this.ctx.src.files.has(p);
    const tryMod = (base: string) => (has(`${base}.py`) ? `${base}.py` : has(`${base}/__init__.py`) ? `${base}/__init__.py` : null);
    if (spec.startsWith(".")) {
      const dots = spec.match(/^\.+/)![0].length;
      let dir = posix.dirname(from);
      for (let i = 1; i < dots; i++) dir = posix.dirname(dir);
      const rest = spec.slice(dots).replace(/\./g, "/");
      return rest ? tryMod(posix.join(dir, rest)) : tryMod(dir);
    }
    const rel = spec.replace(/\./g, "/");
    for (const root of this.pyRoots) {
      const hit = tryMod(root ? posix.join(root, rel) : rel);
      if (hit) return hit;
    }
    return null;
  }
}

/** PageRank over the import graph: files imported by many important files rank highest. */
export function pageRank(nodes: string[], edges: Array<[string, string]>, iterations = 30, d = 0.85) {
  const idx = new Map(nodes.map((n, i) => [n, i]));
  const out: number[][] = nodes.map(() => []);
  for (const [a, b] of edges) {
    const ia = idx.get(a);
    const ib = idx.get(b);
    if (ia !== undefined && ib !== undefined && ia !== ib) out[ia]!.push(ib);
  }
  const n = nodes.length || 1;
  let rank = new Array(nodes.length).fill(1 / n);
  for (let it = 0; it < iterations; it++) {
    const next = new Array(nodes.length).fill((1 - d) / n);
    let dangling = 0;
    for (let i = 0; i < nodes.length; i++) {
      if (out[i]!.length === 0) dangling += rank[i];
      else for (const j of out[i]!) next[j] += (d * rank[i]) / out[i]!.length;
    }
    for (let i = 0; i < nodes.length; i++) next[i] += (d * dangling) / n;
    rank = next;
  }
  return new Map(nodes.map((nd, i) => [nd, rank[i] as number]));
}

const CONTAINER_DIRS = new Set(["src", "app", "apps", "packages", "libs", "lib", "server", "client", "services", "modules", "backend", "frontend", "api"]);

/** Group files into modules by folder, deep enough to be meaningful but not one module per file. */
export function moduleOf(path: string, depth: number) {
  const parts = path.split("/").slice(0, -1);
  if (parts.length === 0) return "(root)";
  let take = depth;
  // Container folders (src/, apps/, packages/...) don't count as a level on their own.
  for (let i = 0; i < Math.min(parts.length, take); i++) if (CONTAINER_DIRS.has(parts[i]!) && take < parts.length) take++;
  return parts.slice(0, Math.min(take, parts.length)).join("/");
}

export function chooseModuleDepth(paths: string[]) {
  for (let depth = 1; depth <= 4; depth++) {
    const counts = new Map<string, number>();
    for (const p of paths) counts.set(moduleOf(p, depth), (counts.get(moduleOf(p, depth)) ?? 0) + 1);
    const max = Math.max(...counts.values());
    if (counts.size >= Math.min(6, paths.length) && max / paths.length <= 0.5) return depth;
    if (counts.size > 40) return Math.max(1, depth - 1);
  }
  return 2;
}

export function analyzeStructure(ctx: Ctx) {
  const resolver = new Resolver(ctx);
  const sourcePaths = [...ctx.parsed.keys()];
  const edges: Array<[string, string]> = [];
  const externalImports = new Map<string, Array<{ path: string; line: number; names: string[] }>>();

  for (const [path, p] of ctx.parsed) {
    const python = p.lang === "python";
    for (const imp of importsOf(p)) {
      const target = resolver.resolve(path, imp.spec, python);
      if (target) edges.push([path, target]);
      else {
        const pkg = packageOf(imp.spec, python);
        if (pkg) {
          const list = externalImports.get(pkg) ?? [];
          list.push({ path, line: imp.line, names: imp.names });
          externalImports.set(pkg, list);
        }
      }
    }
  }

  const rank = pageRank(sourcePaths, edges);
  const importedBy = new Map<string, number>();
  for (const [, b] of edges) importedBy.set(b, (importedBy.get(b) ?? 0) + 1);

  const nonTest = sourcePaths.filter((p) => !ctx.isTest(p));
  const depth = chooseModuleDepth(nonTest.length ? nonTest : sourcePaths);
  const modOf = (p: string) => moduleOf(p, depth);

  const modules = new Map<string, { files: string[]; loc: number }>();
  for (const p of sourcePaths) {
    if (ctx.isTest(p)) continue;
    const m = modOf(p);
    const e = modules.get(m) ?? { files: [], loc: 0 };
    e.files.push(p);
    e.loc += ctx.src.files.get(p)?.lines ?? 0;
    modules.set(m, e);
  }
  const moduleEdgeMap = new Map<string, number>();
  for (const [a, b] of edges) {
    if (ctx.isTest(a) || ctx.isTest(b)) continue;
    const ma = modOf(a);
    const mb = modOf(b);
    if (ma !== mb) moduleEdgeMap.set(`${ma}\u0000${mb}`, (moduleEdgeMap.get(`${ma}\u0000${mb}`) ?? 0) + 1);
  }
  const moduleEdges = [...moduleEdgeMap.entries()].map(([k, w]) => {
    const [from, to] = k.split("\u0000") as [string, string];
    return { from, to, weight: w };
  });

  const testedFiles = new Set<string>();
  for (const [a, b] of edges) if (ctx.isTest(a)) testedFiles.add(b);

  const moduleInfos: ModuleInfo[] = [...modules.entries()]
    .map(([id, m]) => ({
      id,
      path: id,
      files: m.files.length,
      loc: m.loc,
      dependsOn: [...new Set(moduleEdges.filter((e) => e.from === id).map((e) => e.to))],
      keyFiles: [...m.files].sort((a, b) => (rank.get(b) ?? 0) - (rank.get(a) ?? 0)).slice(0, 5),
      tested: m.files.some((f) => testedFiles.has(f)),
    }))
    .sort((a, b) => b.loc - a.loc);

  const keyFiles = sourcePaths
    .filter((p) => !ctx.isTest(p))
    .map((p) => ({ path: p, rank: Number(((rank.get(p) ?? 0) * 1000).toFixed(3)), loc: ctx.src.files.get(p)?.lines ?? 0, importedBy: importedBy.get(p) ?? 0 }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 25);

  return { edges, externalImports, modules: moduleInfos, moduleEdges, keyFiles, testedFiles, modOf };
}

export type StructureResult = ReturnType<typeof analyzeStructure>;

export function textOf(n: Node | null | undefined) {
  return n?.text ?? "";
}
