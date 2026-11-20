import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

test("rag_query parses SSE frames", async (t) => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const { query } = JSON.parse(body || "{}");
      res.writeHead(200, { "Content-Type": "text/event-stream" });

      if (query === "newline") {
        res.write("data: Hello\nworld\n\n");
        res.write("data:  again\n\n");
        res.write("event: done\ndata: [DONE]\n\n");
      } else if (query === "error") {
        res.write("data: [ERROR] boom\n\n");
        res.write("event: error\ndata: [ERROR]\n\n");
      } else if (query === "eof") {
        res.write("data: tail");
      } else {
        res.write("event: done\ndata: [DONE]\n\n");
      }
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  process.env.RAG_API_URL = `http://127.0.0.1:${port}`;

  const { ragQueryTool } = await import("../src/tools/rag_query.js");

  await t.test("preserves newlines inside chunks", async () => {
    const result = await ragQueryTool.execute({ query: "newline" });
    assert.equal(result.content, "Hello\nworld again");
  });

  await t.test("surfaces server errors", async () => {
    const result = await ragQueryTool.execute({ query: "error" });
    assert.equal(result.content, "RAG query failed: boom");
  });

  await t.test("handles an unterminated final frame", async () => {
    const result = await ragQueryTool.execute({ query: "eof" });
    assert.equal(result.content, "tail");
  });

  await t.test("reports an empty answer", async () => {
    const result = await ragQueryTool.execute({ query: "empty" });
    assert.match(result.content, /returned no answer/);
  });

  await new Promise<void>((resolve) => server.close(() => resolve()));
});
