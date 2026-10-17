import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { ProjectDossier } from "@cybercheck/contracts";
import { analyzeSource } from "../src/understanding/analyze.ts";
import { sourceFromFiles, type SnapshotSource } from "../src/understanding/source.ts";

// Loads a benchmark project folder exactly as an upload would contain it (no node_modules) and analyzes it.

export const BENCH = {
  gauntlet: join(import.meta.dirname, "testing-bench/cybercheck-gauntlet/project"),
  aiControl: join(import.meta.dirname, "ai-bench/clean-ai-control/project"),
  noAi: join(import.meta.dirname, "security-bench/clean-node-control/project"),
};

export function projectFiles(root: string): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e === "node_modules" || e === ".git") continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else files[relative(root, p).split(sep).join("/")] = readFileSync(p);
    }
  };
  walk(root);
  return files;
}

const cache = new Map<string, Promise<{ d: ProjectDossier; src: SnapshotSource }>>();
export function analyzed(root: string) {
  if (!cache.has(root)) {
    cache.set(root, (async () => {
      const src = sourceFromFiles(projectFiles(root));
      const d = await analyzeSource(src, { snapshotId: "s1", contentDigest: "digest-1" });
      return { d, src };
    })());
  }
  return cache.get(root)!;
}
