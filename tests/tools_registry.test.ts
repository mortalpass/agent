import test from "node:test";
import assert from "node:assert/strict";
import { executeTool } from "../src/tools/index.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { Tool, ToolCall } from "../src/types.js";

function echoTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: "echo",
    description: "echo",
    parameters: { type: "object", properties: {} },
    async execute(args) {
      return { content: `echo:${String(args.text)}` };
    },
    ...overrides,
  };
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: "call_1",
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

test("registries are isolated per agent", async () => {
  const a = new ToolRegistry();
  const b = new ToolRegistry();
  a.register(echoTool());
  assert.equal(a.get("echo")?.name, "echo");
  assert.equal(b.get("echo"), undefined);
  assert.equal(
    (
      await executeTool(call("echo", { text: "hi" }), { registry: a })
    ).content.startsWith("echo:hi"),
    true,
  );
  assert.equal(
    (await executeTool(call("echo", { text: "hi" }), { registry: b })).content,
    "Unknown tool: echo",
  );
});

test("dangerous tools require approval", async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool({ dangerous: true }));

  const denied = await executeTool(call("echo", { text: "x" }), {
    registry,
    approval: () => false,
  });
  assert.match(denied.content, /denied by the approval policy/);

  const approved = await executeTool(call("echo", { text: "x" }), {
    registry,
    approval: () => true,
  });
  assert.equal(approved.content, "echo:x");
});

test("safe tools run without an approval handler", async () => {
  const registry = new ToolRegistry();
  registry.register(echoTool());
  const result = await executeTool(call("echo", { text: "x" }), { registry });
  assert.equal(result.content, "echo:x");
});
