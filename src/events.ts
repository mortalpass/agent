import type { MessageRole, TokenUsage, ToolCall, ToolResult } from "./types.js";
import { logger } from "./logger.js";

export type AgentEvent =
  | { type: "agent_start"; userMessage: string }
  | { type: "turn_start"; iteration: number; maxIterations: number }
  | { type: "message_start"; role: MessageRole }
  | { type: "message_update"; content: string }
  | {
      type: "message_end";
      role: MessageRole;
      content: string;
      usage?: TokenUsage;
    }
  | { type: "tool_execution_start"; name: string; args: string }
  | { type: "tool_execution_end"; name: string; result: ToolResult }
  | { type: "turn_end"; hasToolCalls: boolean }
  | {
      type: "agent_end";
      answer: string;
      iterations: number;
      toolCalls: ToolCall[];
      usage?: TokenUsage;
    }
  | { type: "agent_error"; message: string };

export type EventListener = (event: AgentEvent) => void;

export class EventBus {
  private listeners: EventListener[] = [];

  subscribe(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  emit(event: AgentEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`Event listener failed for "${event.type}": ${msg}`);
      }
    }
  }
}
