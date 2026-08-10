import type { Migration } from "./index.js";

import { migration001Initial } from "./001-initial.js";
import { migration002AiChat } from "./002-ai-chat.js";
import { migration003AiChatAuditEvents } from "./003-ai-chat-audit-events.js";

/**
 * Ordered list of all known migrations.
 * Add new migrations here as they are created.
 */
export const allMigrations: Migration[] = [
  migration001Initial,
  migration002AiChat,
  migration003AiChatAuditEvents,
];
