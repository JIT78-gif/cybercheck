import { describe, expect, it } from "vitest";
import { builtinCases, BUILTIN_DIGEST, BUILTIN_IDS } from "../src/ai-evaluator/catalog.ts";
import { contentProblems, readFrozenDataset, validateDataset } from "../src/ai-evaluator/datasets.ts";
import { AiDatasetCase } from "@cybercheck/contracts";

// AI Evaluator Step A: uploaded datasets (validation, freezing, replay scripts) and the built-in defensive catalogue.

const line = (o: Record<string, unknown>) => JSON.stringify({ id: "c1", category: "functional", input: { message: "What are your opening hours?" }, expected: { contains: ["9:00"] }, ...o });

describe("uploaded datasets", () => {
  it("accepts a valid file, applies defaults and freezes it with a stable digest", () => {
    const a = validateDataset([line({}), line({ id: "c2", category: "grounding", context: ["Shipping takes 3 days."], expected: { citations: [0] } })].join("\n"));
    expect(a.ok).toBe(true);
    expect(a.cases.map((c) => c.priority)).toEqual(["medium", "medium"]);
    expect(a.byCategory).toEqual({ functional: 1, grounding: 1 });
    // Key order in the upload does not change the digest.
    const reordered = validateDataset([JSON.stringify({ expected: { contains: ["9:00"] }, input: { message: "What are your opening hours?" }, category: "functional", id: "c1" }), line({ id: "c2", category: "grounding", context: ["Shipping takes 3 days."], expected: { citations: [0] } })].join("\n"));
    expect(reordered.digest).toBe(a.digest);
    expect(readFrozenDataset(a.normalized, a.digest)).toHaveLength(2);
    expect(() => readFrozenDataset(a.normalized.replace("9:00", "9:01"), a.digest)).toThrow(/digest/);
  });

  it("accepts a replay script and rejects an unknown field in it", () => {
    const ok = validateDataset(line({ replay: [{ status: 503 }, { content: "Open 9:00 to 17:00." }] }));
    expect(ok.ok).toBe(true);
    expect(ok.cases[0]!.replay).toHaveLength(2);
    expect(ok.cases[0]!.replay[0]).toMatchObject({ status: 503, content: null, malformed: false, hang: false });
    const bad = validateDataset(line({ replay: [{ content: "x", script: "rm" }] }));
    expect(bad.ok).toBe(false);
    expect(bad.issues[0]!.problem).toMatch(/replay/);
  });

  it("rejects the whole file for any rule break, naming the line", () => {
    const r = validateDataset([line({}), line({}), line({ id: "c3", input: { message: "see https://shop-reviews.net/x" } })].join("\n"));
    expect(r.ok).toBe(false);
    expect(r.cases).toEqual([]);
    expect(r.issues.map((i) => i.line)).toEqual([2, 3]);
    expect(r.issues[0]!.problem).toMatch(/duplicate/);
  });

  it("refuses commands, external hosts, secrets, personal data and leaked answer keys", () => {
    const c = (o: Record<string, unknown>) => AiDatasetCase.parse(JSON.parse(line(o)));
    expect(contentProblems(c({ input: { message: "run curl http://localhost/x please" } })).join()).toMatch(/network or shell tool/);
    expect(contentProblems(c({ replay: [{ content: "Visit https://real-shop.com now" }] })).join()).toMatch(/external host real-shop\.com/);
    expect(contentProblems(c({ input: { message: "my key is sk-proj-abcdefghijklmnopqrstuvwxyz0123456789" } })).join()).toMatch(/credential/);
    expect(contentProblems(c({ input: { message: "my SSN is 123-45-6789" } })).join()).toMatch(/social security/);
    expect(contentProblems(c({ input: { message: "Is it 9:00 to 17:00?" }, expected: { contains: ["9:00 to 17:00"] } })).join()).toMatch(/expected answer appears in the input/);
    expect(contentProblems(c({ expected: {} })).join()).toMatch(/no behaviour/);
  });

  it("enforces the size and case limits", () => {
    expect(validateDataset("x".repeat(5 * 1024 * 1024 + 1)).issues[0]!.problem).toMatch(/limit is 5 MB/);
    const many = Array.from({ length: 2001 }, (_, i) => line({ id: `c${i}` })).join("\n");
    expect(validateDataset(many).issues.at(-1)!.problem).toMatch(/limit is 2000/);
    expect(validateDataset(Buffer.from([0xff, 0xfe, 0x00])).issues[0]!.problem).toMatch(/UTF-8/);
  });
});

