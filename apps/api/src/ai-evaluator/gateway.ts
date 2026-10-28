// Configuration for the future trusted live-model gateway. The gateway must run outside the untrusted application
// workload: placing its key or outbound network in the app container would let evaluated code bypass every limit.

/** cybercheck's own model used to run an evaluated app's traffic in live mode (separate from the judge). */
export type LiveModelConfig = { baseUrl: string; apiKey: string; model: string; inPricePerMTok: number; outPricePerMTok: number };

/** Read cybercheck's live-model configuration from the environment. Null when it is not configured (no credits). */
export function liveModelConfig(env: NodeJS.ProcessEnv = process.env): LiveModelConfig | null {
  const baseUrl = env.CC_LIVE_MODEL_BASE_URL?.trim();
  const apiKey = env.CC_LIVE_MODEL_KEY?.trim();
  const model = env.CC_LIVE_MODEL?.trim();
  if (!baseUrl || !apiKey || !model) return null;
  if (!/^https?:\/\//.test(baseUrl)) return null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), apiKey, model, inPricePerMTok: Number(env.CC_LIVE_MODEL_IN_PRICE ?? 0.15), outPricePerMTok: Number(env.CC_LIVE_MODEL_OUT_PRICE ?? 0.6) };
}

export type GatewayStatus = { available: boolean; model: string | null; reason: string };

/** Whether live mode can run. Credentials are necessary but never sufficient: a trusted transport must attest that
 * the app and gateway are isolated. No current sandbox provider supplies that boundary, so production calls use the
 * default `false` and fail closed. The explicit flag exists for capability tests and the future sidecar adapter. */
export function liveGatewayStatus(env: NodeJS.ProcessEnv = process.env, trustedTransport = false): GatewayStatus {
  const cfg = liveModelConfig(env);
  if (!cfg) return { available: false, model: null, reason: "No live model is configured for cybercheck's gateway (set CC_LIVE_MODEL_BASE_URL, CC_LIVE_MODEL_KEY and CC_LIVE_MODEL); live mode is unavailable until then." };
  if (!trustedTransport) return { available: false, model: cfg.model, reason: `Live-model credentials are configured for ${cfg.model}, but the selected sandbox has no isolated gateway sidecar. Live mode is disabled so project code cannot read the key or access the provider directly.` };
  return { available: true, model: cfg.model, reason: `cybercheck's trusted gateway sidecar will route model traffic to ${cfg.model} without exposing its credentials to the app.` };
}

/** Estimated cost of one call, in USD, from token counts and the configured prices. */
export function callCost(cfg: Pick<LiveModelConfig, "inPricePerMTok" | "outPricePerMTok">, inputTokens: number, outputTokens: number): number {
  return (inputTokens * cfg.inPricePerMTok + outputTokens * cfg.outPricePerMTok) / 1_000_000;
}
