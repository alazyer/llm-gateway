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

describe("CORS support", () => {
  describe("CORS not configured", () => {
    it("does not add CORS headers when cors_origin is not set", async () => {
      const app = createApp({ config: baseConfig });

      try {
        const response = await app.inject({
          method: "GET",
          url: "/healthz",
          headers: { origin: "http://localhost:5173" },
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      } finally {
        await app.close();
      }
    });
  });

  describe("CORS configured — single origin", () => {
    const corsConfig: AppConfig = {
      ...baseConfig,
      corsOrigin: "http://localhost:5173",
    };

    it("adds CORS headers for matching origin", async () => {
      const app = createApp({ config: corsConfig });

      try {
        const response = await app.inject({
          method: "GET",
          url: "/healthz",
          headers: { origin: "http://localhost:5173" },
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
        expect(response.headers["access-control-allow-methods"]).toBe("GET, POST, PUT, DELETE, PATCH, OPTIONS");
        expect(response.headers["access-control-allow-headers"]).toContain("Content-Type");
        expect(response.headers["access-control-max-age"]).toBe("86400");
      } finally {
        await app.close();
      }
    });

    it("does not add CORS headers for non-matching origin", async () => {
      const app = createApp({ config: corsConfig });

      try {
        const response = await app.inject({
          method: "GET",
          url: "/healthz",
          headers: { origin: "http://evil.example.com" },
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      } finally {
        await app.close();
      }
    });

    it("does not add CORS headers for requests without Origin", async () => {
      const app = createApp({ config: corsConfig });

      try {
        const response = await app.inject({
          method: "GET",
          url: "/healthz",
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      } finally {
        await app.close();
      }
    });

    it("handles preflight OPTIONS request with 204", async () => {
      const app = createApp({ config: corsConfig });

      try {
        const response = await app.inject({
          method: "OPTIONS",
          url: "/v1/responses",
          headers: {
            origin: "http://localhost:5173",
            "access-control-request-method": "POST",
          },
        });

        expect(response.statusCode).toBe(204);
        expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
        expect(response.headers["access-control-allow-methods"]).toBe("GET, POST, PUT, DELETE, PATCH, OPTIONS");
      } finally {
        await app.close();
      }
    });
  });

  describe("CORS configured — wildcard origin", () => {
    const wildcardConfig: AppConfig = {
      ...baseConfig,
      corsOrigin: "*",
    };

    it("returns Access-Control-Allow-Origin: * for any origin", async () => {
      const app = createApp({ config: wildcardConfig });

      try {
        const response = await app.inject({
          method: "GET",
          url: "/healthz",
          headers: { origin: "http://any-site.example.com" },
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers["access-control-allow-origin"]).toBe("*");
      } finally {
        await app.close();
      }
    });
  });

  describe("CORS configured — multiple origins", () => {
    const multiOriginConfig: AppConfig = {
      ...baseConfig,
      corsOrigin: ["http://localhost:5173", "https://admin.example.com"],
    };

    it("adds CORS headers for first matching origin", async () => {
      const app = createApp({ config: multiOriginConfig });

      try {
        const response = await app.inject({
          method: "GET",
          url: "/healthz",
          headers: { origin: "http://localhost:5173" },
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
      } finally {
        await app.close();
      }
    });

    it("adds CORS headers for second matching origin", async () => {
      const app = createApp({ config: multiOriginConfig });

      try {
        const response = await app.inject({
          method: "GET",
          url: "/healthz",
          headers: { origin: "https://admin.example.com" },
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers["access-control-allow-origin"]).toBe("https://admin.example.com");
      } finally {
        await app.close();
      }
    });

    it("does not add CORS headers for non-matching origin", async () => {
      const app = createApp({ config: multiOriginConfig });

      try {
        const response = await app.inject({
          method: "GET",
          url: "/healthz",
          headers: { origin: "http://evil.example.com" },
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      } finally {
        await app.close();
      }
    });

    it("handles preflight OPTIONS for matching origin", async () => {
      const app = createApp({ config: multiOriginConfig });

      try {
        const response = await app.inject({
          method: "OPTIONS",
          url: "/v1/chat/completions",
          headers: {
            origin: "https://admin.example.com",
            "access-control-request-method": "POST",
          },
        });

        expect(response.statusCode).toBe(204);
        expect(response.headers["access-control-allow-origin"]).toBe("https://admin.example.com");
      } finally {
        await app.close();
      }
    });
  });

  describe("CORS + auth interaction", () => {
    const corsAuthConfig: AppConfig = {
      ...baseConfig,
      corsOrigin: "http://localhost:5173",
      gatewayAuthToken: "test-gateway-token",
    };

    it("preflight OPTIONS is accessible without auth and returns CORS headers", async () => {
      const app = createApp({ config: corsAuthConfig });

      try {
        const response = await app.inject({
          method: "OPTIONS",
          url: "/v1/responses",
          headers: {
            origin: "http://localhost:5173",
            "access-control-request-method": "POST",
          },
        });

        expect(response.statusCode).toBe(204);
        expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
        expect(response.headers["access-control-allow-headers"]).toContain("Authorization");
      } finally {
        await app.close();
      }
    });

    it("allows the x-user-id header for Web AI Chat cross-origin preflight", async () => {
      const app = createApp({ config: corsAuthConfig });

      try {
        const response = await app.inject({
          method: "OPTIONS",
          url: "/api/ai-chat/messages",
          headers: {
            origin: "http://localhost:5173",
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type, authorization, x-user-id",
          },
        });

        expect(response.statusCode).toBe(204);
        expect(response.headers["access-control-allow-headers"]).toContain("x-user-id");
        expect(response.headers["access-control-allow-headers"]).toContain("Authorization");
        expect(response.headers["access-control-allow-headers"]).toContain("Content-Type");
      } finally {
        await app.close();
      }
    });

    it("CORS headers are added even on 401 auth rejection", async () => {
      const fetchMock = vi.fn();
      const app = createApp({ config: corsAuthConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/responses",
          payload: { input: "Hello" },
          headers: { origin: "http://localhost:5173" },
        });

        expect(response.statusCode).toBe(401);
        expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
      } finally {
        await app.close();
      }
    });
  });
});