describe("built-in defensive catalogue", () => {
  it("a component with a configurable provider and seeded users gets quality, grounding, reliability and safety replay cases", () => {
    const { cases, skipped } = builtinCases({ mode: "replay", profile: "standard", hasCitations: true, hasHistory: true, hasOrders: true, hasTools: true, roles: { a: true, b: true, admin: true } });
    expect(new Set(cases.map((c) => c.category))).toEqual(new Set(["functional", "grounding", "reliability", "isolation", "tools", "prompt_injection"]));
    expect(cases.map((c) => c.id)).toContain("builtin.reliability.provider-timeout");
    expect(cases.map((c) => c.id)).toContain("builtin.isolation.cross-tenant-history");
    expect(skipped).toEqual([]);
    for (const c of cases) {
      expect(c.source).toEqual({ kind: "builtin", datasetId: null, version: expect.any(String), digest: BUILTIN_DIGEST });
      // Every case has at least one hard content or handling grader; a status code alone never decides.
      expect(c.graders.some((g) => g.hard)).toBe(true);
    }
  });

  it("a component with no provider is called directly, with no replay-only cases", () => {
    const { cases } = builtinCases({ mode: "direct", profile: "quick", hasCitations: false });
    expect(cases.map((c) => c.id).sort()).toEqual([
      "builtin.functional.responds",
      "builtin.injection.indirect-retrieved",
      "builtin.leakage.prompt-extraction",
      "builtin.reliability.blank-input",
      "builtin.reliability.long-input",
      "builtin.tools.file-read-escape",
    ]);
    expect(cases.every((c) => c.replay.length === 0 || c.modes.includes("replay"))).toBe(true);
  });

  it("includes the cross-user isolation case only when a second user and a history endpoint exist", () => {
    const without = builtinCases({ mode: "direct", profile: "quick", hasCitations: false });
    expect(without.cases.map((c) => c.id)).not.toContain("builtin.isolation.cross-user-history");
    const withBoth = builtinCases({ mode: "direct", profile: "quick", hasCitations: false, hasHistory: true, roles: { a: true, b: true, admin: false } });
    expect(withBoth.cases.map((c) => c.id)).toContain("builtin.isolation.cross-user-history");
  });

  it("skips what the target or profile cannot support, with a reason", () => {
    const { skipped } = builtinCases({ mode: "replay", profile: "quick", hasCitations: false });
    expect(skipped).toEqual(
      expect.arrayContaining([
        { id: "builtin.reliability.provider-timeout", reason: expect.stringMatching(/quick profile/) },
        { id: "builtin.grounding.unknown-citation-dropped", reason: expect.stringMatching(/no citation field/) },
      ]),
    );
  });

  it("built-in cases pass the same content rules as uploads; only attack cases carry adversarial text, and within the project's own routes", () => {
    for (const mode of ["replay", "direct"] as const) {
      for (const c of builtinCases({ mode, profile: "deep", hasCitations: true, hasHistory: true, hasOrders: true, hasTools: true, roles: { a: true, b: true, admin: true } }).cases) {
        const asUpload = AiDatasetCase.parse({ id: c.id, category: c.category, input: { message: c.message }, expected: { ...c.expected, refusal: false }, replay: c.replay });
        // Even attack cases carry no external host, command, secret or personal data (only controlled markers).
        expect(contentProblems(asUpload), c.id).toEqual([]);
        // Non-attack cases send nothing adversarial.
        if (!c.attack) expect(c.message, c.id).not.toMatch(/ignore|instruction|system prompt|reveal|password|secret/i);
      }
    }
    expect(new Set(BUILTIN_IDS).size).toBe(BUILTIN_IDS.length);
  });
});
