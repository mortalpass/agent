export type LLMErrorKind =
  | "aborted"
  | "rate_limit"
  | "timeout"
  | "network"
  | "overloaded"
  | "auth"
  | "unknown";

const RETRYABLE_KINDS: ReadonlySet<LLMErrorKind> = new Set([
  "rate_limit",
  "timeout",
  "network",
  "overloaded",
]);

/** Maps an HTTP status code to an LLMErrorKind. Used by non-SDK providers. */
export function kindFromStatus(status: number): LLMErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "overloaded";
  return "unknown";
}

/** Reads a header from either a `Headers` instance or a plain record. */
function getHeader(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  // Deduped so a lowercase `name` is not checked twice.
  for (const key of new Set([name, "Retry-After", "retry-after"])) {
    const value = (headers as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** Classified LLM API failure. `retryable` decides whether withRetry re-attempts. */
export class LLMError extends Error {
  readonly kind: LLMErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    kind: LLMErrorKind,
    message: string,
    options?: { status?: number; retryAfterMs?: number; cause?: unknown },
  ) {
    super(`[${kind}] ${message}`, { cause: options?.cause });
    this.name = "LLMError";
    this.kind = kind;
    this.status = options?.status;
    this.retryAfterMs = options?.retryAfterMs;
  }

  get retryable(): boolean {
    return RETRYABLE_KINDS.has(this.kind);
  }

  static from(error: unknown): LLMError {
    if (error instanceof LLMError) return error;
    const err = error as {
      status?: number;
      name?: string;
      message?: string;
      code?: string;
      headers?: unknown;
      cause?: unknown;
    };
    const message = err?.message ?? String(error);
    const status = typeof err?.status === "number" ? err.status : undefined;

    let retryAfterMs: number | undefined;
    const retryAfter = getHeader(err?.headers, "retry-after");
    if (retryAfter?.trim()) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) {
        retryAfterMs = seconds * 1000;
      }
    }

    const kind = classify(status, err?.name ?? "", err?.code ?? "", message);
    return new LLMError(kind, message, {
      status,
      retryAfterMs,
      cause: error,
    });
  }
}

function classify(
  status: number | undefined,
  name: string,
  code: string,
  message: string,
): LLMErrorKind {
  if (status !== undefined) return kindFromStatus(status);
  // AbortSignal.timeout surfaces as TimeoutError; some Node versions surface
  // request timeouts as AbortError ("This operation was aborted"). User
  // cancellation never reaches retry: withRetry checks signal.aborted first.
  if (
    /timeout/i.test(name) ||
    name === "AbortError" ||
    /timed?\s?out|operation was aborted/i.test(message)
  ) {
    return "timeout";
  }
  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    /fetch failed|network/i.test(message)
  ) {
    return "network";
  }
  return "unknown";
}
