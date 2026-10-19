import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// AI Adversarial Step 1: the benchmark is frozen before the engine exists, so later work is measured against a fixed
// target. A change to the planted chains, the clean control or the scope must be deliberate and fail here first.

const here = import.meta.dirname;
const bench = join(here, "adversarial-bench");
const vulnDir = join(bench, "ai-agent-gauntlet", "project");
const cleanDir = join(bench, "clean-ai-agent-control", "project");
const read = (dir: string, rel: string) => readFileSync(join(dir, rel), "utf8");

type Chain = { id: string; lane: string; technique: string; entry: string; boundary: string; asset: string; severity: string; mustFind: boolean; chainOf?: string[]; anchor: { path: string; text: string } };
const frozen = JSON.parse(readFileSync(join(bench, "gauntlet-adversarial-frozen.json"), "utf8")) as {
  scope: { owner: string; appliesTo: string; notApplicable: string; insufficientEvidence: string };
  existingAdversarialDefects: { keyPath: string; ids: string[]; mandatory: string[] };
  aiAdversarialGauntlet: { project: string; clean: string; modelProvider: null; chains: Chain[] };
};

// The adversarial coverage lanes this benchmark must exercise (frozen here; the contracts adopt them in Step 2).
const LANES = ["prompt", "leakage", "rag_memory", "tools_approval", "identity_tenant", "mcp_agent", "output_handling", "resource_concurrency", "multi_stage"];
const SEVERITIES = ["low", "medium", "high", "critical"];

describe("AI Adversarial scope and existing-defect freeze", () => {
  it("declares AI-centric applicability, with not_applicable and insufficient-evidence rules", () => {
    expect(frozen.scope.owner).toBe("adversarial");
    expect(frozen.scope.appliesTo).toMatch(/AI|agent|RAG|chatbot/i);
    expect(frozen.scope.notApplicable).toMatch(/no AI component/i);
    expect(frozen.scope.insufficientEvidence).toMatch(/insufficient|no reachable target/i);
  });

  it("keeps exactly the six frozen adversarial Gauntlet defects, unchanged", () => {
    const key = JSON.parse(readFileSync(join(here, "testing-bench/cybercheck-gauntlet/expected.json"), "utf8")) as { defects: Array<{ id: string; track: string }> };
    const adversarial = key.defects.filter((d) => d.track === "adversarial").map((d) => d.id).sort();
    expect(adversarial).toEqual([...frozen.existingAdversarialDefects.ids].sort());
    for (const m of frozen.existingAdversarialDefects.mandatory) expect(frozen.existingAdversarialDefects.ids).toContain(m);
  });
});

describe("AI Adversarial Gauntlet fixture", () => {
  it("is a self-contained, bootable Node app with a matched clean control", () => {
    for (const dir of [vulnDir, cleanDir]) {
      expect(existsSync(join(dir, "package.json"))).toBe(true);
      expect(existsSync(join(dir, "src/server.js"))).toBe(true);
      expect(read(dir, "package.json")).toMatch(/"start":\s*"node src\/server\.js"/);
    }
  });

  it("plants at least twelve attack chains across every required lane", () => {
    const chains = frozen.aiAdversarialGauntlet.chains;
    expect(chains.length).toBeGreaterThanOrEqual(12);
    expect(new Set(chains.map((c) => c.id)).size).toBe(chains.length); // ids unique
    const lanes = new Set(chains.map((c) => c.lane));
    for (const lane of LANES) expect(lanes.has(lane), `lane ${lane} is covered`).toBe(true);
    expect(chains.some((c) => c.lane === "multi_stage" && c.chainOf && c.chainOf.length >= 2)).toBe(true);
    expect(chains.filter((c) => c.mustFind).length).toBeGreaterThanOrEqual(8);
  });

  it("each chain names a valid lane, severity and oracle shape", () => {
    for (const c of frozen.aiAdversarialGauntlet.chains) {
      expect(LANES, c.id).toContain(c.lane);
      expect(SEVERITIES, c.id).toContain(c.severity);
      expect(typeof c.mustFind, c.id).toBe("boolean");
      expect(c.entry.length, c.id).toBeGreaterThan(0);
      expect(c.asset.length, c.id).toBeGreaterThan(0);
    }
  });

  it.each(frozen.aiAdversarialGauntlet.chains.map((c) => [c.id, c] as const))("%s is still planted in the vulnerable source", (_id, c) => {
    expect(read(vulnDir, c.anchor.path)).toContain(c.anchor.text);
  });

  it("the clean control does not contain any planted vulnerable anchor", () => {
    for (const c of frozen.aiAdversarialGauntlet.chains) {
      const p = join(cleanDir, c.anchor.path);
      if (!existsSync(p)) continue; // the clean twin may omit a file entirely
      expect(readFileSync(p, "utf8"), `${c.id} must be fixed in the clean control`).not.toContain(c.anchor.text);
    }
  });

  it("the clean control applies the safe counterparts (tenant-scoped retrieval, caller-scoped memory, safe rendering)", () => {
    expect(read(cleanDir, "src/rag.js")).toMatch(/d\.tenant === tenant/);
    expect(read(cleanDir, "src/memory.js")).toMatch(/filter\(\(m\) => m\.userId === userId\)/);
    expect(read(cleanDir, "public/assistant.html")).toMatch(/answer\.textContent = x\.reply/);
    expect(read(cleanDir, "src/app.js")).toMatch(/error: "internal error"/);
  });
});
