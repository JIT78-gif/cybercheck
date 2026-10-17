import type { ProjectDossier } from "@cybercheck/contracts";
import type { ObjectStore } from "../storage/object-store.ts";
import { analyzeDataModel } from "./analyzers/datamodel.ts";
import { analyzeDeployment } from "./analyzers/deployment.ts";
import { analyzeConfig, requiredOneOf } from "./analyzers/config.ts";
import { analyzeRuntime } from "./analyzers/runtime.ts";
import { analyzeBackground, analyzeIntegrations, analyzeQuality, analyzeSecurityModel, configObjects, resolveMember, sensitiveLogging } from "./analyzers/integrations.ts";
import { dependenciesOf, readPackageJsons, readPyProjects, runCommandsOf, runPlanOf, workspacePackages } from "./analyzers/manifests.ts";
import { analyzeRoutes } from "./analyzers/routes.ts";
import { Resolver, analyzeStructure } from "./analyzers/structure.ts";
import { isTestPath, type Ctx } from "./analyzers/context.ts";
import { buildChecklist, buildObservations } from "./checklist.ts";
import { checkConsistency } from "./consistency.ts";
import { buildDiagrams } from "./diagrams.ts";
import { CodeParser, langFor } from "./parse.ts";
import { SKIP, isGenerated, loadSnapshotSource, type SnapshotSource } from "./source.ts";

/** Bump when analysis changes so cached dossiers are rebuilt. */
export const ANALYZER_VERSION = "2026-10-16.v2.5";

const FRAMEWORKS: Array<[string, string]> = [
  ["next", "Next.js"], ["react", "React"], ["vue", "Vue"], ["nuxt", "Nuxt"], ["svelte", "Svelte"], ["@sveltejs/kit", "SvelteKit"], ["@angular/core", "Angular"],
  ["astro", "Astro"], ["@remix-run/node", "Remix"], ["express", "Express"], ["fastify", "Fastify"], ["@nestjs/core", "NestJS"], ["koa", "Koa"], ["hono", "Hono"],
  ["elysia", "Elysia"], ["@trpc/server", "tRPC"], ["@apollo/server", "Apollo GraphQL"], ["graphql-yoga", "GraphQL Yoga"], ["electron", "Electron"], ["react-native", "React Native"], ["expo", "Expo"],
  ["fastapi", "FastAPI"], ["django", "Django"], ["djangorestframework", "Django REST Framework"], ["flask", "Flask"], ["starlette", "Starlette"], ["streamlit", "Streamlit"], ["gradio", "Gradio"],
];

const LANG_BY_EXT: Record<string, string> = { ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript", js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", py: "Python", sql: "SQL", prisma: "Prisma", vue: "Vue", svelte: "Svelte" };

/** Everything derived directly from the code, before checklist, findings and consistency checks. */
export type Facts = Omit<ProjectDossier, "checklist" | "observations" | "questions" | "diagrams" | "meta" | "consistency" | "schemaVersion" | "ai">;

