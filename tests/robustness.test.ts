import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { loadConfig } from "../src/config.js";
import { closeDatabase } from "../src/db/index.js";

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
      unknownFieldMode: "warn",
      unknownFieldWindowRequests: 100,
      status: "active",
      statusReason: "Loaded from config",
      statusChangedAt: 1_718_000_000,
    },
  ],
};

function createSseStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
}

function getRequestHeader(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (!headers) {
    return undefined;
  }

  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }

  if (Array.isArray(headers)) {
    const found = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return found?.[1];
  }

  const record = headers as Record<string, string | undefined>;
  return record[name] ?? record[name.toLowerCase()];
}

// ──────────────────────────────────────────────
// Task Group 2: Upstream Resilience (Timeouts + Retries)
// ──────────────────────────────────────────────

beforeEach(() => {
  closeDatabase();
});

afterEach(() => {
  closeDatabase();
});

describe("Upstream resilience", () => {
  describe("timeout config", () => {
    it("loads request_timeout_ms from YAML with default of 30000", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "llm-gateway-resilience-"));
      const dbPath = join(tempDir, "gateway.db");
      const configPath = join(tempDir, "gateway.config.yaml");

      writeFileSync(
        configPath,
        `models:
  - name: glm-5.1
    base_url: https://provider.example/v1
    api_key_env: GLM_API_KEY
`,
        "utf8",
      );

      try {
        const config = loadConfig({
          HOST: "127.0.0.1",
          PORT: "4000",
          GATEWAY_CONFIG_PATH: configPath,
          GATEWAY_DB_PATH: dbPath,
          GLM_API_KEY: "api-key",
        });

        expect(config.requestTimeoutMs).toBe(30000);
        expect(config.maxRetries).toBe(0);
        expect(config.maxBodySizeKb).toBe(1024);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("loads custom request_timeout_ms and max_retries from YAML", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "llm-gateway-resilience-"));
      const dbPath = join(tempDir, "gateway.db");
      const configPath = join(tempDir, "gateway.config.yaml");

      writeFileSync(
        configPath,
        `request_timeout_ms: 60000
max_retries: 2
max_body_size_kb: 2048
models:
  - name: glm-5.1
    base_url: https://provider.example/v1
    api_key_env: GLM_API_KEY
`,
        "utf8",
      );

      try {
        const config = loadConfig({
          HOST: "127.0.0.1",
          PORT: "4000",
          GATEWAY_CONFIG_PATH: configPath,
          GATEWAY_DB_PATH: dbPath,
          GLM_API_KEY: "api-key",
        });

        expect(config.requestTimeoutMs).toBe(60000);
        expect(config.maxRetries).toBe(2);
        expect(config.maxBodySizeKb).toBe(2048);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe("retry on transient errors", () => {
    it("retries on 429 and succeeds on second attempt", async () => {
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(async () =>
          new Response(JSON.stringify({ error: "rate limited" }), {
            status: 429,
            statusText: "Too Many Requests",
            headers: { "content-type": "application/json" },
          }),
        )
        .mockImplementationOnce(async () =>
          new Response(
            JSON.stringify({
              id: "chatcmpl_retry",
              object: "chat.completion",
              created: 1_718_000_000,
              model: "glm-5.1",
              choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "retry success" } }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );

      const retryConfig: AppConfig = { ...baseConfig, maxRetries: 1 };
      const app = createApp({ config: retryConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          payload: {
            model: "glm-5.1",
            messages: [{ role: "user", content: "Hello" }],
          },
        });

        expect(response.statusCode).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(response.json().choices[0].message.content).toBe("retry success");
      } finally {
        await app.close();
      }
    });

    it("retries on 502 and succeeds on second attempt", async () => {
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(async () =>
          new Response(JSON.stringify({ error: "bad gateway" }), {
            status: 502,
            statusText: "Bad Gateway",
            headers: { "content-type": "application/json" },
          }),
        )
        .mockImplementationOnce(async () =>
          new Response(
            JSON.stringify({
              id: "chatcmpl_502_retry",
              object: "chat.completion",
              created: 1_718_000_000,
              model: "glm-5.1",
              choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "success after 502" } }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );

      const retryConfig: AppConfig = { ...baseConfig, maxRetries: 1 };
      const app = createApp({ config: retryConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          payload: {
            model: "glm-5.1",
            messages: [{ role: "user", content: "Hello" }],
          },
        });

        expect(response.statusCode).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        await app.close();
      }
    });

    it("retries on 503 and succeeds on second attempt", async () => {
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(async () =>
          new Response(JSON.stringify({ error: "service unavailable" }), {
            status: 503,
            statusText: "Service Unavailable",
            headers: { "content-type": "application/json" },
          }),
        )
        .mockImplementationOnce(async () =>
          new Response(
            JSON.stringify({
              id: "chatcmpl_503_retry",
              object: "chat.completion",
              created: 1_718_000_000,
              model: "glm-5.1",
              choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "success after 503" } }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );

      const retryConfig: AppConfig = { ...baseConfig, maxRetries: 1 };
      const app = createApp({ config: retryConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          payload: {
            model: "glm-5.1",
            messages: [{ role: "user", content: "Hello" }],
          },
        });

        expect(response.statusCode).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        await app.close();
      }
    });

    it("returns the last upstream error when all retries are exhausted", async () => {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "content-type": "application/json" },
        }),
      );

      const retryConfig: AppConfig = { ...baseConfig, maxRetries: 2 };
      const app = createApp({ config: retryConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          payload: {
            model: "glm-5.1",
            messages: [{ role: "user", content: "Hello" }],
          },
        });

        expect(response.statusCode).toBe(429);
        expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
      } finally {
        await app.close();
      }
    });

    it("does not retry on non-transient errors like 401", async () => {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ error: "invalid_api_key" }), {
          status: 401,
          statusText: "Unauthorized",
          headers: { "content-type": "application/json" },
        }),
      );

      const retryConfig: AppConfig = { ...baseConfig, maxRetries: 2 };
      const app = createApp({ config: retryConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          payload: {
            model: "glm-5.1",
            messages: [{ role: "user", content: "Hello" }],
          },
        });

        expect(response.statusCode).toBe(401);
        expect(fetchMock).toHaveBeenCalledTimes(1); // no retries for 401
      } finally {
        await app.close();
      }
    });

    it("does not retry when max_retries is 0", async () => {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "content-type": "application/json" },
        }),
      );

      const noRetryConfig: AppConfig = { ...baseConfig, maxRetries: 0 };
      const app = createApp({ config: noRetryConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          payload: {
            model: "glm-5.1",
            messages: [{ role: "user", content: "Hello" }],
          },
        });

        expect(response.statusCode).toBe(429);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        await app.close();
      }
    });
  });
});

