import { posix } from "node:path";
import type { ProjectDossier } from "@cybercheck/contracts";
import type { SnapshotSource } from "../understanding/source.ts";

/**
 * Turns the dossier's run plan and the snapshot's manifests into exact commands per workspace.
 * Test runners we recognise are called directly with a machine-readable reporter; anything else
 * runs as declared and is judged by exit code and output only (weaker evidence, and said so).
 */

export const APP_ROOT = "/work/app";
export const OUT = "/out";

export type Framework = "vitest" | "jest" | "node" | "mocha" | "pytest" | "unknown";

export type SuitePlan = {
  id: string;
  workspace: string;
  framework: Framework;
  /** The test script as the project declares it. */
  declared: string;
  /** What we run (the runner with a reporter added, or the declared script as is). */
  command: string;
  report: { path: string; format: "junit" | "jest-json" } | null;
};

export type StepPlan = { id: string; kind: "build" | "typecheck" | "lint"; workspace: string; command: string; declared: string; source: "script" | "inferred" };

export type WorkspacePlan = {
  dir: string;
  ecosystem: "node" | "python";
  packageManager: string;
  /** Null when a parent workspace installs it (npm/pnpm/yarn workspaces). */
  install: { command: string; frozen: boolean; note: string | null } | null;
  steps: StepPlan[];
  suites: SuitePlan[];
  /** Test files exist but no runnable suite was found. */
  orphanTests: number;
  start: string | null;
  scripts: Record<string, string>;
  typescript: boolean;
  /** Its tests run as other workspaces' suites (e.g. a root script that only delegates to them). */
  coveredByRoot?: boolean;
};

const wsPath = (dir: string) => (dir === "." ? APP_ROOT : posix.join(APP_ROOT, dir));
const slug = (dir: string) => (dir === "." ? "root" : dir.replace(/[^\w]+/g, "-"));
/** Report file names: no colons or other characters the sandbox file API rejects. */
const fileSafe = (id: string) => id.replace(/[^\w.-]+/g, "-");
export { wsPath, slug };

function readJson(src: SnapshotSource, path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(src.files.get(path)?.text ?? "null");
  } catch {
    return null;
  }
}

const join = (dir: string, f: string) => (dir === "." ? f : `${dir}/${f}`);
const PLACEHOLDER_TEST = /no test specified|exit 1\s*$/i;

/** Split "a && b" chains; only a single runner call can be rewritten safely. */
function singleCommand(script: string) {
  return !/&&|\|\||;|\|/.test(script);
}

function runnerOf(script: string): Framework {
  const s = script.trim().replace(/^(cross-env\s+(\w+=\S+\s+)*)|^(\w+=\S+\s+)+/, "");
  if (/^(npx\s+)?vitest\b/.test(s)) return "vitest";
  if (/^(npx\s+)?jest\b/.test(s)) return "jest";
  if (/^node\s+(.*\s)?--test\b/.test(s)) return "node";
  if (/^(npx\s+)?mocha\b/.test(s)) return "mocha";
  if (/^(python3?\s+-m\s+)?pytest\b/.test(s)) return "pytest";
  return "unknown";
}

/** The declared runner call with a reporter added, so results come from a file, not from parsing logs. */
function withReporter(framework: Framework, script: string, id: string): { command: string; report: SuitePlan["report"] } {
  const env = script.match(/^((\w+=\S+\s+)+)/)?.[1] ?? "";
  const body = script.slice(env.length).replace(/^cross-env\s+((\w+=\S+\s+)*)/, (_m, vars: string) => vars);
  const junit = `${OUT}/${fileSafe(id)}.junit.xml`;
  switch (framework) {
    case "vitest": {
      // Watch mode never ends in a sandbox: always "run".
      const args = body.replace(/^(npx\s+)?vitest(\s+(run|watch))?/, "").replace(/--watch\b/, "");
      return { command: `${env}npx --no-install vitest run${args} --reporter=verbose --reporter=junit --outputFile.junit=${junit}`, report: { path: junit, format: "junit" } };
    }
    case "jest": {
      const out = `${OUT}/${fileSafe(id)}.jest.json`;
      const args = body.replace(/^(npx\s+)?jest/, "").replace(/--watch(All)?\b/, "");
      return { command: `${env}npx --no-install jest${args} --ci --json --outputFile=${out}`, report: { path: out, format: "jest-json" } };
    }
    case "node": {
      const args = body.replace(/^node\s+/, "");
      return { command: `${env}node --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=${junit} ${args}`, report: { path: junit, format: "junit" } };
    }
    case "mocha": {
      const args = body.replace(/^(npx\s+)?mocha/, "");
      return { command: `${env}npx --no-install mocha${args} --reporter xunit --reporter-option output=${junit}`, report: { path: junit, format: "junit" } };
    }
    default:
      return { command: script, report: null };
  }
}

