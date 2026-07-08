import * as vscode from "vscode";
import type {
  CopilotProxyModel,
  CopilotProxyRegisterMessage,
  CopilotProxyStatusUpdateMessage,
} from "@llm-gateway/shared";

import { isExtensionConfigComplete, loadExtensionConfig } from "./config.js";
import { CopilotBridge } from "./copilot-bridge.js";
import { ExtensionLogger } from "./logger.js";
import { StatusBarController } from "./status-bar.js";
import { CopilotProxyWebSocketClient } from "./ws-client.js";

interface RuntimeState {
  logger: ExtensionLogger;
  statusBar: StatusBarController;
  client?: CopilotProxyWebSocketClient;
  disposables: vscode.Disposable[];
}

let runtime: RuntimeState | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("LLM Gateway Copilot Proxy");
  const logger = new ExtensionLogger(output);
  const statusBar = new StatusBarController();
  const disposables: vscode.Disposable[] = [];

  const reconnectCommand = vscode.commands.registerCommand(
    "llmGatewayCopilotProxy.reconnect",
    () => {
      logger.info("Reconnect command invoked.");
      startProxy(logger, statusBar);
    },
  );
  const showOutputCommand = vscode.commands.registerCommand(
    "llmGatewayCopilotProxy.showOutput",
    () => {
      logger.show();
    },
  );

  disposables.push(reconnectCommand, showOutputCommand, statusBar, logger);
  context.subscriptions.push(...disposables);
  runtime = { logger, statusBar, disposables };

  logger.info("Extension activated.");
  startProxy(logger, statusBar);
}

export function deactivate(): void {
  runtime?.logger.info("Extension deactivated.");
  runtime?.client?.disconnect();
  for (const disposable of runtime?.disposables ?? []) {
    disposable.dispose();
  }
  runtime = undefined;
}

function startProxy(logger: ExtensionLogger, statusBar: StatusBarController): void {
  const config = loadExtensionConfig();
  logger.setLevel(config.logLevel);
  logger.info(
    `Loaded proxy configuration: gatewayUrl=${config.gatewayUrl || "<missing>"}, proxyToken=${
      config.proxyToken ? "configured" : "<missing>"
    }, enableGatewayAuth=${config.enableGatewayAuth}, modelPrefix=${config.modelPrefix}, reconnectInitialDelayMs=${config.reconnectInitialDelayMs}, reconnectMaxDelayMs=${config.reconnectMaxDelayMs}, logLevel=${config.logLevel}.`,
  );
  if (!isExtensionConfigComplete(config)) {
    const missing = [
      config.gatewayUrl ? undefined : "gatewayUrl",
      !config.enableGatewayAuth || config.proxyToken ? undefined : "proxyToken",
    ].filter((value): value is string => value !== undefined);
    statusBar.setStatus("disconnected");
    logger.warn(
      `Proxy connection not started because required configuration is missing: ${missing.join(", ")}.`,
    );
    return;
  }

  statusBar.setStatus("retrying");
  logger.info(`Proxy runtime configured for ${config.gatewayUrl}`);
  if (!runtime) {
    return;
  }

  if (runtime.client) {
    logger.info("Replacing existing gateway WebSocket client before reconnecting.");
    runtime.client.disconnect();
  }
  const bridge = new CopilotBridge(config.modelPrefix, logger);
  let lastCopilotStatus: "connected" | "disconnected" | undefined;
  let lastModelCount: number | undefined;

  const updateAvailabilityStatus = (models: readonly CopilotProxyModel[], source: string) => {
    const copilotStatus = models.length > 0 ? "connected" : "disconnected";
    statusBar.setStatus(models.length > 0 ? "connected" : "copilot-unavailable");
    if (lastCopilotStatus !== copilotStatus || lastModelCount !== models.length) {
      logger.info(
        `${source}: Copilot availability is ${copilotStatus}; models=${models.length}.`,
      );
      lastCopilotStatus = copilotStatus;
      lastModelCount = models.length;
    }
    return copilotStatus;
  };

  const buildRegistration = async (): Promise<CopilotProxyRegisterMessage> => {
    const models = await bridge.discoverModels({ reason: "registration" });
    const copilotStatus = updateAvailabilityStatus(models, "Registration");
    logger.debug(`Registration model IDs: ${models.map((model) => model.id).join(", ") || "none"}.`);

    const registration: CopilotProxyRegisterMessage = {
      type: "register",
      extension_version: "0.1.0",
      copilot_status: copilotStatus,
      models,
    };
    return models.length > 0
      ? registration
      : { ...registration, status_message: "No Copilot language models are available." };
  };
  const buildStatusUpdate = async (): Promise<CopilotProxyStatusUpdateMessage> => {
    const models = await bridge.discoverModels({ reason: "status update", log: false });
    const copilotStatus = updateAvailabilityStatus(models, "Status update");
    logger.debug(`Status update model IDs: ${models.map((model) => model.id).join(", ") || "none"}.`);

    const status: CopilotProxyStatusUpdateMessage = {
      type: "status_update",
      copilot_status: copilotStatus,
      available_models: models,
    };
    return models.length > 0
      ? status
      : { ...status, status_message: "No Copilot language models are available." };
  };
  runtime.client = new CopilotProxyWebSocketClient({
    config,
    logger,
    statusBar,
    registrationProvider: buildRegistration,
    statusProvider: buildStatusUpdate,
    requestHandler: (message, send) => bridge.executeRequest(message, send),
    cancelHandler: (id) => bridge.cancel(id),
    onPolicyViolation: (reason) => {
      vscode.window.showErrorMessage(
        `LLM Gateway: The model prefix "${config.modelPrefix}" is not in the gateway allowlist. ` +
        `Update the "llmGatewayCopilotProxy.modelPrefix" setting to use an allowed prefix, ` +
        `or ask your gateway operator to add "${config.modelPrefix}" to the allowed prefixes. ` +
        (reason ? `Gateway reason: ${reason}` : "").trim(),
      );
    },
  });
  runtime.client.connect();
}
