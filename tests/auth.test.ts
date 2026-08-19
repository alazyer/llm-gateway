import { describe, expect, it, vi } from "vitest";

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

describe("Incoming auth", () => {
  describe("auth disabled (no gatewayAuthToken)", () => {
    it("allows requests without auth headers when auth is not configured", async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl_noauth",
            object: "chat.completion",
            created: 1_718_000_000,
            model: "glm-5.1",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      const app = createApp({ config: baseConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/responses",
          payload: { input: "Hello" },
        });

        expect(response.statusCode).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        await app.close();
      }
    });
  });

  describe("auth enabled (gatewayAuthToken configured)", () => {
    const authConfig: AppConfig = {
      ...baseConfig,
      gatewayAuthToken: "test-gateway-token",
    };

    it("accepts valid x-api-key header", async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl_auth_ok",
            object: "chat.completion",
            created: 1_718_000_000,
            model: "glm-5.1",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      const app = createApp({ config: authConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/responses",
          payload: { input: "Hello" },
          headers: { "x-api-key": "test-gateway-token" },
        });

        expect(response.statusCode).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        await app.close();
      }
    });

    it("accepts valid Authorization: Bearer header", async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl_bearer_ok",
            object: "chat.completion",
            created: 1_718_000_000,
            model: "glm-5.1",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      const app = createApp({ config: authConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/responses",
          payload: { input: "Hello" },
          headers: { "authorization": "Bearer test-gateway-token" },
        });

        expect(response.statusCode).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        await app.close();
      }
    });

    it("rejects invalid token with 401", async () => {
      const fetchMock = vi.fn();
      const app = createApp({ config: authConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/responses",
          payload: { input: "Hello" },
          headers: { "x-api-key": "wrong-token" },
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({
          error: {
            message: "Invalid or missing authentication token.",
            type: "authentication_error",
          },
        });
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });

    it("rejects missing token with 401", async () => {
      const fetchMock = vi.fn();
      const app = createApp({ config: authConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/responses",
          payload: { input: "Hello" },
        });

        expect(response.statusCode).toBe(401);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });

    it("returns Anthropic-style 401 for /v1/messages", async () => {
      const fetchMock = vi.fn();
      const app = createApp({ config: authConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/messages",
          payload: { model: "glm-5.1", messages: [{ role: "user", content: "Hi" }], max_tokens: 100 },
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({
          type: "error",
          error: {
            type: "authentication_error",
            message: "Invalid or missing authentication token.",
          },
        });
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });

    it("returns Anthropic-style 401 for /v1/messages/count_tokens", async () => {
      const fetchMock = vi.fn();
      const app = createApp({ config: authConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/messages/count_tokens",
          payload: { model: "glm-5.1", messages: [{ role: "user", content: "Hi" }], max_tokens: 100 },
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({
          type: "error",
          error: {
            type: "authentication_error",
            message: "Invalid or missing authentication token.",
          },
        });
      } finally {
        await app.close();
      }
    });

    it("returns OpenAI-style 401 for /v1/chat/completions", async () => {
      const fetchMock = vi.fn();
      const app = createApp({ config: authConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          payload: { model: "glm-5.1", messages: [{ role: "user", content: "Hi" }] },
        });

        expect(response.statusCode).toBe(401);
        expect(response.json()).toEqual({
          error: {
            message: "Invalid or missing authentication token.",
            type: "authentication_error",
          },
        });
      } finally {
        await app.close();
      }
    });
  });

  describe("auth endpoint coverage", () => {
    const authConfig: AppConfig = {
      ...baseConfig,
      gatewayAuthToken: "test-gateway-token",
    };

    it("skips auth for GET /healthz", async () => {
      const app = createApp({ config: authConfig });

      try {
        const response = await app.inject({
          method: "GET",
          url: "/healthz",
        });

        expect(response.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it("skips auth for GET /v1/models", async () => {
      const app = createApp({ config: authConfig });

      try {
        const response = await app.inject({
          method: "GET",
          url: "/v1/models",
        });

        expect(response.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it("skips auth for GET /models", async () => {
      const app = createApp({ config: authConfig });

      try {
        const response = await app.inject({
          method: "GET",
          url: "/models",
        });

        expect(response.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it("skips auth for GET /models/:model", async () => {
      const app = createApp({ config: authConfig });

      try {
        const response = await app.inject({
          method: "GET",
          url: "/models/glm-5.1",
        });

        expect(response.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it("skips auth for GET /v1/models/:model", async () => {
      const app = createApp({ config: authConfig });

      try {
        const response = await app.inject({
          method: "GET",
          url: "/v1/models/glm-5.1",
        });

        expect(response.statusCode).toBe(200);
      } finally {
        await app.close();
      }
    });

    it("requires auth for POST /v1/responses", async () => {
      const fetchMock = vi.fn();
      const app = createApp({ config: authConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/responses",
          payload: { input: "Hello" },
        });

        expect(response.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it("requires auth for POST /responses", async () => {
      const fetchMock = vi.fn();
      const app = createApp({ config: authConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/responses",
          payload: { input: "Hello" },
        });

        expect(response.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it("requires auth for POST /v1/chat/completions", async () => {
      const fetchMock = vi.fn();
      const app = createApp({ config: authConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          payload: { messages: [{ role: "user", content: "Hi" }] },
        });

        expect(response.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it("requires auth for POST /v1/messages", async () => {
      const fetchMock = vi.fn();
      const app = createApp({ config: authConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/messages",
          payload: { model: "glm-5.1", messages: [{ role: "user", content: "Hi" }], max_tokens: 100 },
        });

        expect(response.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });

    it("requires auth for POST /v1/messages/count_tokens", async () => {
      const fetchMock = vi.fn();
      const app = createApp({ config: authConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/messages/count_tokens",
          payload: { model: "glm-5.1", messages: [{ role: "user", content: "Hi" }], max_tokens: 100 },
        });

        expect(response.statusCode).toBe(401);
      } finally {
        await app.close();
      }
    });
  });
});
