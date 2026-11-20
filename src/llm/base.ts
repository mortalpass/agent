import type {
  Message,
  LLMResponse,
  LLMChunk,
  ToolDefinition,
} from "../types.js";

export interface ChatOptions {
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LLMProvider {
  chat(messages: Message[], options?: ChatOptions): Promise<LLMResponse>;
  stream(messages: Message[], options?: ChatOptions): AsyncGenerator<LLMChunk>;
}
