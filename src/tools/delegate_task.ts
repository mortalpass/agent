import pLimit from "p-limit";
import { Agent } from "../agent.js";
import { config } from "../config.js";
import { estimateToolSchemaTokens } from "../messages.js";
import { SYSTEM_PROMPT } from "../prompts/system.js";
import { logger } from "../logger.js";
import type { Tool, ToolResult } from "../types.js";

const MAX_DELEGATION_DEPTH = 1;

/** Bounds concurrent sub-agents so a 1M window cannot blow the TPM limit. */
const subAgentLimit = pLimit(config.agent.maxParallelSubAgents);

export const delegateTaskTool: Tool = {
  name: "delegate_task",
  description:
    "Delegate a focused, self-contained subtask to a sub-agent. The sub-agent has its own isolated conversation context and the same tools, and returns only its final answer. Use this to split a complex task into independent subtasks that can run in parallel by making multiple delegate_task calls in one turn.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description:
          "Clear description of the subtask, including all context the sub-agent needs",
      },
      system_prompt: {
        type: "string",
        description:
          "Optional system prompt to specialize the sub-agent (defaults to the standard investigation agent prompt)",
      },
    },
    required: ["task"],
  },

  async execute(args, context): Promise<ToolResult> {
    const task = typeof args.task === "string" ? args.task.trim() : "";
    if (!task) {
      return {
        content: "Error: task must be a non-empty string",
        isError: true,
      };
    }

    const depth = context?.depth ?? 0;
    if (depth >= MAX_DELEGATION_DEPTH) {
      logger.warn("Nested delegation blocked");
      return {
        content:
          "Error: nested delegation is not allowed. Complete the task yourself.",
        isError: true,
      };
    }

    const systemPrompt =
      typeof args.system_prompt === "string" && args.system_prompt.trim()
        ? args.system_prompt.trim()
        : SYSTEM_PROMPT;

    logger.debug(`Delegating subtask: ${task.slice(0, 100)}`);

    // Hard-fail budget: reject the spawn before the child makes any LLM call,
    // so a refused delegation costs nothing. The child's per-request reserve()
    // remains the authoritative check.
    const meter = context?.meter;
    if (meter?.enabled) {
      const spawnEstimate =
        Math.ceil((systemPrompt.length + task.length) / 4) +
        estimateToolSchemaTokens(context?.registry?.definitions() ?? []) +
        (context?.maxOutputTokens ?? config.llm.maxTokens);
      if (!meter.canAfford(spawnEstimate)) {
        logger.warn("Sub-agent spawn denied: token budget exhausted");
        return {
          content:
            `Error: token budget exhausted (need ~${spawnEstimate}, ${meter.describe()}). ` +
            "Do not call delegate_task again; summarize the work already completed.",
          isError: true,
        };
      }
    }

    return subAgentLimit(async () => {
      try {
        const subAgent = new Agent(
          systemPrompt,
          context?.maxTokens ?? undefined,
          {
            registry: context?.registry,
            approval: context?.approval,
            pathAccess: context?.pathAccess,
            delegationDepth: depth + 1,
            repoRoot: context?.repoRoot,
            artifacts: context?.artifacts,
            meter: context?.meter,
          },
        );
        if (context?.onSubAgentEvent) {
          subAgent.subscribe(context.onSubAgentEvent);
        } else {
          subAgent.subscribe((event) => {
            if (event.type === "tool_execution_start") {
              logger.debug(`[sub-agent] tool: ${event.name}`);
            }
          });
        }

        const result = await subAgent.run(task, context?.signal);
        if (result.budgetExhausted) {
          return {
            content: `${result.answer}. Do not call delegate_task again; summarize the work already completed.`,
            isError: true,
          };
        }
        return { content: result.answer };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`Delegation failed: ${msg}`);
        return { content: `Delegation error: ${msg}`, isError: true };
      }
    });
  },
};
