import { createHash } from "node:crypto";
import type { Tool as McpToolDefinition } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "../types.js";
import type { McpConnection } from "./client.js";

const MAX_TOOL_NAME_LENGTH = 64;

function buildToolName(server: string, tool: string): string {
  const sanitized = `${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (sanitized.length <= MAX_TOOL_NAME_LENGTH) return sanitized;
  const hash = createHash("sha1").update(sanitized).digest("hex").slice(0, 8);
  return `${sanitized.slice(0, MAX_TOOL_NAME_LENGTH - 9)}_${hash}`;
}

export function mcpToolToTool(
  connection: McpConnection,
  tool: McpToolDefinition,
): Tool {
  const name = buildToolName(connection.name, tool.name);

  // MCP servers may omit `type` or use non-object schemas; only pass through
  // what the LLM tool format actually supports.
  const schema = tool.inputSchema as { type?: string } | undefined;
  const parameters: Tool["parameters"] =
    schema?.type === "object"
      ? (schema as Tool["parameters"])
      : { type: "object", properties: {} };

  return {
    name,
    description: `[MCP:${connection.name}] ${tool.description ?? tool.name}`,
    parameters,
    execute: async (args, context) => ({
      content: await connection.callTool(tool.name, args, {
        signal: context?.signal,
      }),
    }),
  };
}
