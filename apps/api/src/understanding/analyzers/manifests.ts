import { posix } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { Dependency, Deployment, RunPlan, RuntimeFacts } from "@cybercheck/contracts";
import type { SnapshotSource } from "../source.ts";
import type { PackageJson, PyProject } from "./context.ts";

const obj = (v: unknown): Record<string, string> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === "string") as Array<[string, string]>)
    : {};

export function readPackageJsons(src: SnapshotSource): PackageJson[] {
  const out: PackageJson[] = [];
  for (const [path, f] of src.files) {
    if (!/(^|\/)package\.json$/.test(path)) continue;
    try {
      const pkg = JSON.parse(f.text) as Record<string, unknown>;
      const ws = Array.isArray(pkg.workspaces)
        ? (pkg.workspaces as unknown[]).filter((w): w is string => typeof w === "string")
        : Array.isArray((pkg.workspaces as { packages?: unknown })?.packages)
          ? ((pkg.workspaces as { packages: unknown[] }).packages.filter((w): w is string => typeof w === "string"))
          : [];
      out.push({
        path,
        dir: posix.dirname(path) === "." ? "" : posix.dirname(path),
        name: typeof pkg.name === "string" ? pkg.name : null,
        scripts: obj(pkg.scripts),
        dependencies: obj(pkg.dependencies),
        devDependencies: obj(pkg.devDependencies),
        engines: obj(pkg.engines),
        workspaces: ws,
      });
    } catch {
      // invalid JSON: ignore
    }
  }
  return out.sort((a, b) => a.dir.length - b.dir.length);
}

/** Workspace packages: every package.json below the root that declares a name. */
export function workspacePackages(pkgs: PackageJson[]) {
  const root = pkgs.find((p) => p.dir === "");
  const isMonorepo = Boolean(root?.workspaces.length) || pkgs.filter((p) => p.dir).length > 0;
  return isMonorepo ? pkgs.filter((p) => p.dir && p.name).map((p) => ({ name: p.name!, path: p.dir })) : [];
}

function pep508(spec: string): { name: string; spec: string } | null {
  const m = spec.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*(.*)$/);
  if (!m) return null;
  return { name: m[1]!.toLowerCase().replace(/_/g, "-"), spec: (m[3] ?? "").split(";")[0]!.trim() || "*" };
}

