import type { FastifyInstance } from "fastify";
import type { RawData, WebSocket } from "ws";
import type {
  CopilotProxyGatewayMessage,
  CopilotProxyModel,
} from "@llm-gateway/shared";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const copilotModel: CopilotProxyModel = {
  id: "copilot-gpt-4o",
  name: "GPT-4o via Copilot",
  native_id: "gpt-4o",
  source: "copilot-",
  capabilities: {
    supports_streaming: true,
    supports_tools: true,
    supports_usage: true,
    supports_progress: true,
  },
};

const alazyerModel: CopilotProxyModel = {
  id: "alazyer-gpt-4o",
  name: "GPT-4o via Alazyer",
  native_id: "gpt-4o",
  source: "alazyer-",
  capabilities: {
    supports_streaming: true,
    supports_tools: true,
    supports_usage: true,
    supports_progress: true,
  },
};

const teamBModel: CopilotProxyModel = {
  id: "team-b-gpt-4o",
  name: "GPT-4o via Team B",
  native_id: "gpt-4o",
  source: "team-b-",
  capabilities: {
    supports_streaming: true,
    supports_tools: false,
    supports_usage: false,
    supports_progress: false,
  },
};

function makeConfig(overrides: Partial<AppConfig> & { copilotProxy: AppConfig["copilotProxy"] }): AppConfig {
  return {
    host: "127.0.0.1",
    port: 3001,
    logLevel: "silent",
    upstreamBaseUrl: "https://provider.example/v1",
    defaultModel: "glm-5.1",
    requestTimeoutMs: 30000,
    maxRetries: 0,
    maxBodySizeKb: 1024,
    healthProbeEnabled: false,
  workspace: { enabled: false },
    models: [
      {
        name: "glm-5.1",
        upstreamModel: "glm-5.1",
        baseUrl: "https://provider.example/v1",
        apiKey: "secret-key",
        apiKeyEnv: "GLM_API_KEY",
        ownedBy: "zhipu",
        created: 1_718_000_000,
        supportsTools: true,
        supportsStreaming: true,
        unknownFieldMode: "warn",
        unknownFieldWindowRequests: 100,
        status: "active",
        statusReason: "Loaded from config",
        statusChangedAt: 1_718_000_000,
      },
    ],
    ...overrides,
  };
}

function decodeMessage(data: RawData): unknown {
  const raw = Array.isArray(data)
    ? Buffer.concat(data).toString("utf8")
    : data.toString();
  return JSON.parse(raw) as unknown;
}

async function issueProxyToken(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/proxy-token",
    headers: {
      "x-api-key": "gateway-token",
    },
  });

  expect(response.statusCode).toBe(201);
  return (response.json() as { token: string }).token;
}

function waitForMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    ws.once("message", (data) => {
      resolve(decodeMessage(data));
    });
  });
}

async function waitForGatewayMessage(
  ws: WebSocket,
  type: CopilotProxyGatewayMessage["type"],
): Promise<CopilotProxyGatewayMessage> {
  while (true) {
    const message = await waitForMessage(ws);
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === type
    ) {
      return message as CopilotProxyGatewayMessage;
    }
  }
}

function waitForClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.once("close", (code) => {
      resolve(code);
    });
  });
}

async function waitForModel(
  app: FastifyInstance,
  modelId: string,
  present: boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
    });
    const body = response.json() as { data: Array<{ id: string }> };
    const found = body.data.some((model) => model.id === modelId);
    if (found === present) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(
    `Expected model ${modelId} to be ${present ? "present" : "absent"} in /v1/models.`,
  );
}

// ---------------------------------------------------------------------------
// Scenario 1: Two extensions with different prefixes register distinct models
// ---------------------------------------------------------------------------

