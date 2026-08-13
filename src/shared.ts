/**
 * Shared utility functions used across translation and route modules.
 * Each function is identical to its former inline version.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function expectString(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new Error(`${context} must be a string.`);
  }

  return value;
}

export function expectNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`${context} must be a number.`);
  }

  return value;
}

export function expectBoolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${context} must be a boolean.`);
  }

  return value;
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function extractDataFrame(frame: string): string | null {
  const dataLines: string[] = [];

  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  return dataLines.length > 0 ? dataLines.join("\n") : null;
}

import type { ChatMessage } from "./contracts.js";

/**
 * Flatten a chat message's `content` (string | null | ChatContentPart[]) to a
 * plain string. Image parts are reduced to a short placeholder so that
 * text-only sinks (e.g. Copilot proxy websocket) never receive a non-string
 * payload. Text parts are concatenated with newlines, preserving existing
 * string-content behavior.
 */
export function flattenChatMessageContentToText(
  content: ChatMessage["content"],
): string {
  if (content === null || content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      if (part.type === "image_url") {
        return "[image]";
      }
      return "";
    })
    .filter((s) => s.length > 0)
    .join("\n");
}
