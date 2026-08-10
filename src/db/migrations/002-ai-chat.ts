import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./index.js";

/**
 * Migration 002: Web AI Chat persistence schema.
 */
export const migration002AiChat: Migration = {
  version: 2,
  name: "ai_chat_schema",
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_chat_sessions (
        id            TEXT    PRIMARY KEY,
        user_id       TEXT    NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL
      )
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ai_chat_sessions_user_updated
      ON ai_chat_sessions(user_id, updated_at DESC, id DESC)
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_chat_messages (
        id                  TEXT    PRIMARY KEY,
        session_id          TEXT    NOT NULL,
        user_id             TEXT    NOT NULL,
        role                TEXT    NOT NULL,
        content             TEXT    NOT NULL,
        model               TEXT,
        request_id          TEXT,
        status              TEXT    NOT NULL DEFAULT 'done',
        input_tokens        INTEGER,
        output_tokens       INTEGER,
        total_tokens        INTEGER,
        client_message_id   TEXT,
        created_at          INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES ai_chat_sessions(id) ON DELETE CASCADE
      )
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_session_created
      ON ai_chat_messages(session_id, created_at ASC, id ASC)
    `);
  },
};
