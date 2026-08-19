import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const baseConfig: AppConfig = {
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
  copilotProxy: {
    enabled: true,
    requireTokenAuth: true,
    tokenTtlSeconds: 60,
    heartbeatIntervalMs: 30000,
    heartbeatTimeoutMs: 10000,
    maxInflightPerConnection: 4,
    allowedPrefixes: ["copilot-"],
  },
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
inputModalities: ["text"],
outputModalities: ["text"],
      unknownFieldMode: "warn",
      unknownFieldWindowRequests: 100,
      status: "active",
      statusReason: "Loaded from config",
      statusChangedAt: 1_718_000_000,
    },
  ],
};

describe("GET /api/channels", () => {
  it("returns 403 when Copilot proxy is disabled", async () => {
    const app = createApp({
      config: {
        ...baseConfig,
        gatewayAuthToken: "gateway-token",
        copilotProxy: {
          ...baseConfig.copilotProxy!,
          enabled: false,
        },
      },
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/channels",
        headers: {
          "x-api-key": "gateway-token",
        },
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

  it("returns 403 when gateway auth is not configured", async () => {
    const app = createApp({ config: baseConfig });

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

  it("returns 401 when gateway auth is enabled but token is missing", async () => {
    const app = createApp({
      config: {
        ...baseConfig,
        gatewayAuthToken: "gateway-token",
      },
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

  it("returns 401 when gateway auth token is invalid", async () => {
    const app = createApp({
      config: {
        ...baseConfig,
        gatewayAuthToken: "gateway-token",
      },
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/channels",
        headers: {
          "x-api-key": "wrong-token",
        },
      });

      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("returns channels list when authenticated and proxy is enabled", async () => {
    const app = createApp({
      config: {
        ...baseConfig,
        gatewayAuthToken: "gateway-token",
      },
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/channels",
        headers: {
          "x-api-key": "gateway-token",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        { prefix: "copilot-", connectionCount: 0, modelIds: [] },
      ]);
    } finally {
      await app.close();
    }
  });

  it("returns channels with custom allowed prefixes", async () => {
    const app = createApp({
      config: {
        ...baseConfig,
        gatewayAuthToken: "gateway-token",
        copilotProxy: {
          ...baseConfig.copilotProxy!,
          allowedPrefixes: ["copilot-", "alazyer-"],
        },
      },
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/channels",
        headers: {
          "x-api-key": "gateway-token",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        { prefix: "alazyer-", connectionCount: 0, modelIds: [] },
        { prefix: "copilot-", connectionCount: 0, modelIds: [] },
      ]);
    } finally {
      await app.close();
    }
  });
});
