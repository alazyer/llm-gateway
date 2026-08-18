/**
 * Pure timeline-rendering helpers for the Web AI Chat.
 *
 * Extracted from `chat.vue`'s `historyMessageToEntry` and the template's
 * render decisions so the timeline restore behavior is unit-testable without a
 * DOM mount. The component maps each `AiChatHistoryMessage` (from
 * `GET /api/ai-chat/sessions/:sessionId/messages`) into a `ChatTimelineEntry`
 * and renders it; the multimodal envelope (`{ v:1, text, images }`) is decoded
 * by the backend route, so the client receives a `content` text and an
 * `attachments` array already split.
 */

import type { AiChatAttachment, AiChatHistoryMessage } from "../composables/useGatewayApi";

export type ChatTimelineStatus = "streaming" | "done" | "failed";

export interface ChatTimelineEntry {
  id: string;
  role: "user" | "assistant";
  content: string;
  attachments: AiChatAttachment[];
  status: ChatTimelineStatus;
  model: string | null;
  requestId?: string;
  errorTitle?: string;
  errorMessage?: string;
  retryable?: boolean;
}

/**
 * Map a history message into a timeline entry. A multimodal user message (one
 * restored with attachments) keeps its text in `content` and its images in
 * `attachments`; a text-only message has an empty `attachments` array and flat
 * text in `content`. Mirrors `chat.vue`'s `historyMessageToEntry`.
 */
export function historyMessageToEntry(message: AiChatHistoryMessage): ChatTimelineEntry {
  return {
    id: message.messageId,
    role: message.role,
    content: message.content,
    attachments: message.attachments ?? [],
    status: message.status,
    model: message.model,
    requestId: message.requestId ?? undefined,
  };
}

/**
 * Whether a timeline entry should render image-attachment thumbnails. Only user
 * bubbles with attachments render images; assistant bubbles are always
 * text-only (the model returns text). Mirrors the template condition
 * `entry.role === 'user' && entry.attachments.length > 0`.
 */
export function entryRendersImages(entry: ChatTimelineEntry): boolean {
  return entry.role === "user" && entry.attachments.length > 0;
}

/**
 * The source URL for an entry's attachment thumbnail. The `<img>` element's
 * `:src` binds to the attachment's base64 data URL — restored inline from
 * history, no separate fetch required.
 */
export function attachmentThumbnailSrc(attachment: AiChatAttachment): string {
  return attachment.dataUrl;
}
