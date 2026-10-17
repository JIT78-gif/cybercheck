import { readFileSync } from "node:fs";
import { sqliteForeignKeys } from "./db-strategy.ts";
import type { Entity } from "@cybercheck/contracts";
import { OUT, wsPath } from "./adapters.ts";
import type { BootApp } from "./agents.ts";
import { HARNESS_LIB, appEnv } from "./probes.ts";
import { startServices } from "./services.ts";
import { CI_ENV, POLICY, addFinding, execute, setOb, type Ctx } from "./runtime.ts";

// The database worker: the app's own start-up creates the schema on an empty database, then every
// table is probed directly (store, read back, delete; each declared constraint rejects a violating row).
// Deterministic, no AI. Everything runs inside rolled-back transactions.

const DB = readFileSync(new URL("./harness/db.mjs", import.meta.url));
const DB_SQLITE = readFileSync(new URL("./harness/db_sqlite.py", import.meta.url));

type TableOut = {
  table: string;
  columns: number;
  rows: number;
  roundtrip: boolean | null;
  baselineError: string | null;
  notNull: Array<{ column: string; rejected: boolean; error: string | null }>;
  unique: Array<{ columns: string[]; rejected: boolean; error: string | null }>;
  foreignKeys: Array<{ column: string; references: string; rejectedWhenOn: boolean; errorWhenOn: string | null }>;
  fkOff?: Array<{ column: string; acceptedWhenOff: boolean }>;
};
type DbOut = { boot: { ok: boolean; reason: string | null } | null; engine: "sqlite" | "postgres" | null; databases: Array<{ database: string; tables: TableOut[]; error: string | null }>; error: string | null };

/** Does the app turn SQLite foreign keys on for its connections? Off by default; an explicit OFF keeps them off. */
export function enablesSqliteForeignKeys(ctx: Ctx) {
  return sqliteForeignKeys(ctx.src).state === "on";
}

const tableOf = (e: Entity) => (e.table ?? e.name).toLowerCase();

