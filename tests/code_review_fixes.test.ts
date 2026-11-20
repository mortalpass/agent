import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import {
  AnthropicProvider,
  type AnthropicClient,
  type AnthropicStreamEvent,
} from "../src/llm/anthropic.js";
import { MessageManager } from "../src/messages.js";
import { parseMcpServers } from "../src/mcp/index.js";
import { executeTool } from "../src/tools/index.js";
import { createDefaultRegistry } from "../src/tools/registry.js";
import { ragQueryTool } from "../src/tools/rag_query.js";
import { SessionManager } from "../src/session/index.js";
import { config } from "../src/config.js";
import type { AgentMessage } from "../src/types.js";

function toolCall(name: string, args: Record<string, unknown>) {
  return {
    id: "call_1",
    type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  };
}

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

async function startRagServer(
  handler: (query: string, top_k: unknown, res: http.ServerResponse) => void,
): Promise<() => Promise<void>> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}") as {
        query?: string;
        top_k?: unknown;
      };
      handler(parsed.query ?? "", parsed.top_k, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  config.rag.apiUrl = `http://127.0.0.1:${port}`;
  return () =>
    new Promise<void>((resolve) => {
      // fetch keeps a keep-alive socket open; without closeAllConnections,
      // server.close() waits for it and the promise is never resolved.
      server.closeAllConnections();
      server.close(() => resolve());
    });
}

// RAG tests mutate config.rag.apiUrl (module-level singleton), so they must
// always call runWithRagServer to close the temp server afterwards.
async function runWithRagServer(
  handler: (query: string, top_k: unknown, res: http.ServerResponse) => void,
  run: () => Promise<void>,
): Promise<void> {
  const close = await startRagServer(handler);
  try {
    await run();
  } finally {
    await close();
  }
}

test("anthropic stream emits tool_calls even without message_stop", async () => {
  const provider = new AnthropicProvider({
    apiKey: "test",
    model: "claude-test",
    temperature: 0,
    maxTokens: 100,
    requestTimeoutMs: 1000,
    client: streamClient([
      { type: "message_start", message: { usage: { input_tokens: 3 } } },
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
        delta: { partial_json: '{"path":"."}' },
      },
      // Stream ends here: no message_delta/stop.
    ]),
  });

  const chunks = [];
  for await (const chunk of provider.stream(
    [{ role: "user", content: "hi" }],
    {},
  )) {
    chunks.push(chunk);
  }

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].tool_calls?.[0].function.name, "list_files");
  assert.equal(chunks[0].tool_calls?.[0].function.arguments, '{"path":"."}');
  assert.deepEqual(chunks[0].usage, {
    prompt_tokens: 3,
    completion_tokens: 0,
    total_tokens: 3,
  });
});

test("oversized tool results are truncated to the token budget", () => {
  const mgr = new MessageManager("s", 4096);
  mgr.add({ role: "user", content: "go" });
  mgr.add({
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "c1",
        type: "function",
        function: { name: "read_file", arguments: "{}" },
      },
    ],
  });
  mgr.add({ role: "tool", content: "x".repeat(100_000), tool_call_id: "c1" });
  const messages = mgr.getForLlm();
  assert.deepEqual(
    messages.map((m) => m.role),
    ["system", "user", "assistant", "tool"],
  );
  const tool = messages[3];
  assert.match(
    tool.content as string,
    /\[truncated: omitted \d+ of 100000 chars\]/,
  );
  assert.ok(mgr.estimateTokens() <= 4096);
});

test("estimateTokens counts tool_call names too", () => {
  const mgr = new MessageManager("s", 4096);
  mgr.add({
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "c1",
        type: "function",
        function: { name: "a".repeat(100), arguments: "b".repeat(100) },
      },
    ],
  });
  // system "s" (1) + name (25) + arguments (25) at 4 chars/token,
  // plus ~4 tokens per message and 8 per tool call.
  assert.equal(mgr.estimateTokens(), 67);
});

