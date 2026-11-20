import type { Tool, ToolDefinition } from "../types.js";
import { logger } from "../logger.js";
import { readFileTool } from "./read_file.js";
import { listFilesTool } from "./list_files.js";
import { writeFileTool } from "./write_file.js";
import { ragQueryTool } from "./rag_query.js";
import { updatePlanTool } from "./update_plan.js";
import { delegateTaskTool } from "./delegate_task.js";
import {
  findSymbolTool,
  impactAnalyzeTool,
  repoProfileTool,
  searchCodeTool,
  testSelectTool,
} from "../investigate/tools.js";
import {
  riskReportTool,
  sandboxCreateTool,
  sandboxRunTool,
  writePatchTool,
} from "../sandbox/tools.js";

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      logger.warn(`Overriding already registered tool: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    logger.debug(`Registered tool: ${tool.name}`);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  definitions(): ToolDefinition[] {
    return this.getAll().map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }
}

export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [
    readFileTool,
    listFilesTool,
    writeFileTool,
    ragQueryTool,
    updatePlanTool,
    delegateTaskTool,
    repoProfileTool,
    searchCodeTool,
    findSymbolTool,
    impactAnalyzeTool,
    testSelectTool,
    sandboxCreateTool,
    sandboxRunTool,
    writePatchTool,
    riskReportTool,
  ]) {
    registry.register(tool);
  }
  return registry;
}
