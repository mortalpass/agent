import type {
  ToolCall,
  PathAccessHandler,
  ApprovalHandler,
  ToolContext,
  ToolResult,
} from "../types.js";
import type { EventListener } from "../events.js";
import type { PlanStore } from "../planner.js";
import type { ArtifactStore } from "../context/artifacts.js";
import type { UsageMeter } from "../context/usage_meter.js";
import type { SandboxManager } from "../sandbox/index.js";
import type { ToolRegistry } from "./registry.js";
import { ensurePathAccess, PathAccessDeniedError } from "../permissions.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

export interface ExecuteToolOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  planStore?: PlanStore;
  /** Explicit registry; the caller (Agent) decides which tool set is visible. */
  registry: ToolRegistry;
  approval?: ApprovalHandler;
  pathAccess?: PathAccessHandler;
  depth?: number;
  /** Parent agent's context window, forwarded to delegate_task. */
  maxTokens?: number;
  /** Completion reserve forwarded to delegate_task's spawn-time budget check. */
  maxOutputTokens?: number;
  /** Absolute run budget shared with delegate_task sub-agents. */
  meter?: UsageMeter;
  onSubAgentEvent?: EventListener;
  /** Investigation context: repo under investigation (absolute path). */
  repoRoot?: string;
  /** Investigation artifact store for oversized investigation results. */
  artifacts?: ArtifactStore;
  /** Investigation sandbox manager for sandbox/patch/verify tools. */
  sandbox?: SandboxManager;
}

function resolveSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal | undefined; timeoutSignal?: AbortSignal } {
  const timeoutSignal =
    timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  if (!signal) return { signal: timeoutSignal, timeoutSignal };
  if (!timeoutSignal) return { signal };
  return { signal: AbortSignal.any([signal, timeoutSignal]), timeoutSignal };
}

export async function executeTool(
  toolCall: ToolCall,
  options: ExecuteToolOptions,
): Promise<ToolResult> {
  const tool = options.registry.get(toolCall.function.name);
  if (!tool) {
    const msg = `Unknown tool: ${toolCall.function.name}`;
    logger.warn(msg);
    return { content: msg, isError: true };
  }

  let args: Record<string, unknown>;
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    const msg = `Invalid JSON in tool arguments: ${toolCall.function.arguments}`;
    logger.warn(msg);
    return { content: msg, isError: true };
  }

  if (tool.dangerous && options.approval) {
    let allowed: boolean;
    try {
      allowed = await options.approval({ tool: tool.name, args });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.warn(`Approval handler failed for ${tool.name}: ${msg}`);
      allowed = false;
    }
    if (!allowed) {
      logger.info(`Tool ${tool.name} denied by approval policy`);
      return {
        content: `Tool ${tool.name} was denied by the approval policy. Explain to the user that the action was not permitted and continue without it.`,
        isError: true,
      };
    }
  }

  // Shared context for permission resolution and execution: accessRequests
  // needs repoRoot to resolve relative paths inside a target repository.
  const toolContext: ToolContext = {
    planStore: options.planStore,
    registry: options.registry,
    depth: options.depth,
    approval: options.approval,
    pathAccess: options.pathAccess,
    maxTokens: options.maxTokens,
    maxOutputTokens: options.maxOutputTokens,
    meter: options.meter,
    onSubAgentEvent: options.onSubAgentEvent,
    repoRoot: options.repoRoot,
    artifacts: options.artifacts,
    sandbox: options.sandbox,
  };

  // Path permission is resolved before the tool timeout is armed, so user
  // deliberation does not consume TOOL_TIMEOUT_MS.
  for (const access of tool.accessRequests?.(args, toolContext) ?? []) {
    try {
      await ensurePathAccess(
        tool.name,
        access.operation,
        access.path,
        options.pathAccess,
      );
    } catch (error) {
      if (error instanceof PathAccessDeniedError) {
        logger.info(`Path access denied for ${tool.name}: ${access.path}`);
        return {
          content: `Access denied: ${error.message}. Ask the user how to proceed or continue without the access.`,
          isError: true,
        };
      }
      throw error;
    }
  }

  const timeoutMs =
    options.timeoutMs ?? tool.timeoutMs ?? config.agent.toolTimeoutMs;
  const { signal, timeoutSignal } = resolveSignal(options.signal, timeoutMs);
  let onAbort: (() => void) | undefined;

  try {
    if (!signal) {
      return await tool.execute(args, toolContext);
    }
    const abortMessage = (): string =>
      timeoutSignal?.aborted
        ? `Tool ${tool.name} timed out after ${timeoutMs}ms`
        : `Tool ${tool.name} aborted`;
    if (signal.aborted) {
      throw new Error(abortMessage());
    }

    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error(abortMessage()));
      signal.addEventListener("abort", onAbort, { once: true });
    });

    return await Promise.race([
      tool.execute(args, { ...toolContext, signal }),
      aborted,
    ]);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`Tool ${tool.name} failed: ${msg}`);
    return { content: `Tool execution error: ${msg}`, isError: true };
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}
