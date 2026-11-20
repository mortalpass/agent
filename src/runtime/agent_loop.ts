import type { ChatOptions } from "../llm/base.js";
import type { MessageManager } from "../messages.js";
import { estimateToolSchemaTokens } from "../messages.js";
import type { UsageMeter } from "../context/usage_meter.js";
import type {
  AgentHooks,
  AgentMessage,
  ApprovalHandler,
  LLMChunk,
  LLMResponse,
  Message,
  PathAccessHandler,
  TokenUsage,
  ToolCall,
  ToolResult,
} from "../types.js";
import { executeTool } from "../tools/index.js";
import type { ArtifactStore } from "../context/artifacts.js";
import type { SandboxManager } from "../sandbox/index.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { EventBus, EventListener } from "../events.js";
import { logger } from "../logger.js";
import type { PlanStore } from "../planner.js";

export interface AgentRunResult {
  answer: string;
  iterations: number;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
  aborted?: boolean;
  /** True when MAX_RUN_TOKENS rejected a request (hard fail). */
  budgetExhausted?: boolean;
}

/**
 * Everything one run needs, built by the stateful Agent wrapper per call
 * (pi-agent pattern: agentLoop orchestrates, Agent owns state).
 */
export interface AgentRuntime {
  history: MessageManager;
  registry: ToolRegistry;
  planStore: PlanStore;
  bus: EventBus;
  hooks: AgentHooks;
  maxIterations: number;
  streaming: boolean;
  approval?: ApprovalHandler;
  pathAccess?: PathAccessHandler;
  /** Delegation depth of this agent (sub-agents get parent depth + 1). */
  delegationDepth: number;
  /** Context window forwarded to delegate_task sub-agents. */
  maxTokens: number;
  /** Completion reserve used when accounting a request against the meter. */
  maxOutputTokens: number;
  /** Absolute run budget shared with sub-agents (undefined = unlimited). */
  meter?: UsageMeter;
  onSubAgentEvent?: EventListener;
  /** LLM transport; usually derived from LLMProvider. */
  chat(messages: Message[], options: ChatOptions): Promise<LLMResponse>;
  stream(messages: Message[], options: ChatOptions): AsyncGenerator<LLMChunk>;
  drainSteering(): AgentMessage[];
  /** Investigation context: repo under investigation (absolute path). */
  repoRoot?: string;
  /** Investigation artifact store for oversized investigation results. */
  artifacts?: ArtifactStore;
  /** Investigation sandbox manager for sandbox/patch/verify tools. */
  sandbox?: SandboxManager;
}

export function agentLoop(
  runtime: AgentRuntime,
  userMessage: string,
  signal: AbortSignal,
): Promise<AgentRunResult> {
  return new Loop(runtime, signal).run(userMessage);
}

