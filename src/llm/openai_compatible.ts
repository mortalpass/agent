import OpenAI from "openai";
import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import type { ChatOptions, LLMProvider } from "./base.js";
import type { Message, LLMResponse, LLMChunk, ToolCall } from "../types.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { withRetry } from "./retry.js";

export interface OpenAICompatibleConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  temperature: number;
  maxTokens: number;
  requestTimeoutMs: number;
  maxRetries?: number;
  retryBaseMs?: number;
}

/**
 * Assembles streamed OpenAI tool_call deltas into complete ToolCalls.
 * Lives in the provider so the agent only sees finished tool calls.
 */
export class StreamToolCallAssembler {
  private byIndex = new Map<number, ToolCall>();

  addDelta(delta: {
    index: number;
    id?: string;
    name?: string;
    arguments?: string;
  }): void {
    const existing = this.byIndex.get(delta.index);
    if (!existing) {
      this.byIndex.set(delta.index, {
        id: delta.id ?? `call_${delta.index}`,
        type: "function",
        function: {
          name: delta.name ?? "",
          arguments: delta.arguments ?? "",
        },
      });
      return;
    }
    if (delta.id) existing.id = delta.id;
    // Some OpenAI-compatible services resend the full name on every delta;
    // only set it once to avoid "read_fileread_file".
    if (delta.name && !existing.function.name) {
      existing.function.name = delta.name;
    }
    if (delta.arguments) existing.function.arguments += delta.arguments;
  }

  complete(): ToolCall[] {
    return [...this.byIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tc]) => tc);
  }
}

/**
 * openai-node registers an abort listener on the signal it is given for every
 * request and does not remove it. Passing the long-lived run signal therefore
 * accumulates listeners and trips MaxListenersExceededWarning around the 11th
 * turn. A fresh per-request composite keeps the listener lifetime bounded to
 * the request while still propagating run aborts.
 */
export function perRequestSignal(
  signal?: AbortSignal,
): AbortSignal | undefined {
  return signal ? AbortSignal.any([signal]) : undefined;
}

export class OpenAICompatibleProvider implements LLMProvider {
  private client: OpenAI;
  private cfg: OpenAICompatibleConfig;

  constructor(config: OpenAICompatibleConfig) {
    this.cfg = config;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      timeout: config.requestTimeoutMs,
      maxRetries: 0,
    });
  }

  private retryOptions(signal?: AbortSignal) {
    return {
      maxRetries: this.cfg.maxRetries ?? config.llm.maxRetries,
      baseDelayMs: this.cfg.retryBaseMs ?? config.llm.retryBaseMs,
      signal,
      onRetry: (error: Error, attempt: number, delayMs: number) => {
        logger.warn(
          `LLM request failed (attempt ${attempt}), retrying in ${delayMs}ms: ${error.message}`,
        );
      },
    };
  }

  async chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse> {
    const response = await withRetry(
      () =>
        this.client.chat.completions.create(
          {
            model: this.cfg.model,
            messages:
              messages as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
            tools:
              options?.tools as unknown as OpenAI.Chat.Completions.ChatCompletionTool[],
            temperature: options?.temperature ?? this.cfg.temperature,
            max_tokens: options?.maxTokens ?? this.cfg.maxTokens,
          },
          { signal: perRequestSignal(options?.signal) },
        ),
      this.retryOptions(options?.signal),
    );

    const choice = response.choices[0];
    if (!choice) {
      throw new Error("No response from LLM");
    }

    // 新增：过滤掉 custom tool call（无 function 字段），显式映射
    const toolCalls: ToolCall[] = [];
    for (const tc of choice.message.tool_calls ?? []) {
      if (tc.type !== "function") continue;
      toolCalls.push({
        id: tc.id,
        type: "function",
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      });
    }

    return {
      content: choice.message.content,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      finish_reason: choice.finish_reason,
      usage: response.usage
        ? {
            prompt_tokens: response.usage.prompt_tokens,
            completion_tokens: response.usage.completion_tokens,
            total_tokens: response.usage.total_tokens,
          }
        : undefined,
    };
  }

  async *stream(
    messages: Message[],
    options?: ChatOptions,
  ): AsyncGenerator<LLMChunk> {
    // Retry only covers establishing the stream; once the first chunk
    // arrives the request is considered in-flight and no longer retried.
    let response!: AsyncIterable<ChatCompletionChunk>;
    try {
      response = await withRetry(
        () =>
          this.client.chat.completions.create(
            {
              model: this.cfg.model,
              messages:
                messages as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
              tools:
                options?.tools as unknown as OpenAI.Chat.Completions.ChatCompletionTool[],
              temperature: options?.temperature ?? this.cfg.temperature,
              max_tokens: options?.maxTokens ?? this.cfg.maxTokens,
              stream: true,
              ...(config.llm.streamOptions
                ? { stream_options: { include_usage: true } }
                : {}),
            },
            { signal: perRequestSignal(options?.signal) },
          ),
        this.retryOptions(options?.signal),
      );
    } catch (error) {
      // Older vLLM builds and some gateways reject unknown fields with a 400;
      // retry once without stream_options so streaming still works.
      const msg = error instanceof Error ? error.message : String(error);
      if (
        config.llm.streamOptions &&
        msg.toLowerCase().includes("stream_options")
      ) {
        logger.warn(
          "LLM endpoint rejected stream_options; retrying without usage stats",
        );
        response = await withRetry(
          () =>
            this.client.chat.completions.create(
              {
                model: this.cfg.model,
                messages:
                  messages as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
                tools:
                  options?.tools as unknown as OpenAI.Chat.Completions.ChatCompletionTool[],
                temperature: options?.temperature ?? this.cfg.temperature,
                max_tokens: options?.maxTokens ?? this.cfg.maxTokens,
                stream: true,
              },
              { signal: perRequestSignal(options?.signal) },
            ),
          this.retryOptions(options?.signal),
        );
      } else {
        throw error;
      }
    }

    const assembler = new StreamToolCallAssembler();
    let finishReason: string | null = null;
    let usage;

    for await (const chunk of response) {
      const delta = chunk.choices[0]?.delta;
      finishReason = chunk.choices[0]?.finish_reason ?? finishReason;

      if (delta?.content) {
        yield { content: delta.content, finish_reason: null };
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          assembler.addDelta({
            index: tc.index,
            id: tc.id,
            name: tc.function?.name,
            arguments: tc.function?.arguments,
          });
        }
      }

      if (chunk.usage) {
        usage = {
          prompt_tokens: chunk.usage.prompt_tokens ?? 0,
          completion_tokens: chunk.usage.completion_tokens ?? 0,
          total_tokens: chunk.usage.total_tokens ?? 0,
        };
      }
    }

    const toolCalls = assembler.complete();
    if (toolCalls.length > 0 || usage || finishReason) {
      yield {
        content: "",
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        usage,
        finish_reason: finishReason,
      };
    }
  }
}
