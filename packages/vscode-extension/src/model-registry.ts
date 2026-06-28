import type * as vscode from "vscode";
import type { CopilotProxyModel } from "@llm-gateway/shared";

function normalizeModelId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^copilot-/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function toGatewayModel(model: vscode.LanguageModelChat): CopilotProxyModel {
  const nativeId = normalizeModelId(model.id || model.family || model.name);

  return {
    id: `copilot-${nativeId}`,
    name: model.name,
    native_id: model.id,
    source: "copilot-proxy",
    capabilities: {
      supports_streaming: true,
      supports_tools: false,
      supports_usage: false,
      supports_progress: false,
      max_tokens: model.maxInputTokens,
    },
  };
}
