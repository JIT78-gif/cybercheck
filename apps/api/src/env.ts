import { z } from "zod";

// Empty strings in .env mean "not set".
const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters. Generate one with: openssl rand -base64 32"),
  // Public URL the browser uses (the web app proxies /api/auth/* to this API).
  BETTER_AUTH_URL: z.string().url().default("http://localhost:3000"),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  // Proxies in front of the API whose x-forwarded-for entries are skipped when finding
  // the client IP. Locally that is the Next.js server; in production add your load balancer.
  TRUSTED_PROXIES: z
    .string()
    .default("127.0.0.1,::1")
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean)),

  GOOGLE_CLIENT_ID: optional,
  GOOGLE_CLIENT_SECRET: optional,
  // GitHub App (used for both GitHub sign-in and read-only repository import).
  GITHUB_CLIENT_ID: optional,
  GITHUB_CLIENT_SECRET: optional,
  /** The app's URL name: github.com/apps/<slug> */
  GITHUB_APP_SLUG: optional,
  /** Only changed by tests, which point it at a local fake GitHub. */
  GITHUB_API_URL: z.string().url().default("https://api.github.com"),

  // AI step of project understanding (OpenAI-compatible Nebius Token Factory). Without a key,
  // the dossier stays code-derived only.
  NEBIUS_API_KEY: optional,
  NEBIUS_BASE_URL: z.string().url().default("https://api.tokenfactory.nebius.com/v1/"),
  NEBIUS_MODEL_FAST: z.string().default("deepseek-ai/DeepSeek-V4-Flash-0731"),
  NEBIUS_MODEL_STRONG: z.string().default("deepseek-ai/DeepSeek-V4-Pro-0813"),
  NEBIUS_MODEL_CRITIC: z.string().default("zai-org/GLM-5.3"),
  NEBIUS_MODEL_EMBED: z.string().default("Qwen/Qwen3-Embedding-8B"),
  /** Spending cap for one project analysis, in US dollars. */
  AI_RUN_BUDGET_USD: z.coerce.number().positive().default(1),

  SMTP_HOST: z.string().trim().min(1).default("smtp.gmail.com"),
  SMTP_PORT: z.coerce.number().int().positive().default(465),
  SMTP_USER: optional,
  SMTP_PASS: optional,
  EMAIL_FROM: optional,
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration. Fix these values in .env:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

export const providers = {
  google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
  githubApp: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.GITHUB_APP_SLUG),
  smtp: Boolean(env.SMTP_USER && env.SMTP_PASS),
  ai: Boolean(env.NEBIUS_API_KEY),
};
