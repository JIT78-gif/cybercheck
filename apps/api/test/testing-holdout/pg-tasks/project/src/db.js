"use strict";

const { Pool } = require("pg");

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tasks (
    id          SERIAL PRIMARY KEY,
    title       TEXT        NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
    priority    SMALLINT    NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
    status      TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks (status);
`;

function createPool(connectionString) {
  const pool = new Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000 });
  pool.on("error", (err) => {
    console.error("[db] idle client error:", err.message);
  });
  return pool;
}

async function migrate(pool) {
  await pool.query(SCHEMA);
}

module.exports = { createPool, migrate, SCHEMA };
