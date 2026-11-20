import test from "node:test";
import assert from "node:assert/strict";
import { UsageMeter } from "../src/context/usage_meter.js";
import { MessageManager } from "../src/messages.js";
import { Agent } from "../src/agent.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { delegateTaskTool } from "../src/tools/delegate_task.js";
import type { LLMProvider } from "../src/llm/base.js";

test("reserve holds tokens and fails hard when the budget is exhausted", () => {
  const meter = new UsageMeter(1000);

  const first = meter.reserve(600);
  assert.ok(first);
  assert.equal(meter.reserved, 600);
  assert.equal(meter.remaining, 400);

  // A second parallel child sees the first child's hold and is rejected
  // instead of both overshooting together.
  assert.equal(meter.reserve(600), null);
  assert.equal(meter.spent, 0);

  meter.release(first);
  assert.ok(meter.reserve(600));
});

test("settle replaces a reservation with the provider's actual usage", () => {
  const meter = new UsageMeter(1000);
  const reservation = meter.reserve(600);
  assert.ok(reservation);

  meter.settle(reservation, {
    prompt_tokens: 100,
    completion_tokens: 20,
    total_tokens: 120,
  });
  assert.equal(meter.spent, 120);
  assert.equal(meter.reserved, 0);
  assert.equal(meter.remaining, 880);
});

test("settle without usage charges the reservation", () => {
  const meter = new UsageMeter(1000);
  const reservation = meter.reserve(300);
  assert.ok(reservation);
  meter.settle(reservation);
  assert.equal(meter.spent, 300);
});

test("a disabled meter never blocks but still tracks spend", () => {
  const meter = new UsageMeter(0);
  assert.equal(meter.enabled, false);
  const reservation = meter.reserve(10_000_000);
  assert.ok(reservation);
  meter.settle(reservation, {
    prompt_tokens: 5,
    completion_tokens: 5,
    total_tokens: 10,
  });
  assert.equal(meter.spent, 10);
  assert.ok(meter.canAfford(Number.MAX_SAFE_INTEGER));
});

test("reset starts a fresh budget", () => {
  const meter = new UsageMeter(1000);
  const reservation = meter.reserve(900);
  assert.ok(reservation);
  meter.settle(reservation, {
    prompt_tokens: 900,
    completion_tokens: 0,
    total_tokens: 900,
  });
  assert.equal(meter.remaining, 100);

  meter.reset();
  assert.equal(meter.spent, 0);
  assert.equal(meter.reserved, 0);
  assert.ok(meter.reserve(900));
});

test("budget accounts for safety margin, output reserve and tool schemas", () => {
  const mgr = new MessageManager("s", 1000, {
    safety: 0.5,
    outputReserveTokens: 100,
  });
  assert.equal(mgr.budgetTokens(), 400);
  mgr.setToolSchemaTokens(50);
  assert.equal(mgr.budgetTokens(), 350);
});

test("tool schemas count toward the request and trigger trimming", () => {
  const mgr = new MessageManager("s", 200);
  mgr.add({ role: "user", content: "task" });
  mgr.add({ role: "assistant", content: "y".repeat(400) });
  assert.deepEqual(
    mgr.getAll().map((m) => m.role),
    ["system", "user", "assistant"],
  );

  mgr.setToolSchemaTokens(150);
  assert.deepEqual(
    mgr.getAll().map((m) => m.role),
    ["system", "user"],
  );
  assert.ok(mgr.estimateRequestTokens() >= 150);
});

test("recordUsage calibrates the estimate upward and clamps the ratio", () => {
  const mgr = new MessageManager("s", 1000, { model: "test/calibration" });
  mgr.add({ role: "user", content: "x".repeat(400) });
  const raw = mgr.estimateTokens();

  mgr.recordUsage({
    prompt_tokens: 200,
    completion_tokens: 0,
    total_tokens: 200,
  });
  assert.ok(mgr.estimateTokens() > raw);

  const calibrated = mgr.estimateTokens();
  mgr.recordUsage({
    prompt_tokens: 10_000,
    completion_tokens: 0,
    total_tokens: 10_000,
  });
  // Clamped at 1.6x, so a wildly outlying count cannot shrink the window.
  assert.equal(mgr.estimateTokens(), calibrated);
});

test("agent hard-fails before the next request once the budget is spent", async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: "echo",
    description: "echo",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: "ok" };
    },
  });

  let calls = 0;
  const provider: LLMProvider = {
    async chat() {
      calls++;
      return {
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "echo", arguments: "{}" },
          },
        ],
        finish_reason: "tool_calls",
        usage: {
          prompt_tokens: 2900,
          completion_tokens: 50,
          total_tokens: 2950,
        },
      };
    },
    async *stream() {
      throw new Error("not used in this test");
    },
  };

  const meter = new UsageMeter(3200);
  const agent = new Agent("system", 4096, { provider, registry, meter });
  const result = await agent.run("go");

  assert.equal(result.budgetExhausted, true);
  assert.match(result.answer, /token budget exhausted/);
  assert.equal(calls, 1);
});

test("delegate_task refuses to spawn when the budget cannot cover it", async () => {
  const result = await delegateTaskTool.execute(
    { task: "do work" },
    {
      depth: 0,
      registry: new ToolRegistry(),
      meter: new UsageMeter(10),
      maxTokens: 4096,
    },
  );
  assert.equal(result.isError, true);
  assert.match(result.content, /token budget exhausted/);
});
