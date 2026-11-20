import { LLMError } from "./errors.js";

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (error: LLMError, attempt: number, delayMs: number) => void;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  // Cancellation is classified as its own non-retryable kind so logs show
  // "[aborted] ..." instead of the misleading "[unknown] ...".
  const aborted = (): LLMError =>
    new LLMError("aborted", "Aborted during retry backoff");
  return new Promise((resolve, reject) => {
    // Check before registering anything: an already-aborted signal must not
    // resolve even if the abort listener raced with the timer.
    if (signal?.aborted) {
      reject(aborted());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(aborted());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Retries `fn` on retryable LLM errors (rate limit / timeout / network /
 * overloaded) with exponential backoff, honoring Retry-After when present.
 * Auth and unknown failures are rethrown immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const llmError = LLMError.from(error);
      const nextAttempt = attempt + 1;
      if (
        !llmError.retryable ||
        nextAttempt > options.maxRetries ||
        options.signal?.aborted
      ) {
        throw llmError;
      }
      const delay = Math.min(
        llmError.retryAfterMs ?? options.baseDelayMs * 2 ** attempt,
        options.maxDelayMs ?? 8000,
      );
      options.onRetry?.(llmError, nextAttempt, delay);
      await sleep(delay, options.signal);
    }
  }
}
