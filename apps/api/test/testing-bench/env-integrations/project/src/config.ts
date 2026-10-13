export interface AppConfig {
  port: number;
  stripeSecretKey: string;
  sendgridApiKey: string;
  databaseUrl: string;
  internalApiToken: string;
  mailFrom: string;
}

const REQUIRED = ["STRIPE_SECRET_KEY", "SENDGRID_API_KEY", "DATABASE_URL", "INTERNAL_API_TOKEN"] as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const missing = REQUIRED.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new ConfigError(`Missing required environment variables: ${missing.join(", ")}`);
  }

  const databaseUrl = env.DATABASE_URL!.trim();
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new ConfigError("DATABASE_URL is not a valid URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new ConfigError("DATABASE_URL must use the postgres:// scheme");
  }

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError(`Invalid PORT: ${env.PORT}`);
  }

  return {
    port,
    stripeSecretKey: env.STRIPE_SECRET_KEY!.trim(),
    sendgridApiKey: env.SENDGRID_API_KEY!.trim(),
    databaseUrl,
    internalApiToken: env.INTERNAL_API_TOKEN!.trim(),
    mailFrom: env.MAIL_FROM?.trim() || "receipts@example.com",
  };
}
