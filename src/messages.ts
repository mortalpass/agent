import type {
  AgentMessage,
  Message,
  TokenUsage,
  ToolDefinition,
} from "./types.js";
import { isLLMMessage } from "./types.js";
import { logger } from "./logger.js";

const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD_TOKENS = 4;
const TOOL_CALL_OVERHEAD_TOKENS = 8;
const MAX_CALIBRATION_RATIO = 1.6;

/**
 * Worst observed actual/estimated prompt ratio per provider model. Tokenizers
 * differ (Qwen/GLM/Claude), so a self-calibrating ratio is more accurate than
 * any third-party tokenizer guess. Shared across agents (including sub-agents)
 * so a child does not restart from the optimistic default.
 */
const modelRatios = new Map<string, number>();

export type TransformContextFn = (messages: AgentMessage[]) => AgentMessage[];

export type ConvertToLlmFn = (messages: AgentMessage[]) => Message[];

const defaultTransformContext: TransformContextFn = (messages) => messages;

const defaultConvertToLlm: ConvertToLlmFn = (messages) =>
  messages.filter(isLLMMessage);

export interface MessageManagerOptions {
  transformContext?: TransformContextFn;
  convertToLlm?: ConvertToLlmFn;
  /** Hard cap for one tool result, independent of the context window. */
  maxToolChars?: number;
  /** Fraction of the window usable for history (default 1). */
  safety?: number;
  /** Completion tokens reserved per request (default 0). */
  outputReserveTokens?: number;
  /** Provider/model label used to share calibration between agents. */
  model?: string;
}

/** Rough size of the tool schemas sent with every request (~3 chars/token). */
export function estimateToolSchemaTokens(
  definitions: ToolDefinition[],
): number {
  if (definitions.length === 0) return 0;
  return Math.ceil(JSON.stringify(definitions).length / 3);
}

export class MessageManager {
  private messages: AgentMessage[] = [];
  private systemPrompt: string;
  private windowTokens: number;
  private safety: number;
  private outputReserveTokens: number;
  private toolSchemaTokens = 0;
  private maxToolChars: number;
  private model?: string;
  private calibrationRatio: number;
  private transformContext: TransformContextFn;
  private convertToLlm: ConvertToLlmFn;

  constructor(
    systemPrompt: string,
    maxTokens: number = 4096,
    options?: MessageManagerOptions,
  ) {
    this.systemPrompt = systemPrompt;
    this.windowTokens = maxTokens;
    this.safety = options?.safety ?? 1;
    this.outputReserveTokens = options?.outputReserveTokens ?? 0;
    this.maxToolChars =
      options?.maxToolChars ??
      Math.max(Math.floor((maxTokens * CHARS_PER_TOKEN) / 2), 2000);
    this.model = options?.model;
    this.calibrationRatio = this.model ? (modelRatios.get(this.model) ?? 1) : 1;
    this.transformContext =
      options?.transformContext ?? defaultTransformContext;
    this.convertToLlm = options?.convertToLlm ?? defaultConvertToLlm;
    this.messages.push({ role: "system", content: systemPrompt });
  }

  add(message: AgentMessage): void {
    if (
      isLLMMessage(message) &&
      message.role === "tool" &&
      !this.hasToolCall(message.tool_call_id)
    ) {
      return;
    }
    this.messages.push(this.truncateToolResult(message));
    this.trim();
  }

  getAll(): AgentMessage[] {
    return [...this.messages];
  }

  getForLlm(): Message[] {
    const transformed = this.transformContext([...this.messages]);
    return this.convertToLlm(transformed);
  }

  clear(): void {
    this.messages = [{ role: "system", content: this.systemPrompt }];
  }

  replace(messages: AgentMessage[]): void {
    const incoming = [...messages];
    const first = incoming[0];
    if (!(first && isLLMMessage(first) && first.role === "system")) {
      // Restored history must always start with the system prompt.
      incoming.unshift({ role: "system", content: this.systemPrompt });
    }
    this.messages = incoming;
    // A restored session may be larger than the current budget.
    this.trim();
  }

  count(): number {
    return this.messages.length;
  }

  /**
   * Token estimate for the history, corrected by the worst observed
   * actual/estimated ratio. ~4 chars/token is a lower bound: CJK text and
   * dense code use more tokens per char, so the ratio grows from 1 at most to
   * MAX_CALIBRATION_RATIO.
   */
  estimateTokens(): number {
    return Math.ceil(this.rawEstimate() * this.calibrationRatio);
  }

  /** History plus the tool schemas that travel with every request. */
  estimateRequestTokens(): number {
    return this.estimateTokens() + this.toolSchemaTokens;
  }

