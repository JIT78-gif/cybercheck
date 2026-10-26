import type { AiInsights } from "@cybercheck/contracts";
import { env } from "../../env.ts";
import { AiSession } from "./gateway.ts";

export type UnderstandingProviderName = "nebius" | "gemini";
export type UnderstandingModels = AiInsights["models"];
export type UnderstandingProvider = { name: UnderstandingProviderName; models: UnderstandingModels; session: AiSession };

type Availability = { preference: "auto" | UnderstandingProviderName; nebius: boolean; gemini: boolean };

/** Provider order for the Architecture and Understanding AI step. Auto prefers Nebius and uses Gemini as fallback. */
export function understandingProviderOrder(input: Availability): UnderstandingProviderName[] {
  if (input.preference === "nebius") return input.nebius ? ["nebius"] : [];
  if (input.preference === "gemini") return input.gemini ? ["gemini"] : [];
  return [...(input.nebius ? (["nebius"] as const) : []), ...(input.gemini ? (["gemini"] as const) : [])];
}

export function configuredUnderstandingProviderNames(): UnderstandingProviderName[] {
  return understandingProviderOrder({
    preference: env.UNDERSTANDING_AI_PROVIDER,
    nebius: Boolean(env.NEBIUS_API_KEY),
    gemini: Boolean(env.GEMINI_API_KEY),
  });
}

export function understandingModels(name: UnderstandingProviderName): UnderstandingModels {
  return name === "nebius"
    ? { fast: env.NEBIUS_MODEL_FAST, strong: env.NEBIUS_MODEL_STRONG, critic: env.NEBIUS_MODEL_CRITIC }
    : { fast: env.GEMINI_MODEL_AUTHOR, strong: env.GEMINI_MODEL_TRIAGE, critic: env.GEMINI_MODEL_CRITIC };
}

export function createUnderstandingProvider(name: UnderstandingProviderName): UnderstandingProvider {
  const models = understandingModels(name);
  if (name === "nebius") {
    return { name, models, session: new AiSession({ apiKey: env.NEBIUS_API_KEY!, baseUrl: env.NEBIUS_BASE_URL, models, budgetUsd: env.AI_RUN_BUDGET_USD, timeoutMs: 300_000 }) };
  }

  // Google does not publish prices through its OpenAI-compatible /models response. These conservative prices keep
  // the same pre-flight budget guard used by the other AI workflows.
  const modelPrices = {
    [models.fast]: { inputUsdPerMillion: 1.5, outputUsdPerMillion: 7.5 },
    [models.strong]: { inputUsdPerMillion: 1.5, outputUsdPerMillion: 7.5 },
    [models.critic]: { inputUsdPerMillion: 2.5, outputUsdPerMillion: 15 },
  };
  return {
    name,
    models,
    session: new AiSession({
      apiKey: env.GEMINI_API_KEY!,
      baseUrl: env.GEMINI_BASE_URL,
      models,
      modelPrices,
      budgetUsd: env.AI_RUN_BUDGET_USD,
      timeoutMs: 300_000,
      extraBody: { reasoning_effort: env.GEMINI_REASONING_EFFORT },
    }),
  };
}

/** Only provider availability/credit failures cause auto fallback. Bad model output and Cybercheck's own budget do not. */
export function understandingProviderUnavailable(error: string | null): boolean {
  return Boolean(error && /HTTP\s+(?:401|402|403|408|409|429|5\d\d)\b|payment required|credits? exhausted|fetch failed|network error|timed?\s*out|\b(?:ECONN[A-Z_]*|ENOTFOUND|EAI_AGAIN)\b/i.test(error));
}

export function addAttemptUsage(final: AiInsights, attempts: AiInsights[]): AiInsights {
  if (attempts.length <= 1) return final;
  return {
    ...final,
    usage: {
      calls: attempts.reduce((n, x) => n + x.usage.calls, 0),
      inputTokens: attempts.reduce((n, x) => n + x.usage.inputTokens, 0),
      outputTokens: attempts.reduce((n, x) => n + x.usage.outputTokens, 0),
      costUsd: Number(attempts.reduce((n, x) => n + x.usage.costUsd, 0).toFixed(6)),
      ms: attempts.reduce((n, x) => n + x.usage.ms, 0),
    },
  };
}
