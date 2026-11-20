import test from "node:test";
import assert from "node:assert/strict";
import {
  AnthropicProvider,
  type AnthropicClient,
  type AnthropicStreamEvent,
  toAnthropicMessages,
  parseAnthropicResponse,
} from "../src/llm/anthropic.js";
import type { Message } from "../src/types.js";

function streamClient(events: AnthropicStreamEvent[]): AnthropicClient {
  return {
    messages: {
      create: async () => {
        throw new Error("create not expected in stream tests");
      },
      async *stream() {
        yield* events;
      },
    },
  };
}

function streamProvider(events: AnthropicStreamEvent[]): AnthropicProvider {
  return new AnthropicProvider({
    apiKey: "test",
    model: "claude-test",
    temperature: 0,
    maxTokens: 100,
    requestTimeoutMs: 1000,
    client: streamClient(events),
  });
}

test("message conversion extracts system and maps roles", () => {
  const messages: Message[] = [
    { role: "system", content: "sys prompt" },
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: "checking",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"a.txt"}' },
        },
      ],
    },
    { role: "tool", content: "file body", tool_call_id: "call_1" },
    { role: "assistant", content: "done" },
  ];

  const { system, messages: converted } = toAnthropicMessages(messages);
  assert.equal(system, "sys prompt");
  assert.equal(converted.length, 4);
  assert.equal(converted[0].role, "user");
  assert.equal(converted[0].content[0].text, "hello");
  assert.equal(converted[1].role, "assistant");
  assert.equal(converted[1].content[1].type, "tool_use");
  assert.deepEqual(converted[1].content[1].input, { path: "a.txt" });
  // consecutive tool results merge into one user message
  assert.equal(converted[2].role, "user");
  assert.equal(converted[2].content[0].type, "tool_result");
  assert.equal(converted[2].content[0].tool_use_id, "call_1");
  assert.equal(converted[3].role, "assistant");
});

test("consecutive tool results merge into a single user message", () => {
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
        {
          id: "c2",
          type: "function",
          function: { name: "b", arguments: "{}" },
        },
      ],
    },
    { role: "tool", content: "r1", tool_call_id: "c1" },
    { role: "tool", content: "r2", tool_call_id: "c2" },
  ];
  const { messages: converted } = toAnthropicMessages(messages);
  assert.equal(converted.length, 3);
  assert.equal(converted[2].role, "user");
  assert.equal(converted[2].content.length, 2);
});

test("response parsing maps tool_use and stop reasons", () => {
  const response = parseAnthropicResponse({
    content: [
      { type: "text", text: "let me check" },
      {
        type: "tool_use",
        id: "toolu_1",
        name: "read_file",
        input: { path: "x" },
      },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 5 },
  });
  assert.equal(response.content, "let me check");
  assert.equal(response.tool_calls?.[0].function.name, "read_file");
  assert.equal(response.tool_calls?.[0].function.arguments, '{"path":"x"}');
  assert.equal(response.finish_reason, "tool_calls");
  assert.deepEqual(response.usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
  });
});

test("stream parses text deltas and assembles tool_use blocks", async () => {
  const provider = streamProvider([
    { type: "message_start", message: { usage: { input_tokens: 7 } } },
    {
      type: "content_block_start",
      index: 1,
      content_block: {
        type: "tool_use",
        id: "toolu_9",
        name: "list_files",
      },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"pa' },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: 'th":"."}' },
    },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 4 },
    },
    { type: "message_stop" },
  ]);

  const chunks = [];
  for await (const chunk of provider.stream(
    [{ role: "user", content: "hi" }],
    {},
  )) {
    chunks.push(chunk);
  }

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].content, "");
  assert.equal(chunks[0].tool_calls?.[0].id, "toolu_9");
  assert.equal(chunks[0].tool_calls?.[0].function.name, "list_files");
  assert.equal(chunks[0].tool_calls?.[0].function.arguments, '{"path":"."}');
  assert.deepEqual(chunks[0].usage, {
    prompt_tokens: 7,
    completion_tokens: 4,
    total_tokens: 11,
  });
  assert.equal(chunks[0].finish_reason, "tool_calls");
});

test("stream yields text deltas as they arrive", async () => {
  const provider = streamProvider([
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hel" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "lo" },
    },
    { type: "message_delta", delta: { stop_reason: "end_turn" } },
    { type: "message_stop" },
  ]);

  const contents: string[] = [];
  for await (const chunk of provider.stream(
    [{ role: "user", content: "hi" }],
    {},
  )) {
    if (chunk.content) contents.push(chunk.content);
  }
  assert.deepEqual(contents, ["Hel", "lo"]);
});
