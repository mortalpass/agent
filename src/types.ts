export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: MessageRole;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface CustomAgentMessages {
  // Extend via declaration merging:
  // declare module "./types.js" {
  //   interface CustomAgentMessages {
  //     notification: { role: "notification"; text: string; timestamp: number };
  //   }
  // }
}

export type CustomMessage = CustomAgentMessages[keyof CustomAgentMessages];

export type AgentMessage = Message | CustomMessage;

export function isLLMMessage(msg: AgentMessage): msg is Message {
  return (
    msg.role === "system" ||
    msg.role === "user" ||
    msg.role === "assistant" ||
    msg.role === "tool"
  );
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JSONSchema;
  };
}

/** How a tool participates in same-turn parallel execution (pi-agent pattern). */
export type ToolExecutionMode = "sequential" | "parallel";

/**
 * Uniform tool execution outcome. Tools may throw; executeTool converts
 * thrown errors to a ToolResult with isError set.
 */
export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface JSONSchemaProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: { type: string; description?: string };
  minimum?: number;
  maximum?: number;
}

export interface JSONSchema {
  type: "object";
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
}

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface LLMResponse {
  content: string | null;
  tool_calls?: ToolCall[];
  finish_reason: string | null;
  usage?: TokenUsage;
}

export interface LLMChunk {
  content: string;
  /** Complete tool calls, assembled by the provider and yielded on the final chunk. */
  tool_calls?: ToolCall[];
  usage?: TokenUsage;
  finish_reason: string | null;
}

import type { PlanStore } from "./planner.js";
import type { ArtifactStore } from "./context/artifacts.js";
import type { UsageMeter } from "./context/usage_meter.js";
import type { SandboxManager } from "./sandbox/index.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { EventListener } from "./events.js";

export interface ToolApprovalRequest {
  tool: string;
  args: Record<string, unknown>;
}

export type ApprovalHandler = (
  request: ToolApprovalRequest,
) => Promise<boolean> | boolean;

export type PathAccessOperation = "read" | "list" | "write";

export interface PathAccessRequest {
  tool: string;
  operation: PathAccessOperation;
  /** Absolute, already-resolved path this call needs. */
  path: string;
}

export type PathAccessDecision = "once" | "session" | "deny";

export type PathAccessHandler = (
  request: PathAccessRequest,
) => Promise<PathAccessDecision> | PathAccessDecision;

export interface ToolContext {
  signal?: AbortSignal;
  planStore?: PlanStore;
  registry?: ToolRegistry;
  approval?: ApprovalHandler;
  pathAccess?: PathAccessHandler;
  /** How deep this execution is in the delegation chain (0 = top-level agent). */
  depth?: number;
  /** Context window inherited by delegate_task's sub-agent. */
  maxTokens?: number;
  /** Completion tokens reserved per request, used by spawn-time budgeting. */
  maxOutputTokens?: number;
  /** Absolute run budget shared by the parent and its sub-agents. */
  meter?: UsageMeter;
  /** Receives events from sub-agents spawned via delegate_task. */
  onSubAgentEvent?: EventListener;
  /** Investigation context: repo under investigation (absolute path). */
  repoRoot?: string;
  /** Investigation context: store for oversized tool outputs. */
  artifacts?: ArtifactStore;
  /** Investigation context: sandbox manager wired by the investigate CLI. */
  sandbox?: SandboxManager;
}

/** Paths a tool call wants to access, declared for permission prompting. */
export interface ToolAccessRequest {
  path: string;
  operation: PathAccessOperation;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  /** Dangerous tools require approval via the ApprovalHandler before execution. */
  dangerous?: boolean;
  /**
   * Per-tool timeout override (executed before the global TOOL_TIMEOUT_MS
   * default); long-running tools like sandbox_run use it.
   */
  timeoutMs?: number;
  /**
   * Declares whether this tool may run concurrently with other tools in the
   * same turn. Defaults to "sequential"; only read-only tools opt in.
   */
  executionMode?: ToolExecutionMode;
  /**
   * Declares the paths this call needs so executeTool can ask for
   * permission (and honor session grants) before arming the tool timeout.
   * The context is provided so tools can resolve relative paths against the
   * investigation repo root instead of the process cwd.
   */
  accessRequests?(
    args: Record<string, unknown>,
    context?: ToolContext,
  ): ToolAccessRequest[];
  execute(
    args: Record<string, unknown>,
    context?: ToolContext,
  ): Promise<ToolResult>;
}

/** Runtime hooks (pi-agent pattern); all optional, no-op when omitted. */
export interface AgentHooks {
  /** Transform the LLM request messages right before each provider call. */
  prepareRequest?(
    messages: Message[],
    context: { tools: ToolDefinition[] },
  ): Message[];
  /** Veto a tool call before execution (sandbox policy, phase gates). */
  beforeToolCall?(
    request: ToolApprovalRequest,
  ):
    | BeforeToolCallDecision
    | undefined
    | Promise<BeforeToolCallDecision | undefined>;
  /** Observe or replace the tool result before it enters history. */
  afterToolCall?(request: {
    tool: string;
    toolCallId: string;
    result: ToolResult;
  }): ToolResult | Promise<ToolResult>;
  /**
   * Called on the final (tool-free) response. Returning a string continues
   * the loop with that string injected as a user message (acceptance gates).
   */
  finishTurn?(context: {
    answer: string;
    iterations: number;
  }): string | undefined | Promise<string | undefined>;
}

export interface BeforeToolCallDecision {
  deny?: boolean;
  reason?: string;
}
