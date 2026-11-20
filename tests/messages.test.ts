import test from "node:test";
import assert from "node:assert/strict";
import { MessageManager } from "../src/messages.js";
import type { Message } from "../src/types.js";

function bigCall(id: string): Message {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id,
        type: "function",
        function: { name: "read_file", arguments: "x".repeat(200) },
      },
    ],
  };
}

function roles(messages: MessageManager): string[] {
  return messages.getForLlm().map((m) => m.role);
}

test("trim drops tool_calls and results together when assistant is evicted", () => {
  const mgr = new MessageManager("s", 20);
  mgr.add({ role: "user", content: "u" });
  mgr.add(bigCall("c1"));
  mgr.add({ role: "tool", content: "r", tool_call_id: "c1" });
  assert.deepEqual(roles(mgr), ["system", "user"]);
});

test("trim protects the first user message (the original task)", () => {
  // 100 tokens fits everything except the early "ack" assistant turn, which
  // is the oldest evictable message (the first user message is protected).
  const mgr = new MessageManager("s", 100);
  mgr.add({ role: "user", content: "original task" });
  mgr.add({ role: "assistant", content: "ack" });
  mgr.add({ role: "user", content: "later instruction" });
  mgr.add({ role: "assistant", content: "y".repeat(300) });
  assert.deepEqual(roles(mgr), ["system", "user", "user", "assistant"]);
  const users = mgr
    .getForLlm()
    .filter((m) => m.role === "user")
    .map((m) => m.content);
  assert.deepEqual(users, ["original task", "later instruction"]);
});

test("trim keeps a complete tool exchange", () => {
  const mgr = new MessageManager("s", 200);
  mgr.add({ role: "user", content: "u" });
  mgr.add(bigCall("c1"));
  mgr.add({ role: "tool", content: "r", tool_call_id: "c1" });
  mgr.add({ role: "assistant", content: "final" });
  assert.deepEqual(roles(mgr), [
    "system",
    "user",
    "assistant",
    "tool",
    "assistant",
  ]);
});

test("tool result without a matching assistant tool_call is rejected", () => {
  const mgr = new MessageManager("s", 4096);
  mgr.add({ role: "tool", content: "orphan", tool_call_id: "missing" });
  assert.deepEqual(roles(mgr), ["system"]);
});
