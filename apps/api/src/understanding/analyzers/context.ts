import type { CodeParser, Parsed } from "../parse.ts";
import type { SnapshotSource } from "../source.ts";

export type PackageJson = {
  path: string;
  dir: string;
  name: string | null;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  engines: Record<string, string>;
  workspaces: string[];
};

export type PyProject = {
  path: string;
  dir: string;
  name: string | null;
  dependencies: Array<{ name: string; spec: string; dev: boolean }>;
  scripts: Record<string, string>;
  pythonVersion: string | null;
  manager: "poetry" | "uv" | "pip" | "pipenv";
};

/** Everything analyzers share for one snapshot. */
export type Ctx = {
  src: SnapshotSource;
  parser: CodeParser;
  parsed: Map<string, Parsed>;
  packageJsons: PackageJson[];
  pyProjects: PyProject[];
  workspaces: Array<{ name: string; path: string }>;
  /** All npm + Python package names declared anywhere in the project. */
  declared: Set<string>;
  isTest: (path: string) => boolean;
};

const UI_DEPS = /^(react|react-dom|vue|svelte|@angular\/core|solid-js|preact|@remix-run\/react)$/;
const SERVER_DEPS = /^(express|fastify|koa|hono|@nestjs\/core|next|nuxt|@sveltejs\/kit|@remix-run\/node|elysia|@hapi\/hapi)$/;
const frontendCache = new WeakMap<Ctx, string[]>();

/** Directories of packages that only run in the browser (a Vite/React app next to an API, for example). */
export function frontendRoots(ctx: Ctx): string[] {
  const hit = frontendCache.get(ctx);
  if (hit) return hit;
  const roots = ctx.packageJsons
    .filter((p) => {
      const deps = [...Object.keys(p.dependencies), ...Object.keys(p.devDependencies)];
      return deps.some((d) => UI_DEPS.test(d)) && !deps.some((d) => SERVER_DEPS.test(d));
    })
    .map((p) => p.dir);
  frontendCache.set(ctx, roots);
  return roots;
}

export function isFrontendPath(ctx: Ctx, path: string) {
  return frontendRoots(ctx).some((dir) => dir === "" || dir === "." ? !ctx.packageJsons.some((p) => p.dir && p.dir !== "." && path.startsWith(`${p.dir}/`)) : path.startsWith(`${dir}/`));
}

export function isTestPath(path: string) {
  return (
    /(^|\/)(__tests__|tests?|e2e|spec|cypress|playwright)\//i.test(path) ||
    /\.(test|spec|e2e)\.[cm]?[jt]sx?$/i.test(path) ||
    /(^|\/)(test_[\w-]+|[\w-]+_test|conftest)\.py$/i.test(path)
  );
}
