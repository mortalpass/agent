import { chat, stream } from "./llm/index.js";
import type { ChatOptions, LLMProvider } from "./llm/base.js";
import { MessageManager, type MessageManagerOptions } from "./messages.js";
import { EventBus, type EventListener } from "./events.js";
import {
  agentLoop,
  type AgentRunResult,
  type AgentRuntime,
} from "./runtime/agent_loop.js";
import { PlanStore, type PlanState } from "./planner.js";
import type {
  AgentHooks,
  AgentMessage,
  ApprovalHandler,
  LLMChunk,
  LLMResponse,
  Message,
  PathAccessHandler,
} from "./types.js";
import type { ArtifactStore } from "./context/artifacts.js";
import type { SandboxManager } from "./sandbox/index.js";
import { UsageMeter } from "./context/usage_meter.js";
import { ToolRegistry, createDefaultRegistry } from "./tools/registry.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

export interface AgentOptions {
  messages?: MessageManagerOptions;
  /** LLM provider for this agent; falls back to the global llm module when omitted. */
  provider?: LLMProvider;
  /** Tool set for this agent; defaults to a fresh registry with the built-in tools. */
  registry?: ToolRegistry;
  approval?: ApprovalHandler;
  pathAccess?: PathAccessHandler;
  /** Delegation depth of this agent (sub-agents get parent depth + 1). */
  delegationDepth?: number;
  /** Receives events emitted by sub-agents spawned via delegate_task. */
  onSubAgentEvent?: EventListener;
  /** Runtime hooks (pi-agent pattern): prepareRequest / beforeToolCall / afterToolCall / finishTurn. */
  hooks?: AgentHooks;
  /** Investigation context: repo under investigation (absolute path). */
  repoRoot?: string;
  /** Investigation artifact store for oversized investigation results. */
  artifacts?: ArtifactStore;
  /** Investigation sandbox manager (sandbox_create/run, write_patch, risk_report). */
  sandbox?: SandboxManager;
  /**
   * Absolute token budget shared with sub-agents. Defaults to a meter built
   * from MAX_RUN_TOKENS; omit both for an unlimited run.
   */
  meter?: UsageMeter;
}

/**
 * Stateful agent wrapper (pi-agent pattern): owns history, plan, queues, and
 * abort state; each run delegates orchestration to agentLoop().
 */
export class Agent {
  private history: MessageManager;
  private maxTokens: number;
  private maxOutputTokens: number;
  private meter?: UsageMeter;
  private bus = new EventBus();
  private steeringQueue: AgentMessage[] = [];
  private followUpQueue: string[] = [];
  private abortController?: AbortController;
  private planStore = new PlanStore();
  private provider?: LLMProvider;
  private registry: ToolRegistry;
  private approval?: ApprovalHandler;
  private pathAccess?: PathAccessHandler;
  private delegationDepth: number;
  private onSubAgentEvent?: EventListener;
  private hooks: AgentHooks;
  private repoRoot?: string;
  private artifacts?: ArtifactStore;
  private sandbox?: SandboxManager;
  private streaming = false;

  constructor(
    systemPrompt: string,
    maxTokens: number = config.llm.contextTokens,
    options: AgentOptions = {},
  ) {
    this.registry = options.registry ?? createDefaultRegistry();
    this.meter =
      options.meter ??
      (config.llm.runTokenBudget > 0
        ? new UsageMeter(config.llm.runTokenBudget)
        : undefined);
    this.maxOutputTokens = config.llm.maxTokens;
    this.history = new MessageManager(systemPrompt, maxTokens, {
      safety: config.llm.contextSafety,
      outputReserveTokens: this.maxOutputTokens,
      maxToolChars: config.llm.maxToolResultChars,
      model: config.llm.model || config.llm.provider,
      ...options.messages,
    });
    this.maxTokens = maxTokens;
    this.provider = options.provider;
    this.approval = options.approval;
    this.pathAccess = options.pathAccess;
    this.delegationDepth = options.delegationDepth ?? 0;
    this.onSubAgentEvent = options.onSubAgentEvent;
    this.hooks = options.hooks ?? {};
    this.repoRoot = options.repoRoot;
    this.artifacts = options.artifacts;
    this.sandbox = options.sandbox;
  }

