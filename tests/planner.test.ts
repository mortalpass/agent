import test from "node:test";
import assert from "node:assert/strict";
import { PlanStore } from "../src/planner.js";
import { executeTool } from "../src/tools/index.js";
import { createDefaultRegistry } from "../src/tools/registry.js";

const registry = createDefaultRegistry();

function planCall(steps: string[]) {
  return {
    id: `call-${steps[0]}`,
    type: "function" as const,
    function: {
      name: "update_plan",
      arguments: JSON.stringify({ steps, completed: 1 }),
    },
  };
}

test("plan stores are isolated between agents", async () => {
  const first = new PlanStore();
  const second = new PlanStore();
  await executeTool(planCall(["a1", "a2"]), { planStore: first, registry });
  await executeTool(planCall(["b1"]), { planStore: second, registry });
  assert.deepEqual(first.get()?.steps, ["a1", "a2"]);
  assert.deepEqual(second.get()?.steps, ["b1"]);
});

test("completed is clamped to the step range", () => {
  const store = new PlanStore();
  assert.equal(store.set(["one"], 99).completed, 1);
  assert.equal(store.set(["one", "two"], -5).completed, 0);
});

test("update_plan fails clearly without a plan store", async () => {
  const result = await executeTool(planCall(["x"]), { registry });
  assert.equal(result.content, "Error: plan store is unavailable");
});
