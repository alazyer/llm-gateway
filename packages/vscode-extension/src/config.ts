import * as vscode from "vscode";

export interface ExtensionConfig {
  gatewayUrl: string;
  proxyToken: string;
  reconnectInitialDelayMs: number;
  reconnectMaxDelayMs: number;
}

const CONFIG_SECTION = "llmGatewayCopilotProxy";

function readNumber(
  config: vscode.WorkspaceConfiguration,
  key: string,
  fallback: number,
): number {
  const value = config.get<number>(key, fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function loadExtensionConfig(): ExtensionConfig {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

  return {
    gatewayUrl: config.get<string>("gatewayUrl", "").trim(),
    proxyToken: config.get<string>("proxyToken", "").trim(),
    reconnectInitialDelayMs: readNumber(config, "reconnectInitialDelayMs", 1000),
    reconnectMaxDelayMs: readNumber(config, "reconnectMaxDelayMs", 30000),
  };
}

export function isExtensionConfigComplete(config: ExtensionConfig): boolean {
  return config.gatewayUrl.length > 0 && config.proxyToken.length > 0;
}
