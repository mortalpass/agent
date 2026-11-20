import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import type { AgentMessage } from "../types.js";
import { SessionStore } from "./sqlite.js";
import type { SessionMeta } from "./types.js";

export class SessionManager {
  private store: SessionStore;

  constructor(dbPath?: string) {
    this.store = new SessionStore(dbPath ?? config.session.dbPath);
  }

  save(messages: AgentMessage[], name?: string): SessionMeta {
    const id = randomUUID();
    const now = new Date().toISOString();
    const record = {
      id,
      name: name || `session-${now.slice(0, 19).replace(/[T:]/g, "-")}`,
      createdAt: now,
      updatedAt: now,
      messages,
    };
    this.store.save(record);
    return {
      id,
      name: record.name,
      createdAt: now,
      updatedAt: now,
      messageCount: messages.length,
    };
  }

  load(id: string): AgentMessage[] | null {
    return this.store.load(id)?.messages ?? null;
  }

  /**
   * Updates an existing session in place; returns null when the id is
   * unknown. Keeps the original name and createdAt unless renamed.
   */
  update(
    id: string,
    messages: AgentMessage[],
    name?: string,
  ): SessionMeta | null {
    const record = this.store.load(id);
    if (!record) return null;
    const updatedAt = new Date().toISOString();
    this.store.save({
      id: record.id,
      name: name ?? record.name,
      createdAt: record.createdAt,
      updatedAt,
      messages,
    });
    return {
      id,
      name: name ?? record.name,
      createdAt: record.createdAt,
      updatedAt,
      messageCount: messages.length,
    };
  }

  list(): SessionMeta[] {
    return this.store.list();
  }

  close(): void {
    this.store.close();
  }
}
