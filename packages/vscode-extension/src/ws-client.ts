import type {
  CopilotProxyGatewayMessage,
  CopilotProxyRegisterMessage,
  CopilotProxyStatusUpdateMessage,
} from "@llm-gateway/shared";

import type { ExtensionConfig } from "./config.js";
import type { ExtensionLogger } from "./logger.js";
import type { StatusBarController } from "./status-bar.js";

interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface CopilotProxyWebSocketClientOptions {
  config: ExtensionConfig;
  logger: ExtensionLogger;
  statusBar: StatusBarController;
  registrationProvider: () => CopilotProxyRegisterMessage | Promise<CopilotProxyRegisterMessage>;
  statusProvider?: () => CopilotProxyStatusUpdateMessage | Promise<CopilotProxyStatusUpdateMessage>;
  requestHandler?: (
    message: Extract<CopilotProxyGatewayMessage, { type: "request" }>,
    send: (message: unknown) => void,
  ) => void | Promise<void>;
  cancelHandler?: (id: string) => void;
  webSocketFactory?: WebSocketFactory;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
  statusPollIntervalMs?: number;
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  if (typeof WebSocket === "undefined") {
    throw new Error("WebSocket is not available in this VS Code extension host.");
  }

  return new WebSocket(url) as unknown as WebSocketLike;
}

function buildWebSocketUrl(gatewayUrl: string, proxyToken: string): string {
  const url = new URL(gatewayUrl);
  url.searchParams.set("token", proxyToken);
  return url.toString();
}

function parseGatewayMessage(data: unknown): CopilotProxyGatewayMessage | undefined {
  if (typeof data !== "string") {
    return undefined;
  }

  const parsed = JSON.parse(data) as unknown;
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "type" in parsed &&
    (parsed.type === "ping" || parsed.type === "request" || parsed.type === "cancel")
  ) {
    return parsed as CopilotProxyGatewayMessage;
  }

  return undefined;
}

export class CopilotProxyWebSocketClient {
  private readonly webSocketFactory: WebSocketFactory;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private socket: WebSocketLike | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private statusTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectDelayMs: number;
  private disposed = false;

  public constructor(private readonly options: CopilotProxyWebSocketClientOptions) {
    this.webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.setIntervalFn = options.setIntervalFn ?? setInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval;
    this.reconnectDelayMs = options.config.reconnectInitialDelayMs;
  }

  public connect(): void {
    if (this.disposed) {
      this.options.logger.warn("Skipping gateway WebSocket connect because the client is disposed.");
      return;
    }

    this.options.statusBar.setStatus("retrying");
    this.options.logger.info(
      `Opening gateway WebSocket connection to ${this.options.config.gatewayUrl}.`,
    );
    const url = buildWebSocketUrl(
      this.options.config.gatewayUrl,
      this.options.config.proxyToken,
    );
    this.socket = this.webSocketFactory(url);
    this.socket.onopen = () => {
      void this.handleOpen();
    };
    this.socket.onmessage = (event) => {
      this.handleMessage(event.data);
    };
    this.socket.onerror = () => {
      this.options.statusBar.setStatus("gateway-error");
      this.options.logger.warn("Gateway WebSocket reported an error.");
    };
    this.socket.onclose = (event) => {
      this.handleClose(event.code, event.reason);
    };
  }