  subscribe(listener: EventListener): () => void {
    return this.bus.subscribe(listener);
  }

  setStreaming(enabled: boolean): void {
    this.streaming = enabled;
  }

  setApproval(handler: ApprovalHandler | undefined): void {
    this.approval = handler;
  }

  setPathAccess(handler: PathAccessHandler | undefined): void {
    this.pathAccess = handler;
  }

  getPlan(): PlanState | null {
    return this.planStore.get();
  }

  resetPlan(): void {
    this.planStore.reset();
  }

  abort(): void {
    if (!this.abortController) {
      logger.debug("Abort requested but no run is active");
      return;
    }
    logger.warn("Aborting current run");
    this.abortController.abort();
  }

  async run(
    userMessage: string,
    externalSignal?: AbortSignal,
  ): Promise<AgentRunResult> {
    if (this.abortController) {
      throw new Error(
        "Agent.run() called while another run is active; abort it first",
      );
    }
    // MAX_RUN_TOKENS is a per-run budget: sub-agents share the parent's meter
    // and must never reset it mid-run.
    if (this.delegationDepth === 0) {
      this.meter?.reset();
    }
    this.abortController = new AbortController();
    const signal = externalSignal
      ? AbortSignal.any([this.abortController.signal, externalSignal])
      : this.abortController.signal;

    try {
      let result = await agentLoop(this.runtime(), userMessage, signal);
      // followUp() messages queued during a run start a new run after the
      // current one; an abort stops draining the chain.
      while (!signal.aborted && this.followUpQueue.length > 0) {
        const next = this.followUpQueue.shift()!;
        logger.debug("Starting follow-up run");
        result = await agentLoop(this.runtime(), next, signal);
      }
      return result;
    } finally {
      this.abortController = undefined;
      // Drop queued steering/follow-up messages that arrived after the last
      // drain so they cannot leak into an unrelated future run.
      this.steeringQueue = [];
      this.followUpQueue = [];
    }
  }

  steer(message: string): void {
    this.steeringQueue.push({ role: "user", content: message });
    logger.debug(`Steering queued (${this.steeringQueue.length} pending)`);
  }

  followUp(message: string): void {
    this.followUpQueue.push(message);
    logger.debug(`Follow-up queued (${this.followUpQueue.length} pending)`);
  }

  clear(): void {
    this.history.clear();
    this.steeringQueue = [];
    this.followUpQueue = [];
    logger.debug("History cleared");
  }

  getMessages(): AgentMessage[] {
    return this.history.getAll();
  }

  restore(messages: AgentMessage[]): void {
    this.history.replace(messages);
    logger.debug(`History restored (${messages.length} msgs)`);
  }

  historyCount(): number {
    return this.history.count();
  }

  historyTokens(): number {
    return this.history.estimateTokens();
  }

  private runtime(): AgentRuntime {
    return {
      history: this.history,
      registry: this.registry,
      planStore: this.planStore,
      bus: this.bus,
      hooks: this.hooks,
      maxIterations: config.agent.maxIterations,
      streaming: this.streaming,
      approval: this.approval,
      pathAccess: this.pathAccess,
      delegationDepth: this.delegationDepth,
      maxTokens: this.maxTokens,
      maxOutputTokens: this.maxOutputTokens,
      meter: this.meter,
      onSubAgentEvent: this.onSubAgentEvent,
      repoRoot: this.repoRoot,
      artifacts: this.artifacts,
      sandbox: this.sandbox,
      chat: (messages: Message[], options: ChatOptions) =>
        this.llmChat(messages, options),
      stream: (messages: Message[], options: ChatOptions) =>
        this.llmStream(messages, options),
      drainSteering: () => {
        const pending = this.steeringQueue;
        this.steeringQueue = [];
        return pending;
      },
    };
  }

  private llmChat(
    messages: Message[],
    options: ChatOptions,
  ): Promise<LLMResponse> {
    if (this.provider) return this.provider.chat(messages, options);
    return chat(messages, options);
  }

  private llmStream(
    messages: Message[],
    options: ChatOptions,
  ): AsyncGenerator<LLMChunk> {
    if (this.provider) return this.provider.stream(messages, options);
    return stream(messages, options);
  }
}
