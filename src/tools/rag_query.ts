import { EventSourceParserStream } from "eventsource-parser/stream";
import { config } from "../config.js";
import { logger } from "../logger.js";
import type { Tool, ToolResult } from "../types.js";

/**
 * Fixup stream for the RAG service's SSE dialect: it emits continuation
 * lines without a new `data:` prefix for multi-line payloads. The spec
 * parser ignores such lines, so each one is rewritten as a `data:` line.
 */
function lineFixupStream(): TransformStream<string, string> {
  let pending = "";
  return new TransformStream<string, string>({
    transform(chunk, controller) {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) controller.enqueue(fixupLine(line) + "\n");
    },
    flush(controller) {
      // A stream cut before the final blank line can still carry a complete
      // last event; close the block synthetically so the parser dispatches it.
      if (pending) {
        controller.enqueue(fixupLine(pending) + "\n");
        pending = "";
      }
      controller.enqueue("\n");
    },
  });
}

function fixupLine(line: string): string {
  if (
    line === "" ||
    line.startsWith(":") ||
    /^(data|event|id|retry):/.test(line)
  ) {
    return line;
  }
  return `data: ${line}`;
}

export const ragQueryTool: Tool = {
  name: "rag_query",
  description:
    "Query the knowledge base (RAG service) to retrieve relevant documents and get an answer based on internal data. Use this when the user asks questions about internal documents, project knowledge, or information that should come from the company's knowledge base rather than general knowledge.",
  executionMode: "parallel",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The question to ask the knowledge base",
      },
      top_k: {
        type: "number",
        description: "Number of top results to retrieve (1-20, default 5)",
      },
    },
    required: ["query"],
  },

  async execute(args, context): Promise<ToolResult> {
    const query = args.query as string;
    // LLM-provided numbers are untrusted: "abc" would pass the type facet,
    // and no provider validation clamps out-of-range values. Decode + clamp.
    const rawTopK = Number(args.top_k);
    const topK = Number.isFinite(rawTopK)
      ? Math.min(Math.max(Math.trunc(rawTopK), 1), 20)
      : 5;

    const url = `${config.rag.apiUrl}/api/chat/stream`;
    logger.debug(`RAG query: "${query}" (top_k=${topK})`);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ query, top_k: topK }),
        signal: context?.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return {
          content: `RAG service error: ${response.status} ${response.statusText}${
            body ? ` - ${body.slice(0, 300)}` : ""
          }`,
          isError: true,
        };
      }

      if (!response.body) {
        return {
          content: "RAG service returned empty response",
          isError: true,
        };
      }

      const events = response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(lineFixupStream())
        .pipeThrough(new EventSourceParserStream({ onError: "terminate" }));

      let fullAnswer = "";
      try {
        for await (const message of events) {
          if (!message.data) continue;

          if (message.event === "error" || message.data.startsWith("[ERROR]")) {
            const error =
              message.data.replace(/^\[ERROR\]\s*/, "") || "RAG service error";
            return { content: `RAG query failed: ${error}`, isError: true };
          }
          if (message.data === "[DONE]") break;
          fullAnswer += message.data;
        }
      } finally {
        // Cancellation propagates through the pipe chain to the response body,
        // releasing the socket; harmless once the stream closed by itself.
        await events.cancel().catch(() => {});
      }

      if (!fullAnswer) {
        return {
          content:
            "RAG service returned no answer. The knowledge base may be empty or the query may not match any documents.",
          isError: true,
        };
      }

      return { content: fullAnswer };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes("fetch failed") || msg.includes("ECONNREFUSED")) {
        return {
          content: `Cannot connect to RAG service at ${config.rag.apiUrl}. Make sure the Python RAG service is running.`,
          isError: true,
        };
      }
      return { content: `RAG query failed: ${msg}`, isError: true };
    }
  },
};
