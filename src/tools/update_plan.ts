import { formatPlan } from "../planner.js";
import type { Tool, ToolResult } from "../types.js";

export const updatePlanTool: Tool = {
  name: "update_plan",
  description:
    "Declare or update the task plan for a complex multi-step task. Call this first to lay out the plan, then call it again after each step finishes to mark progress. Do not use this for simple single-step requests.",
  parameters: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        description: "Ordered list of plan steps, one short sentence each",
        items: { type: "string" },
      },
      completed: {
        type: "number",
        description:
          "Number of steps already completed (0 when declaring a new plan)",
        minimum: 0,
      },
    },
    required: ["steps", "completed"],
  },

  async execute(args, context): Promise<ToolResult> {
    const rawSteps = args.steps;
    if (
      !Array.isArray(rawSteps) ||
      rawSteps.length === 0 ||
      !rawSteps.every((s) => typeof s === "string" && s.trim().length > 0)
    ) {
      return {
        content: "Error: steps must be a non-empty array of non-empty strings",
        isError: true,
      };
    }

    const steps = rawSteps.map((s) => (s as string).trim());
    const rawCompleted = Number(args.completed ?? 0);
    const completed = Number.isFinite(rawCompleted)
      ? Math.trunc(rawCompleted)
      : 0;

    const plan = context?.planStore?.set(steps, completed);
    if (!plan) {
      return { content: "Error: plan store is unavailable", isError: true };
    }
    return {
      content: `Plan updated (${plan.completed}/${plan.steps.length} completed):\n${formatPlan(plan)}`,
    };
  },
};
