// cybercheck database harness. Runs INSIDE the sandbox (network disabled), never on the host.
// Usage: node db.mjs <spec.json> <out-dir>
// Starts the app on an empty database so its own start-up creates the schema, then probes the
// database directly: SQLite files with db_sqlite.py, Postgres (the local test server) through pg.
// Every probe runs inside a transaction that is rolled back. Writes <out-dir>/db.json.
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ensureDirs, run, sleep, startApp, stopApp } from "./lib.mjs";

const [specPath, outDir] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specPath, "utf8"));
mkdirSync(outDir, { recursive: true });
const env = { ...process.env, ...spec.env };
ensureDirs(spec.env ?? {});
const result = { boot: null, engine: null, databases: [], error: null };
const save = () => writeFileSync(`${outDir}/db.json`, JSON.stringify(result));

/** SQLite files written since the app started (header "SQLite format 3"), outside dependency folders. */
function sqliteFiles(roots, since) {
  const out = [];
  const skip = /node_modules|\/\.git|\/venv|\/\.venv|site-packages|\/proc|\/sys|\/opt\/cc-/;
  const walk = (dir, depth) => {
    if (depth > 6 || skip.test(dir)) return;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile()) {
        try {
          const st = statSync(p);
          if (st.size < 100 || st.mtimeMs < since - 1000) continue;
          const fd = openSync(p, "r");
          const buf = Buffer.alloc(16);
          readSync(fd, buf, 0, 16, 0);
          closeSync(fd);
          if (buf.toString("latin1") === "SQLite format 3\u0000") out.push(p);
        } catch {}
      }
    }
  };
  for (const r of roots) walk(r, 0);
  return [...new Set(out)];
}