// ──────────────────────────────────────────────
// Task Group 4: Request Guardrails (Body Size + Counter Bounds)
// ──────────────────────────────────────────────

describe("Request guardrails", () => {
  describe("body size limit", () => {
    it("loads max_body_size_kb from YAML with default of 1024", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "llm-gateway-guardrails-"));
      const dbPath = join(tempDir, "gateway.db");
      const configPath = join(tempDir, "gateway.config.yaml");

      writeFileSync(
        configPath,
        `models:
  - name: glm-5.1
    base_url: https://provider.example/v1
    api_key_env: GLM_API_KEY
`,
        "utf8",
      );

      try {
        const config = loadConfig({
          HOST: "127.0.0.1",
          PORT: "4000",
          GATEWAY_CONFIG_PATH: configPath,
          GATEWAY_DB_PATH: dbPath,
          GLM_API_KEY: "api-key",
        });

        expect(config.maxBodySizeKb).toBe(1024);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("loads custom max_body_size_kb from YAML", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "llm-gateway-guardrails-"));
      const dbPath = join(tempDir, "gateway.db");
      const configPath = join(tempDir, "gateway.config.yaml");

      writeFileSync(
        configPath,
        `max_body_size_kb: 512
models:
  - name: glm-5.1
    base_url: https://provider.example/v1
    api_key_env: GLM_API_KEY
`,
        "utf8",
      );

      try {
        const config = loadConfig({
          HOST: "127.0.0.1",
          PORT: "4000",
          GATEWAY_CONFIG_PATH: configPath,
          GATEWAY_DB_PATH: dbPath,
          GLM_API_KEY: "api-key",
        });

        expect(config.maxBodySizeKb).toBe(512);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("rejects requests exceeding the body size limit", async () => {
      const smallLimitConfig: AppConfig = { ...baseConfig, maxBodySizeKb: 1 }; // 1KB limit
      const fetchMock = vi.fn();
      const app = createApp({ config: smallLimitConfig, fetchFn: fetchMock as typeof fetch });

      try {
        // Create a body larger than 1KB
        const largeBody = "x".repeat(2048);
        const response = await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          payload: {
            model: "glm-5.1",
            messages: [{ role: "user", content: largeBody }],
          },
        });

        expect(response.statusCode).toBe(413);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });

    it("accepts requests within the body size limit", async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl_ok",
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
          url: "/v1/chat/completions",
          payload: {
            model: "glm-5.1",
            messages: [{ role: "user", content: "Hello" }],
          },
        });

        expect(response.statusCode).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        await app.close();
      }
    });
  });

  describe("unknown-field counter window reset", () => {
    it("loads unknown_field_window_requests from YAML with default of 100", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "llm-gateway-counter-"));
      const dbPath = join(tempDir, "gateway.db");
      const configPath = join(tempDir, "gateway.config.yaml");

      writeFileSync(
        configPath,
        `models:
  - name: glm-5.1
    base_url: https://provider.example/v1
    api_key_env: GLM_API_KEY
`,
        "utf8",
      );

      try {
        const config = loadConfig({
          HOST: "127.0.0.1",
          PORT: "4000",
          GATEWAY_CONFIG_PATH: configPath,
          GATEWAY_DB_PATH: dbPath,
          GLM_API_KEY: "api-key",
        });

        expect(config.models[0].unknownFieldWindowRequests).toBe(100);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("loads custom unknown_field_window_requests from YAML", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "llm-gateway-counter-"));
      const dbPath = join(tempDir, "gateway.db");
      const configPath = join(tempDir, "gateway.config.yaml");

      writeFileSync(
        configPath,
        `models:
  - name: glm-5.1
    base_url: https://provider.example/v1
    api_key_env: GLM_API_KEY
    unknown_field_window_requests: 50
`,
        "utf8",
      );

      try {
        const config = loadConfig({
          HOST: "127.0.0.1",
          PORT: "4000",
          GATEWAY_CONFIG_PATH: configPath,
          GATEWAY_DB_PATH: dbPath,
          GLM_API_KEY: "api-key",
        });

        expect(config.models[0].unknownFieldWindowRequests).toBe(50);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});

