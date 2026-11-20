import { config as dotenvConfig } from "dotenv";
import { resolve } from "node:path";

dotenvConfig({ path: resolve(process.cwd(), ".env") });

function optionalEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

function numberEnv(
  key: string,
  fallback: number,
  min: number,
  max = Number.POSITIVE_INFINITY,
): number {
  const raw = optionalEnv(key, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    const range = Number.isFinite(max) ? `${min}..${max}` : `>= ${min}`;
    throw new Error(`${key} must be a number ${range} (got "${raw}")`);
  }
  return value;
}

export const config = {
  llm: {
    provider: optionalEnv("LLM_PROVIDER", "dashscope"),
    apiKey: optionalEnv("LLM_API_KEY", ""),
    baseUrl: optionalEnv("LLM_BASE_URL", ""),
    model: optionalEnv("LLM_MODEL", ""),
    temperature: numberEnv("LLM_TEMPERATURE", 0.2, 0, 2),
    // Completion cap only; context sizing is LLM_CONTEXT_TOKENS below.
    maxTokens: numberEnv("LLM_MAX_TOKENS", 2048, 1),
    // Advertised model window. The usable history budget is this value times
    // LLM_CONTEXT_SAFETY minus the completion reserve and tool schemas.
    contextTokens: numberEnv("LLM_CONTEXT_TOKENS", 131072, 1024),
    contextSafety: numberEnv("LLM_CONTEXT_SAFETY", 0.85, 0.1, 1),
    maxToolResultChars: numberEnv("MAX_TOOL_RESULT_CHARS", 16384, 1000),
    // Absolute prompt+completion budget for one run (0 disables the cap).
    runTokenBudget: numberEnv("MAX_RUN_TOKENS", 0, 0),
    requestTimeoutMs: numberEnv("LLM_TIMEOUT_MS", 120000, 1),
    maxRetries: numberEnv("LLM_MAX_RETRIES", 2, 0),
    retryBaseMs: numberEnv("LLM_RETRY_BASE_MS", 500, 1),
    // Some OpenAI-compatible gateways reject unknown fields with a 400;
    // set LLM_STREAM_OPTIONS=off to omit stream_options from stream requests.
    streamOptions: optionalEnv("LLM_STREAM_OPTIONS", "on") === "on",
  },
  rag: {
    apiUrl: optionalEnv("RAG_API_URL", "http://localhost:8000"),
  },
  agent: {
    maxIterations: numberEnv("MAX_ITERATIONS", 10, 1),
    maxParallelSubAgents: numberEnv("MAX_PARALLEL_SUBAGENTS", 2, 1),
    toolTimeoutMs: numberEnv("TOOL_TIMEOUT_MS", 30000, 0),
    approval: optionalEnv("TOOL_APPROVAL", "off"),
    // Path-level permission prompts for file tools; empty disables the check.
    pathApproval: optionalEnv("PATH_APPROVAL", "on"),
    // Optional sandbox root for file tools; empty disables the check.
    workspaceRoot: optionalEnv("WORKSPACE_ROOT", ""),
  },
  session: {
    dbPath: optionalEnv(
      "SESSION_DB_PATH",
      resolve(process.cwd(), ".sessions.db"),
    ),
  },
  sandbox: {
    // Requested provider override; empty lets the investigate CLI default
    // (docker) or --sandbox flag decide.
    provider: optionalEnv("SANDBOX_PROVIDER", ""),
    image: optionalEnv("SANDBOX_IMAGE", ""),
    network: optionalEnv("SANDBOX_NETWORK", "off") === "on" ? "on" : "off",
    cpus: numberEnv("SANDBOX_CPU", 2, 0.1),
    memory: optionalEnv("SANDBOX_MEMORY", "2g"),
    timeoutMs: numberEnv("SANDBOX_TIMEOUT_MS", 600000, 1000),
  },
  mcp: {
    servers: optionalEnv("MCP_SERVERS", ""),
  },
  log: {
    level: optionalEnv("LOG_LEVEL", "info"),
  },
};