  /** Effective history budget after safety margin, output reserve and schemas. */
  budgetTokens(): number {
    const usable =
      Math.floor(this.windowTokens * this.safety) -
      this.outputReserveTokens -
      this.toolSchemaTokens;
    return Math.max(1, usable);
  }

  /**
   * Tool schemas are sent on every request but are not part of history, so
   * they are registered separately before each request. The registry can grow
   * at runtime (MCP), hence this is set rather than fixed at construction.
   */
  setToolSchemaTokens(tokens: number): void {
    this.toolSchemaTokens = Math.max(0, Math.ceil(tokens));
    this.trim();
  }

  /**
   * Feed a real prompt_tokens count back into the estimator. The actual value
   * covers system + history + tools, so it is compared against the full
   * request estimate (including schemas), never the history alone.
   */
  recordUsage(usage?: TokenUsage): void {
    if (!usage || usage.prompt_tokens <= 0) return;
    const raw = this.rawEstimate() + this.toolSchemaTokens;
    if (raw <= 0) return;
    const observed = usage.prompt_tokens / raw;
    if (!Number.isFinite(observed)) return;
    this.calibrationRatio = Math.max(
      this.calibrationRatio,
      Math.min(observed, MAX_CALIBRATION_RATIO),
    );
    if (this.model) {
      modelRatios.set(this.model, this.calibrationRatio);
    }
  }

  private rawEstimate(): number {
    let total = 0;
    for (const msg of this.messages) {
      total += this.messageTokens(msg);
    }
    return total;
  }

  private messageTokens(msg: AgentMessage): number {
    if (!isLLMMessage(msg)) return 0;
    let total = MESSAGE_OVERHEAD_TOKENS;
    if (msg.content) {
      total += msg.content.length / CHARS_PER_TOKEN;
    }
    if (msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        // The function name is part of every tool_call's serialized form.
        total +=
          TOOL_CALL_OVERHEAD_TOKENS +
          (tc.function.name.length + tc.function.arguments.length) /
            CHARS_PER_TOKEN;
      }
    }
    return total;
  }

  private trim(): void {
    let current = this.estimateTokens();
    while (current > this.budgetTokens() && this.messages.length > 1) {
      const idx = this.firstEvictableIndex();
      if (idx < 0) {
        logger.warn(
          `History exceeds token budget (~${current} > ${this.budgetTokens()} tokens) and nothing evictable remains`,
        );
        break;
      }
      // Subtract the evicted group instead of re-estimating every message on
      // each pass; large windows (1M) would otherwise be quadratic.
      current -= this.evictGroup(idx);
    }
  }

  /** Removes an assistant turn and any tool results that followed it. */
  private evictGroup(idx: number): number {
    let raw = 0;
    const [first] = this.messages.splice(idx, 1);
    if (first) raw += this.messageTokens(first);
    // Never leave tool results without their preceding assistant tool_calls.
    while (idx < this.messages.length) {
      const next = this.messages[idx];
      if (!isLLMMessage(next) || next.role !== "tool") break;
      raw += this.messageTokens(next);
      this.messages.splice(idx, 1);
    }
    return Math.ceil(raw * this.calibrationRatio);
  }

  /**
   * A single tool result can be up to 256KB (~64K tokens), beyond the whole
   * context budget; evicting it would orphan the assistant tool_calls. So it
   * is truncated at add time, keeping head and tail (start of a file and the
   * truncation notice stay visible).
   */
  private truncateToolResult(message: AgentMessage): AgentMessage {
    if (message.role !== "tool") return message;
    const content = message.content;
    if (typeof content !== "string" || content.length <= this.maxToolChars) {
      return message;
    }
    const head = this.maxToolChars - Math.floor(this.maxToolChars * 0.2);
    const tail = this.maxToolChars - head;
    const omitted = content.length - head - tail;
    return {
      ...message,
      content: `${content.slice(0, head)}\n[truncated: omitted ${omitted} of ${content.length} chars]\n${content.slice(-tail)}`,
    };
  }

  /**
   * Index of the oldest message that may be evicted. The system prompt and
   * the first user message (the original task) are always protected.
   */
  private firstEvictableIndex(): number {
    const firstUser = this.messages.findIndex(
      (msg) => isLLMMessage(msg) && msg.role === "user",
    );
    for (let i = 1; i < this.messages.length; i++) {
      if (i === firstUser) continue;
      return i;
    }
    return -1;
  }

  private hasToolCall(toolCallId?: string): boolean {
    if (!toolCallId) return true;
    return this.messages.some(
      (msg) =>
        isLLMMessage(msg) &&
        msg.role === "assistant" &&
        msg.tool_calls?.some((tc) => tc.id === toolCallId),
    );
  }
}