/** Run the deterministic analysis over one snapshot's files (no AI, nothing executed). */
export async function analyzeSource(src: SnapshotSource, meta: { snapshotId: string; contentDigest: string }): Promise<ProjectDossier> {
  const started = Date.now();
  const parser = await new CodeParser().init();
  try {
    const packageJsons = readPackageJsons(src);
    const pyProjects = readPyProjects(src);
    const declared = new Set<string>([...packageJsons.flatMap((p) => [...Object.keys(p.dependencies), ...Object.keys(p.devDependencies)]), ...pyProjects.flatMap((p) => p.dependencies.map((d) => d.name))]);
    const ctx: Ctx = { src, parser, parsed: new Map(), packageJsons, pyProjects, workspaces: workspacePackages(packageJsons), declared, isTest: isTestPath };

    const parseFailed: string[] = [];
    for (const [path, f] of src.files) {
      if (!langFor(path) || isGenerated(path)) continue;
      const p = parser.parse(path, f.text);
      if (p) ctx.parsed.set(path, p);
      else parseFailed.push(path);
    }

    const structure = analyzeStructure(ctx);
    const { entryPoints, screens } = analyzeRoutes(ctx, new Resolver(ctx));
    const { dataModel, domainTypes } = analyzeDataModel(ctx);
    const config = analyzeConfig(ctx);
    const { integrations, aiComponents } = analyzeIntegrations(ctx, structure, config.envVars);
    const deployment = analyzeDeployment(ctx);
    const runtime = analyzeRuntime(ctx, entryPoints);
    const configs = configObjects(ctx);
    const oneOf = requiredOneOf(ctx, (expr) => resolveMember(expr, configs)?.env ?? null);

    const langStats = new Map<string, { files: number; loc: number }>();
    for (const [path, f] of src.files) {
      const name = LANG_BY_EXT[path.split(".").at(-1)?.toLowerCase() ?? ""];
      if (!name || isGenerated(path)) continue;
      const s = langStats.get(name) ?? { files: 0, loc: 0 };
      s.files++;
      s.loc += f.lines;
      langStats.set(name, s);
    }
    const runtimes: ProjectDossier["stack"]["runtimes"] = [];
    const nodeEngine = packageJsons.map((p) => p.engines.node).find(Boolean);
    if (packageJsons.length) runtimes.push({ name: "Node.js", version: nodeEngine ?? src.files.get(".nvmrc")?.text.trim() ?? null });
    if (pyProjects.length || [...ctx.parsed.values()].some((p) => p.lang === "python")) runtimes.push({ name: "Python", version: pyProjects.map((p) => p.pythonVersion).find(Boolean) ?? src.files.get(".python-version")?.text.trim() ?? null });
    const lockfiles: Array<[RegExp, string]> = [[/(^|\/)pnpm-lock\.yaml$/, "pnpm"], [/(^|\/)yarn\.lock$/, "yarn"], [/(^|\/)bun\.lockb?$/, "bun"], [/(^|\/)package-lock\.json$/, "npm"], [/(^|\/)poetry\.lock$/, "poetry"], [/(^|\/)uv\.lock$/, "uv"], [/(^|\/)Pipfile\.lock$/, "pipenv"]];
    const packageManagers = lockfiles.filter(([re]) => src.allPaths.some((p) => re.test(p))).map(([, n]) => n);

    const facts: Facts = {
      stack: {
        languages: [...langStats.entries()].map(([name, s]) => ({ name, ...s })).sort((a, b) => b.loc - a.loc),
        frameworks: FRAMEWORKS.filter(([pkg]) => declared.has(pkg)).map(([, n]) => n),
        runtimes,
        packageManagers,
        workspaces: ctx.workspaces,
      },
      modules: structure.modules,
      keyFiles: structure.keyFiles,
      graph: { nodes: ctx.parsed.size, edges: structure.edges.length, moduleEdges: structure.moduleEdges },
      entryPoints,
      screens,
      dataModel,
      domainTypes,
      integrations,
      aiComponents,
      config,
      deployment,
      background: analyzeBackground(ctx),
      securityModel: analyzeSecurityModel(ctx, entryPoints, dataModel.enums, runtime.session),
      dependencies: dependenciesOf(src, packageJsons, pyProjects),
      quality: analyzeQuality(ctx),
      runCommands: runCommandsOf(src, packageJsons, pyProjects),
      runPlan: runPlanOf(src, packageJsons, pyProjects, config.envVars.filter((e) => e.required === true).map((e) => e.name), deployment, { requiredOneOf: oneOf, runtime }),
      runtime,
      coverage: coverageOf(src, ctx, parseFailed),
    };
    const { checklist, questions } = buildChecklist(facts, src);
    const observations = buildObservations(facts, src, sensitiveLogging(ctx));
    const diagrams = buildDiagrams(facts);
    const dossier: ProjectDossier = {
      schemaVersion: 2,
      meta: { analyzerVersion: ANALYZER_VERSION, snapshotId: meta.snapshotId, contentDigest: meta.contentDigest, generatedAt: new Date().toISOString(), durationMs: 0 },
      ...facts,
      checklist,
      observations,
      questions,
      consistency: [],
      ai: null,
      diagrams,
    };
    dossier.consistency = checkConsistency(dossier, src);
    dossier.meta.durationMs = Date.now() - started;
    return dossier;
  } finally {
    parser.dispose();
  }
}

/** Every file lands in exactly one category, so the totals always add up. */
function coverageOf(src: SnapshotSource, ctx: Ctx, parseFailed: string[]): ProjectDossier["coverage"] {
  type Cat = ProjectDossier["coverage"]["categories"][number];
  const failed = new Set(parseFailed);
  const read = [...src.files.keys()];
  const groups: Array<[Cat["id"], string, string[]]> = [
    ["parsed_code", "Parsed as source code", [...ctx.parsed.keys()]],
    ["parse_failed", "Source code that could not be parsed", parseFailed],
    ["lockfile", "Lockfiles and generated files (read for dependency versions only)", read.filter((p) => isGenerated(p) && !ctx.parsed.has(p) && !failed.has(p))],
    ["read_config", "Read as configuration, schema or documentation", read.filter((p) => !ctx.parsed.has(p) && !failed.has(p) && !isGenerated(p))],
    ["not_source", "Images, fonts and other files that are not code or configuration", [...src.skipped].filter(([, r]) => r === SKIP.notText).map(([p]) => p)],
    ["binary", "Binary content", [...src.skipped].filter(([, r]) => r === SKIP.binary).map(([p]) => p)],
    ["too_large", "Larger than 512 KB", [...src.skipped].filter(([, r]) => r === SKIP.tooLarge).map(([p]) => p)],
    ["budget", "Not read because the analysis size budget was reached", [...src.skipped].filter(([, r]) => r === SKIP.budget).map(([p]) => p)],
    ["secret_skipped", "Secret files stored in the snapshot but never read", [...src.skipped].filter(([, r]) => r === SKIP.secret).map(([p]) => p)],
    ["secret_excluded", "Secret files left out at upload and never stored", [...src.excluded.keys()]],
  ];
  return {
    filesTotal: src.allPaths.length + src.excluded.size,
    filesParsed: ctx.parsed.size,
    categories: groups.filter(([, , paths]) => paths.length).map(([id, label, paths]) => ({ id, label, count: paths.length, examples: paths.slice(0, 8) })),
  };
}

export async function analyzeSnapshot(store: ObjectStore, archiveKey: string, meta: { snapshotId: string; contentDigest: string }) {
  const src = await loadSnapshotSource(store, archiveKey);
  return analyzeSource(src, meta);
}
