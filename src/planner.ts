export interface PlanState {
  steps: string[];
  completed: number;
  updatedAt: string;
}

export class PlanStore {
  private plan: PlanState | null = null;

  set(steps: string[], completed: number): PlanState {
    this.plan = {
      steps,
      completed: Math.min(Math.max(completed, 0), steps.length),
      updatedAt: new Date().toISOString(),
    };
    return this.plan;
  }

  get(): PlanState | null {
    return this.plan;
  }

  reset(): void {
    this.plan = null;
  }
}

const utf8Terminal = /utf-?8/i.test(
  `${process.env.LC_ALL ?? ""}${process.env.LANG ?? ""}`,
);

const MARKS = utf8Terminal
  ? { done: "✅", doing: "⏳", todo: "⬜" }
  : { done: "[x]", doing: "[~]", todo: "[ ]" };

export function formatPlan(plan: PlanState): string {
  const lines = plan.steps.map((step, i) => {
    const mark =
      i < plan.completed
        ? MARKS.done
        : i === plan.completed
          ? MARKS.doing
          : MARKS.todo;
    return `  ${mark} ${i + 1}. ${step}`;
  });
  return lines.join("\n");
}
