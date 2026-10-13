# cybercheck database probe for SQLite. Runs INSIDE the sandbox, never on the host.
# Usage: python3 -I db_sqlite.py <database file> <out.json>
# For every table: builds a valid row, stores it, reads it back and deletes it; then checks that each
# declared NOT NULL, UNIQUE and FOREIGN KEY constraint rejects a violating row. Everything happens
# inside a savepoint that is rolled back, so the database is left exactly as it was.
import json, re, sqlite3, sys

path, out_path = sys.argv[1], sys.argv[2]
result = {"database": path, "tables": [], "error": None}

def q(name):
    return '"' + name.replace('"', '""') + '"'

def enum_values(sql):
    # CHECK (status IN ('a', 'b')) gives the allowed values of a column.
    out = {}
    for m in re.finditer(r'CHECK\s*\(\s*"?(\w+)"?\s+IN\s*\(([^)]*)\)', sql or "", re.I):
        vals = re.findall(r"'((?:[^']|'')*)'", m.group(2))
        if vals:
            out[m.group(1)] = vals[0].replace("''", "'")
    # Numeric ranges: CHECK (rating BETWEEN 1 AND 5), CHECK (qty > 0), CHECK (price >= 0).
    for m in re.finditer(r'CHECK\s*\(\s*"?(\w+)"?\s+BETWEEN\s+(-?[\d.]+)\s+AND', sql or "", re.I):
        out.setdefault(m.group(1), float(m.group(2)) if "." in m.group(2) else int(m.group(2)))
    for m in re.finditer(r'CHECK\s*\(\s*"?(\w+)"?\s*(>=|>|<=|<)\s*(-?[\d.]+)', sql or "", re.I):
        v = float(m.group(3)) if "." in m.group(3) else int(m.group(3))
        out.setdefault(m.group(1), v + 1 if m.group(2) == ">" else v - 1 if m.group(2) == "<" else v)
    return out

def sample(col, i, enums):
    name, ctype = col["name"], (col["type"] or "").upper()
    if name in enums:
        return enums[name]
    if "INT" in ctype or "BOOL" in ctype:
        return 1 if "BOOL" in ctype else 100000 + i
    if any(x in ctype for x in ("REAL", "FLOA", "DOUB", "NUM", "DEC")):
        return 1.5
    if "DATE" in ctype or "TIME" in ctype:
        return "2026-01-01 00:00:00"
    if "JSON" in ctype:
        return "{}"
    if "BLOB" in ctype:
        return b"cc"
    return "cc_%s_%d" % (name, i)

def info(con, table):
    cols = [dict(cid=r[0], name=r[1], type=r[2], notnull=bool(r[3]), default=r[4], pk=r[5]) for r in con.execute("PRAGMA table_info(%s)" % q(table))]
    fks = [dict(column=r[3], table=r[2], to=r[4]) for r in con.execute("PRAGMA foreign_key_list(%s)" % q(table))]
    uniques = []
    for r in con.execute("PRAGMA index_list(%s)" % q(table)):
        if r[2] and r[3] != "pk":
            uniques.append([x[2] for x in con.execute("PRAGMA index_info(%s)" % q(r[1]))])
    sql = con.execute("SELECT sql FROM sqlite_master WHERE name=?", (table,)).fetchone()[0]
    return cols, fks, uniques, sql

counter = [0]
def row_for(con, table, fk_on, depth=0, overrides=None):
    """A valid row for a table: parents are created first when foreign keys are enforced."""
    cols, fks, uniques, sql = info(con, table)
    enums = enum_values(sql)
    values = {}
    for c in cols:
        counter[0] += 1
        if c["pk"] and "INT" in (c["type"] or "").upper() and len([x for x in cols if x["pk"]]) == 1:
            continue  # rowid alias: SQLite assigns it
        fk = next((f for f in fks if f["column"] == c["name"]), None)
        if fk and fk_on:
            if depth > 3:
                raise Exception("foreign keys nest too deep")
            parent = insert(con, fk["table"], fk_on, depth + 1)
            values[c["name"]] = parent.get(fk["to"]) if fk["to"] else parent.get("rowid")
            continue
        if not c["notnull"] and c["default"] is None and not c["pk"] and not fk:
            values[c["name"]] = sample(c, counter[0], enums)
            continue
        values[c["name"]] = sample(c, counter[0], enums)
    if overrides:
        values.update(overrides)
    return values

