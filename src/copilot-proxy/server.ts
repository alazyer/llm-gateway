import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";

import type { FastifyInstance } from "fastify";
import type { RawData } from "ws";
import type {
  CopilotProxyExtensionMessage,
  CopilotProxyModel,
} from "@llm-gateway/shared";

import type { CopilotProxyConfig } from "../config.js";
import { isRecord } from "../shared.js";
import {
  extractProxyTokenFromUrl,
  type CopilotProxyTokenStore,
} from "./auth.js";
import { CopilotProxyConnectionRegistry } from "./registry.js";
import { validateExtensionMessage } from "./validation.js";

interface RegisterCopilotProxyWebsocketOptions {
  config: CopilotProxyConfig;
  registry: CopilotProxyConnectionRegistry;
  tokenStore: CopilotProxyTokenStore;
}

function decodeRawData(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  return data.toString("utf8");
}

function parseJsonMessage(data: RawData): unknown {
  return JSON.parse(decodeRawData(data)) as unknown;
}

function isModelCapabilities(value: unknown): value is CopilotProxyModel["capabilities"] {
  return (
    isRecord(value) &&
    typeof value.supports_streaming === "boolean" &&
    typeof value.supports_tools === "boolean" &&
    typeof value.supports_usage === "boolean" &&
    typeof value.supports_progress === "boolean" &&
    (value.max_tokens === undefined || value.max_tokens === null || typeof value.max_tokens === "number") &&
    (value.concurrent_requests === undefined || typeof value.concurrent_requests === "number")
  );
}

function isCopilotProxyModel(value: unknown): value is CopilotProxyModel {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.native_id === "string" &&
    typeof value.source === "string" &&
    isModelCapabilities(value.capabilities)
  );
}

function isCopilotProxyModels(value: unknown): value is CopilotProxyModel[] {
  return Array.isArray(value) && value.every(isCopilotProxyModel);
}

function isExtensionMessage(value: unknown): value is CopilotProxyExtensionMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }

  switch (value.type) {
    case "register":
      return (
        isCopilotProxyModels(value.models) &&
        typeof value.extension_version === "string" &&
        (value.copilot_status === "connected" ||
          value.copilot_status === "disconnected" ||
          value.copilot_status === "error") &&
        (value.copilot_user === undefined || typeof value.copilot_user === "string") &&
        (value.status_message === undefined || typeof value.status_message === "string")
      );
    case "status_update":
      return (
        isCopilotProxyModels(value.available_models) &&
        (value.copilot_status === "connected" ||
          value.copilot_status === "disconnected" ||
          value.copilot_status === "error") &&
        (value.status_message === undefined || typeof value.status_message === "string")
      );
    case "stream_delta":
      return (
        typeof value.id === "string" &&
        typeof value.content_type === "string" &&
        ["text", "tool_call", "usage", "progress"].includes(value.content_type)
      );
    case "stream_done":
      return typeof value.id === "string";
    case "stream_error":
      return (
        typeof value.id === "string" &&
        typeof value.partial === "boolean" &&
        isRecord(value.error) &&
        typeof value.error.code === "string" &&
        typeof value.error.message === "string"
      );
    case "pong":
      return true;
    case "disconnect":
      return value.reason === undefined || typeof value.reason === "string";
    default:
      return false;
  }
}

function getRegistrationModels(message: CopilotProxyExtensionMessage): CopilotProxyModel[] {
  if (message.type === "register") {
    return message.copilot_status === "connected" ? message.models : [];
  }

  if (message.type === "status_update") {
    return message.copilot_status === "connected" ? message.available_models : [];
  }

  return [];
}

