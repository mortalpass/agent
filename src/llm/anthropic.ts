import Anthropic from "@anthropic-ai/sdk";
import type { ChatOptions, LLMProvider } from "./base.js";
import type {
  Message,
  LLMResponse,
  LLMChunk,
  ToolCall,
  ToolDefinition,
} from "../types.js";
import { LLMError } from "./errors.js";
import { withRetry } from "./retry.js";

export interface AnthropicConfig {
  apiKey: string;
  baseURL?: string;
  model: string;
  temperature: number;
  maxTokens: number;
  requestTimeoutMs: number;
  maxRetries?: number;
  retryBaseMs?: number;
  /**
   * Injectable minimal Anthropic client (tests). When omitted, a real
   * @anthropic-ai/sdk client is built. Our retry/backoff layer stays the
   * source of truth, so the SDK client is created with maxRetries: 0.
   */
  client?: AnthropicClient;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

interface AnthropicToolUseDelta {
  type?: string;
  text?: string;
  partial_json?: string;
}

export interface AnthropicStreamEvent {
  type: string;
  index?: number;
  content_block?: { type: string; id?: string; name?: string };
  delta?: AnthropicToolUseDelta & { stop_reason?: string };
  message?: { usage?: { input_tokens?: number } };
  usage?: { output_tokens?: number; input_tokens?: number };
}

interface AnthropicApiResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Shape of the SDK client we rely on; test doubles implement this directly. */
export interface AnthropicClient {
  messages: {
    create(
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): Promise<AnthropicApiResponse>;
    stream(
      params: Record<string, unknown>,
      options?: { signal?: AbortSignal },
    ): AsyncIterable<AnthropicStreamEvent>;
  };
}

/** Converts OpenAI-style chat messages to Anthropic system + messages. */
export function toAnthropicMessages(messages: Message[]): {
  system: string;
  messages: AnthropicMessage[];
} {
  const systemParts: string[] = [];
  const mapped: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      if (msg.content) systemParts.push(msg.content);
      continue;
    }

    if (msg.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      if (msg.content) blocks.push({ type: "text", text: msg.content });
      for (const tc of msg.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function.arguments || "{}");
        } catch {
          input = {};
        }
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input,
        });
      }
      if (blocks.length > 0)
        mapped.push({ role: "assistant", content: blocks });
      continue;
    }

    if (msg.role === "tool") {
      const block: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id ?? "",
        content: msg.content ?? "",
      };
      const last = mapped[mapped.length - 1];
      if (last && last.role === "user") {
        // Kept in the order tool_result, then text: a dirty history
        // ([user(text), tool]) must become one legal user message, and normal
        // histories keep result order ([tool, tool] -> [r1, r2]).
        if (last.content[0]?.type === "text") {
          last.content.unshift(block);
        } else {
          last.content.push(block);
        }
      } else {
        mapped.push({ role: "user", content: [block] });
      }
      continue;
    }

    // user
    // Restored / steering histories can carry content-less user messages;
    // an empty text block is worse for API tolerance than skipping them.
    if (!msg.content) continue;
    const block: AnthropicContentBlock = {
      type: "text",
      text: msg.content,
    };
    const last = mapped[mapped.length - 1];
    // Merge into any trailing user message (tool_result followed by steer
    // text is legal) so consecutive same-role messages never occur.
    if (last && last.role === "user") {
      last.content.push(block);
    } else {
      mapped.push({ role: "user", content: [block] });
    }
  }

  if (mapped.length > 0 && mapped[0].role === "assistant") {
    mapped.unshift({
      role: "user",
      content: [{ type: "text", text: "(continue)" }],
    });
  }

  return { system: systemParts.join("\n\n"), messages: mapped };
}

function toAnthropicTools(
  tools?: ToolDefinition[],
): Array<{ name: string; description: string; input_schema: unknown }> {
  return (tools ?? []).map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

export function parseAnthropicResponse(json: {
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}): LLMResponse {
  const blocks = json.content ?? [];
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  const toolCalls: ToolCall[] = blocks
    .filter((b) => b.type === "tool_use")
    .map((b, i) => ({
      id: b.id ?? `call_${i}`,
      type: "function" as const,
      function: {
        name: b.name ?? "",
        arguments: JSON.stringify(b.input ?? {}),
      },
    }));

  const prompt = json.usage?.input_tokens ?? 0;
  const completion = json.usage?.output_tokens ?? 0;

  return {
    content: text || null,
    tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    finish_reason:
      json.stop_reason === "tool_use"
        ? "tool_calls"
        : json.stop_reason === "max_tokens"
          ? "length"
          : (json.stop_reason ?? null),
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    },
  };
}

/**
 * Consumes raw Anthropic stream events and yields assembled LLM chunks:
 * text deltas as they arrive, accumulated tool_use blocks and usage in a
 * final chunk (emitted even when the stream ends before message_stop, so
 * network-truncated streams never lose assembled tool calls).
 */
