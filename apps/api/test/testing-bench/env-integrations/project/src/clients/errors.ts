/** The provider answered with a non-success status. */
export class ProviderError extends Error {
  constructor(
    readonly provider: "stripe" | "sendgrid",
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** The provider could not be reached at all (DNS, TCP, TLS, timeout). */
export class ProviderUnavailableError extends Error {
  constructor(
    readonly provider: "stripe" | "sendgrid",
    options?: { cause?: unknown },
  ) {
    super(`${provider} is unreachable`, options);
    this.name = "ProviderUnavailableError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function safeFetch(
  provider: "stripe" | "sendgrid",
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new ProviderUnavailableError(provider, { cause: error });
  }
}
