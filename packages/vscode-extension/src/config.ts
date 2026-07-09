import * as vscode from "vscode";
import { normalizeLogLevel, type LogLevel } from "./logger.js";

export interface ExtensionConfig {
  gatewayUrl: string;
  proxyToken: string;
  enableGatewayAuth: boolean;
  modelPrefix: string;
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
    modelPrefix: config.get<string>("modelPrefix", "copilot-").trim(),
    reconnectInitialDelayMs: readNumber(config, "reconnectInitialDelayMs", 1000),
    reconnectMaxDelayMs: readNumber(config, "reconnectMaxDelayMs", 30000),
    logLevel: normalizeLogLevel(config.get<string>("logLevel", "info")),
  };
}

export function isExtensionConfigComplete(config: ExtensionConfig): boolean {
  return (
    config.gatewayUrl.length > 0 &&
    config.modelPrefix.length > 0 &&
    (!config.enableGatewayAuth || config.proxyToken.length > 0)
  );
}

const RECONNECT_REQUIRED_KEYS = new Set([
  "gatewayUrl",
  "proxyToken",
  "enableGatewayAuth",
  "modelPrefix",
]);

export function getChangedSettings(
  oldConfig: ExtensionConfig,
  newConfig: ExtensionConfig,
): { changedKeys: string[]; requiresReconnect: boolean } {
  const allKeys: (keyof ExtensionConfig)[] = [
    "gatewayUrl",
    "proxyToken",
    "enableGatewayAuth",
    "modelPrefix",
    "reconnectInitialDelayMs",
    "reconnectMaxDelayMs",
    "logLevel",
  ];

  const changedKeys: string[] = [];

  for (const key of allKeys) {
    if (oldConfig[key] !== newConfig[key]) {
      changedKeys.push(key);
    }
  }

  const requiresReconnect = changedKeys.some((key) => RECONNECT_REQUIRED_KEYS.has(key));

  return { changedKeys, requiresReconnect };
}