export async function* assembleAnthropicStream(
  events: AsyncIterable<AnthropicStreamEvent>,
): AsyncGenerator<LLMChunk> {
  let usage: LLMChunk["usage"];
  let finishReason: string | null = null;
  let stopped = false;
  // tool_use blocks: index -> accumulated state
  const toolBlocks = new Map<
    number,
    { id: string; name: string; json: string }
  >();

  // Mutates the accumulated state and returns a chunk to yield, if any.
  const processEvent = (event: AnthropicStreamEvent): LLMChunk | null => {
    if (
      event.type === "content_block_start" &&
      event.content_block?.type === "tool_use"
    ) {
      toolBlocks.set(event.index ?? 0, {
        id: event.content_block.id ?? "",
        name: event.content_block.name ?? "",
        json: "",
      });
      return null;
    }
    if (event.type === "content_block_delta") {
      if (event.delta?.text) {
        return { content: event.delta.text, finish_reason: null };
      }
      if (event.delta?.partial_json !== undefined) {
        const existing = toolBlocks.get(event.index ?? 0);
        if (existing) existing.json += event.delta.partial_json;
      }
      return null;
    }
    if (event.type === "message_delta") {
      if (event.delta?.stop_reason) {
        finishReason =
          event.delta.stop_reason === "tool_use"
            ? "tool_calls"
            : event.delta.stop_reason;
      }
      if (event.usage?.output_tokens !== undefined) {
        const prompt = usage?.prompt_tokens ?? event.usage.input_tokens;
        // message_start carried no input_tokens and neither does this
        // delta; keep usage unset rather than reporting a fake 0 prompt,
        // which would make total_tokens silently wrong.
        if (prompt !== undefined) {
          const completion = event.usage.output_tokens;
          usage = {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: prompt + completion,
          };
        }
      }
      return null;
    }
    if (event.type === "message_start" && event.message?.usage) {
      usage = {
        prompt_tokens: event.message.usage.input_tokens ?? 0,
        completion_tokens: 0,
        total_tokens: event.message.usage.input_tokens ?? 0,
      };
      return null;
    }
    if (event.type === "message_stop") {
      stopped = true;
    }
    return null;
  };

  try {
    for await (const event of events) {
      const chunk = processEvent(event);
      if (chunk) yield chunk;
    }
  } catch (error) {
    throw LLMError.from(error);
  }

  // Emit accumulated state once after the loop, like the OpenAI provider.
  // This also covers streams cut short before message_stop, so assembled
  // tool_calls are never lost.
  const toolCalls = [...toolBlocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, b]) => ({
      id: b.id,
      type: "function" as const,
      function: { name: b.name, arguments: b.json || "{}" },
    }));
  if (toolCalls.length > 0 || usage || finishReason || stopped) {
    yield {
      content: "",
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      finish_reason: finishReason,
    };
  }
}

/**
 * Native Anthropic Messages API provider on @anthropic-ai/sdk. Validates that
 * the LLMProvider abstraction holds beyond OpenAI-compatible endpoints.
 */
export class AnthropicProvider implements LLMProvider {
  private cfg: AnthropicConfig;

  constructor(config: AnthropicConfig) {
    this.cfg = config;
  }

  private client(): AnthropicClient {
    if (this.cfg.client) return this.cfg.client;
    return new Anthropic({
      apiKey: this.cfg.apiKey,
      baseURL: this.cfg.baseURL,
      // Our withRetry layer owns backoff; stacking SDK retries would multiply.
      maxRetries: 0,
      timeout: this.cfg.requestTimeoutMs,
    }) as unknown as AnthropicClient;
  }

  private retryOptions(signal?: AbortSignal) {
    return {
      maxRetries: this.cfg.maxRetries ?? 2,
      baseDelayMs: this.cfg.retryBaseMs ?? 500,
      signal,
    };
  }

  private requestOptions(signal?: AbortSignal): { signal?: AbortSignal } {
    return signal ? { signal } : {};
  }

  private requestParams(
    messages: Message[],
    options?: ChatOptions,
    stream = false,
  ): Record<string, unknown> {
    const { system, messages: anthropicMessages } =
      toAnthropicMessages(messages);
    const anthropicTools = toAnthropicTools(options?.tools);
    return {
      model: this.cfg.model,
      system: system || undefined,
      messages: anthropicMessages,
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
      temperature: options?.temperature ?? this.cfg.temperature,
      max_tokens: options?.maxTokens ?? this.cfg.maxTokens,
      stream,
    };
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    const params = this.requestParams(messages, options, false);
    const json = await withRetry(
      () =>
        this.client().messages.create(
          params,
          this.requestOptions(options?.signal),
        ),
      this.retryOptions(options?.signal),
    );
    return parseAnthropicResponse(json);
  }

  async *stream(
    messages: Message[],
    options?: ChatOptions,
  ): AsyncGenerator<LLMChunk> {
    const params = this.requestParams(messages, options, true);
    let events: AsyncIterable<AnthropicStreamEvent>;
    try {
      events = this.client().messages.stream(
        params,
        this.requestOptions(options?.signal),
      );
    } catch (error) {
      throw LLMError.from(error);
    }
    yield* assembleAnthropicStream(events);
  }
}
