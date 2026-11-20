import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AnthropicProvider,
  type AnthropicClient,
  toAnthropicMessages,
} from "../src/llm/anthropic.js";
import { LLMError, kindFromStatus } from "../src/llm/errors.js";
import { withRetry } from "../src/llm/retry.js";
import {
  OpenAICompatibleProvider,
  StreamToolCallAssembler,
} from "../src/llm/openai_compatible.js";
import { MessageManager } from "../src/messages.js";
import { executeTool } from "../src/tools/index.js";
import { createDefaultRegistry } from "../src/tools/registry.js";
import type { Message, ToolCall } from "../src/types.js";

test("kindFromStatus maps non-SDK status codes (Anthropic #2)", () => {
  assert.equal(kindFromStatus(429), "rate_limit");
  assert.equal(kindFromStatus(401), "auth");
  assert.equal(kindFromStatus(503), "overloaded");
  assert.equal(kindFromStatus(400), "unknown");
});

test("Anthropic provider retries 429 responses (#2)", async () => {
  let calls = 0;
  const create = (async () => {
    calls++;
    if (calls === 1) {
      // SDK errors carry the HTTP status; LLMError.from classifies them.
      const error = new Error("rate limited") as Error & { status: number };
      error.status = 429;
      throw error;
    }
    return {
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  }) as AnthropicClient["messages"]["create"];
  const provider = new AnthropicProvider({
    apiKey: "test",
    model: "claude-test",
    temperature: 0,
    maxTokens: 100,
    requestTimeoutMs: 1000,
    retryBaseMs: 1,
    client: {
      messages: {
        create,
        async *stream() {
          yield { type: "message_stop" };
        },
      },
    },
  });

  const response = await provider.chat([{ role: "user", content: "hi" }], {});
  assert.equal(calls, 2);
  assert.equal(response.content, "ok");
});

test("Retry-After is read from a Headers instance (#3)", () => {
  const error = new Error("http 429") as Error & {
    status: number;
    headers: Headers;
  };
  error.status = 429;
  const headers = new Headers({ "retry-after": "2" });
  error.headers = headers;

  const llmError = LLMError.from(error);
  assert.equal(llmError.retryAfterMs, 2000);
});

test("withRetry removes abort listener after normal expiry (#10)", async () => {
  const controller = new AbortController();
  // More listeners than retries would accumulate if they leaked; run many.
  for (let i = 0; i < 5; i++) {
    await withRetry(() => Promise.reject(new Error("http 503")), {
      maxRetries: 1,
      baseDelayMs: 1,
      signal: controller.signal,
    }).catch(() => {});
  }
  // If listeners leaked, this count would be > 0.
  assert.equal(
    (controller.signal as unknown as { eventListenerCount?: number })
      .eventListenerCount,
    undefined,
  );
});

test("dirty history [user, tool] keeps tool_result before text (#4)", () => {
  const messages: Message[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "dirty" },
    { role: "tool", content: "r1", tool_call_id: "c1" },
  ];
  const { messages: converted } = toAnthropicMessages(messages);
  // One user message; tool_result first, text after — both legal, no
  // consecutive same-role messages.
  assert.equal(converted.length, 1);
  assert.equal(converted[0].role, "user");
  assert.equal(converted[0].content[0].type, "tool_result");
  assert.equal(converted[0].content[1].type, "text");
});

test("steer text merges into trailing tool_result user message (#4)", () => {
  const messages: Message[] = [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "c1",
          type: "function",
          function: { name: "a", arguments: "{}" },
        },
      ],
    },
    { role: "tool", content: "r1", tool_call_id: "c1" },
    { role: "user", content: "also check x" },
  ];
  const { messages: converted } = toAnthropicMessages(messages);
  assert.equal(converted.length, 3);
  assert.equal(converted[2].role, "user");
  assert.equal(converted[2].content.length, 2);
  assert.equal(converted[2].content[0].type, "tool_result");
  assert.equal(converted[2].content[1].type, "text");
});

test("repeated tool_call name deltas are not concatenated (#7)", () => {
  const assembler = new StreamToolCallAssembler();
  assembler.addDelta({
    index: 0,
    id: "c1",
    name: "read_file",
    arguments: '{"pa',
  });
  // Some compatible services resend the full name on every delta.
  assembler.addDelta({ index: 0, name: "read_file", arguments: 'th":"x"}' });
  assembler.addDelta({ index: 0, name: "read_file" });
  const [toolCall] = assembler.complete();
  assert.equal(toolCall.function.name, "read_file");
  assert.equal(toolCall.function.arguments, '{"path":"x"}');
});

test("replace() restores the system prompt when missing (#8)", () => {
  const mgr = new MessageManager("sys prompt", 4096);
  mgr.clear();
  mgr.replace([
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
  ]);
  assert.equal(mgr.getForLlm()[0].role, "system");
  assert.equal(mgr.getForLlm()[0].content, "sys prompt");

  mgr.replace([
    { role: "system", content: "existing" },
    { role: "user", content: "u2" },
  ]);
  assert.equal(mgr.getForLlm()[0].content, "existing");
});

test("read_file truncates oversized files (#6)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "readfile-"));
  try {
    const big = path.join(dir, "big.txt");
    await fs.writeFile(big, "x".repeat(300 * 1024));
    const result = await executeTool(
      {
        id: "c1",
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({ path: big }),
        },
      },
      { registry: createDefaultRegistry() },
    );
    assert.match(
      result.content,
      /\[truncated: showing first 262144 of 307200 bytes/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("list_files sorts entries (#16)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "listfiles-"));
  try {
    await fs.mkdir(path.join(dir, "zdir"));
    await fs.writeFile(path.join(dir, "b.txt"), "");
    await fs.writeFile(path.join(dir, "a.txt"), "");
    const result = await executeTool(
      {
        id: "c1",
        type: "function",
        function: {
          name: "list_files",
          arguments: JSON.stringify({ path: dir }),
        },
      },
      { registry: createDefaultRegistry() },
    );
    const lines = result.content.split("\n");
    assert.deepEqual(lines, ["a.txt", "b.txt", "zdir/"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