  public disconnect(): void {
    this.disposed = true;
    this.options.logger.info("Disconnecting gateway WebSocket client.");
    if (this.reconnectTimer) {
      this.clearTimeoutFn(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.options.logger.debug("Cleared pending gateway reconnect timer.");
    }
    this.stopStatusUpdates();

    if (this.socket) {
      this.socket.send(JSON.stringify({ type: "disconnect", reason: "Extension deactivated." }));
      this.options.logger.debug("Sent gateway disconnect frame.");
      this.socket.close(1000, "Extension deactivated.");
    }
    this.socket = undefined;
    this.options.statusBar.setStatus("disconnected");
  }

  private async handleOpen(): Promise<void> {
    this.reconnectDelayMs = this.options.config.reconnectInitialDelayMs;
    this.options.statusBar.setStatus("connected");
    this.options.logger.info("Connected to LLM Gateway Copilot proxy.");
    const registration = await this.options.registrationProvider();
    this.socket?.send(JSON.stringify(registration));
    this.options.logger.info(
      `Sent proxy registration: status=${registration.copilot_status}, models=${registration.models.length}.`,
    );
    this.options.logger.debug(
      `Registration frame details: modelIds=${registration.models.map((model) => model.id).join(", ") || "none"}.`,
    );
    this.startStatusUpdates();
  }

  private handleMessage(data: unknown): void {
    let message: CopilotProxyGatewayMessage | undefined;
    try {
      message = parseGatewayMessage(data);
    } catch (error) {
      this.options.logger.warn(
        `Ignoring invalid gateway WebSocket message: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }

    if (!message) {
      this.options.logger.warn("Ignoring unsupported gateway WebSocket message.");
      return;
    }

    if (message.type === "ping") {
      this.options.logger.debug("Received gateway ping; sending pong.");
      this.socket?.send(JSON.stringify({ type: "pong" }));
      return;
    }

    if (message.type === "request") {
      this.options.logger.info(
        `Received gateway request ${message.id}: model=${message.model}, messages=${message.messages.length}.`,
      );
      void this.options.requestHandler?.(message, (outbound) => {
        this.options.logger.debug(`Sending extension frame for request ${message.id}: ${getFrameType(outbound)}.`);
        this.socket?.send(JSON.stringify(outbound));
      });
      return;
    }

    if (message.type === "cancel") {
      this.options.logger.info(`Received gateway cancellation for request ${message.id}.`);
      this.options.cancelHandler?.(message.id);
    }
  }

  private handleClose(code: number, reason: string): void {
    this.socket = undefined;
    this.stopStatusUpdates();
    if (this.disposed) {
      return;
    }

    if (code === 1008) {
      this.options.statusBar.setStatus("gateway-error");
      this.options.logger.warn(`Gateway rejected proxy token: code=${code}, reason=${reason}`);
      return;
    }

    this.options.statusBar.setStatus("retrying");
    const delay = this.reconnectDelayMs;
    this.options.logger.warn(
      `Gateway WebSocket closed: code=${code}, reason=${reason || "none"}; reconnecting in ${delay}ms.`,
    );
    this.reconnectDelayMs = Math.min(
      this.reconnectDelayMs * 2,
      this.options.config.reconnectMaxDelayMs,
    );
    this.reconnectTimer = this.setTimeoutFn(() => {
      this.reconnectTimer = undefined;
      this.options.logger.debug("Gateway reconnect timer fired.");
      this.connect();
    }, delay);
  }

  private startStatusUpdates(): void {
    this.stopStatusUpdates();
    if (!this.options.statusProvider) {
      return;
    }

    this.statusTimer = this.setIntervalFn(() => {
      void this.sendStatusUpdate();
    }, this.options.statusPollIntervalMs ?? 30_000);
    this.options.logger.debug("Started gateway status update timer.");
  }

  private stopStatusUpdates(): void {
    if (!this.statusTimer) {
      return;
    }

    this.clearIntervalFn(this.statusTimer);
    this.statusTimer = undefined;
    this.options.logger.debug("Stopped gateway status update timer.");
  }

  private async sendStatusUpdate(): Promise<void> {
    const update = await this.options.statusProvider?.();
    if (update) {
      this.options.logger.debug(
        `Sending status update: status=${update.copilot_status}, models=${update.available_models.length}.`,
      );
      this.socket?.send(JSON.stringify(update));
    }
  }
}

function getFrameType(value: unknown): string {
  return typeof value === "object" && value !== null && "type" in value
    ? String(value.type)
    : "unknown";
}
