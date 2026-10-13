export interface AppConfig {
  port: number;
  host: string;
  adminToken: string;
  dbPath: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const adminToken = env.ADMIN_TOKEN?.trim();
  if (!adminToken) {
    throw new Error("ADMIN_TOKEN must be set");
  }

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }

  return {
    port,
    host: env.HOST ?? "0.0.0.0",
    adminToken,
    dbPath: env.LEDGER_DB_PATH ?? ":memory:",
  };
}
