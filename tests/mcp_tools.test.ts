import test from "node:test";
import assert from "node:assert/strict";
import type { Tool as McpToolDefinition } from "@modelcontextprotocol/sdk/types.js";
import { mcpToolToTool } from "../src/mcp/tools.js";
import type { McpConnection } from "../src/mcp/client.js";

const fakeConnection = {
  name: "server",
  callTool: async () => "",
} as unknown as McpConnection;

function toolName(name: string): string {
  return mcpToolToTool(fakeConnection, {
    name,
    description: "",
    inputSchema: { type: "object", properties: {} },
  } as McpToolDefinition).name;
}

test("short MCP names are left intact", () => {
  assert.equal(toolName("short"), "server__short");
});

test("long MCP names are capped at 64 chars with distinct hashes", () => {
  const base =
    "a-very-long-tool-name-that-keeps-going-and-going-and-going-past-limit";
  const first = toolName(base);
  const second = toolName(`${base}2`);
  assert.equal(first.length, 64);
  assert.equal(second.length, 64);
  assert.notEqual(first, second);
});