async function postgres(url) {
  const { default: pg } = await import("/opt/cc-tools/node_modules/pg/lib/index.js");
  const c = new pg.Client({ connectionString: url });
  c.on("error", () => {});
  await c.connect();
  // Simple-protocol queries with escaped literals: the local Postgres stand-in (PGlite) mishandles
  // parameterised (extended-protocol) queries after an error inside a transaction.
  const lit = (v) =>
    v === null || v === undefined ? "NULL" : typeof v === "number" ? String(v) : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : c.escapeLiteral(typeof v === "object" ? (Array.isArray(v) ? `{${v.join(",")}}` : JSON.stringify(v)) : String(v));
  const sq = (text, params = []) => c.query(params.length ? text.replace(/\$(\d+)/g, (_m, i) => lit(params[Number(i) - 1])) : text);
  const q = (n) => `"${String(n).replace(/"/g, '""')}"`;
  // Array columns are aggregated as text and split here: name[] values are not parsed by every client.
  const list = (v) => (Array.isArray(v) ? v : String(v ?? "").replace(/^\{|\}$/g, "").split(",").filter(Boolean).map((x) => x.replace(/^"|"$/g, "")));

  const tables = (await sq("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name NOT IN ('_prisma_migrations','__drizzle_migrations','alembic_version','knex_migrations','knex_migrations_lock','schema_migrations')")).rows.map((r) => r.table_name);
  const meta = {};
  for (const t of tables) {
    const cols = (await sq("SELECT column_name, data_type, is_nullable, column_default, udt_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [t])).rows;
    const cons = (await sq("SELECT con.contype, string_agg(att.attname::text, ',' ORDER BY att.attnum) cols, confrel.relname::text ref_table, (SELECT string_agg(a2.attname::text, ',') FROM pg_attribute a2 WHERE a2.attrelid = con.confrelid AND a2.attnum = ANY(con.confkey)) ref_cols FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = ANY(con.conkey) LEFT JOIN pg_class confrel ON confrel.oid = con.confrelid WHERE rel.relname=$1 GROUP BY con.oid, con.contype, confrel.relname", [t])).rows.map((r) => ({ ...r, cols: list(r.cols), ref_cols: list(r.ref_cols) }));
    const enums = {};
    for (const col of cols.filter((x) => x.data_type === "USER-DEFINED")) enums[col.column_name] = (await sq("SELECT e.enumlabel FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid WHERE ty.typname=$1 ORDER BY e.enumsortorder LIMIT 1", [col.udt_name])).rows[0]?.enumlabel;
    // CHECK (role IN ('a','b')) and CHECK (n >= 0) give usable values.
    const checks = (await sq("SELECT pg_get_constraintdef(con.oid) def FROM pg_constraint con JOIN pg_class rel ON rel.oid = con.conrelid WHERE rel.relname=$1 AND con.contype='c'", [t])).rows.map((r) => r.def);
    meta[t] = { cols, cons, enums, checks };
  }
  let n = 0;
  const sample = (t, col) => {
    n++;
    const m = meta[t];
    if (m.enums[col.column_name] !== undefined) return m.enums[col.column_name];
    for (const def of m.checks) {
      const inList = def.match(new RegExp(`${col.column_name}\\)?(?:::text)?\\s*=\\s*ANY\\s*\\(\\s*\\(?ARRAY\\[\\s*'([^']*)'`));
      if (inList) return inList[1];
      const ge = def.match(new RegExp(`${col.column_name}\\)?\\s*(>=|>)\\s*\\(?(-?\\d+)`));
      if (ge) return Number(ge[2]) + (ge[1] === ">" ? 1 : 0);
    }
    const ty = col.data_type;
    if (/int|numeric|double|real|decimal/.test(ty)) return 100000 + n;
    if (/bool/.test(ty)) return true;
    if (/timestamp|date/.test(ty)) return "2026-01-01T00:00:00Z";
    if (/uuid/.test(ty)) return `00000000-0000-4000-8000-${String(100000000000 + n).slice(-12)}`;
    if (/json/.test(ty)) return {};
    if (/ARRAY/.test(ty)) return [];
    return `cc_${col.column_name}_${n}`;
  };
  /** A valid row for a table: required foreign keys get a parent row created first (inside the same transaction). */
  const insert = async (t, overrides = {}, depth = 0) => {
    const m = meta[t];
    const v = {};
    for (const col of m.cols) {
      if (col.column_name in overrides) continue;
      const fk = m.cons.find((x) => x.contype === "f" && x.cols.includes(col.column_name));
      if (fk) {
        if (col.is_nullable === "YES" || depth > 3 || !meta[fk.ref_table]) continue;
        const parent = await insert(fk.ref_table, {}, depth + 1);
        v[col.column_name] = parent[fk.ref_cols[fk.cols.indexOf(col.column_name)] ?? "id"];
        continue;
      }
      if (col.column_default) continue; // serials and defaults
      v[col.column_name] = sample(t, col);
    }
    Object.assign(v, overrides);
    const names = Object.keys(v);
    const sql = names.length ? `INSERT INTO ${q(t)} (${names.map(q).join(",")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *` : `INSERT INTO ${q(t)} DEFAULT VALUES RETURNING *`;
    return (await sq(sql, names.map((k) => v[k]))).rows[0];
  };
  const attempt = async (fn) => {
    await sq("BEGIN");
    try {
      await fn();
      return null;
    } catch (e) {
      return String(e.message).slice(0, 300);
    } finally {
      await sq("ROLLBACK").catch(() => {});
    }
  };
  const out = [];
  for (const t of tables) {
    const m = meta[t];
    const pk = m.cons.find((x) => x.contype === "p")?.cols ?? [];
    const entry = { table: t, columns: m.cols.length, rows: Number((await sq(`SELECT count(*) n FROM ${q(t)}`)).rows[0].n), roundtrip: null, baselineError: null, notNull: [], unique: [], foreignKeys: [] };
    entry.baselineError = await attempt(async () => {
      const r = await insert(t);
      if (pk.length) {
        const where = pk.map((k, i) => `${q(k)}=$${i + 1}`).join(" AND ");
        const back = await sq(`SELECT 1 FROM ${q(t)} WHERE ${where}`, pk.map((k) => r[k]));
        if (!back.rowCount) throw new Error("the inserted row could not be read back");
        await sq(`DELETE FROM ${q(t)} WHERE ${where}`, pk.map((k) => r[k]));
      }
    });
    entry.roundtrip = entry.baselineError === null;
    if (entry.roundtrip) {
      for (const col of m.cols.filter((x) => x.is_nullable === "NO" && !x.column_default)) {
        const err = await attempt(() => insert(t, { [col.column_name]: null }));
        entry.notNull.push({ column: col.column_name, rejected: err !== null && /null value|not-null/i.test(err), error: err });
      }
      for (const u of m.cons.filter((x) => x.contype === "u")) {
        const err = await attempt(async () => {
          const first = await insert(t);
          await insert(t, Object.fromEntries(u.cols.map((k) => [k, first[k]])));
        });
        entry.unique.push({ columns: u.cols, rejected: err !== null && /unique|duplicate/i.test(err), error: err });
      }
      for (const f of m.cons.filter((x) => x.contype === "f")) {
        const col = m.cols.find((x) => x.column_name === f.cols[0]);
        const err = await attempt(() => insert(t, { [f.cols[0]]: /int|numeric/.test(col?.data_type ?? "") ? 987654321 : `cc-missing-${n}` }));
        entry.foreignKeys.push({ column: f.cols[0], references: `${f.ref_table}.${f.ref_cols[0] ?? "id"}`, rejectedWhenOn: err !== null && /foreign key/i.test(err), errorWhenOn: err });
      }
    }
    out.push(entry);
  }
  await c.end();
  return { database: "postgres (local test server)", tables: out, error: null };
}

const started = Date.now();
const h = await startApp(spec.app, env, `${outDir}/server.log`, spec.bootTimeoutSec ?? 90);
result.boot = h.boot;
try {
  if (h.boot.ok) {
    await sleep(1500);
    if (/^postgres/.test(env.DATABASE_URL ?? "") && spec.engine === "postgres") {
      result.engine = "postgres";
      result.databases.push(await postgres(env.DATABASE_URL));
    } else {
      result.engine = "sqlite";
      const files = sqliteFiles([spec.app.cwd, "/tmp", "/work"], started);
      for (const f of files.slice(0, 4)) {
        const r = await run("python3", ["-I", "/cc/db_sqlite.py", f, `${outDir}/db-${result.databases.length}.json`], { timeoutMs: 180000 });
        try {
          result.databases.push(JSON.parse(readFileSync(`${outDir}/db-${result.databases.length}.json`, "utf8")));
        } catch {
          result.databases.push({ database: f, tables: [], error: `the probe did not finish: ${(r.stderr || r.stdout || "").slice(-300)}` });
        }
      }
    }
  }
} catch (e) {
  result.error = String(e?.message ?? e).slice(0, 400);
}
await stopApp(h);
save();
console.log(`db: boot=${h.boot.ok} engine=${result.engine} databases=${result.databases.length} tables=${result.databases.reduce((n, d) => n + d.tables.length, 0)}${result.error ? ` error=${result.error}` : ""}`);
process.exit(0);