def insert(con, table, fk_on, depth=0, overrides=None):
    values = row_for(con, table, fk_on, depth, overrides)
    names = list(values.keys())
    if names:
        cur = con.execute("INSERT INTO %s (%s) VALUES (%s)" % (q(table), ",".join(q(n) for n in names), ",".join("?" for _ in names)), [values[n] for n in names])
    else:
        cur = con.execute("INSERT INTO %s DEFAULT VALUES" % q(table))
    row = con.execute("SELECT rowid, * FROM %s WHERE rowid=?" % q(table), (cur.lastrowid,)).fetchone()
    cols = ["rowid"] + [d[0] for d in con.execute("SELECT * FROM %s LIMIT 0" % q(table)).description]
    return dict(zip(cols, row))

def attempt(con, fn):
    con.execute("SAVEPOINT cc_probe")
    try:
        fn()
        return None
    except Exception as e:
        return str(e)[:300]
    finally:
        con.execute("ROLLBACK TO cc_probe")
        con.execute("RELEASE cc_probe")

try:
    con = sqlite3.connect(path, isolation_level=None, timeout=10)
    tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('alembic_version','_prisma_migrations','schema_migrations','knex_migrations','knex_migrations_lock','__drizzle_migrations')")]
    for t in tables:
        cols, fks, uniques, sql = info(con, t)
        entry = {"table": t, "columns": len(cols), "rows": con.execute("SELECT count(*) FROM %s" % q(t)).fetchone()[0], "roundtrip": None, "baselineError": None, "notNull": [], "unique": [], "foreignKeys": []}
        # Foreign key enforcement is per connection; the probes run once with it off and once on.
        for fk_on in (False, True):
            con.execute("PRAGMA foreign_keys=%s" % ("ON" if fk_on else "OFF"))
            if fk_on:
                for f in fks:
                    # A valid row whose other parents exist, while this foreign key points nowhere.
                    err = attempt(con, lambda f=f: insert(con, t, True, overrides={f["column"]: 987654321}))
                    entry["foreignKeys"].append({"column": f["column"], "references": "%s.%s" % (f["table"], f["to"] or "rowid"), "rejectedWhenOn": err is not None and "FOREIGN KEY" in err.upper(), "errorWhenOn": err})
                continue
            # Round trip: insert, read back, delete.
            def roundtrip():
                row = insert(con, t, False)
                back = con.execute("SELECT * FROM %s WHERE rowid=?" % q(t), (row["rowid"],)).fetchone()
                if back is None:
                    raise Exception("the inserted row could not be read back")
                con.execute("DELETE FROM %s WHERE rowid=?" % q(t), (row["rowid"],))
                if con.execute("SELECT count(*) FROM %s WHERE rowid=?" % q(t), (row["rowid"],)).fetchone()[0]:
                    raise Exception("the row was still there after DELETE")
            entry["baselineError"] = attempt(con, roundtrip)
            entry["roundtrip"] = entry["baselineError"] is None
            if entry["baselineError"]:
                continue
            for c in cols:
                if not c["notnull"] or (c["pk"] and "INT" in (c["type"] or "").upper()):
                    continue
                err = attempt(con, lambda c=c: insert(con, t, False, overrides={c["name"]: None}))
                entry["notNull"].append({"column": c["name"], "rejected": err is not None and "NOT NULL" in err.upper(), "error": err})
            for u in uniques:
                def dup(u=u):
                    first = insert(con, t, False)
                    insert(con, t, False, overrides={k: first[k] for k in u})
                err = attempt(con, dup)
                entry["unique"].append({"columns": u, "rejected": err is not None and "UNIQUE" in err.upper(), "error": err})
            for f in fks:
                err = attempt(con, lambda f=f: insert(con, t, False, overrides={f["column"]: 987654321}))
                entry.setdefault("fkOff", []).append({"column": f["column"], "acceptedWhenOff": err is None})
        result["tables"].append(entry)
except Exception as e:
    result["error"] = str(e)[:500]

with open(out_path, "w") as fh:
    json.dump(result, fh)
print("db: tables=%d error=%s" % (len(result["tables"]), result["error"]))
