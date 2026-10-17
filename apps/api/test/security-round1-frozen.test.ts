import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SecurityRunDetail } from "@cybercheck/contracts";

// Security Round 1, evaluation run 1b, frozen. Round 2 changes the report schema; these runs must keep rendering
// and keep their classification, so the new engine can be compared against them and old runs never break.

const dir = join(import.meta.dirname, "security-bench/round1-frozen");
const read = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));
const frozen = read("classification.json") as { projects: Record<string, { decision: string; findings: Array<{ category: string; status: string; severity: string; location: string | null }> }> };

describe("Round 1 results, frozen", () => {
  it.each([["gauntlet.v1.run.json", "cybercheck-gauntlet"], ["control.v1.run.json", "clean-node-control"]])("%s still parses as a Security run", (file, project) => {
    const run = SecurityRunDetail.parse(read(file));
    expect(run.report?.schemaVersion).toBe(1);
    expect(run.report?.decision).toBe(frozen.projects[project]!.decision);
    expect(run.findings.map((f) => `${f.category}:${f.status}`)).toEqual(frozen.projects[project]!.findings.map((f) => `${f.category}:${f.status}`));
  });

  it("pins what Round 1 found on the gauntlet and that the clean control stayed clean", () => {
    const g = frozen.projects["cybercheck-gauntlet"]!.findings;
    expect(g.filter((f) => f.status === "confirmed").map((f) => f.category).sort()).toEqual(["cors", "dependencies"]);
    expect(g).toHaveLength(13);
    expect(frozen.projects["clean-node-control"]!.findings).toEqual([]);
  });
});
