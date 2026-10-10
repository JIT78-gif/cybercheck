import { readFile } from "node:fs/promises";
import type { Detection, IntakeIssue } from "@cybercheck/contracts";
import type { ExtractedFile } from "./archive.ts";
import { warnings } from "./policy.ts";

const LOCKFILES: Array<[string, NonNullable<Detection["packageManager"]>]> = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

const FRAMEWORKS: Array<[string, string]> = [
  ["next", "Next.js"],
  ["react", "React"],
  ["vue", "Vue"],
  ["svelte", "Svelte"],
  ["@angular/core", "Angular"],
  ["express", "Express"],
  ["fastify", "Fastify"],
  ["@nestjs/core", "NestJS"],
  ["koa", "Koa"],
  ["hono", "Hono"],
  ["@remix-run/node", "Remix"],
  ["astro", "Astro"],
];

const AI_SDKS: Array<[string, string]> = [
  ["openai", "OpenAI"],
  ["@anthropic-ai/sdk", "Anthropic"],
  ["ai", "Vercel AI SDK"],
  ["langchain", "LangChain"],
  ["@langchain/core", "LangChain"],
  ["llamaindex", "LlamaIndex"],
  ["@google/generative-ai", "Google Gemini"],
  ["@google/genai", "Google Gemini"],
  ["cohere-ai", "Cohere"],
  ["@mistralai/mistralai", "Mistral"],
];

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  rb: "Ruby",
  php: "PHP",
  cs: "C#",
  swift: "Swift",
};

type PackageJson = {
  name?: unknown;
  scripts?: unknown;
  engines?: { node?: unknown };
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
};

/** Reads manifests as data only. Nothing in the project is executed or obeyed. */
export async function detectProject(
  files: Map<string, ExtractedFile>,
): Promise<{ detection: Detection; warnings: IntakeIssue[] }> {
  const warns: IntakeIssue[] = [];

  // Languages by file count.
  const counts = new Map<string, number>();
  for (const path of files.keys()) {
    const ext = path.split(".").at(-1)?.toLowerCase() ?? "";
    const lang = LANGUAGE_BY_EXT[ext];
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  const languages = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);

  // Shallowest package.json is the project root.
  const pkgPath = [...files.keys()]
    .filter((p) => p === "package.json" || p.endsWith("/package.json"))
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))[0];
  const root = pkgPath ? pkgPath.slice(0, -"package.json".length) : "";

  let pkg: PackageJson | null = null;
  if (pkgPath) {
    const blob = files.get(pkgPath)!;
    if (blob.size <= 1024 * 1024) {
      try {
        pkg = JSON.parse(await readFile(blob.blobPath, "utf8")) as PackageJson;
      } catch {
        pkg = null;
      }
    }
  }

  const lock = LOCKFILES.find(([name]) => files.has(root + name));
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const has = (name: string) => Object.prototype.hasOwnProperty.call(deps, name);
  const scripts: Record<string, string> = {};
  if (pkg?.scripts && typeof pkg.scripts === "object") {
    for (const [k, v] of Object.entries(pkg.scripts as Record<string, unknown>)) {
      if (typeof v === "string" && ["build", "test", "lint", "start", "dev", "typecheck"].includes(k)) {
        scripts[k] = v.slice(0, 300);
      }
    }
  }

  const detection: Detection = {
    languages,
    packageManager: lock?.[1] ?? null,
    lockfile: lock ? root + lock[0] : null,
    typescript: has("typescript") || files.has(root + "tsconfig.json"),
    frameworks: [...new Set(FRAMEWORKS.filter(([d]) => has(d)).map(([, n]) => n))],
    aiSdks: [...new Set(AI_SDKS.filter(([d]) => has(d)).map(([, n]) => n))],
    scripts,
    nodeEngine: typeof pkg?.engines?.node === "string" ? pkg.engines.node.slice(0, 50) : null,
    packageName: typeof pkg?.name === "string" ? pkg.name.slice(0, 100) : null,
  };

  if (!pkgPath) warns.push(warnings.notNode());
  else {
    if (!lock) warns.push(warnings.noLockfile());
    if (!scripts.test) warns.push(warnings.noTestScript());
  }
  return { detection, warnings: warns };
}
