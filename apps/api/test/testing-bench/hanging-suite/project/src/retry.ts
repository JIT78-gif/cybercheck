import { setTimeout as sleep } from "node:timers/promises";

export interface RetryOptions {
  retries: number;
  delayMs?: number;
  factor?: number;
  shouldRetry?: (error: unknown) => boolean;
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const { retries, delayMs = 100, factor = 2, shouldRetry = () => true } = options;
  if (!Number.isInteger(retries) || retries < 0) {
    throw new RangeError(`retries must be a non-negative integer, got ${retries}`);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === retries || !shouldRetry(error)) break;
      await sleep(delayMs * factor ** attempt);
    }
  }
  throw lastError;
}