function nodeWorkspace(d: ProjectDossier, src: SnapshotSource, rp: ProjectDossier["runPlan"]["workspaces"][number], installedByParent: boolean): WorkspacePlan {
  const dir = rp.dir;
  const pkg = readJson(src, join(dir, "package.json")) ?? {};
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  const deps = { ...((pkg.dependencies ?? {}) as Record<string, string>), ...((pkg.devDependencies ?? {}) as Record<string, string>) };
  const pm = rp.packageManager || "npm";
  const run = (name: string) => (pm === "yarn" ? `yarn ${name}` : pm === "pnpm" ? `pnpm run ${name}` : `npm run ${name}`);
  const lock = { npm: "package-lock.json", pnpm: "pnpm-lock.yaml", yarn: "yarn.lock" }[pm as "npm"] ?? "package-lock.json";
  const hasLock = src.allPaths.includes(join(dir, lock));

  let install: WorkspacePlan["install"] = null;
  if (!installedByParent) {
    const base = "--no-audit --no-fund";
    if (pm === "pnpm") install = { command: hasLock ? "corepack enable && pnpm install --frozen-lockfile" : "corepack enable && pnpm install", frozen: hasLock, note: hasLock ? null : "No pnpm-lock.yaml: dependency versions are not pinned." };
    else if (pm === "yarn") install = { command: hasLock ? "corepack enable && yarn install --frozen-lockfile" : "corepack enable && yarn install", frozen: hasLock, note: hasLock ? null : "No yarn.lock: dependency versions are not pinned." };
    else install = { command: hasLock ? `npm ci ${base}` : `npm install ${base}`, frozen: hasLock, note: hasLock ? null : "No package-lock.json: npm install picks the newest allowed versions, so results may differ from the developer's machine." };
  }

  const typescript = Boolean(deps.typescript) && src.allPaths.includes(join(dir, "tsconfig.json"));
  const steps: StepPlan[] = [];
  const s = slug(dir);
  if (scripts.build) steps.push({ id: `build:${s}`, kind: "build", workspace: dir, command: run("build"), declared: scripts.build, source: "script" });
  const tcScript = Object.keys(scripts).find((k) => /^(typecheck|type-check|check-types|types|tsc)$/.test(k));
  if (tcScript) steps.push({ id: `typecheck:${s}`, kind: "typecheck", workspace: dir, command: run(tcScript), declared: scripts[tcScript]!, source: "script" });
  else if (typescript) steps.push({ id: `typecheck:${s}`, kind: "typecheck", workspace: dir, command: "npx --no-install tsc --noEmit", declared: "tsc --noEmit (TypeScript project without a typecheck script)", source: "inferred" });
  if (scripts.lint) steps.push({ id: `lint:${s}`, kind: "lint", workspace: dir, command: run("lint"), declared: scripts.lint, source: "script" });

  const suites: SuitePlan[] = [];
  const testScript = scripts.test;
  if (testScript && !PLACEHOLDER_TEST.test(testScript)) {
    const framework = singleCommand(testScript) ? runnerOf(testScript) : "unknown";
    const id = `suite:${s}`;
    const { command, report } = framework === "unknown" ? { command: run("test"), report: null } : withReporter(framework, testScript, id);
    const guessed: Framework = framework !== "unknown" ? framework : (["vitest", "jest", "mocha"] as const).find((f) => testScript.includes(f)) ?? "unknown";
    suites.push({ id, workspace: dir, framework: guessed, declared: testScript, command, report: framework === "unknown" ? null : report });
  }
  const prefix = dir === "." ? "" : `${dir}/`;
  const testFiles = src.allPaths.filter((p) => p.startsWith(prefix) && !p.includes("node_modules/") && /(\.|\/)(test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\//.test(p)).length;
  const start = scripts.start ? run("start") : null;
  return { dir, ecosystem: "node", packageManager: pm, install, steps, suites, orphanTests: suites.length ? 0 : testFiles, start, scripts, typescript };
}

type PythonStart = { command: string; runner: "uvicorn" | "flask" | "django" | "python" };

/** Deterministic Python web-app entry point. This is deliberately source-derived: no model invents a module or app. */
function pythonStart(dir: string, paths: string[], src: SnapshotSource, venv: string, port: number): PythonStart | null {
  const relative = (path: string) => (dir === "." ? path : path.slice(dir.length + 1));
  const moduleOf = (path: string) => relative(path).replace(/\.py$/, "").replace(/\/__init__$/, "").replace(/\//g, ".");
  const python = `${venv}/bin/python`;
  const code = paths
    .filter((p) => p.endsWith(".py") && !/(^|\/)(test|tests|fixtures)(\/|_)/i.test(relative(p)))
    .map((path) => ({ path, text: src.files.get(path)?.text ?? "" }));

  for (const f of code) {
    const match = f.text.match(/\b([A-Za-z_]\w*)\s*(?::[^=\n]+)?=\s*FastAPI\s*\(/);
    if (match) return { command: `${python} -m uvicorn ${moduleOf(f.path)}:${match[1]} --host 0.0.0.0 --port ${port}`, runner: "uvicorn" };
  }
  const manage = paths.find((p) => relative(p) === "manage.py");
  if (manage) return { command: `${python} manage.py runserver 0.0.0.0:${port} --noreload`, runner: "django" };
  for (const f of code) {
    const match = f.text.match(/\b([A-Za-z_]\w*)\s*(?::[^=\n]+)?=\s*Flask\s*\(/);
    if (match) return { command: `${python} -m flask --app ${moduleOf(f.path)}:${match[1]} run --host 0.0.0.0 --port ${port}`, runner: "flask" };
  }
  const executable = code.find((f) => /if\s+__name__\s*==\s*["']__main__["']/.test(f.text) && /\b(?:uvicorn\.run|\.run)\s*\(/.test(f.text));
  return executable ? { command: `${python} ${relative(executable.path)}`, runner: "python" } : null;
}

function pythonWorkspaces(d: ProjectDossier, src: SnapshotSource): WorkspacePlan[] {
  const roots = new Set<string>();
  for (const p of src.allPaths) {
    const m = p.match(/^(?:(.*)\/)?(requirements(?:[-_.][\w-]+)?\.txt|pyproject\.toml|setup\.py|Pipfile)$/);
    if (m && !p.includes("node_modules/") && !/(^|\/)(\.venv|venv|site-packages)\//.test(p)) roots.add(m[1] ?? ".");
  }
  const out: WorkspacePlan[] = [];
  for (const dir of [...roots].sort((a, b) => a.length - b.length)) {
    if (out.some((w) => w.dir !== "." && dir.startsWith(`${w.dir}/`))) continue;
    const files = src.allPaths.filter((p) => (dir === "." ? !p.includes("/") : p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes("/")));
    const workspacePaths = src.allPaths.filter((p) => dir === "." || p.startsWith(`${dir}/`));
    const reqs = files.filter((p) => /requirements(?:[-_.][\w-]+)?\.txt$/.test(p)).map((p) => posix.basename(p));
    const venv = `/work/venv-${slug(dir)}`;
    const pip = `${venv}/bin/pip install --disable-pip-version-check --no-input`;
    const pyproject = files.some((p) => p.endsWith("pyproject.toml"));
    const port = Number(d.runPlan.ports.find((p) => /^\d+$/.test(p.port))?.port ?? 8000);
    const start = pythonStart(dir, workspacePaths, src, venv, port);
    const installCmd = [
      // Debian ships venv support separately; add it when missing (network is on while installing).
      `(python3 -c "import ensurepip" >/dev/null 2>&1 || (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-venv >/dev/null))`,
      `python3 -m venv ${venv}`,
      reqs.length ? reqs.map((r) => `${pip} -r ${r}`).join(" && ") : pyproject ? `(${pip} -e ".[test]" || ${pip} -e ".[dev]" || ${pip} -e .)` : "true",
      start?.runner === "uvicorn" ? `(${venv}/bin/python -c "import uvicorn" >/dev/null 2>&1 || ${pip} uvicorn)` : "true",
      start?.runner === "flask" ? `(${venv}/bin/python -c "import flask" >/dev/null 2>&1 || ${pip} flask)` : "true",
    ].join(" && ");
    const prefix = dir === "." ? "" : `${dir}/`;
    const tests = src.allPaths.filter((p) => p.startsWith(prefix) && /(^|\/)(test_[\w]+|[\w]+_test)\.py$/.test(p)).length;
    const suites: SuitePlan[] = [];
    if (tests > 0) {
      const id = `suite:${slug(dir)}-py`;
      const junit = `${OUT}/${fileSafe(id)}.junit.xml`;
      suites.push({ id, workspace: dir, framework: "pytest", declared: "pytest", command: `${venv}/bin/python -m pytest -p no:cacheprovider -q --junitxml=${junit}`, report: { path: junit, format: "junit" } });
    }
    out.push({
      dir,
      ecosystem: "python",
      packageManager: "pip",
      // pytest is added when tests exist but the project doesn't install it (said in the report).
      install: { command: tests > 0 ? `${installCmd} && (${venv}/bin/python -m pytest --version >/dev/null 2>&1 || ${pip} pytest)` : installCmd, frozen: reqs.some((r) => /==/.test(src.files.get(join(dir, r))?.text ?? "")), note: null },
      steps: [],
      suites,
      orphanTests: 0,
      start: start?.command ?? null,
      scripts: {},
      typescript: false,
    });
  }
  return out;
}

export function planWorkspaces(d: ProjectDossier, src: SnapshotSource): WorkspacePlan[] {
  const node: WorkspacePlan[] = [];
  const rootPkg = readJson(src, "package.json");
  const declaredWs = rootPkg?.workspaces;
  const workspaceGlobs = (Array.isArray(declaredWs) ? declaredWs : ((declaredWs as { packages?: string[] } | undefined)?.packages ?? [])) as string[];
  const pnpmWs = src.allPaths.includes("pnpm-workspace.yaml");
  for (const rp of d.runPlan.workspaces) {
    if (!src.files.has(join(rp.dir, "package.json"))) continue;
    // Members of npm/yarn/pnpm workspaces are installed by the root install.
    const member = rp.dir !== "." && (pnpmWs || workspaceGlobs.some((g) => new RegExp(`^${g.replace(/\*\*?/g, "[^/]+")}$`).test(rp.dir)));
    node.push(nodeWorkspace(d, src, rp, member));
  }
  // Workspace members depend on their siblings being built. When the root runs the same step it covers
  // them; otherwise the member step first builds the workspaces it depends on.
  const root = node.find((w) => w.dir === ".");
  // A root test script that only runs every workspace's tests duplicates the member suites. Keep the
  // members (each gets a machine-readable reporter, so failures have names and locations) and skip the root one.
  if (root?.suites.some((s) => /--workspaces|\s-ws\b|--ws\b|turbo\s+run\s+test|pnpm\s+(-r|--recursive)|lerna\s+run\s+test|nx\s+run-many/.test(s.declared)) && node.some((w) => w.dir !== "." && w.suites.length)) {
    Object.assign(root, { suites: [], orphanTests: 0, coveredByRoot: true });
  }
  if (root && (workspaceGlobs.length || pnpmWs)) {
    for (const w of node.filter((x) => x.dir !== "." && !x.install)) {
      w.steps = w.steps
        .filter((s) => !root.steps.some((r) => r.kind === s.kind && r.source === "script"))
        .map((s) => ({ ...s, command: `(cd ${APP_ROOT} && ${root.packageManager === "pnpm" ? "pnpm -r --if-present run build" : root.packageManager === "yarn" ? "yarn workspaces run build" : "npm run build --workspaces --if-present"} >/dev/null 2>&1 || true) && ${s.command}` }));
    }
  }
  return [...node, ...pythonWorkspaces(d, src)];
}
