import { dirname } from "node:path";
import { appendFile, mkdir } from "node:fs/promises";
import type { Database } from "bun:sqlite";
import { EventBus, type EngineEvent } from "./event-bus";
import { newId, nowIso } from "./db";

export interface LogEventInput {
  type: string;
  userId?: string | null;
  conversationId?: string | null;
  payload?: Record<string, unknown>;
}

export class EventLog {
  private insertStatement;
  private selectByConversationStatement;

  constructor(
    private readonly db: Database,
    private readonly jsonlPath: string,
    private readonly bus: EventBus,
  ) {
    this.insertStatement = db.query(
      "INSERT INTO events (id, user_id, conversation_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.selectByConversationStatement = db.query(
      "SELECT id, user_id as userId, conversation_id as conversationId, type, payload_json as payloadJson, created_at as createdAt FROM events WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?",
    );
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.jsonlPath), { recursive: true });
  }

  async log(input: LogEventInput): Promise<EngineEvent> {
    const event: EngineEvent = {
      id: newId("evt"),
      createdAt: nowIso(),
      type: input.type,
      userId: input.userId ?? null,
      conversationId: input.conversationId ?? null,
      payload: input.payload ?? {},
    };

    this.insertStatement.run(
      event.id,
      event.userId,
      event.conversationId,
      event.type,
      JSON.stringify(event.payload),
      event.createdAt,
    );

    await appendFile(this.jsonlPath, `${JSON.stringify(event)}\n`, "utf8");
    this.bus.publish(event);
    return event;
  }

  listForConversation(conversationId: string, limit = 200): EngineEvent[] {
    const rows = this.selectByConversationStatement.all(conversationId, limit) as Array<{
      id: string;
      userId: string | null;
      conversationId: string | null;
      type: string;
      payloadJson: string;
      createdAt: string;
    }>;

    return rows.reverse().map((row) => ({
      id: row.id,
      userId: row.userId,
      conversationId: row.conversationId,
      type: row.type,
      payload: JSON.parse(row.payloadJson),
      createdAt: row.createdAt,
    }));
  }
}
