import type * as vscode from "vscode";
import type { CopilotProxyModel } from "@llm-gateway/shared";

function normalizeModelId(value: string, modelPrefix: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(new RegExp(`^${escapeRegExp(modelPrefix.toLowerCase())}`), "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

export function toGatewayModel(model: vscode.LanguageModelChat, modelPrefix: string): CopilotProxyModel {
  const nativeId = normalizeModelId(model.id || model.family || model.name, modelPrefix);

  const toolCalling = readToolCallingCapability(model);
  // If toolCalling is explicitly set, use it. Otherwise default to true
  // because Copilot models support tool calling via the stable vscode.lm API.
  const supportsTools = typeof toolCalling === "boolean" ? toolCalling : typeof toolCalling === "number" ? true : true;

  return {
    id: `${modelPrefix}${nativeId}`,
    name: model.name,
    native_id: model.id,
    source: modelPrefix,
    capabilities: {
      supports_streaming: true,
      supports_tools: supportsTools,
      supports_usage: false,
      supports_progress: false,
      // Omit max_tokens when the model reports a non-finite value (Infinity/NaN).
      // JSON.stringify converts Infinity/NaN to null, which the gateway rejects,
      // so we must not include it at all — undefined is stripped by JSON.stringify.
      ...(typeof model.maxInputTokens === "number" && Number.isFinite(model.maxInputTokens) && model.maxInputTokens > 0
        ? { max_tokens: model.maxInputTokens }
        : {}),
    },
  };
}
