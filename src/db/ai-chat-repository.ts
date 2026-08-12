import { getDatabase } from "./index.js";

export interface AiChatSessionRow {
  id: string;
  user_id: string;
  created_at: number;
  updated_at: number;
  model: string | null;
  title: string | null;
}

export interface AiChatMessageRow {
  id: string;
  session_id: string;
  user_id: string;
  role: "user" | "assistant";
  content: string;
  model: string | null;
  request_id: string | null;
  status: "streaming" | "done" | "failed";
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  client_message_id: string | null;
  created_at: number;
}

export function getAiChatSessionById(sessionId: string): AiChatSessionRow | null {
  const db = getDatabase();
  const row = db.prepare("SELECT * FROM ai_chat_sessions WHERE id = ?").get(sessionId);
  return (row as AiChatSessionRow | undefined) ?? null;
}

export function insertAiChatSession(session: AiChatSessionRow): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO ai_chat_sessions (id, user_id, created_at, updated_at, model, title)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    session.user_id,
    session.created_at,
    session.updated_at,
    session.model,
    session.title,
  );
}

export function touchAiChatSession(sessionId: string, updatedAt: number): void {
  const db = getDatabase();
  db.prepare("UPDATE ai_chat_sessions SET updated_at = ? WHERE id = ?").run(updatedAt, sessionId);
}

/**
 * Update a session's selected model (mid-session switch). Does not touch
 * `updated_at` — a model switch is not a content change that should reorder
 * the session list.
 */
export function updateAiChatSessionModel(sessionId: string, model: string): void {
  const db = getDatabase();
  db.prepare("UPDATE ai_chat_sessions SET model = ? WHERE id = ?").run(model, sessionId);
}

/**
 * Rename a session's title and bump `updated_at` so a renamed session sorts to
 * the top of the recency-ordered session list.
 */
export function renameAiChatSession(sessionId: string, title: string, updatedAt: number): void {
  const db = getDatabase();
  db.prepare("UPDATE ai_chat_sessions SET title = ?, updated_at = ? WHERE id = ?").run(
    title,
    updatedAt,
    sessionId,
  );
}

export function insertAiChatMessage(message: AiChatMessageRow): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO ai_chat_messages (
      id, session_id, user_id, role, content, model, request_id, status,
      input_tokens, output_tokens, total_tokens, client_message_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    message.id,
    message.session_id,
    message.user_id,
    message.role,
    message.content,
    message.model,
    message.request_id,
    message.status,
    message.input_tokens,
    message.output_tokens,
    message.total_tokens,
    message.client_message_id,
    message.created_at,
  );
}

export interface AiChatSessionCursor {
  updatedAt: number;
  id: string;
}

export interface AiChatMessageCursor {
  createdAt: number;
  id: string;
}

export function listAiChatSessionsByUser(
  userId: string,
  limit: number,
  cursor?: AiChatSessionCursor,
): AiChatSessionRow[] {
  const db = getDatabase();
  if (cursor) {
    return db.prepare(
      `SELECT * FROM ai_chat_sessions
       WHERE user_id = ?
         AND (updated_at < ? OR (updated_at = ? AND id < ?))
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
    ).all(userId, cursor.updatedAt, cursor.updatedAt, cursor.id, limit) as unknown as AiChatSessionRow[];
  }

  return db.prepare(
    `SELECT * FROM ai_chat_sessions
     WHERE user_id = ?
     ORDER BY updated_at DESC, id DESC
     LIMIT ?`,
  ).all(userId, limit) as unknown as AiChatSessionRow[];
}

export function listAiChatMessagesBySession(
  sessionId: string,
  userId: string,
  limit: number,
  cursor?: AiChatMessageCursor,
): AiChatMessageRow[] {
  const db = getDatabase();
  if (cursor) {
    return db.prepare(
      `SELECT * FROM ai_chat_messages
       WHERE session_id = ?
         AND user_id = ?
         AND (created_at > ? OR (created_at = ? AND id > ?))
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    ).all(sessionId, userId, cursor.createdAt, cursor.createdAt, cursor.id, limit) as unknown as AiChatMessageRow[];
  }

  return db.prepare(
    `SELECT * FROM ai_chat_messages
     WHERE session_id = ?
       AND user_id = ?
     ORDER BY created_at ASC, id ASC
     LIMIT ?`,
  ).all(sessionId, userId, limit) as unknown as AiChatMessageRow[];
}