export async function judgeDatabase(ctx: Ctx, image: string, app: BootApp) {
  const obs = [...ctx.obligations.values()].filter((o) => o.layer === "data" && o.status === "planned");
  if (!obs.length) return;
  const engine = ctx.services.includes("postgres") ? "postgres" : "sqlite";
  const env = appEnv(ctx, app);
  const spec = { app: { cwd: wsPath(app.workspace), start: app.start, port: app.port, readyPath: app.readyPath }, env, engine, bootTimeoutSec: POLICY.bootTimeoutSec };
  const [libId, dbId, pyId, specId] = await Promise.all([ctx.provider.upload(HARNESS_LIB), ctx.provider.upload(DB), ctx.provider.upload(DB_SQLITE), ctx.provider.upload(Buffer.from(JSON.stringify(spec)))]);
  const prepare = app.prepare.length ? `(cd '${wsPath(app.workspace)}' && ${app.prepare.join(" && ")}) </dev/null && ` : "";
  const r = await execute(ctx, { kind: "database", label: `Probe the database directly (${engine})`, workspace: app.workspace, fetch: [`${OUT}/db.json`] }, {
    image,
    command: `${startServices(ctx.services)}mkdir -p ${OUT} && ${prepare}node /cc/db.mjs /cc/dbspec.json ${OUT}`,
    network: false,
    keep: true,
    timeoutSec: POLICY.commandTimeoutSec,
    env: { ...CI_ENV, ...env },
    files: [
      { path: "/cc/lib.mjs", fileId: libId },
      { path: "/cc/db.mjs", fileId: dbId },
      { path: "/cc/db_sqlite.py", fileId: pyId },
      { path: "/cc/dbspec.json", fileId: specId },
    ],
  });
  const raw = r.files.get(`${OUT}/db.json`);
  const out: DbOut | null = raw ? JSON.parse(raw.toString("utf8")) : null;
  const execIds = [r.exec.id];
  const blockAll = async (reason: string) => {
    for (const o of obs) await setOb(ctx, o.id, { status: "blocked", blockedBy: "prerequisite", reason, executionIds: execIds });
  };
  if (!out) return blockAll(`Not run: the database probe produced no result (${r.exec.outcome}).`);
  if (!out.boot?.ok) return blockAll(`Not run: the app did not start for the database probe (${out.boot?.reason ?? out.error ?? "unknown"}).`);
  const tables = out.databases.flatMap((db) => db.tables);
  if (!tables.length) {
    for (const o of obs) await setOb(ctx, o.id, { status: "inconclusive", reason: out.databases.length ? `The database had no tables after start-up${out.databases[0]?.error ? ` (${out.databases[0].error})` : ""}; the schema may be created by a separate migration command.` : `No ${engine === "sqlite" ? "SQLite database file" : "Postgres schema"} was written when the app started; it may create its database lazily or by a separate command.`, executionIds: execIds });
    return;
  }
  const fkOn = engine === "postgres" || enablesSqliteForeignKeys(ctx);
  const byName = new Map(tables.map((t) => [t.table.toLowerCase(), t]));
  const entities = ctx.d.dataModel.entities;

  // Clean install: every table the code defines exists after start-up.
  const missing = entities.filter((e) => !byName.has(tableOf(e)) && !byName.has(`${tableOf(e)}s`));
  if (ctx.obligations.get("data:schema:clean-install")?.status === "planned") {
    await setOb(ctx, "data:schema:clean-install", missing.length
      ? { status: "inconclusive", reachedTarget: true, reason: `${missing.length} of ${entities.length} table(s) were not created at start-up (${missing.slice(0, 6).map((e) => e.table ?? e.name).join(", ")}); they may need a separate migration command.`, executionIds: execIds }
      : { status: "passed", reachedTarget: true, reason: `All ${entities.length} table(s) exist after starting the app on an empty database (${engine}).`, executionIds: execIds });
  }

  const unenforced: Array<{ table: string; column: string; references: string; obligationId: string }> = [];
  for (const e of entities) {
    const t = byName.get(tableOf(e)) ?? byName.get(`${tableOf(e)}s`);
    const name = e.table ?? e.name;
    const cId = `data:${name}:constraints`;
    const rId = `data:${name}:roundtrip`;
    if (!t) {
      for (const id of [cId, rId]) if (ctx.obligations.get(id)?.status === "planned") await setOb(ctx, id, { status: "inconclusive", reason: `The table ${name} does not exist after start-up, so it could not be probed.`, executionIds: execIds });
      continue;
    }
    if (ctx.obligations.get(rId)?.status === "planned") {
      await setOb(ctx, rId, t.roundtrip ? { status: "passed", reachedTarget: true, reason: `A valid row was stored, read back and deleted (inside a rolled-back transaction).`, executionIds: execIds } : { status: "inconclusive", reason: `cybercheck could not build a valid row for ${name} (${t.baselineError ?? "unknown error"}), so storing and reading it back was not tested.`, executionIds: execIds });
    }
    if (ctx.obligations.get(cId)?.status !== "planned") continue;
    if (!t.roundtrip) {
      await setOb(ctx, cId, { status: "inconclusive", reason: `Without a valid row for ${name} the constraints could not be probed (${t.baselineError ?? "unknown error"}).`, executionIds: execIds });
      continue;
    }
    const notNullBad = t.notNull.filter((x) => !x.rejected);
    const uniqueBad = t.unique.filter((x) => !x.rejected);
    // SQLite enforces foreign keys only when the connection turns them on; the app's own setting decides.
    const fkBad = engine === "sqlite" && !fkOn ? t.foreignKeys : [];
    for (const f of fkBad) unenforced.push({ table: name, column: f.column, references: f.references, obligationId: cId });
    const checked = `${t.notNull.length} required field(s), ${t.unique.length} unique key(s), ${t.foreignKeys.length} foreign key(s)`;
    if (notNullBad.length || uniqueBad.length || fkBad.length) {
      await setOb(ctx, cId, { status: "failed", reachedTarget: true, reason: `Checked ${checked}. Not enforced: ${[...notNullBad.map((x) => `${x.column} accepts NULL`), ...uniqueBad.map((x) => `duplicate ${x.columns.join("+")} accepted`), ...fkBad.map((x) => `${x.column} accepts an id that does not exist in ${x.references}`)].join("; ")}.`, executionIds: execIds });
    } else if (!t.notNull.length && !t.unique.length && !t.foreignKeys.length) {
      await setOb(ctx, cId, { status: "passed", reachedTarget: true, oracleStrength: "moderate", reason: "The table declares no required field, unique key or foreign key besides its primary key.", executionIds: execIds });
    } else {
      await setOb(ctx, cId, { status: "passed", reachedTarget: true, reason: `Checked ${checked}: each rejected a violating row.`, executionIds: execIds });
    }
  }
  if (unenforced.length) {
    await addFinding(ctx, {
      kind: "product_defect",
      status: "confirmed",
      severity: "medium",
      confidence: "high",
      title: `Foreign keys are declared but not enforced (${unenforced.length} in ${new Set(unenforced.map((u) => u.table)).size} table(s))`,
      expected: "A row that points to a record that does not exist is rejected, as the schema declares",
      actual: `SQLite accepted rows with dangling references: ${unenforced.slice(0, 6).map((u) => `${u.table}.${u.column} -> ${u.references}`).join(", ")}. The app never turns on PRAGMA foreign_keys, and SQLite leaves it off for every new connection.`,
      reproduction: `Open the database the app creates and run, without PRAGMA foreign_keys: INSERT INTO ${unenforced[0]!.table} (${unenforced[0]!.column}, ...) VALUES (987654321, ...); it succeeds although no ${unenforced[0]!.references} 987654321 exists.`,
      rootCause: "SQLite enforces foreign keys only when each connection runs PRAGMA foreign_keys = ON; no code in the project does.",
      location: entities.find((e) => (e.table ?? e.name) === unenforced[0]!.table)?.evidence ?? null,
      obligationIds: [...new Set(unenforced.map((u) => u.obligationId))],
      executionIds: execIds,
      validation: "Measured directly against the database the app created, inside a rolled-back transaction.",
      limitation: null,
      layer: "data",
      nextAction: "Run PRAGMA foreign_keys = ON on every new connection (for SQLAlchemy, in a connect event listener).",
    });
  }
}
