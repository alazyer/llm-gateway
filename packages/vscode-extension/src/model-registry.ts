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

/**
 * Read the toolCalling capability from a LanguageModelChat model.
 *
 * The `capabilities` property exists on `LanguageModelChatInformation` (used
 * by `LanguageModelChatProvider`) but is not declared on `LanguageModelChat`
 * in all @types/vscode versions. At runtime, Copilot models expose it, so we
 * access it via a runtime check. If unavailable, we default to `true` because
 * tool calling is a stable API feature for Copilot models (confirmed by
 * COM-30 investigation of VS Code 1.122.0).
 */
function readToolCallingCapability(model: vscode.LanguageModelChat): boolean | number | undefined {
  if ("capabilities" in model) {
    const capabilities = (model as Record<string, unknown>).capabilities as Record<string, unknown> | undefined;
    if (capabilities && "toolCalling" in capabilities) {
      return capabilities.toolCalling as boolean | number | undefined;
    }
  }
  return undefined;
}

export function toGatewayModel(model: vscode.LanguageModelChat): CopilotProxyModel {
  const nativeId = normalizeModelId(model.id || model.family || model.name);

  const toolCalling = readToolCallingCapability(model);
  // If toolCalling is explicitly set, use it. Otherwise default to true
  // because Copilot models support tool calling via the stable vscode.lm API.
  const supportsTools = typeof toolCalling === "boolean" ? toolCalling : typeof toolCalling === "number" ? true : true;

  return {
    id: `copilot-${nativeId}`,
    name: model.name,
    native_id: model.id,
    source: "copilot-proxy",
    capabilities: {
      supports_streaming: true,
      supports_tools: supportsTools,
      supports_usage: false,
      supports_progress: false,
      max_tokens: model.maxInputTokens,
    },
  };
}
