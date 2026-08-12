import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./index.js";

/**
 * Migration 004: Web AI Chat session model and title columns.
 *
 * Additive: adds nullable `model` (the session's selected model) and `title`
 * (human-readable session title) columns to `ai_chat_sessions`. Existing rows
 * get NULL for both; clients render a fallback when `title` is NULL. No index
 * changes — sessions are already indexed on (user_id, updated_at DESC, id DESC).
 */
export const migration004AiChatModelTitle: Migration = {
  version: 4,
  name: "ai_chat_session_model_title",
  up(db: DatabaseSync): void {
    db.exec(`
      ALTER TABLE ai_chat_sessions ADD COLUMN model TEXT
    `);
    db.exec(`
      ALTER TABLE ai_chat_sessions ADD COLUMN title TEXT
    `);
  },
};
