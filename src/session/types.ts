import type { AgentMessage } from "../types.js";

export interface SessionMeta {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface SessionRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messages: AgentMessage[];
}