export function readPyProjects(src: SnapshotSource): PyProject[] {
  const out: PyProject[] = [];
  for (const [path, f] of src.files) {
    const dir = posix.dirname(path) === "." ? "" : posix.dirname(path);
    if (/(^|\/)pyproject\.toml$/.test(path)) {
      try {
        const t = parseToml(f.text) as Record<string, any>;
        const deps: PyProject["dependencies"] = [];
        for (const d of (t.project?.dependencies as string[] | undefined) ?? []) {
          const p = pep508(d);
          if (p) deps.push({ ...p, dev: false });
        }
        for (const group of Object.values((t.project?.["optional-dependencies"] as Record<string, string[]>) ?? {})) {
          for (const d of group) {
            const p = pep508(d);
            if (p) deps.push({ ...p, dev: true });
          }
        }
        const poetry = t.tool?.poetry;
        for (const [name, v] of Object.entries((poetry?.dependencies as Record<string, unknown>) ?? {})) {
          if (name.toLowerCase() === "python") continue;
          deps.push({ name: name.toLowerCase(), spec: typeof v === "string" ? v : "*", dev: false });
        }
        for (const [name, v] of Object.entries((poetry?.group?.dev?.dependencies as Record<string, unknown>) ?? {})) {
          deps.push({ name: name.toLowerCase(), spec: typeof v === "string" ? v : "*", dev: true });
        }
        const has = (n: string) => [...src.files.keys()].some((p) => p === posix.join(dir, n) || (dir === "" && p === n));
        out.push({
          path,
          dir,
          name: t.project?.name ?? poetry?.name ?? null,
          dependencies: deps,
          scripts: obj(t.project?.scripts ?? poetry?.scripts),
          pythonVersion: t.project?.["requires-python"] ?? (poetry?.dependencies?.python as string | undefined) ?? null,
          manager: poetry ? "poetry" : has("uv.lock") ? "uv" : "pip",
        });
      } catch {
        // invalid TOML
      }
    } else if (/(^|\/)requirements(-[\w]+)?\.txt$/.test(path)) {
      const dev = /-(dev|test)/.test(path);
      const deps = f.text
        .split("\n")
        .map((l) => l.replace(/#.*$/, "").trim())
        .filter((l) => l && !l.startsWith("-"))
        .map(pep508)
        .filter((x): x is { name: string; spec: string } => Boolean(x))
        .map((d) => ({ ...d, dev }));
      out.push({ path, dir, name: null, dependencies: deps, scripts: {}, pythonVersion: null, manager: "pip" });
    } else if (/(^|\/)Pipfile$/.test(path)) {
      try {
        const t = parseToml(f.text) as Record<string, any>;
        const deps = [
          ...Object.entries((t.packages as Record<string, unknown>) ?? {}).map(([n, v]) => ({ name: n.toLowerCase(), spec: typeof v === "string" ? v : "*", dev: false })),
          ...Object.entries((t["dev-packages"] as Record<string, unknown>) ?? {}).map(([n, v]) => ({ name: n.toLowerCase(), spec: typeof v === "string" ? v : "*", dev: true })),
        ];
        out.push({ path, dir, name: null, dependencies: deps, scripts: {}, pythonVersion: t.requires?.python_version ?? null, manager: "pipenv" });
      } catch {
        // invalid
      }
    }
  }
  return out;
}

/** Resolved versions from package-lock.json (npm v2/v3 lockfiles). */
function npmLockVersions(src: SnapshotSource, dir: string): Map<string, string> {
  const lock = src.files.get(dir ? `${dir}/package-lock.json` : "package-lock.json");
  const out = new Map<string, string>();
  if (!lock) return out;
  try {
    const j = JSON.parse(lock.text) as { packages?: Record<string, { version?: string }> };
    for (const [k, v] of Object.entries(j.packages ?? {})) {
      const m = k.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/);
      if (m && v.version && !out.has(m[1]!)) out.set(m[1]!, v.version);
    }
  } catch {
    // ignore
  }
  return out;
}

export function dependenciesOf(src: SnapshotSource, pkgs: PackageJson[], pys: PyProject[]): Dependency[] {
  const out: Dependency[] = [];
  for (const p of pkgs) {
    const locked = npmLockVersions(src, p.dir);
    const rootLocked = p.dir ? npmLockVersions(src, "") : locked;
    for (const [dev, deps] of [
      [false, p.dependencies],
      [true, p.devDependencies],
    ] as const) {
      for (const [name, declared] of Object.entries(deps)) {
        out.push({ ecosystem: "npm", name, declared, resolved: locked.get(name) ?? rootLocked.get(name) ?? null, dev, manifest: p.path });
      }
    }
  }
  for (const p of pys) for (const d of p.dependencies) out.push({ ecosystem: "pypi", name: d.name, declared: d.spec, resolved: null, dev: d.dev, manifest: p.path });
  return out;
}

export function runCommandsOf(src: SnapshotSource, pkgs: PackageJson[], pys: PyProject[]) {
  const out: Array<{ name: string; command: string; source: string }> = [];
  const interesting = /^(dev|start|build|test|lint|typecheck|migrate|seed|e2e|serve|preview|db:[\w-]+|test:[\w-]+)$/;
  for (const p of pkgs) for (const [k, v] of Object.entries(p.scripts)) if (interesting.test(k)) out.push({ name: k, command: v.slice(0, 200), source: p.path });
  for (const p of pys) for (const [k, v] of Object.entries(p.scripts)) out.push({ name: k, command: v.slice(0, 200), source: p.path });
  for (const [path, f] of src.files) {
    if (/(^|\/)Makefile$/.test(path)) {
      for (const m of f.text.matchAll(/^([A-Za-z][\w-]*):(?!=)/gm)) out.push({ name: m[1]!, command: `make ${m[1]}`, source: path });
    }
    if (/(^|\/)Procfile$/.test(path)) {
      for (const m of f.text.matchAll(/^([\w-]+):\s*(.+)$/gm)) out.push({ name: m[1]!, command: m[2]!.slice(0, 200), source: path });
    }
  }
  if (src.files.has("manage.py")) out.push({ name: "runserver", command: "python manage.py runserver", source: "manage.py" });
  return out.slice(0, 60);
}

const LOCKS: Array<[string, string, string]> = [
  ["pnpm-lock.yaml", "pnpm", "pnpm install --frozen-lockfile"],
  ["yarn.lock", "yarn", "yarn install --frozen-lockfile"],
  ["bun.lockb", "bun", "bun install --frozen-lockfile"],
  ["bun.lock", "bun", "bun install --frozen-lockfile"],
  ["package-lock.json", "npm", "npm ci"],
];

/** Install, build, test and start commands as declared, plus ports and required configuration. Nothing is run. */
export function runPlanOf(
  src: SnapshotSource,
  pkgs: PackageJson[],
  pys: PyProject[],
  requiredEnv: string[],
  deployment: Deployment,
  extra: { requiredOneOf: Array<{ names: string[]; evidence: { path: string; line: number } }>; runtime: RuntimeFacts },
): RunPlan {
  const has = (p: string) => src.allPaths.includes(p);
  const join = (dir: string, f: string) => (dir ? `${dir}/${f}` : f);
  const workspaces: RunPlan["workspaces"] = [];
  for (const p of pkgs) {
    const lock = LOCKS.find(([f]) => has(join(p.dir, f))) ?? LOCKS.find(([f]) => has(f));
    const pm = lock?.[1] ?? "npm";
    const run = (s: string) => (p.scripts[s] ? (pm === "npm" && (s === "test" || s === "start") ? `npm ${s}` : `${pm} run ${s}`) : null);
    workspaces.push({ dir: p.dir || ".", packageManager: pm, install: lock && has(join(p.dir, lock[0])) ? lock[2] : `${pm} install`, build: run("build"), test: run("test"), start: run("start"), dev: run("dev") });
  }
  for (const p of pys) {
    const install = p.manager === "poetry" ? "poetry install" : p.manager === "uv" ? "uv sync" : p.manager === "pipenv" ? "pipenv install --deploy" : has(join(p.dir, "requirements.txt")) ? "pip install -r requirements.txt" : "pip install .";
    const test = p.dependencies.some((d) => d.name === "pytest") ? "pytest" : null;
    workspaces.push({ dir: p.dir || ".", packageManager: p.manager, install, build: null, test, start: p.scripts.start ?? p.scripts.serve ?? null, dev: null });
  }

  const ports: RunPlan["ports"] = [];
  for (const df of deployment.dockerfiles) {
    const text = src.files.get(df.path)?.text ?? "";
    for (const port of df.exposes) ports.push({ port, note: `EXPOSE in ${df.path}`, evidence: { path: df.path, line: Math.max(1, text.split("\n").findIndex((l) => /^\s*EXPOSE\b/i.test(l)) + 1) } });
  }
  for (const c of deployment.containers) {
    for (const p of c.ports) ports.push({ port: p, note: `published by ${c.name} in ${c.file}`, evidence: c.evidence });
    for (const p of c.exposes) ports.push({ port: p, note: `internal only (${c.name} in ${c.file})`, evidence: c.evidence });
  }

  const runtimes: RunPlan["runtimes"] = [];
  for (const p of pkgs) if (p.engines.node) runtimes.push({ name: "Node.js", version: p.engines.node, source: p.path });
  for (const df of deployment.dockerfiles) {
    for (const img of df.baseImages) {
      const m = img.match(/^(node|python|oven\/bun|denoland\/deno):([\w.-]+)/);
      if (m) runtimes.push({ name: m[1] === "node" ? "Node.js" : m[1] === "python" ? "Python" : m[1]!.split("/")[1]!, version: m[2]!, source: df.path });
    }
  }
  const nvmrc = src.files.get(".nvmrc")?.text.trim();
  if (nvmrc) runtimes.push({ name: "Node.js", version: nvmrc, source: ".nvmrc" });
  for (const p of pys) if (p.pythonVersion) runtimes.push({ name: "Python", version: p.pythonVersion, source: p.path });

  const uniq = <T,>(xs: T[], key: (x: T) => string) => [...new Map(xs.map((x) => [key(x), x])).values()];
  // Ordering and setup notes a person (or the sandbox) needs to actually run it.
  const notes: RunPlan["notes"] = [];
  for (const [path, f] of src.files) {
    if (!/fastifyStatic|express\.static|serveStatic|StaticFiles|sendFile\(/.test(f.text)) continue;
    const builtDir = (dir: string) => new RegExp(`${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(dist|build|out)\\b`);
    const fe = pkgs.find((p) => p.dir && p.scripts.build && builtDir(p.dir).test(f.text));
    const m = fe ? f.text.match(builtDir(fe.dir)) : null;
    if (m && fe) notes.push({ note: `Build ${fe.dir}/ first (${fe.dir}: ${LOCKS.find(([l]) => has(join(fe.dir, l)))?.[2] ?? "npm install"}, then npm run build): the server serves the built files from it.`, evidence: [{ path, line: f.text.slice(0, m.index).split("\n").length }] });
  }
  for (const i of [...new Map(extra.runtime.supplyChain.installs.map((x) => [x.command, x])).values()]) {
    if (!i.locked && /^npm (install|i)\b/.test(i.command) && has("package-lock.json")) notes.push({ note: `The Dockerfile runs "${i.command}", which can change dependency versions; npm ci would enforce package-lock.json.`, evidence: [i.evidence] });
  }
  const dev = extra.runtime.frontend?.devServer;
  if (dev) notes.push({ note: `In development the frontend dev server runs on port ${dev.port ?? "5173"}${dev.proxy.length ? ` and forwards ${dev.proxy.join(", ")} to the API` : ""}.`, evidence: [] });
  for (const g of extra.requiredOneOf) notes.push({ note: `At least one of ${g.names.join(" or ")} must be set, or the app refuses to start.`, evidence: [g.evidence] });
  if (dev?.port) ports.push({ port: dev.port, note: "frontend dev server", evidence: { path: [...src.files.keys()].find((p) => /vite\.config/.test(p)) ?? "package.json", line: 1 } });

  return { status: "declared", workspaces, ports: uniq(ports, (x) => `${x.port}|${x.note}`), requiredEnv, requiredOneOf: extra.requiredOneOf.map((g) => g.names), notes, runtimes: uniq(runtimes, (x) => `${x.name}|${x.version}|${x.source}`) };
}