class Loop {
  private readonly toolCalls: ToolCall[] = [];
  private usage: TokenUsage | undefined;
  private iterations = 0;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly signal: AbortSignal,
  ) {}

  async run(userMessage: string): Promise<AgentRunResult> {
    const { runtime } = this;
    runtime.history.add({ role: "user", content: userMessage });
    runtime.bus.emit({ type: "agent_start", userMessage });
    logger.debug(`User: ${userMessage}`);

    for (let i = 0; i < runtime.maxIterations; i++) {
      if (this.signal.aborted) {
        return this.cancelled(false);
      }
      this.iterations = i + 1;

      for (const msg of runtime.drainSteering()) {
        runtime.history.add(msg);
        logger.debug(`Steering applied: ${String(msg.content).slice(0, 80)}`);
      }

      runtime.bus.emit({
        type: "turn_start",
        iteration: this.iterations,
        maxIterations: runtime.maxIterations,
      });
      logger.debug(
        `--- Iteration ${this.iterations}/${runtime.maxIterations} ---`,
      );

      // Tool schemas travel with every request but are not history; register
      // them first so the budget check and the trim see the full request.
      runtime.history.setToolSchemaTokens(
        estimateToolSchemaTokens(runtime.registry.definitions()),
      );

      // Hard-fail absolute budget: reserve synchronously before the request so
      // parallel sub-agents cannot all observe the same remaining budget.
      const reservation = runtime.meter
        ? runtime.meter.reserve(
            runtime.history.estimateRequestTokens() + runtime.maxOutputTokens,
          )
        : null;
      if (runtime.meter && !reservation) {
        return this.budgetExhausted();
      }

      let response: LLMResponse;
      let streamed = false;
      try {
        if (runtime.streaming) {
          const streamedResult = await this.streamChat();
          response = {
            content: streamedResult.content,
            tool_calls:
              streamedResult.toolCalls.length > 0
                ? streamedResult.toolCalls
                : undefined,
            finish_reason: null,
            usage: streamedResult.usage,
          };
          this.usage = addUsage(this.usage, streamedResult.usage);
          streamed = true;
        } else {
          response = await runtime.chat(this.requestMessages(), {
            tools: runtime.registry.definitions(),
            signal: this.signal,
          });
          this.usage = addUsage(this.usage, response.usage);
        }
        runtime.history.recordUsage(response.usage);
        if (reservation) runtime.meter?.settle(reservation, response.usage);
      } catch (error) {
        if (reservation) runtime.meter?.release(reservation);
        if (this.signal.aborted) {
          runtime.bus.emit({ type: "turn_end", hasToolCalls: false });
          return this.cancelled(false);
        }
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`LLM call failed: ${msg}`);
        runtime.bus.emit({ type: "agent_error", message: msg });
        runtime.bus.emit({ type: "turn_end", hasToolCalls: false });
        return {
          answer: `(LLM error: ${msg})`,
          iterations: this.iterations,
          toolCalls: this.toolCalls,
          usage: this.usage,
        };
      }

      for (const tc of response.tool_calls ?? []) this.toolCalls.push(tc);

      if (!response.tool_calls || response.tool_calls.length === 0) {
        const answer = response.content ?? "(no response)";
        runtime.history.add({ role: "assistant", content: answer });

        const nudge = await this.finishTurn(answer);
        if (nudge !== undefined && !this.signal.aborted) {
          // Acceptance gate rejected the turn: continue the loop instead of
          // ending the run.
          runtime.history.add({ role: "user", content: nudge });
          runtime.bus.emit({ type: "turn_end", hasToolCalls: false });
          continue;
        }

        if (!streamed) {
          runtime.bus.emit({ type: "message_start", role: "assistant" });
          runtime.bus.emit({ type: "message_update", content: answer });
          runtime.bus.emit({
            type: "message_end",
            role: "assistant",
            content: answer,
            usage: response.usage,
          });
        }
        runtime.bus.emit({ type: "turn_end", hasToolCalls: false });
        runtime.bus.emit({
          type: "agent_end",
          answer,
          iterations: this.iterations,
          toolCalls: this.toolCalls,
          usage: this.usage,
        });
        logger.debug(`Final answer (${answer.length} chars)`);
        return {
          answer,
          iterations: this.iterations,
          toolCalls: this.toolCalls,
          usage: this.usage,
        };
      }

      runtime.history.add({
        role: "assistant",
        content: response.content,
        tool_calls: response.tool_calls,
      });
      runtime.bus.emit({ type: "turn_end", hasToolCalls: true });

      // Tool-specific executionMode decides concurrency; a turn made only of
      // delegate_task calls also runs in parallel: sub-agents have isolated
      // histories/plan stores, so delegations only touch each other via the
      // filesystem. Mixing delegation with anything else stays sequential to
      // avoid racing a sub-agent's writes against parent tools.
      const outcomes: Array<{ toolCall: ToolCall; result: ToolResult }> = [];
      if (canRunInParallel(response.tool_calls, runtime.registry)) {
        outcomes.push(
          ...(await Promise.all(
            response.tool_calls.map((toolCall) =>
              this.executeToolCall(toolCall),
            ),
          )),
        );
      } else {
        for (const toolCall of response.tool_calls) {
          outcomes.push(await this.executeToolCall(toolCall));
        }
      }

      for (const { toolCall, result } of outcomes) {
        runtime.history.add({
          role: "tool",
          content: result.content,
          tool_call_id: toolCall.id,
        });
      }

      if (this.signal.aborted) {
        return this.cancelled(true);
      }
    }

    logger.warn(`Max iterations (${runtime.maxIterations}) reached`);
    const answer = "(reached maximum iterations)";
    runtime.bus.emit({ type: "turn_end", hasToolCalls: false });
    runtime.bus.emit({
      type: "agent_end",
      answer,
      iterations: this.iterations,
      toolCalls: this.toolCalls,
      usage: this.usage,
    });
    return {
      answer,
      iterations: this.iterations,
      toolCalls: this.toolCalls,
      usage: this.usage,
    };
  }

  private requestMessages(): Message[] {
    const messages = this.runtime.history.getForLlm();
    const prepare = this.runtime.hooks.prepareRequest;
    if (!prepare) return messages;
    return prepare(messages, { tools: this.runtime.registry.definitions() });
  }

  private async finishTurn(answer: string): Promise<string | undefined> {
    const finish = this.runtime.hooks.finishTurn;
    if (!finish) return undefined;
    try {
      return await finish({ answer, iterations: this.iterations });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`finishTurn hook failed: ${msg}`);
      return undefined;
    }
  }

  private async executeToolCall(
    toolCall: ToolCall,
  ): Promise<{ toolCall: ToolCall; result: ToolResult }> {
    const { runtime } = this;
    runtime.bus.emit({
      type: "tool_execution_start",
      name: toolCall.function.name,
      args: toolCall.function.arguments,
    });
    logger.tool(toolCall.function.name, toolCall.function.arguments);

    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = JSON.parse(toolCall.function.arguments) as Record<
        string,
        unknown
      >;
    } catch {
      // executeTool re-parses and reports the invalid JSON itself.
      parsedArgs = {};
    }

    const veto = await this.beforeToolCall(toolCall, parsedArgs);
    let result: ToolResult;
    if (veto) {
      result = {
        content: veto,
        isError: true,
      };
    } else {
      result = await executeTool(toolCall, {
        signal: this.signal,
        planStore: runtime.planStore,
        registry: runtime.registry,
        approval: runtime.approval,
        pathAccess: runtime.pathAccess,
        depth: runtime.delegationDepth,
        maxTokens: runtime.maxTokens,
        maxOutputTokens: runtime.maxOutputTokens,
        meter: runtime.meter,
        onSubAgentEvent: runtime.onSubAgentEvent,
        repoRoot: runtime.repoRoot,
        artifacts: runtime.artifacts,
        sandbox: runtime.sandbox,
      });
      const after = runtime.hooks.afterToolCall;
      if (after) {
        try {
          result = await after({
            tool: toolCall.function.name,
            toolCallId: toolCall.id,
            result,
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          logger.warn(`afterToolCall hook failed: ${msg}`);
        }
      }
    }

    runtime.bus.emit({
      type: "tool_execution_end",
      name: toolCall.function.name,
      result,
    });
    logger.result(result.content);

    return { toolCall, result };
  }

  private async beforeToolCall(
    toolCall: ToolCall,
    args: Record<string, unknown>,
  ): Promise<string | undefined> {
    const hook = this.runtime.hooks.beforeToolCall;
    if (!hook) return undefined;
    try {
      const decision = await hook({ tool: toolCall.function.name, args });
      if (decision?.deny) {
        const reason = decision.reason ?? "policy";
        logger.info(
          `Tool ${toolCall.function.name} denied by beforeToolCall hook: ${reason}`,
        );
        return `Tool ${toolCall.function.name} was denied by policy (${reason}). Explain to the user or continue without it.`;
      }
      return undefined;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`beforeToolCall hook failed: ${msg}`);
      return undefined;
    }
  }

  private async streamChat(): Promise<{
    content: string;
    toolCalls: ToolCall[];
    usage?: TokenUsage;
  }> {
    const { runtime } = this;
    let content = "";
    let started = false;
    const toolCalls: ToolCall[] = [];

    for await (const chunk of runtime.stream(this.requestMessages(), {
      tools: runtime.registry.definitions(),
      signal: this.signal,
    })) {
      if (chunk.content) {
        if (!started) {
          started = true;
          runtime.bus.emit({ type: "message_start", role: "assistant" });
        }
        content += chunk.content;
        runtime.bus.emit({ type: "message_update", content: chunk.content });
      }

      if (chunk.tool_calls) {
        // Tool-only turns emit message_start too, so the CLI still shows an
        // "Assistant > " prompt line instead of jumping straight to [tool].
        if (!started) {
          started = true;
          runtime.bus.emit({ type: "message_start", role: "assistant" });
        }
        toolCalls.push(...chunk.tool_calls);
      }
      if (chunk.usage) {
        // Convention: a provider's chunks carry cumulative usage with the
        // final chunk at full totals; OpenAI-compatible streams do this today.
        // If a future provider reports per-chunk deltas, accumulate them.
        this.lastStreamUsage = chunk.usage;
      }
    }

    if (started) {
      runtime.bus.emit({
        type: "message_end",
        role: "assistant",
        content,
        usage: this.lastStreamUsage,
      });
    }

    return { content, toolCalls, usage: this.lastStreamUsage };
  }

  private lastStreamUsage: TokenUsage | undefined;

  private budgetExhausted(): AgentRunResult {
    const message = `(token budget exhausted: ${this.runtime.meter?.describe() ?? "limit reached"})`;
    logger.warn(message);
    this.runtime.bus.emit({ type: "agent_error", message });
    this.runtime.bus.emit({ type: "turn_end", hasToolCalls: false });
    this.runtime.bus.emit({
      type: "agent_end",
      answer: message,
      iterations: this.iterations,
      toolCalls: this.toolCalls,
      usage: this.usage,
    });
    return {
      answer: message,
      iterations: this.iterations,
      toolCalls: this.toolCalls,
      usage: this.usage,
      budgetExhausted: true,
    };
  }

  private cancelled(hasToolCalls: boolean): AgentRunResult {
    const answer = "(cancelled)";
    const { runtime } = this;
    logger.warn("Run cancelled");
    runtime.bus.emit({ type: "turn_end", hasToolCalls });
    runtime.bus.emit({
      type: "agent_end",
      answer,
      iterations: this.iterations,
      toolCalls: this.toolCalls,
      usage: this.usage,
    });
    return {
      answer,
      iterations: this.iterations,
      toolCalls: this.toolCalls,
      usage: this.usage,
      aborted: true,
    };
  }
}

function addUsage(
  total: TokenUsage | undefined,
  usage?: TokenUsage,
): TokenUsage | undefined {
  if (!usage) return total;
  const base = total ?? {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  };
  return {
    prompt_tokens: base.prompt_tokens + usage.prompt_tokens,
    completion_tokens: base.completion_tokens + usage.completion_tokens,
    total_tokens: base.total_tokens + usage.total_tokens,
  };
}

/**
 * Tools declare their own executionMode; a turn where every tool opted into
 * "parallel" runs concurrently. A turn made only of delegate_task calls also
 * runs in parallel (isolated sub-agent contexts); anything else stays
 * sequential in call order.
 */
export function canRunInParallel(
  toolCalls: ToolCall[],
  registry: ToolRegistry,
): boolean {
  if (toolCalls.every((tc) => tc.function.name === "delegate_task")) {
    return true;
  }
  return toolCalls.every(
    (tc) => registry.get(tc.function.name)?.executionMode === "parallel",
  );
}
