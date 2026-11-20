import test from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/agent.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { AgentEvent, LLMProvider, Tool, ToolCall } from "../src/types.js";

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: `call_${name}`,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function echoTool(): Tool {
  return {
    name: "echo",
    description: "echo back",
    parameters: { type: "object", properties: {} },
    async execute(args) {
      return {
        content: `echo:${JSON.stringify(args.text ?? "")}`,
        isError: args.error === true,
      };
    },
  };
}

function fakeProvider(
  script: Array<
    { kind: "tools"; calls: ToolCall[] } | { kind: "text"; content: string }
  >,
): LLMProvider {
  let step = 0;
  return {
    async chat() {
      const action = script[step++];
      if (!action) throw new Error("script exhausted");
      if (action.kind === "tools") {
        return {
          content: null,
          tool_calls: action.calls,
          finish_reason: "tool_calls",
        };
      }
      return { content: action.content, finish_reason: "stop" };
    },
    async *stream() {
      throw new Error("stream not expected in this test");
    },
  };
}

function registry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(echoTool());
  return reg;
}

function collect(agent: Agent): AgentEvent[] {
  const events: AgentEvent[] = [];
  agent.subscribe((event) => events.push(event));
  return events;
}

test("beforeToolCall hook can veto a tool call", async () => {
  const provider = fakeProvider([
    { kind: "tools", calls: [toolCall("echo", { text: "x" })] },
    { kind: "text", content: "done" },
  ]);
  const agent = new Agent("system", 4096, {
    provider,
    registry: registry(),
    hooks: {
      beforeToolCall: ({ tool }) => ({
        deny: tool === "echo",
        reason: "sandbox policy",
      }),
    },
  });

  const result = await agent.run("go");
  assert.equal(result.answer, "done");
  const denied = agent
    .getMessages()
    .find((m) => m.role === "tool" && m.content.includes("denied by policy"));
  assert.ok(denied);
});

test("afterToolCall hook can rewrite or observe results", async () => {
  const provider = fakeProvider([
    { kind: "tools", calls: [toolCall("echo", { text: "x" })] },
    { kind: "text", content: "done" },
  ]);
  const seen: string[] = [];
  const agent = new Agent("system", 4096, {
    provider,
    registry: registry(),
    hooks: {
      afterToolCall: ({ toolCallId, result }) => {
        seen.push(toolCallId);
        return { ...result, content: `rewritten(${result.content})` };
      },
    },
  });

  await agent.run("go");
  assert.deepEqual(seen, ["call_echo"]);
  const toolMsg = agent.getMessages().find((m) => m.role === "tool");
  assert.match(String(toolMsg?.content), /rewritten\(echo:"x"\)/);
});

test("finishTurn hook can keep the loop going with a nudge", async () => {
  const provider = fakeProvider([
    { kind: "text", content: "preliminary" },
    { kind: "text", content: "final answer" },
  ]);
  let checks = 0;
  const agent = new Agent("system", 4096, {
    provider,
    registry: registry(),
    hooks: {
      finishTurn: ({ answer }) => {
        checks += 1;
        return answer.includes("final") ? undefined : "please finish properly";
      },
    },
  });

  const result = await agent.run("go");
  assert.equal(checks, 2);
  assert.equal(result.answer, "final answer");
  assert.equal(result.iterations, 2);
  const nudge = agent
    .getMessages()
    .find((m) => m.role === "user" && m.content === "please finish properly");
  assert.ok(nudge);
});

test("prepareRequest hook sees the messages before each LLM call", async () => {
  const provider = fakeProvider([{ kind: "text", content: "answer" }]);
  const firstRoles: string[][] = [];
  const agent = new Agent("system", 4096, {
    provider,
    registry: registry(),
    hooks: {
      prepareRequest: (messages) => {
        firstRoles.push(messages.map((m) => m.role));
        return messages;
      },
    },
  });

  await agent.run("question");
  assert.deepEqual(firstRoles, [["system", "user"]]);
});

test("followUp() starts a new run after the current one", async () => {
  const provider = fakeProvider([
    { kind: "text", content: "first" },
    { kind: "text", content: "seconds" },
  ]);
  const agent = new Agent("system", 4096, {
    provider,
    registry: registry(),
  });
  agent.followUp("second question");

  const events = collect(agent);
  const result = await agent.run("first question");

  assert.equal(result.answer, "seconds");
  const runs = events.filter((e) => e.type === "agent_start");
  assert.equal(runs.length, 2);
  const final = events.at(-1);
  assert.ok(final?.type === "agent_end");
  assert.equal(final.answer, "seconds");
});

test("tool events carry isError for failing tools", async () => {
  const provider = fakeProvider([
    { kind: "tools", calls: [toolCall("echo", { text: "x", error: true })] },
    { kind: "text", content: "done" },
  ]);
  const agent = new Agent("system", 4096, {
    provider,
    registry: registry(),
  });

  const events = collect(agent);
  await agent.run("go");
  const end = events.find(
    (e) => e.type === "tool_execution_end" && resultOf(e),
  );
  assert.ok(end);
  if (end?.type === "tool_execution_end") {
    assert.equal(end.result.isError, true);
    assert.equal(end.result.content, 'echo:"x"');
  }
  const start = events.find((e) => e.type === "tool_execution_start");
  assert.equal(start?.name, "echo");
});

function resultOf(event: AgentEvent): boolean {
  return event.type === "tool_execution_end";
}

test("steer() applied by a hook lands in history before the next LLM call", async () => {
  const prov = fakeProvider([
    { kind: "tools", calls: [toolCall("echo", { text: "x" })] },
    { kind: "text", content: "done" },
  ]);
  const agent = new Agent("system", 4096, {
    provider: prov,
    registry: registry(),
    hooks: {
      afterToolCall: ({ result }) => {
        agent.steer("extra instruction");
        return result;
      },
    },
  });
  const result = await agent.run("go");
  assert.equal(result.answer, "done");
  const steerMsg = agent
    .getMessages()
    .find((m) => m.role === "user" && m.content === "extra instruction");
  assert.ok(steerMsg);
});
