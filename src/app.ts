import Fastify from "fastify";
import websocket from "@fastify/websocket";

import {
  DEFAULT_COPILOT_PROXY_CONFIG,
  type AppConfig,
  type CopilotProxyConfig,
} from "./config.js";
import { registerAuthHook } from "./auth.js";
import { CopilotProxyTokenStore } from "./copilot-proxy/auth.js";
import { CopilotProxyConnectionRegistry } from "./copilot-proxy/registry.js";
import { registerCopilotProxyWebsocket } from "./copilot-proxy/server.js";
import { registerCorsHook } from "./cors.js";
import { responsesRoutes } from "./routes/responses.js";
import { adminRoutes } from "./routes/admin.js";
import { adminWorkspacesRoutes } from "./routes/admin-workspaces.js";
import { InMemoryWorkspaceStorage } from "./workspace/storage.js";
import { registerWorkspaceContext } from "./workspace/context.js";
import { registerWorkspaceAuth } from "./workspace/auth.js";
import { registerUsageTracking } from "./workspace/usage.js";
import type { ChatCompletionsTransport } from "./upstream/chat-completions-client.js";
import { aiChatRoutes } from "./routes/ai-chat.js";

export interface CreateAppOptions {
  config: AppConfig;
  client?: ChatCompletionsTransport;
  fetchFn?: typeof fetch;
}

function getCopilotProxyConfig(config: AppConfig): CopilotProxyConfig {
  return config.copilotProxy ?? DEFAULT_COPILOT_PROXY_CONFIG;
}

export function createApp(options: CreateAppOptions) {
  const maxBodySizeKb = Number.isFinite(options.config.maxBodySizeKb) && options.config.maxBodySizeKb > 0
    ? options.config.maxBodySizeKb
    : 1024;
  const config: AppConfig = {
    ...options.config,
    maxBodySizeKb,
    healthProbeEnabled: options.config.healthProbeEnabled ?? false,
    workspace: options.config.workspace ?? { enabled: false },
    modelChains: options.config.modelChains ?? [],
  };
  const copilotProxyConfig = getCopilotProxyConfig(config);
  const copilotProxyTokenStore = new CopilotProxyTokenStore({
    tokenTtlSeconds: copilotProxyConfig.tokenTtlSeconds,
  });
  const copilotProxyRegistry = new CopilotProxyConnectionRegistry({ allowedPrefixes: copilotProxyConfig.allowedPrefixes });
  const workspaceStorage = new InMemoryWorkspaceStorage();
  const app = Fastify({
    bodyLimit: config.maxBodySizeKb * 1024,
    logger: {
      level: config.logLevel,
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.headers[\"x-api-key\"]",
        "req.headers[\"api-key\"]",
        "req.headers[\"proxy-authorization\"]",
        "res.headers[\"set-cookie\"]",
        "authorization",
        "apiKey",
      ],
    },
  });

  if (config.corsOrigin) {
    registerCorsHook(app, config.corsOrigin);
  }

  if (config.workspace.enabled) {
    registerWorkspaceContext(app, {
      storage: workspaceStorage,
      enabled: true,
    });
    registerWorkspaceAuth(app, {
      storage: workspaceStorage,
      enabled: true,
      gatewayAuthToken: config.gatewayAuthToken,
    });
    registerUsageTracking(app, {
      storage: workspaceStorage,
      enabled: true,
    });
  } else if (config.gatewayAuthToken) {
    // When workspace is disabled, use the simpler gateway auth hook
    registerAuthHook(app, config.gatewayAuthToken);
  }

  app.get("/healthz", async (request, reply) => {
    app.log.debug("Serving health check response.");

    const healthResponse: { ok: boolean; models: number; configured: boolean; upstream?: string } = {
      ok: true,
      models: config.models.length,
      configured: config.models.length > 0,
    };

    if (config.healthProbeEnabled && config.models.length > 0) {
      try {
        const probeUrl = `${config.upstreamBaseUrl}/models`;
        const fetchToUse = options.fetchFn ?? fetch;
        const probeResponse = await fetchToUse(probeUrl, {
          signal: AbortSignal.timeout(5000),
        });

        if (probeResponse.ok) {
          healthResponse.upstream = "reachable";
        } else {
          healthResponse.upstream = "unreachable";
          return reply.code(503).send({
            ok: false,
            error: "Upstream unreachable.",
            upstream: "unreachable",
          });
        }
      } catch {
        return reply.code(503).send({
          ok: false,
          error: "Upstream unreachable.",
          upstream: "unreachable",
        });
      }
    }

    return healthResponse;
  });

  app.post("/api/proxy-token", async (_request, reply) => {
    if (!copilotProxyConfig.enabled) {
      return reply.code(403).send({
        error: {
          message: "Copilot proxy is disabled.",
          type: "invalid_request_error",
        },
      });
    }

    if (!config.gatewayAuthToken) {
      return reply.code(403).send({
        error: {
          message: "Gateway auth must be enabled to issue Copilot proxy tokens.",
          type: "authentication_error",
        },
      });
    }

    return reply.code(201).send(copilotProxyTokenStore.issueToken());
  });

  app.get("/api/channels", async (_request, reply) => {
    if (!copilotProxyConfig.enabled) {
      return reply.code(403).send({
        error: {
          message: "Copilot proxy is disabled.",
          type: "invalid_request_error",
        },
      });
    }

    if (!config.gatewayAuthToken) {
      return reply.code(403).send({
        error: {
          message: "Gateway auth must be enabled to access channel information.",
          type: "authentication_error",
        },
      });
    }

    return copilotProxyRegistry.getChannelsInfo();
  });

  if (copilotProxyConfig.enabled) {
    void app.register(websocket);
    app.after((error) => {
      if (error) {
        throw error;
      }

      registerCopilotProxyWebsocket(app, {
        config: copilotProxyConfig,
        registry: copilotProxyRegistry,
        tokenStore: copilotProxyTokenStore,
      });
    });
  }

  const routeOptions: {
    config: AppConfig;
    client?: ChatCompletionsTransport;
    fetchFn?: typeof fetch;
    copilotProxyRegistry?: CopilotProxyConnectionRegistry;
    allowedPrefixes?: readonly string[];
  } = {
    config,
    copilotProxyRegistry,
    allowedPrefixes: copilotProxyConfig.allowedPrefixes,
  };

  if (options.client) {
    routeOptions.client = options.client;
  }

  if (options.fetchFn) {
    routeOptions.fetchFn = options.fetchFn;
  }

  void app.register(responsesRoutes, routeOptions);
  const aiChatRouteOptions: { config: AppConfig; client?: ChatCompletionsTransport; fetchFn?: typeof fetch } = {
    config,
    ...(options.client ? { client: options.client } : {}),
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
  };
  void app.register(aiChatRoutes, aiChatRouteOptions);
  void app.register(adminRoutes, { config });

  if (config.workspace.enabled) {
    void app.register(adminWorkspacesRoutes, {
      storage: workspaceStorage,
      enabled: true,
    });
  }

  return app;
}
