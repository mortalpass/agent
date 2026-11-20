import test from "node:test";
import assert from "node:assert/strict";
import { canRunInParallel } from "../src/runtime/agent_loop.js";
import { createDefaultRegistry } from "../src/tools/registry.js";
import type { Tool, ToolCall } from "../src/types.js";

const registry = createDefaultRegistry();

function calls(...names: string[]): ToolCall[] {
  return names.map((name, i) => ({
    id: `c${i}`,
    type: "function",
    function: { name, arguments: "{}" },
  }));
}

test("tools declare parallelism via executionMode", () => {
  assert.equal(registry.get("read_file")?.executionMode, "parallel");
  assert.equal(registry.get("list_files")?.executionMode, "parallel");
  assert.equal(registry.get("rag_query")?.executionMode, "parallel");
  assert.equal(registry.get("write_file")?.executionMode, undefined);
  assert.equal(registry.get("update_plan")?.executionMode, undefined);
});

test("parallel-mode batches run in parallel", () => {
  assert.equal(
    canRunInParallel(calls("read_file", "list_files"), registry),
    true,
  );
  assert.equal(canRunInParallel(calls("rag_query"), registry), true);
  assert.equal(
    canRunInParallel(calls("read_file", "rag_query"), registry),
    true,
  );
});

test("sequential tools opt out even when mixed with parallel ones", () => {
  assert.equal(
    canRunInParallel(calls("write_file", "read_file"), registry),
    false,
  );
  assert.equal(canRunInParallel(calls("update_plan"), registry), false);
});

test("a turn of only delegate_task calls runs in parallel", () => {
  assert.equal(
    canRunInParallel(calls("delegate_task", "delegate_task"), registry),
    true,
  );
});

test("delegation mixed with other tools stays sequential", () => {
  assert.equal(
    canRunInParallel(calls("delegate_task", "read_file"), registry),
    false,
  );
  assert.equal(
    canRunInParallel(calls("read_file", "delegate_task"), registry),
    false,
  );
});

test("unknown tools are never parallel", () => {
  assert.equal(canRunInParallel(calls("no_such_tool"), registry), false);
});

test("custom tools can opt into parallel execution", async () => {
  const { ToolRegistry } = await import("../src/tools/registry.js");
  const custom: Tool = {
    name: "fan_read",
    description: "custom parallel reader",
    parameters: { type: "object", properties: {} },
    executionMode: "parallel",
    async execute() {
      return { content: "ok" };
    },
  };
  const reg = new ToolRegistry();
  reg.register(custom);
  assert.equal(canRunInParallel(calls("fan_read"), reg), true);
  assert.equal(canRunInParallel(calls("fan_read", "write_file"), reg), false);
});
