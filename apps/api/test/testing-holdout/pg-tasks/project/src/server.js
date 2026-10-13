"use strict";

const { createApp } = require("./app");
const { createPool, migrate } = require("./db");

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("[pg-tasks] DATABASE_URL must be set");
    process.exit(1);
  }

  const pool = createPool(databaseUrl);
  await migrate(pool);

  const port = Number(process.env.PORT || 3000);
  const server = createApp(pool).listen(port, () => {
    console.log(`[pg-tasks] listening on port ${port}`);
  });

  const shutdown = () => server.close(() => pool.end().finally(() => process.exit(0)));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[pg-tasks] failed to start:", err.message);
  process.exit(1);
});
