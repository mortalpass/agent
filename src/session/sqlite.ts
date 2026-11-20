import Database from "better-sqlite3";
import type { AgentMessage } from "../types.js";
import type { SessionMeta, SessionRecord } from "./types.js";

interface SessionRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  messages: string;
}

/** Shape returned by the list() SELECT (no messages column). */
type SessionListRow = Omit<SessionRow, "messages">;

export class SessionStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        messages TEXT NOT NULL
      )
    `);
    const columns = this.db.pragma("table_info(sessions)") as Array<{
      name: string;
    }>;
    if (!columns.some((c) => c.name === "message_count")) {
      this.db.exec(
        "ALTER TABLE sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0",
      );
    }
  }

  save(record: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO sessions (id, name, created_at, updated_at, message_count, messages)
         VALUES (@id, @name, @createdAt, @updatedAt, @messageCount, @messages)
         ON CONFLICT(id) DO UPDATE SET
           name = @name,
           updated_at = @updatedAt,
           message_count = @messageCount,
           messages = @messages`,
      )
      .run({
        id: record.id,
        name: record.name,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        messageCount: record.messages.length,
        messages: JSON.stringify(record.messages),
      });
  }

  load(id: string): SessionRecord | null {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as SessionRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messages: JSON.parse(row.messages) as AgentMessage[],
    };
  }

  list(): SessionMeta[] {
    const rows = this.db
      .prepare(
        "SELECT id, name, created_at, updated_at, message_count FROM sessions ORDER BY updated_at DESC",
      )
      .all() as SessionListRow[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: row.message_count,
    }));
  }

  close(): void {
    this.db.close();
  }
}
