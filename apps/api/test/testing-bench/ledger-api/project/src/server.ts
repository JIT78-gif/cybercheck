import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`[ledger-api] configuration error: ${(err as Error).message}`);
    process.exit(1);
  }

  const app = buildApp({ adminToken: config.adminToken, dbPath: config.dbPath, logger: true });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
