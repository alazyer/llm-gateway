import * as vscode from "vscode";
import type { CopilotProxyStreamDeltaMessage } from "@llm-gateway/shared";

export function adaptLanguageModelStreamPart(
  id: string,
  part: unknown,
): CopilotProxyStreamDeltaMessage | undefined {
  if (part instanceof vscode.LanguageModelTextPart) {
    return {
      type: "stream_delta",
      id,
      content_type: "text",
      content: part.value,
    };
  }

  if (part instanceof vscode.LanguageModelToolCallPart) {
    return {
      type: "stream_delta",
      id,
      content_type: "tool_call",
      content: {
        index: 0,
        id: part.callId,
        type: "function",
        function: {
          name: part.name,
          arguments: JSON.stringify(part.input),
        },
      },
    };
  }

  return undefined;
}