describe("Configurable model prefix integration", () => {
  it("two extensions with different prefixes register distinct models", async () => {
    const app = createApp({
      config: makeConfig({
        gatewayAuthToken: "gateway-token",
        copilotProxy: {
          enabled: true,
          requireTokenAuth: true,
          tokenTtlSeconds: 60,
          heartbeatIntervalMs: 30000,
          heartbeatTimeoutMs: 10000,
          maxInflightPerConnection: 4,
          allowedPrefixes: ["copilot-", "alazyer-"],
        },
      }),
    });

    try {
      await app.ready();
      const token = await issueProxyToken(app);

      // Connect first extension (copilot-)
      const wsA = await app.injectWS(
        `/ws/copilot-proxy?token=${encodeURIComponent(token)}`,
      );
      wsA.send(
        JSON.stringify({
          type: "register",
          extension_version: "0.1.0",
          copilot_status: "connected",
          models: [copilotModel],
        }),
      );
      await waitForModel(app, "copilot-gpt-4o", true);

      // Connect second extension (alazyer-)
      const wsB = await app.injectWS(
        `/ws/copilot-proxy?token=${encodeURIComponent(token)}`,
      );
      wsB.send(
        JSON.stringify({
          type: "register",
          extension_version: "0.1.0",
          copilot_status: "connected",
          models: [alazyerModel],
        }),
      );
      await waitForModel(app, "alazyer-gpt-4o", true);

      // Both models should appear in /v1/models
      const response = await app.inject({
        method: "GET",
        url: "/v1/models",
      });
      const body = response.json() as { data: Array<{ id: string }> };
      const ids = body.data.map((m) => m.id);

      expect(ids).toContain("copilot-gpt-4o");
      expect(ids).toContain("alazyer-gpt-4o");

      wsA.close();
      wsB.close();
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 2: Disallowed prefix gets connection rejected (1008)
  // -------------------------------------------------------------------------

  it("extension with disallowed prefix gets WebSocket closed with code 1008", async () => {
    const app = createApp({
      config: makeConfig({
        gatewayAuthToken: "gateway-token",
        copilotProxy: {
          enabled: true,
          requireTokenAuth: true,
          tokenTtlSeconds: 60,
          heartbeatIntervalMs: 30000,
          heartbeatTimeoutMs: 10000,
          maxInflightPerConnection: 4,
          allowedPrefixes: ["copilot-"],
        },
      }),
    });

    try {
      await app.ready();
      const token = await issueProxyToken(app);
      const ws = await app.injectWS(
        `/ws/copilot-proxy?token=${encodeURIComponent(token)}`,
      );

      // Register a model with a disallowed prefix
      ws.send(
        JSON.stringify({
          type: "register",
          extension_version: "0.1.0",
          copilot_status: "connected",
          models: [alazyerModel], // alazyer- not in allowedPrefixes
        }),
      );

      const closeCode = await waitForClose(ws);
      expect(closeCode).toBe(1008);
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 3: /api/channels returns correct aggregation
  // -------------------------------------------------------------------------

  it("/api/channels returns correct prefix, extension count, and model IDs", async () => {
    const app = createApp({
      config: makeConfig({
        gatewayAuthToken: "gateway-token",
        copilotProxy: {
          enabled: true,
          requireTokenAuth: true,
          tokenTtlSeconds: 60,
          heartbeatIntervalMs: 30000,
          heartbeatTimeoutMs: 10000,
          maxInflightPerConnection: 4,
          allowedPrefixes: ["copilot-", "alazyer-"],
        },
      }),
    });

    try {
      await app.ready();
      const token = await issueProxyToken(app);

      // No connections yet → empty channels
      const emptyResponse = await app.inject({
        method: "GET",
        url: "/api/channels",
        headers: { "x-api-key": "gateway-token" },
      });
      expect(emptyResponse.statusCode).toBe(200);
      expect(emptyResponse.json()).toEqual([
        { prefix: "alazyer-", connectionCount: 0, modelIds: [] },
        { prefix: "copilot-", connectionCount: 0, modelIds: [] },
      ]);

      // Connect copilot- extension
      const wsA = await app.injectWS(
        `/ws/copilot-proxy?token=${encodeURIComponent(token)}`,
      );
      wsA.send(
        JSON.stringify({
          type: "register",
          extension_version: "0.1.0",
          copilot_status: "connected",
          models: [copilotModel],
        }),
      );
      await waitForModel(app, "copilot-gpt-4o", true);

      // Connect alazyer- extension
      const wsB = await app.injectWS(
        `/ws/copilot-proxy?token=${encodeURIComponent(token)}`,
      );
      wsB.send(
        JSON.stringify({
          type: "register",
          extension_version: "0.1.0",
          copilot_status: "connected",
          models: [alazyerModel],
        }),
      );
      await waitForModel(app, "alazyer-gpt-4o", true);

      // Now check /api/channels
      const channelsResponse = await app.inject({
        method: "GET",
        url: "/api/channels",
        headers: { "x-api-key": "gateway-token" },
      });
      expect(channelsResponse.statusCode).toBe(200);
      expect(channelsResponse.json()).toEqual([
        { prefix: "alazyer-", connectionCount: 1, modelIds: ["alazyer-gpt-4o"] },
        { prefix: "copilot-", connectionCount: 1, modelIds: ["copilot-gpt-4o"] },
      ]);

      wsA.close();
      wsB.close();
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 4: Default copilot- prefix still works (backward compatibility)
  // -------------------------------------------------------------------------

  it("default copilot- prefix still works without explicit allowedPrefixes", async () => {
    const app = createApp({
      config: makeConfig({
        gatewayAuthToken: "gateway-token",
        copilotProxy: {
          enabled: true,
          requireTokenAuth: true,
          tokenTtlSeconds: 60,
          heartbeatIntervalMs: 30000,
          heartbeatTimeoutMs: 10000,
          maxInflightPerConnection: 4,
          // No allowedPrefixes → defaults to ["copilot-"]
        },
      }),
    });

    try {
      await app.ready();
      const token = await issueProxyToken(app);
      const ws = await app.injectWS(
        `/ws/copilot-proxy?token=${encodeURIComponent(token)}`,
      );

      ws.send(
        JSON.stringify({
          type: "register",
          extension_version: "0.1.0",
          copilot_status: "connected",
          models: [copilotModel],
        }),
      );

      await waitForModel(app, "copilot-gpt-4o", true);

      // Verify the model appears in /v1/models with correct details
      const detail = await app.inject({
        method: "GET",
        url: "/models/copilot-gpt-4o",
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        id: "copilot-gpt-4o",
        source: "copilot-",
        owned_by: "github-copilot",
      });

      // Verify /api/channels only shows copilot- channel
      const channelsResponse = await app.inject({
        method: "GET",
        url: "/api/channels",
        headers: { "x-api-key": "gateway-token" },
      });
      expect(channelsResponse.statusCode).toBe(200);
      expect(channelsResponse.json()).toEqual([
        { prefix: "copilot-", connectionCount: 1, modelIds: ["copilot-gpt-4o"] },
      ]);

      ws.close();
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 5: Empty allowlist ([]) rejects all registrations
  // -------------------------------------------------------------------------

  it("empty allowedPrefixes rejects all model registrations with code 1008", async () => {
    const app = createApp({
      config: makeConfig({
        gatewayAuthToken: "gateway-token",
        copilotProxy: {
          enabled: true,
          requireTokenAuth: true,
          tokenTtlSeconds: 60,
          heartbeatIntervalMs: 30000,
          heartbeatTimeoutMs: 10000,
          maxInflightPerConnection: 4,
          allowedPrefixes: [],
        },
      }),
    });

    try {
      await app.ready();
      const token = await issueProxyToken(app);
      const ws = await app.injectWS(
        `/ws/copilot-proxy?token=${encodeURIComponent(token)}`,
      );

      // Even copilot- model should be rejected with empty allowlist
      ws.send(
        JSON.stringify({
          type: "register",
          extension_version: "0.1.0",
          copilot_status: "connected",
          models: [copilotModel],
        }),
      );

      const closeCode = await waitForClose(ws);
      expect(closeCode).toBe(1008);
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 6: Same model ID, same prefix, two extensions — dedup
  // -------------------------------------------------------------------------

  it("same model ID with same prefix registered by two extensions deduplicates", async () => {
    const app = createApp({
      config: makeConfig({
        gatewayAuthToken: "gateway-token",
        copilotProxy: {
          enabled: true,
          requireTokenAuth: true,
          tokenTtlSeconds: 60,
          heartbeatIntervalMs: 30000,
          heartbeatTimeoutMs: 10000,
          maxInflightPerConnection: 4,
          allowedPrefixes: ["copilot-"],
        },
      }),
    });

    try {
      await app.ready();
      const token = await issueProxyToken(app);

      // First extension registers copilot-gpt-4o
      const wsA = await app.injectWS(
        `/ws/copilot-proxy?token=${encodeURIComponent(token)}`,
      );
      wsA.send(
        JSON.stringify({
          type: "register",
          extension_version: "0.1.0",
          copilot_status: "connected",
          models: [copilotModel],
        }),
      );
      await waitForModel(app, "copilot-gpt-4o", true);

      // Second extension also registers copilot-gpt-4o
      const wsB = await app.injectWS(
        `/ws/copilot-proxy?token=${encodeURIComponent(token)}`,
      );
      wsB.send(
        JSON.stringify({
          type: "register",
          extension_version: "0.1.0",
          copilot_status: "connected",
          models: [copilotModel],
        }),
      );

      // Wait a tick for the second registration to process
      await new Promise((resolve) => setTimeout(resolve, 50));

      // /v1/models should list copilot-gpt-4o only once
      const listResponse = await app.inject({
        method: "GET",
        url: "/v1/models",
      });
      const body = listResponse.json() as { data: Array<{ id: string }> };
      const copilotModels = body.data.filter((m) => m.id === "copilot-gpt-4o");
      expect(copilotModels).toHaveLength(1);

      // /api/channels should show 2 connections but same model ID listed once
      const channelsResponse = await app.inject({
        method: "GET",
        url: "/api/channels",
        headers: { "x-api-key": "gateway-token" },
      });
      expect(channelsResponse.statusCode).toBe(200);
      expect(channelsResponse.json()).toEqual([
        { prefix: "copilot-", connectionCount: 2, modelIds: ["copilot-gpt-4o"] },
      ]);

      wsA.close();
      wsB.close();
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // Scenario 7: Auth pattern for /api/channels
  //   (403 proxy disabled, 403 auth not configured, 401 token missing/invalid)
  //   These are already covered in channels.test.ts; verify they also work
  //   with custom allowedPrefixes.
  // -------------------------------------------------------------------------

  it("/api/channels returns 403 when proxy disabled, even with custom prefixes", async () => {
    const app = createApp({
      config: makeConfig({
        gatewayAuthToken: "gateway-token",
        copilotProxy: {
          enabled: false,
          requireTokenAuth: true,
          tokenTtlSeconds: 60,
          heartbeatIntervalMs: 30000,
          heartbeatTimeoutMs: 10000,
          maxInflightPerConnection: 4,
          allowedPrefixes: ["copilot-", "alazyer-"],
        },
      }),
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/channels",
        headers: { "x-api-key": "gateway-token" },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: {
          message: "Copilot proxy is disabled.",
          type: "invalid_request_error",
        },
      });
    } finally {
      await app.close();
    }
  });

  it("/api/channels returns 403 when gateway auth is not configured", async () => {
    const app = createApp({
      config: makeConfig({
        // No gatewayAuthToken
        copilotProxy: {
          enabled: true,
          requireTokenAuth: true,
          tokenTtlSeconds: 60,
          heartbeatIntervalMs: 30000,
          heartbeatTimeoutMs: 10000,
          maxInflightPerConnection: 4,
          allowedPrefixes: ["copilot-", "alazyer-"],
        },
      }),
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/channels",
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: {
          message: "Gateway auth must be enabled to access channel information.",
          type: "authentication_error",
        },
      });
    } finally {
      await app.close();
    }
  });

  it("/api/channels returns 401 when auth is enabled but token is missing", async () => {
    const app = createApp({
      config: makeConfig({
        gatewayAuthToken: "gateway-token",
        copilotProxy: {
          enabled: true,
          requireTokenAuth: true,
          tokenTtlSeconds: 60,
          heartbeatIntervalMs: 30000,
          heartbeatTimeoutMs: 10000,
          maxInflightPerConnection: 4,
          allowedPrefixes: ["copilot-", "alazyer-"],
        },
      }),
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/channels",
      });

      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("/api/channels returns 401 when auth token is invalid", async () => {
    const app = createApp({
      config: makeConfig({
        gatewayAuthToken: "gateway-token",
        copilotProxy: {
          enabled: true,
          requireTokenAuth: true,
          tokenTtlSeconds: 60,
          heartbeatIntervalMs: 30000,
          heartbeatTimeoutMs: 10000,
          maxInflightPerConnection: 4,
          allowedPrefixes: ["copilot-", "alazyer-"],
        },
      }),
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/channels",
        headers: { "x-api-key": "wrong-token" },
      });

      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // Additional coverage: multiple prefixes in /api/channels with active WS
  // -------------------------------------------------------------------------

  it("/api/channels counts extensions per prefix correctly with three channels", async () => {
    const app = createApp({
      config: makeConfig({
        gatewayAuthToken: "gateway-token",
        copilotProxy: {
          enabled: true,
          requireTokenAuth: true,
          tokenTtlSeconds: 60,
          heartbeatIntervalMs: 30000,
          heartbeatTimeoutMs: 10000,
          maxInflightPerConnection: 4,
          allowedPrefixes: ["copilot-", "alazyer-", "team-b-"],
        },
      }),
    });

    try {
      await app.ready();
      const token = await issueProxyToken(app);

      // Register one copilot- and one team-b- model
      const wsA = await app.injectWS(
        `/ws/copilot-proxy?token=${encodeURIComponent(token)}`,
      );
      wsA.send(
        JSON.stringify({
          type: "register",
          extension_version: "0.1.0",
          copilot_status: "connected",
          models: [copilotModel],
        }),
      );
      await waitForModel(app, "copilot-gpt-4o", true);

      const wsB = await app.injectWS(
        `/ws/copilot-proxy?token=${encodeURIComponent(token)}`,
      );
      wsB.send(
        JSON.stringify({
          type: "register",
          extension_version: "0.1.0",
          copilot_status: "connected",
          models: [teamBModel],
        }),
      );
      await waitForModel(app, "team-b-gpt-4o", true);

      const channelsResponse = await app.inject({
        method: "GET",
        url: "/api/channels",
        headers: { "x-api-key": "gateway-token" },
      });
      expect(channelsResponse.statusCode).toBe(200);
      expect(channelsResponse.json()).toEqual([
        { prefix: "alazyer-", connectionCount: 0, modelIds: [] },
        { prefix: "copilot-", connectionCount: 1, modelIds: ["copilot-gpt-4o"] },
        { prefix: "team-b-", connectionCount: 1, modelIds: ["team-b-gpt-4o"] },
      ]);

      wsA.close();
      wsB.close();
    } finally {
      await app.close();
    }
  });

  // -------------------------------------------------------------------------
  // Additional coverage: disallowed prefix with multiple allowed prefixes
  // -------------------------------------------------------------------------

  it("extension with prefix not in the allowlist is rejected even when other prefixes are allowed", async () => {
    const app = createApp({
      config: makeConfig({
        gatewayAuthToken: "gateway-token",
        copilotProxy: {
          enabled: true,
          requireTokenAuth: true,
          tokenTtlSeconds: 60,
          heartbeatIntervalMs: 30000,
          heartbeatTimeoutMs: 10000,
          maxInflightPerConnection: 4,
          allowedPrefixes: ["copilot-", "alazyer-"],
        },
      }),
    });

    try {
      await app.ready();
      const token = await issueProxyToken(app);
      const ws = await app.injectWS(
        `/ws/copilot-proxy?token=${encodeURIComponent(token)}`,
      );

      // team-b- is not in the allowedPrefixes list
      ws.send(
        JSON.stringify({
          type: "register",
          extension_version: "0.1.0",
          copilot_status: "connected",
          models: [teamBModel],
        }),
      );

      const closeCode = await waitForClose(ws);
      expect(closeCode).toBe(1008);
    } finally {
      await app.close();
    }
  });
});
