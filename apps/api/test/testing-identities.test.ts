import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { completeIdentities, type Identity } from "../src/testing/agents.ts";
import { seededAccounts } from "../src/testing/fixtures.ts";

const dir = join(import.meta.dirname, "testing-bench/cybercheck-gauntlet/project");
const files = new Map<string, { path: string; text: string; lines: number }>();
const walk = (d: string) => {
  for (const n of readdirSync(d)) {
    const full = join(d, n);
    if (n === "node_modules") continue;
    if (statSync(full).isDirectory()) walk(full);
    else {
      const p = relative(dir, full).replace(/\\/g, "/");
      const text = readFileSync(full, "utf8");
      files.set(p, { path: p, text, lines: text.split("\n").length });
    }
  }
};
walk(dir);
const gauntlet = { files, allPaths: [...files.keys()] } as never;
const d = { entryPoints: [{ method: "POST", path: "/api/login" }, { method: "GET", path: "/api/orders" }] } as never;
const login = (json: Record<string, string>): Identity => ({ name: "customer", kind: "login", appliesTo: ["session_required"], request: { method: "POST", path: "/api/login", json }, tokenPath: "token", dependsOn: [], verify: null, evidence: [] });
const names = (ids: Identity[]) => ids.map((i) => `${i.name}:${(i.request?.json as { email?: string } | undefined)?.email}`);

describe("sign-ins from the accounts the project seeds", () => {
  it("reads seed records from the code, never from the README", () => {
    expect(seededAccounts(gauntlet).map((a) => [a.account, a.role, a.at.path])).toEqual([
      ["alice@example.test", "customer", "src/store.js"],
      ["bob@example.test", "customer", "src/store.js"],
      ["admin@example.test", "admin", "src/store.js"],
    ]);
  });

  it("plans every seeded account when the planner proposed none (rounds 48 and 50)", () => {
    const ids = completeIdentities([], d, gauntlet);
    expect(names(ids)).toEqual(["customer:alice@example.test", "customer-2:bob@example.test", "admin:admin@example.test"]);
    expect(ids.find((i) => i.name === "admin")!.appliesTo).toEqual(["session_required", "role_required"]);
    expect(ids[0]!.evidence).toEqual([{ path: "src/store.js", line: 2 }]);
  });

  it("gives a seeded account its seeded password instead of a generated CC_ one, and adds the others in its shape", () => {
    // The round 50 diagnostic: one sign-in, Alice, with ${ENV:CC_ALICE_PASSWORD} (a random value that cannot log in).
    const ids = completeIdentities([login({ email: "alice@example.test", password: "${ENV:CC_ALICE_PASSWORD}" })], d, gauntlet);
    expect((ids[0]!.request!.json as { password: string }).password).toBe("AlicePass123!");
    expect(names(ids)).toEqual(["customer:alice@example.test", "customer-2:bob@example.test", "admin:admin@example.test"]);
    expect(ids.every((i) => i.tokenPath === "token")).toBe(true);
  });

  it("leaves a project without seeded accounts or a login route as planned", () => {
    const plain = { files: new Map([["src/app.js", { path: "src/app.js", text: "app.get('/health')", lines: 1 }]]), allPaths: ["src/app.js"] } as never;
    expect(completeIdentities([], d, plain)).toEqual([]);
    expect(completeIdentities([], { entryPoints: [] } as never, gauntlet)).toEqual([]);
  });
});