// ──────────────────────────────────────────────
// Task Group 5: Request Tracing (ID Propagation + Latency)
// ──────────────────────────────────────────────

describe("Request tracing", () => {
  describe("X-Request-ID header propagation", () => {
    it("propagates the Fastify request ID as X-Request-ID header on upstream calls", async () => {
      const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        expect(getRequestHeader(init, "x-request-id")).toBeDefined();

        return new Response(
          JSON.stringify({
            id: "chatcmpl_trace",
            object: "chat.completion",
            created: 1_718_000_000,
            model: "glm-5.1",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "traced" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });

      const app = createApp({ config: baseConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          payload: {
            model: "glm-5.1",
            messages: [{ role: "user", content: "Hello" }],
          },
        });

        expect(response.statusCode).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // The X-Request-ID header should have been sent upstream
        const requestId = getRequestHeader(fetchMock.mock.calls[0][1], "x-request-id");
        expect(requestId).toBeDefined();
        expect(typeof requestId).toBe("string");
        expect(requestId!.length).toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    });

    it("propagates X-Request-ID header on streaming /v1/chat/completions requests", async () => {
      const fetchMock = vi.fn(async () => {
        const body = createSseStream([
          'data: {"id":"chatcmpl_stream_trace","object":"chat.completion.chunk","created":1718000000,"model":"glm-5.1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}\n\n',
          "data: [DONE]\n\n",
        ]);

        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      });

      const app = createApp({ config: baseConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/chat/completions",
          payload: {
            model: "glm-5.1",
            messages: [{ role: "user", content: "Hello" }],
            stream: true,
          },
        });

        expect(response.statusCode).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const requestId = getRequestHeader(fetchMock.mock.calls[0][1], "x-request-id");
        expect(requestId).toBeDefined();
      } finally {
        await app.close();
      }
    });

    it("propagates X-Request-ID header on /v1/responses requests", async () => {
      const fetchMock = vi.fn(async () =>
        new Response(
          JSON.stringify({
            id: "chatcmpl_responses_trace",
            object: "chat.completion",
            created: 1_718_000_000,
            model: "glm-5.1",
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "traced responses" } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

      const app = createApp({ config: baseConfig, fetchFn: fetchMock as typeof fetch });

      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/responses",
          payload: {
            input: "Hello",
          },
        });

        expect(response.statusCode).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const requestId = getRequestHeader(fetchMock.mock.calls[0][1], "x-request-id");
        expect(requestId).toBeDefined();
      } finally {
        await app.close();
      }
    });
  });
});
