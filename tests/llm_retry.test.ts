import test from "node:test";
import assert from "node:assert/strict";
import { LLMError } from "../src/llm/errors.js";
import { withRetry } from "../src/llm/retry.js";
import { perRequestSignal } from "../src/llm/openai_compatible.js";

function statusError(status: number, message = `http ${status}`): Error {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

test("LLMError classifies status codes", () => {
  assert.equal(LLMError.from(statusError(401)).kind, "auth");
  assert.equal(LLMError.from(statusError(429)).kind, "rate_limit");
  assert.equal(LLMError.from(statusError(503)).kind, "overloaded");
  assert.equal(LLMError.from(new Error("fetch failed")).kind, "network");
  assert.equal(
    LLMError.from(
      Object.assign(new Error("request timed out"), { name: "TimeoutError" }),
    ).kind,
    "timeout",
  );
  assert.equal(LLMError.from(new Error("weird")).kind, "unknown");
});

test("auth and unknown errors are not retryable", () => {
  assert.equal(LLMError.from(statusError(401)).retryable, false);
  assert.equal(LLMError.from(new Error("weird")).retryable, false);
  assert.equal(LLMError.from(statusError(429)).retryable, true);
});

test("withRetry retries retryable failures then succeeds", async () => {
  let calls = 0;
  const delays: number[] = [];
  const result = await withRetry(
    () => {
      calls++;
      if (calls < 3) throw statusError(429);
      return Promise.resolve("ok");
    },
    { maxRetries: 3, baseDelayMs: 1, onRetry: (_e, _a, d) => delays.push(d) },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.equal(delays.length, 2);
});

test("withRetry gives up after maxRetries", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      () => {
        calls++;
        throw statusError(503);
      },
      { maxRetries: 2, baseDelayMs: 1 },
    ),
    (error: LLMError) => error.kind === "overloaded",
  );
  assert.equal(calls, 3);
});

test("withRetry does not retry auth errors", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(
      () => {
        calls++;
        throw statusError(401);
      },
      { maxRetries: 5, baseDelayMs: 1 },
    ),
    (error: LLMError) => error.kind === "auth",
  );
  assert.equal(calls, 1);
});

test("withRetry honors Retry-After header", async () => {
  let calls = 0;
  const delays: number[] = [];
  await withRetry(
    () => {
      calls++;
      if (calls === 1) {
        throw Object.assign(statusError(429), {
          headers: { "retry-after": "1" },
        });
      }
      return Promise.resolve("ok");
    },
    {
      maxRetries: 2,
      baseDelayMs: 1000,
      onRetry: (_e, _a, d) => delays.push(d),
    },
  );
  assert.deepEqual(delays, [1000]);
});

test("perRequestSignal isolates SDK listeners but still honors run aborts", () => {
  const controller = new AbortController();
  const first = perRequestSignal(controller.signal);
  const second = perRequestSignal(controller.signal);
  assert.ok(first && second);
  // A fresh signal per request keeps vendor listeners off the long-lived run
  // signal (openai-node never removes them).
  assert.notEqual(first, second);
  assert.notEqual(first, controller.signal);
  assert.equal(first.aborted, false);
  controller.abort();
  assert.equal(first.aborted, true);
  assert.equal(second.aborted, true);
  assert.equal(perRequestSignal(undefined), undefined);
});
