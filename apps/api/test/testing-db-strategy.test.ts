import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { databaseStrategy, declaredForeignKeys, judgeInMemoryDatabase, sqliteForeignKeys } from "../src/testing/db-strategy.ts";

function source(dir: string) {
  const files = new Map<string, { text: string }>();
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (name === "node_modules") continue;
      if (statSync(full).isDirectory()) walk(full);
      else files.set(relative(dir, full).replace(/\\/g, "/"), { text: readFileSync(full, "utf8") });
    }
  };
  walk(dir);
  return { files, allPaths: [...files.keys()] } as never;
}
const mem = (entries: Record<string, string>) => ({ files: new Map(Object.entries(entries).map(([k, text]) => [k, { text }])), allPaths: Object.keys(entries) }) as never;
const noDb = { integrations: [], dataModel: { sources: [], entities: [] } } as never;

describe("database strategy", () => {
  const gauntlet = source(join(import.meta.dirname, "testing-bench/cybercheck-gauntlet/project"));

  it("checks the Gauntlet's in-memory SQLite through the app, and sees that it switches foreign keys off", () => {
    expect(databaseStrategy(noDb, gauntlet, [])).toBe("api_level");
    expect(sqliteForeignKeys(gauntlet)).toEqual({ state: "off", at: { path: "src/database.js", line: 4 } });
    expect(declaredForeignKeys(gauntlet)).toEqual([{ table: "data_orders", column: "customer_id", references: "customers", at: { path: "src/database.js", line: 7 } }]);
  });

  it("opens a file database or Postgres directly, and has no strategy without a database", () => {
    expect(databaseStrategy(noDb, mem({ "db.js": `const db = new Database("data/app.sqlite"); require("better-sqlite3")` }), [])).toBe("direct_sqlite_file");
    expect(databaseStrategy(noDb, mem({ "db.py": "import sqlite3\nconn = sqlite3.connect(':memory:')" }), [])).toBe("api_level");
    expect(databaseStrategy(noDb, mem({ "a.js": "x" }), ["postgres"])).toBe("direct_postgres");
    expect(databaseStrategy(noDb, mem({ "a.js": "app.listen(3000)" }), [])).toBe("none");
  });

  it("counts only an explicit ON as foreign keys enforced", () => {
    expect(sqliteForeignKeys(mem({ "db.js": `db.exec("PRAGMA foreign_keys = ON");` })).state).toBe("on");
    expect(sqliteForeignKeys(mem({ "db.py": `cur.execute("PRAGMA foreign_keys=1")` })).state).toBe("on");
    expect(sqliteForeignKeys(mem({ "db.js": `new Database(f, { foreign_keys: true })` })).state).toBe("on");
    expect(sqliteForeignKeys(mem({ "db.js": `db.pragma("foreign_keys = OFF")` })).state).toBe("off");
    expect(sqliteForeignKeys(mem({ "db.js": `const db = new Database(":memory:")` })).state).toBe("default_off");
    // A test turning them on says nothing about the app.
    expect(sqliteForeignKeys(mem({ "test/db.test.js": `db.exec("PRAGMA foreign_keys = ON")` })).state).toBe("default_off");
  });

  it("reads foreign keys declared inline and as table constraints", () => {
    const fks = declaredForeignKeys(mem({ "schema.sql": "CREATE TABLE IF NOT EXISTS items (\n  id INTEGER PRIMARY KEY,\n  order_id INTEGER NOT NULL,\n  FOREIGN KEY (order_id) REFERENCES orders(id)\n);" }));
    expect(fks.map((f) => `${f.table}.${f.column}->${f.references}`)).toEqual(["items.order_id->orders"]);
  });
});

describe("in-memory database lane", () => {
  const gauntlet = source(join(import.meta.dirname, "testing-bench/cybercheck-gauntlet/project"));
  const ob = (id: string, label: string) => ({ id, layer: "data", status: "planned", asset: { label }, executionIds: [], findingIds: [] });

  it("never passes or fails a check without an execution, and keeps the unenforced foreign key a suspected finding", async () => {
    const obs = [ob("data:data_orders:constraints", "data_orders"), ob("data:customers:constraints", "customers"), ob("data:customers:roundtrip", "customers")];
    const findings: Array<Record<string, unknown>> = [];
    const ctx = { src: gauntlet, obligations: new Map(obs.map((o) => [o.id, o])), findings, store: { putObligations: async () => {}, putFinding: async () => {} } } as never;
    await judgeInMemoryDatabase(ctx);
    for (const o of obs) {
      expect(o.status, o.id).toBe("inconclusive");
      expect(o).toMatchObject({ blockedBy: "capability", executionIds: [] });
    }
    expect((obs[0] as { reason?: string }).reason).toMatch(/^Static observation only: foreign key\(s\) customer_id -> customers are declared but not enforced/);
    expect((obs[1] as { reason?: string }).reason).toMatch(/^Static observation only: SQLite enforces required fields and unique keys/);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ status: "suspected", executionIds: [], obligationIds: ["data:data_orders:constraints"], location: { path: "src/database.js", line: 4 } });
    expect(obs[0]!.findingIds).toEqual(["F1"]);
  });

  it("leaves the verdict to the app-level check of a foreign key when that check ran", async () => {
    const obs: Array<Record<string, unknown> & { id: string; status: string; executionIds: string[]; findingIds: string[] }> = [ob("data:data_orders:constraints", "data_orders"), { ...ob("req:req-fk-data-orders-customer-id:tpl:req-fk-data-orders-customer-id", "x"), layer: "api", status: "failed", requirementIds: ["req-fk-data-orders-customer-id"], executionIds: ["e1"] }];
    const findings: unknown[] = [];
    const ctx = { src: gauntlet, obligations: new Map(obs.map((o) => [o.id, o])), findings, store: { putObligations: async () => {}, putFinding: async () => {} } } as never;
    await judgeInMemoryDatabase(ctx);
    expect(findings).toEqual([]);
    expect(obs[0]).toMatchObject({ status: "inconclusive", reason: expect.stringMatching(/^Checked through the running app instead: customer_id -> customers failed \(req:req-fk-data-orders-customer-id/) });
  });
});
