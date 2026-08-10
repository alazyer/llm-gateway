import { getDatabase } from "./index.js";

export interface AiChatAuditEventRow {
  id: string;
  actor: string;
  action: string;
  request_id: string;
  session_id: string;
  outcome: string;
  timestamp: number;
  retry_count: number;
  error_class: string | null;
  prompt_redacted: 0 | 1;
  response_redacted: 0 | 1;
}

export function insertAiChatAuditEvent(row: AiChatAuditEventRow): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO ai_chat_audit_events (
      id, actor, action, request_id, session_id, outcome, timestamp, retry_count, error_class,
      prompt_redacted, response_redacted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.actor,
    row.action,
    row.request_id,
    row.session_id,
    row.outcome,
    row.timestamp,
    row.retry_count,
    row.error_class,
    row.prompt_redacted,
    row.response_redacted,
  );
}
