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
};

describe("Enhanced health check", () => {
  describe("healthy config returns model count", () => {
    it("returns {ok: true, models: count} when models are configured", async () => {
      const app = createApp({ config: baseConfig });

      try {
        const response = await app.inject({
          method: "GET",
          url: "/healthz",
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true, models: 1 });
      } finally {
        await app.close();
      }
    });

    it("returns model count for multi-model config", async () => {
      const multiConfig: AppConfig = {
        ...baseConfig,
        models: [
          ...baseConfig.models,
          {
            name: "coder-alias",
            upstreamModel: "provider-internal-coder",
            baseUrl: "https://provider-b.example/v1",
            apiKey: "api-key-b",
            apiKeyEnv: "CODER_API_KEY",
            ownedBy: "custom-provider",
            created: 1_718_000_001,
            supportsTools: true,
            supportsStreaming: true,
            unknownFieldMode: "warn",
            unknownFieldWindowRequests: 100,
            status: "active",
            statusReason: "Loaded from config",
            statusChangedAt: 1_718_000_001,
          },
        ],
      };

      const app = createApp({ config: multiConfig });

      try {
        const response = await app.inject({
          method: "GET",
          url: "/healthz",
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true, models: 2 });
      } finally {
        await app.close();
      }
    });
  });

  describe("zero models returns 503", () => {
    it("returns {ok: false, error} with 503 when no models are configured", async () => {
      const emptyConfig: AppConfig = {
        ...baseConfig,
        models: [],
      };

      const app = createApp({ config: emptyConfig });

      try {
        const response = await app.inject({
          method: "GET",
          url: "/healthz",
        });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({
          ok: false,
          error: "No models configured.",
        });
      } finally {
        await app.close();
      }
    });
  });

  describe("health probe enabled", () => {
    it("returns {ok: true, models, upstream: reachable} when probe succeeds", async () => {
      const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
        const url = input.toString();
        if (url.endsWith("/models")) {
          return new Response(
            JSON.stringify({ object: "list", data: [] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }

        return new Response(
          JSON.stringify({
            id: "chatcmpl_probe_ok",
            object: "chat.completion",
            created: 1_718_000_000,
            model: "glm-5.1",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const probeConfig: AppConfig = {
        ...baseConfig,
        healthProbeEnabled: true,
      };

      const app = createApp({ config: probeConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "GET",
          url: "/healthz",
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          ok: true,
          models: 1,
          upstream: "reachable",
        });
      } finally {
        await app.close();
      }
    });

    it("returns {ok: false, error, upstream: unreachable} with 503 when probe fails", async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({ error: "unavailable" }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
      );

      const probeConfig: AppConfig = {
        ...baseConfig,
        healthProbeEnabled: true,
      };

      const app = createApp({ config: probeConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "GET",
          url: "/healthz",
        });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({
          ok: false,
          error: "Upstream unreachable.",
          upstream: "unreachable",
        });
      } finally {
        await app.close();
      }
    });

    it("returns 503 when probe throws a network error", async () => {
      const fetchMock = vi.fn(async () => {
        throw new Error("Network error");
      });

      const probeConfig: AppConfig = {
        ...baseConfig,
        healthProbeEnabled: true,
      };

      const app = createApp({ config: probeConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "GET",
          url: "/healthz",
        });

        expect(response.statusCode).toBe(503);
        expect(response.json()).toEqual({
          ok: false,
          error: "Upstream unreachable.",
          upstream: "unreachable",
        });
      } finally {
        await app.close();
      }
    });

    it("does not probe upstream when health_probe_enabled is false (default)", async () => {
      const fetchMock = vi.fn();

      const app = createApp({ config: baseConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "GET",
          url: "/healthz",
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ ok: true, models: 1 });
        // fetch should NOT have been called for probe
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });
  });
});
