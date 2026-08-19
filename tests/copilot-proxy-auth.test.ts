import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import {
  CopilotProxyTokenStore,
  extractProxyTokenFromUrl,
} from "../src/copilot-proxy/auth.js";

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
  },
  models: [
    {
      name: "glm-5.1",
      upstreamModel: "glm-5.1",
      baseUrl: "https://provider.example/v1",
      apiKey: "secret-key",
      ownedBy: "zhipu",
      created: 1_718_000_000,
      supportsTools: true,
supportsStreaming: true,
inputModalities: ["text"],
outputModalities: ["text"],
      unknownFieldMode: "warn",
      unknownFieldWindowRequests: 100,
    },
  ],
};

describe("Copilot proxy auth", () => {
  it("issues a scoped proxy token when gateway auth succeeds", async () => {
    const app = createApp({
      config: {
        ...baseConfig,
        gatewayAuthToken: "gateway-token",
      },
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/proxy-token",
        headers: {
          "x-api-key": "gateway-token",
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json() as {
        token: string;
        token_type: string;
        expires_at: string;
      };
      expect(body.token).toMatch(/^cpx_/);
      expect(body.token_type).toBe("copilot_proxy");
      expect(Date.parse(body.expires_at)).toBeGreaterThan(Date.now());
    } finally {
      await app.close();
    }
  });

  it("rejects proxy token issuance without valid gateway auth", async () => {
    const app = createApp({
      config: {
        ...baseConfig,
        gatewayAuthToken: "gateway-token",
      },
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/proxy-token",
      });

      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("rejects proxy token issuance when gateway auth is disabled", async () => {
    const app = createApp({ config: baseConfig });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/proxy-token",
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: {
          message: "Gateway auth must be enabled to issue Copilot proxy tokens.",
          type: "authentication_error",
        },
      });
    } finally {
      await app.close();
    }
  });

  it("rejects proxy token issuance when Copilot proxy is disabled", async () => {
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
        method: "POST",
        url: "/api/proxy-token",
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

  it("does not grant HTTP data endpoint access with a scoped proxy token", async () => {
    const fetchMock = vi.fn();
    const app = createApp({
      config: {
        ...baseConfig,
        gatewayAuthToken: "gateway-token",
      },
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const tokenResponse = await app.inject({
        method: "POST",
        url: "/api/proxy-token",
        headers: {
          "x-api-key": "gateway-token",
        },
      });
      const body = tokenResponse.json() as { token: string };

      const dataResponse = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "x-api-key": body.token,
        },
        payload: {
          model: "glm-5.1",
          messages: [{ role: "user", content: "Hi" }],
        },
      });

      expect(dataResponse.statusCode).toBe(401);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("validates issued tokens until expiry and rejects unknown tokens", () => {
    const store = new CopilotProxyTokenStore({ tokenTtlSeconds: 1 });
    const issuedAt = new Date("2026-06-26T00:00:00.000Z");

    const issued = store.issueToken(issuedAt);

    expect(store.validateToken(issued.token, issuedAt)).toBe(true);
    expect(store.validateToken("cpx_unknown", issuedAt)).toBe(false);
    expect(
      store.validateToken(issued.token, new Date("2026-06-26T00:00:01.001Z")),
    ).toBe(false);
  });

  it("extracts proxy tokens from WebSocket URLs", () => {
    expect(extractProxyTokenFromUrl("/ws/copilot-proxy?token=cpx_abc")).toBe(
      "cpx_abc",
    );
    expect(extractProxyTokenFromUrl("/ws/copilot-proxy")).toBeUndefined();
    expect(extractProxyTokenFromUrl("/ws/copilot-proxy?token=")).toBeUndefined();
  });
});
