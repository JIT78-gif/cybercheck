"use strict";

const { createPool, migrate } = require("../src/db");

function testPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must point at a disposable PostgreSQL database to run the tests");
  }
  return createPool(process.env.DATABASE_URL);
}

async function resetDatabase(pool) {
  await migrate(pool);
  await pool.query("TRUNCATE tasks RESTART IDENTITY");
}

module.exports = { testPool, resetDatabase };
