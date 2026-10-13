import { randomBytes } from "node:crypto";

export interface Config {
  port: number;
  dashboardPassword: string;
  sessionSecret: string;
  secureCookies: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dashboardPassword = env.DASHBOARD_PASSWORD;
  if (!dashboardPassword) {
    throw new Error("DASHBOARD_PASSWORD must be set");
  }

  const sessionSecret = env.SESSION_SECRET ?? randomBytes(32).toString("hex");
  if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters");
  }

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }

  return {
    port,
    dashboardPassword,
    sessionSecret,
    secureCookies: env.NODE_ENV === "production",
  };
}
