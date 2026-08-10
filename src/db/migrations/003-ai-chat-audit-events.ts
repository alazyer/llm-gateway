import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./index.js";

/**
 * Migration 003: Web AI Chat audit event schema.
 */
export const migration003AiChatAuditEvents: Migration = {
  version: 3,
  name: "ai_chat_audit_events",
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_chat_audit_events (
        id                  TEXT    PRIMARY KEY,
        actor               TEXT    NOT NULL,
        action              TEXT    NOT NULL,
        request_id          TEXT    NOT NULL,
        session_id          TEXT    NOT NULL,
        outcome             TEXT    NOT NULL,
        timestamp           INTEGER NOT NULL,
        retry_count         INTEGER NOT NULL,
        error_class         TEXT,
        prompt_redacted     INTEGER NOT NULL,
        response_redacted   INTEGER NOT NULL
      )
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ai_chat_audit_events_session_timestamp
      ON ai_chat_audit_events(session_id, timestamp DESC, id DESC)
    `);
  },
};
