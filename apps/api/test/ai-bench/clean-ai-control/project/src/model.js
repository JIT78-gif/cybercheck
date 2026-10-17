// Client for any OpenAI-compatible chat completions API. The provider is chosen by configuration only:
// AI_BASE_URL (for example https://api.openai.com/v1), AI_API_KEY and AI_MODEL.
const TIMEOUT_MS = 15_000;

class ModelUnavailable extends Error {
  constructor(reason) {
    super(`model unavailable: ${reason}`);
    this.reason = reason;
  }
}

async function requestOnce(body) {
  const base = process.env.AI_BASE_URL;
  if (!base) throw new ModelUnavailable("not_configured");
  let res;
  try {
    res = await fetch(`${base.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.AI_API_KEY ?? ""}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new ModelUnavailable(error.name === "TimeoutError" ? "timeout" : "network");
  }
  if (res.status === 429 || res.status >= 500) throw new ModelUnavailable(`status_${res.status}`);
  if (!res.ok) throw new ModelUnavailable(`rejected_${res.status}`);
  const data = await res.json().catch(() => null);
  const message = data?.choices?.[0]?.message;
  const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  if (!message || (typeof message.content !== "string" && !toolCalls.length)) throw new ModelUnavailable("malformed");
  return { content: typeof message.content === "string" ? message.content : "", toolCalls, usage: { promptTokens: data.usage?.prompt_tokens ?? 0, completionTokens: data.usage?.completion_tokens ?? 0 } };
}

/** One retry for timeouts, rate limits, network and server errors; never for a rejected or malformed reply. */
async function chat(messages, tools) {
  const body = { model: process.env.AI_MODEL ?? "gpt-4o-mini", temperature: 0, messages, tools };
  try {
    return await requestOnce(body);
  } catch (error) {
    const retryable = error instanceof ModelUnavailable && /^(timeout|network|status_)/.test(error.reason);
    if (!retryable) throw error;
    return requestOnce(body);
  }
}

module.exports = { chat, ModelUnavailable };