export function registerCopilotProxyWebsocket(
  app: FastifyInstance,
  options: RegisterCopilotProxyWebsocketOptions,
): void {
  app.get("/ws/copilot-proxy", { websocket: true }, (socket, request) => {
    if (options.config.requireTokenAuth) {
      const token = extractProxyTokenFromUrl(request.url);
      if (!options.tokenStore.validateToken(token)) {
        request.log.warn("Rejected unauthorized Copilot proxy WebSocket connection.");
        socket.close(1008, "Unauthorized Copilot proxy token.");
        return;
      }
    } else {
      request.log.warn(
        "Accepted Copilot proxy WebSocket connection without token auth because copilot_proxy_require_token_auth=false.",
      );
    }

    const connectionId = randomUUID();
    options.registry.addConnection(connectionId, (message) => {
      socket.send(JSON.stringify(message));
    });
    request.log.info({ connectionId }, "Accepted Copilot proxy WebSocket connection.");

    let heartbeatTimeout: ReturnType<typeof setTimeout> | undefined;
    const clearHeartbeatTimeout = () => {
      if (heartbeatTimeout) {
        clearTimeout(heartbeatTimeout);
        heartbeatTimeout = undefined;
      }
    };
    let cleanedUp = false;
    const cleanupConnection = () => {
      if (cleanedUp) {
        return;
      }

      cleanedUp = true;
      clearInterval(heartbeatInterval);
      clearHeartbeatTimeout();
      options.registry.removeConnection(connectionId);
      request.log.info({ connectionId }, "Closed Copilot proxy WebSocket connection.");
    };

    const heartbeatInterval = setInterval(() => {
      clearHeartbeatTimeout();
      socket.send(JSON.stringify({ type: "ping" }));
      heartbeatTimeout = setTimeout(() => {
        options.registry.markUnhealthy(connectionId);
        request.log.warn({ connectionId }, "Copilot proxy WebSocket missed heartbeat.");
        socket.close(1001, "Heartbeat timeout.");
      }, options.config.heartbeatTimeoutMs);
    }, options.config.heartbeatIntervalMs);

    socket.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = parseJsonMessage(data);
      } catch (error) {
        request.log.warn(
          { connectionId, error: error instanceof Error ? error.message : String(error) },
          "Received invalid Copilot proxy WebSocket JSON frame.",
        );
        socket.close(1003, "Invalid JSON frame.");
        return;
      }

      if (!isExtensionMessage(parsed)) {
        const validationError = validateExtensionMessage(parsed);
        request.log.warn(
          { connectionId, parsed, validationError },
          "Received invalid Copilot proxy protocol frame.",
        );
        socket.close(1003, "Invalid protocol frame.");
        return;
      }

      if (parsed.type === "pong") {
        clearHeartbeatTimeout();
        options.registry.markHealthy(connectionId);
        return;
      }

      if (parsed.type === "disconnect") {
        options.registry.markClosing(connectionId);
        cleanupConnection();
        socket.close(1000, parsed.reason ?? "Extension disconnected.");
        return;
      }

      if (parsed.type === "register" || parsed.type === "status_update") {
        const models = getRegistrationModels(parsed);
        try {
          options.registry.replaceRegistration(connectionId, models);
        } catch (error) {
          request.log.warn(
            { connectionId, error: error instanceof Error ? error.message : String(error) },
            "Rejected Copilot proxy model registration.",
          );
          options.registry.clearRegistration(connectionId);
          socket.close(1008, "Invalid model registration.");
        }
        return;
      }

      if (
        parsed.type === "stream_delta" ||
        parsed.type === "stream_done" ||
        parsed.type === "stream_error"
      ) {
        if (!options.registry.handleStreamMessage(connectionId, parsed)) {
          request.log.debug(
            { connectionId, frameType: parsed.type, id: parsed.id },
            "Received Copilot proxy stream frame without active dispatcher.",
          );
        }
        return;
      }

      request.log.debug(
        { connectionId, frameType: parsed.type, id: "id" in parsed ? parsed.id : undefined },
        "Received Copilot proxy stream frame without active dispatcher.",
      );
    });

    socket.on("close", () => {
      cleanupConnection();
    });

    socket.on("error", () => {
      cleanupConnection();
    });
  });
}
