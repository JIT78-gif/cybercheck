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

  // AI step of project understanding. Auto prefers Nebius and falls back to Gemini when Nebius is unavailable.
  // Without either key, the dossier stays code-derived only.
  UNDERSTANDING_AI_PROVIDER: z.enum(["auto", "nebius", "gemini"]).default("auto"),
  NEBIUS_API_KEY: optional,
  NEBIUS_BASE_URL: z.string().url().default("https://api.tokenfactory.nebius.com/v1/"),
  // NVIDIA Nemotron on Token Factory does the work; the critic is a different model family so no model reviews its own answer.
  NEBIUS_MODEL_FAST: z.string().default("nvidia/nemotron-3-super-120b-a12b"),
  NEBIUS_MODEL_STRONG: z.string().default("nvidia/Nemotron-3-Ultra-550b-a55b"),
  NEBIUS_MODEL_CRITIC: z.string().default("zai-org/GLM-5.3"),
  NEBIUS_MODEL_EMBED: z.string().default("Qwen/Qwen3-Embedding-8B"),
  /** Spending cap for one project analysis, in US dollars. */
  AI_RUN_BUDGET_USD: z.coerce.number().positive().default(1),

  // Testing check: project code runs only in Nebius Sandboxes (VM-isolated), never on this host.
  NEBIUS_PROJECT_ID: optional,
  NEBIUS_SANDBOX_URL: z.string().url().default("https://api.tokenfactory.nebius.com/sandboxes/v1"),
  /** The model provider is independent of the sandbox provider. Nebius Sandboxes still execute all project code. */
  TESTING_AI_PROVIDER: z.enum(["nebius", "gemini"]).default("nebius"),
  GEMINI_API_KEY: optional,
  /** Salt for the fingerprints of secrets the Security check finds (the values themselves are never stored). Derived from BETTER_AUTH_SECRET when unset. */
  SECURITY_FINGERPRINT_SALT: optional,
  GEMINI_BASE_URL: z.string().url().default("https://generativelanguage.googleapis.com/v1beta/openai/"),
  GEMINI_MODEL_AUTHOR: z.string().default("gemini-3.8-flash"),
  GEMINI_MODEL_TRIAGE: z.string().default("gemini-3.8-flash"),
  GEMINI_MODEL_CRITIC: z.string().default("gemini-2.5-pro"),
  /** Gemini's thinking counts against max_tokens on its OpenAI-compatible API; "low" keeps answers whole. */
  GEMINI_REASONING_EFFORT: z.enum(["none", "low", "medium", "high"]).default("low"),
  /** Model that writes extra probes, tests, attacks and repair patches (many calls: fast and low cost). */
  TESTING_MODEL_AUTHOR: z.string().default("nvidia/nemotron-3-super-120b-a12b"),
  /** Model that plans booting and explains failures (fewer calls that need the strongest reasoning). */
  TESTING_MODEL_TRIAGE: z.string().default("nvidia/Nemotron-3-Ultra-550b-a55b"),
  /** Independent model (different family) that must agree before a product defect is confirmed. */
  TESTING_MODEL_CRITIC: z.string().default("zai-org/GLM-5.3"),
  /** Spending cap on AI for one Testing run, in US dollars (the 9+/10 plan's hard limit for a Deep run is $1). */
  TESTING_RUN_BUDGET_USD: z.coerce.number().positive().default(1),
  /** "1" runs the previous Testing engine (no requirements or typed scenarios, no backend-served screens, no in-memory database lane, no stage budgets): a temporary rollback switch. */
  TESTING_LEGACY_ENGINE: z.enum(["0", "1"]).default("0"),

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
  ai:
    env.UNDERSTANDING_AI_PROVIDER === "nebius"
      ? Boolean(env.NEBIUS_API_KEY)
      : env.UNDERSTANDING_AI_PROVIDER === "gemini"
        ? Boolean(env.GEMINI_API_KEY)
        : Boolean(env.NEBIUS_API_KEY || env.GEMINI_API_KEY),
  testingAi: env.TESTING_AI_PROVIDER === "gemini" ? Boolean(env.GEMINI_API_KEY) : Boolean(env.NEBIUS_API_KEY),
  sandbox: Boolean(env.NEBIUS_API_KEY && env.NEBIUS_PROJECT_ID),
};
