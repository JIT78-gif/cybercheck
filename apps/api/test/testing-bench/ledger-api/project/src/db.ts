import Database from "better-sqlite3";

export type Db = Database.Database;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS accounts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    currency      TEXT    NOT NULL,
    balance_cents INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS entries (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id   INTEGER NOT NULL REFERENCES accounts(id),
    kind         TEXT    NOT NULL,
    amount_cents INTEGER NOT NULL,
    reference    TEXT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id     INTEGER NOT NULL REFERENCES accounts(id),
    tax_rate_bps   INTEGER NOT NULL,
    subtotal_cents INTEGER NOT NULL,
    tax_cents      INTEGER NOT NULL,
    total_cents    INTEGER NOT NULL,
    lines_json     TEXT    NOT NULL,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
