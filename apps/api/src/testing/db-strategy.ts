import type { DatabaseStrategy, ProjectDossier } from "@cybercheck/contracts";
import type { SnapshotSource } from "../understanding/source.ts";
import { addFinding, setOb, type Ctx } from "./runtime.ts";

// How the database lane checks integrity (the 9+/10 plan, section 4). A file SQLite database or a sandbox Postgres is
// inspected directly by another process. An in-memory database lives only inside the app process: nothing can open
// it from outside, so it is judged from its schema and SQLite's own rules, and through the running app.

const TEST_FILE = /(\.|\/)(test|spec)\.|(^|\/)(tests?|__tests__|spec)\//;
const code = (src: SnapshotSource) => [...src.files.entries()].filter(([p]) => /\.(c|m)?[jt]sx?$|\.py$|\.sql$/.test(p) && !TEST_FILE.test(p) && !p.includes("node_modules/"));

const SQLITE_LIB = /node:sqlite|better-sqlite3|require\(\s*["']sqlite3?["']\s*\)|from\s+["']sqlite3?["']|import\s+sqlite3|sqlite:\/\/|aiosqlite|DatabaseSync/;
const MEMORY = /["'`]:memory:["'`]|sqlite:\/\/\/?:memory:|mode=memory/;

/** Which database strategy fits the project. */
export function databaseStrategy(d: Pick<ProjectDossier, "integrations" | "dataModel">, src: SnapshotSource, services: string[]): DatabaseStrategy {
  if (services.includes("postgres")) return "direct_postgres";
  const files = code(src);
  const sqlite = d.integrations.some((i) => i.category === "database" && /sqlite/i.test(i.name)) || d.dataModel.sources.some((s) => /sqlite/i.test(s)) || files.some(([, f]) => SQLITE_LIB.test(f.text));
  if (!sqlite) return "none";
  const memory = files.some(([, f]) => MEMORY.test(f.text));
  const fileDb = files.some(([, f]) => /["'`][^"'`\s]+\.(db|sqlite3?)["'`]|sqlite:\/\/\/[^:]/.test(f.text));
  return memory && !fileDb ? "api_level" : "direct_sqlite_file";
}

/**
 * Whether the app turns SQLite foreign keys on. They are off by default for every connection, and an explicit
 * "PRAGMA foreign_keys = OFF" keeps them off: only an explicit ON (1, true) enables them.
 */
export function sqliteForeignKeys(src: SnapshotSource): { state: "on" | "off" | "default_off"; at: { path: string; line: number } | null } {
  let off: { path: string; line: number } | null = null;
  let on: { path: string; line: number } | null = null;
  for (const [path, f] of code(src)) {
    const lines = f.text.split("\n");
    lines.forEach((l, i) => {
      if (/foreign_keys\s*(=|\()\s*["']?(OFF|0|false|no)\b/i.test(l)) off ??= { path, line: i + 1 };
      else if (/foreign_keys\s*(=|\()\s*["']?(ON|1|true|yes)\b|foreign_keys["']?\s*:\s*(true|1)\b/i.test(l)) on ??= { path, line: i + 1 };
    });
  }
  if (off) return { state: "off", at: off };
  if (on) return { state: "on", at: on };
  return { state: "default_off", at: null };
}

/** The requirement id of the referential-integrity check built for a declared foreign key (see templates.ts). */
export const fkRequirementId = (table: string, column: string) => `req-fk-${table}-${column}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-");

/** Foreign keys declared in SQL schema text: "customer_id INTEGER REFERENCES customers(id)". */
export function declaredForeignKeys(src: SnapshotSource): Array<{ table: string; column: string; references: string; at: { path: string; line: number } }> {
  const out: Array<{ table: string; column: string; references: string; at: { path: string; line: number } }> = [];
  for (const [path, f] of code(src)) {
    for (const t of f.text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?\s*\(([\s\S]*?)\)\s*;/gi)) {
      const body = t[2]!;
      for (const c of body.matchAll(/["`]?(\w+)["`]?\s+\w+[^,]*?\bREFERENCES\s+["`]?(\w+)["`]?/gi)) {
        // A table constraint (FOREIGN KEY (...) REFERENCES ...) is read below, not as a column.
        if (/^(FOREIGN|CONSTRAINT|PRIMARY|UNIQUE|CHECK|KEY)$/i.test(c[1]!)) continue;
        out.push({ table: t[1]!, column: c[1]!, references: c[2]!, at: { path, line: f.text.slice(0, t.index! + t[0].indexOf(c[0])).split("\n").length } });
      }
      for (const c of body.matchAll(/FOREIGN\s+KEY\s*\(\s*["`]?(\w+)["`]?\s*\)\s*REFERENCES\s+["`]?(\w+)["`]?/gi)) {
        out.push({ table: t[1]!, column: c[1]!, references: c[2]!, at: { path, line: f.text.slice(0, t.index!).split("\n").length } });
      }
    }
  }
  return out;
}

/**
 * The database lane for an in-memory SQLite database: required fields and unique keys are enforced by SQLite on every
 * connection, foreign keys only when the app turns them on. Nothing here runs against the database, so every check
 * stays inconclusive with the static observation as its reason (an unenforced foreign key is a suspected finding);
 * integrity through the app is decided by the API scenarios, which cite their executions.
 */
export async function judgeInMemoryDatabase(ctx: Ctx) {
  const obs = [...ctx.obligations.values()].filter((o) => o.layer === "data" && o.status === "planned");
  if (!obs.length) return;
  const fks = declaredForeignKeys(ctx.src);
  const pragma = sqliteForeignKeys(ctx.src);
  // A foreign key the running app was already checked on (delete a parent, read the children) needs no static guess.
  const viaApp = (f: (typeof fks)[number]) => [...ctx.obligations.values()].find((o) => o.requirementIds?.includes(fkRequirementId(f.table, f.column)) && (o.status === "passed" || o.status === "failed"));
  const unenforced = pragma.state === "on" ? [] : fks.filter((f) => !viaApp(f));
  const checked = fks.flatMap((f) => (viaApp(f) ? [{ f, o: viaApp(f)! }] : []));
  const why = pragma.state === "off" ? `the app turns enforcement off explicitly (${pragma.at!.path}:${pragma.at!.line})` : "the app never turns PRAGMA foreign_keys on, and SQLite leaves it off for every connection";
  const NOTE = "Decided from the schema and SQLite's documented rules: an in-memory database lives only inside the app process, so it was not inspected directly.";
  for (const o of obs) {
    const table = o.asset.label;
    if (o.id.endsWith(":constraints")) {
      // Nothing ran against the database, so this is a static observation: never a pass or a failure on its own.
      const bad = unenforced.filter((f) => f.table.toLowerCase() === table.toLowerCase());
      const app = checked.filter((c) => c.f.table.toLowerCase() === table.toLowerCase());
      const seen = app.length
        ? `Checked through the running app instead: ${app.map((c) => `${c.f.column} -> ${c.f.references} ${c.o.status} (${c.o.id})`).join(", ")}.`
        : bad.length
        ? `Static observation only: foreign key(s) ${bad.map((f) => `${f.column} -> ${f.references}`).join(", ")} are declared but not enforced, because ${why}. Recorded as a suspected finding until the running app shows an orphan row.`
        : `Static observation only: SQLite enforces required fields and unique keys on every connection${fks.some((f) => f.table.toLowerCase() === table.toLowerCase()) ? ", and the app turns foreign keys on" : "; the table declares no foreign key"}.`;
      await setOb(ctx, o.id, { status: "inconclusive", blockedBy: "capability", reachedTarget: false, reason: `${seen} ${NOTE}`, executionIds: [] });
    } else {
      await setOb(ctx, o.id, { status: "inconclusive", blockedBy: "capability", reason: `The database is in memory inside the app process, so it cannot be opened from outside; ${o.id.endsWith(":roundtrip") ? "storing and reading records is checked through the app's own endpoints instead" : "its tables exist only while the app runs"}.`, executionIds: [] });
    }
  }
  if (unenforced.length) {
    const first = unenforced[0]!;
    await addFinding(ctx, {
      kind: "product_defect",
      // Code evidence and SQLite's rules, not a reproduction: suspected until the app itself shows an orphan.
      status: "suspected",
      severity: "medium",
      confidence: "high",
      title: `SQLite foreign keys are not enforced: ${unenforced.slice(0, 3).map((f) => `${f.table}.${f.column} can point to a deleted ${f.references} row`).join("; ")}`,
      expected: "A declared foreign key rejects a row whose parent does not exist, and deleting a parent with children is refused or cascades",
      actual: `${unenforced.length} foreign key(s) are declared (${unenforced.map((f) => `${f.table}.${f.column} -> ${f.references}`).join(", ")}), but ${why}. SQLite then accepts orphan rows silently.`,
      reproduction: `Start the app, delete a ${first.references} row that has ${first.table} rows referring to it, then read those ${first.table} rows: they still point to the deleted ${first.references} id.`,
      rootCause: "SQLite enforces foreign keys only on connections that run PRAGMA foreign_keys = ON.",
      location: pragma.at ?? first.at,
      obligationIds: obs.filter((o) => o.id.endsWith(":constraints") && unenforced.some((f) => f.table.toLowerCase() === o.asset.label.toLowerCase())).map((o) => o.id),
      executionIds: [],
      validation: "Found in the code: the schema declares the keys and the connection setting leaves them unenforced (SQLite's documented behaviour).",
      limitation: "Not reproduced against the running app yet: the in-memory database cannot be opened from outside.",
      layer: "data",
      nextAction: "Run PRAGMA foreign_keys = ON right after opening each connection, and decide what deleting a parent should do (refuse or cascade).",
    });
  }
}
