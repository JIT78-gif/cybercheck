import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/understanding/analyze.ts";
import { fixtureSource } from "./fixture-source.ts";
import { score } from "./golden-score.ts";

// Every acceptance fixture must match its hand-checked answer key exactly and pass every gate.
const dir = join(import.meta.dirname, "golden");
const goldens = readdirSync(dir).filter((f) => f.endsWith(".golden.json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));

describe("analyzer acceptance fixtures", () => {
  for (const g of goldens) {
    it(`${g.fixture} matches its answer key`, async () => {
      const src = fixtureSource(g.fixture);
      const d = await analyzeSource(src, { snapshotId: g.fixture, contentDigest: "test" });
      const { metrics, gates } = score(d, g, src);
      expect(metrics.filter((m) => m.found !== m.expected).map((m) => `${m.name}: ${m.found}/${m.expected} ${(m.detail ?? []).join("; ")}`)).toEqual([]);
      expect(gates.filter((x) => !x.ok).map((x) => `${x.name}: ${x.detail}`)).toEqual([]);
    });
  }
});
