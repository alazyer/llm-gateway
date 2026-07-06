import * as vscode from "vscode";
import { normalizeLogLevel, type LogLevel } from "./logger.js";

export interface ExtensionConfig {
  gatewayUrl: string;
  proxyToken: string;
  enableGatewayAuth: boolean;
  reconnectInitialDelayMs: number;
  reconnectMaxDelayMs: number;
  logLevel: LogLevel;
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
    enableGatewayAuth: config.get<boolean>("enableGatewayAuth", true),
    reconnectInitialDelayMs: readNumber(config, "reconnectInitialDelayMs", 1000),
    reconnectMaxDelayMs: readNumber(config, "reconnectMaxDelayMs", 30000),
    logLevel: normalizeLogLevel(config.get<string>("logLevel", "info")),
  };
}

export function isExtensionConfigComplete(config: ExtensionConfig): boolean {
  return config.gatewayUrl.length > 0 && (!config.enableGatewayAuth || config.proxyToken.length > 0);
}