test("executeTool rejects an already-aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await executeTool(toolCall("read_file", { path: "." }), {
    signal: controller.signal,
    timeoutMs: 5000,
    registry: createDefaultRegistry(),
  });
  assert.match(result.content, /aborted/);
});

test("SessionManager.update overwrites an existing session", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "sessions-"));
  try {
    const sessions = new SessionManager(path.join(dir, "db.sqlite"));
    const messages: AgentMessage[] = [{ role: "user", content: "first" }];
    const meta = sessions.save(messages, "topic");
    const updated = sessions.update(meta.id, [
      ...messages,
      { role: "assistant", content: "answer" },
    ]);
    assert.ok(updated);
    assert.equal(updated.id, meta.id);
    assert.equal(updated.name, "topic");
    assert.equal(updated.messageCount, 2);
    assert.deepEqual(
      sessions.list().map((s) => s.id),
      [meta.id],
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("rag_query surfaces an error event left in the tail buffer", async () => {
  await runWithRagServer(
    (_query, _topK, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // The stream dies before the final \n\n of the error event.
      res.write("event: error\ndata: [ERROR] garbled on last chunk");
      res.end();
    },
    async () => {
      const result = await ragQueryTool.execute({ query: "tail-error" });
      assert.equal(result.content, "RAG query failed: garbled on last chunk");
    },
  );
});

test("rag_query clamps an untrusted top_k", async () => {
  let servedTopK: unknown;
  await runWithRagServer(
    (_query, topK, res) => {
      servedTopK = topK;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end("event: done\ndata: [DONE]\n\n");
    },
    async () => {
      async function assertTopK(arg: unknown, expected: number): Promise<void> {
        servedTopK = undefined;
        await ragQueryTool.execute({ query: "q", top_k: arg });
        assert.equal(servedTopK, expected);
      }

      await assertTopK("abc", 5);
      await assertTopK(undefined, 5);
      await assertTopK(99, 20);
      await assertTopK(0.7, 1);
    },
  );
});

test("write_file reports UTF-8 bytes, not UTF-16 code units", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "writefile-"));
  try {
    const target = path.join(dir, "emoji.txt");
    const result = await executeTool(
      toolCall("write_file", { path: target, content: "😀" }),
      { registry: createDefaultRegistry() },
    );
    // "😀" is 1 code unit "pair" (length 2) but 4 UTF-8 bytes.
    assert.equal(result.content, `Successfully wrote 4 bytes to ${target}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("read_file notice uses the actually-read byte count", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "readfile2-"));
  try {
    const big = path.join(dir, "big.txt");
    await fs.writeFile(big, "y".repeat(300 * 1024));
    const result = await executeTool(toolCall("read_file", { path: big }), {
      registry: createDefaultRegistry(),
    });
    assert.match(
      result.content,
      /\[truncated: showing first 262144 of 307200 bytes/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("parseMcpServers drops non-record env maps and non-string values", () => {
  const raw = JSON.stringify([
    { name: "fs", command: "node", env: ["not", "an", "object"] },
    {
      name: "calc",
      command: "node",
      env: { GOOD: "1", BAD: 42, WORSE: { a: 1 } },
    },
  ]);
  const servers = parseMcpServers(raw);
  assert.equal(servers[0].env, undefined);
  assert.deepEqual(servers[1].env, { GOOD: "1" });
});

test("anthropic stream keeps usage unset when prompt tokens are unknown", async () => {
  const provider = new AnthropicProvider({
    apiKey: "test",
    model: "claude-test",
    temperature: 0,
    maxTokens: 100,
    requestTimeoutMs: 1000,
    client: streamClient([
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hi" },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 5 },
      },
      { type: "message_stop" },
    ]),
  });

  const chunks = [];
  for await (const chunk of provider.stream(
    [{ role: "user", content: "q" }],
    {},
  )) {
    chunks.push(chunk);
  }
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1].usage, undefined);
});
