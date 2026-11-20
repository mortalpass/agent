import { config } from "../config.js";
import type { ChatOptions, LLMProvider } from "./base.js";
import type { Message, LLMResponse, LLMChunk } from "../types.js";
import {
  OpenAICompatibleProvider,
  type OpenAICompatibleConfig,
} from "./openai_compatible.js";
import { AnthropicProvider } from "./anthropic.js";

interface ProviderPreset {
  baseURL: string;
  defaultModel: string;
  /**
   * Env var holding the API key. Providers that need no key (ollama) omit
   * this so users are not told to configure a variable named after a key.
   */
  keyEnvVar?: string;
}

const PRESETS: Record<string, ProviderPreset> = {
  dashscope: {
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen-plus",
    keyEnvVar: "DASHSCOPE_API_KEY",
  },
  openai: {
    baseURL: "https://api.openai.com/v1",
    defaultModel: "gpt-4o",
    keyEnvVar: "OPENAI_API_KEY",
  },
  anthropic: {
    baseURL: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-20250514",
    keyEnvVar: "ANTHROPIC_API_KEY",
  },
  ollama: {
    baseURL: "http://localhost:11434/v1",
    defaultModel: "qwen3:8b",
  },
};

function createProvider(): LLMProvider {
  const providerName = config.llm.provider;
  const preset = PRESETS[providerName];

  if (!preset) {
    throw new Error(
      `Unknown LLM provider: "${providerName}". Supported: ${Object.keys(PRESETS).join(", ")}`,
    );
  }

  const apiKey =
    (preset.keyEnvVar ? process.env[preset.keyEnvVar] : undefined) ||
    config.llm.apiKey ||
    (providerName === "ollama" ? "ollama" : "");

  if (!apiKey) {
    throw new Error(
      `${preset.keyEnvVar ?? "An API key"} is required for LLM provider "${providerName}" (or set LLM_API_KEY)`,
    );
  }

  if (providerName === "anthropic") {
    return new AnthropicProvider({
      apiKey,
      baseURL: config.llm.baseUrl || preset.baseURL,
      model: config.llm.model || preset.defaultModel,
      temperature: config.llm.temperature,
      maxTokens: config.llm.maxTokens,
      requestTimeoutMs: config.llm.requestTimeoutMs,
      maxRetries: config.llm.maxRetries,
      retryBaseMs: config.llm.retryBaseMs,
    });
  }

  const providerConfig: OpenAICompatibleConfig = {
    apiKey,
    baseURL: config.llm.baseUrl || preset.baseURL,
    model: config.llm.model || preset.defaultModel,
    temperature: config.llm.temperature,
    maxTokens: config.llm.maxTokens,
    requestTimeoutMs: config.llm.requestTimeoutMs,
    maxRetries: config.llm.maxRetries,
    retryBaseMs: config.llm.retryBaseMs,
  };

  return new OpenAICompatibleProvider(providerConfig);
}

let providerInstance: LLMProvider | null = null;

function getProvider(): LLMProvider {
  if (!providerInstance) {
    providerInstance = createProvider();
  }
  return providerInstance;
}

export async function chat(
  messages: Message[],
  options?: ChatOptions,
): Promise<LLMResponse> {
  return getProvider().chat(messages, options);
}

export async function* stream(
  messages: Message[],
  options?: ChatOptions,
): AsyncGenerator<LLMChunk> {
  yield* getProvider().stream(messages, options);
}
