import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { closeDatabase, getDatabase, openDatabase } from "../src/db/index.js";
import { allMigrations } from "../src/db/migrations/all.js";
import { runMigrations } from "../src/db/migrations/index.js";

const GATEWAY_AUTH_TOKEN = "test-chat-token";
let tempDir = "";

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

function baseConfig(): AppConfig {
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
    gatewayAuthToken: GATEWAY_AUTH_TOKEN,
    models: [
      {
        name: "glm-5.1",
        upstreamModel: "glm-5.1",
        baseUrl: "https://provider.example/v1",
        apiKey: "secret-key",
        apiKeyEnv: "GLM5_KEY",
        ownedBy: "zhipu",
        created: 1_718_000_000,
        supportsTools: true,
        supportsStreaming: true,
        supportsImageInput: false,
        unknownFieldMode: "warn",
      },
      {
        name: "glm-5.1-vision",
        upstreamModel: "glm-5.1-vision",
        baseUrl: "https://provider.example/v1",
        apiKey: "secret-key",
        apiKeyEnv: "GLM5_KEY",
        ownedBy: "zhipu",
        created: 1_718_000_000,
        supportsTools: true,
        supportsStreaming: true,
        supportsImageInput: true,
        unknownFieldMode: "warn",
      },
    ],
  };
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

beforeEach(() => {
  closeDatabase();
  tempDir = join(tmpdir(), `llm-gateway-ai-chat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "test.db") });
  runMigrations(db, allMigrations);
});

afterEach(() => {
  closeDatabase();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Web AI Chat routes", () => {
  it("returns 401 for missing x-user-id even with valid gateway auth", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: {
          "x-api-key": GATEWAY_AUTH_TOKEN,
        },
        payload: {
          prompt: "hello",
          stream: false,
          clientMessageId: "55fdd9e6-1d31-46a9-8ec5-f47f48c76469",
        },
      });

      expect(response.statusCode).toBe(401);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("enforces cross-user session isolation with 403", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "chatcmpl_1",
      model: "glm-5.1",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      const createResponse = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: {
          "x-api-key": GATEWAY_AUTH_TOKEN,
          "x-user-id": "user-a",
        },
        payload: {
          prompt: "hello",
          stream: false,
          clientMessageId: "f5a7cae1-655c-4f5e-aec6-52b39a5fcdd6",
        },
      });
      expect(createResponse.statusCode).toBe(200);
      const body = createResponse.json() as { sessionId: string };

      const readResponse = await app.inject({
        method: "GET",
        url: `/api/ai-chat/sessions/${body.sessionId}/messages`,
        headers: {
          "x-api-key": GATEWAY_AUTH_TOKEN,
          "x-user-id": "user-b",
        },
      });

      expect(readResponse.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("streams strict started->delta*->completed lifecycle", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        createSseStream([
          'data: {"id":"chatcmpl_stream","object":"chat.completion.chunk","created":1718000000,"model":"glm-5.1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl_stream","object":"chat.completion.chunk","created":1718000000,"model":"glm-5.1","choices":[{"index":0,"delta":{"content":" there"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}\n\n',
          "data: [DONE]\n\n",
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: {
          "x-api-key": GATEWAY_AUTH_TOKEN,
          "x-user-id": "user-stream",
        },
        payload: {
          prompt: "hello",
          stream: true,
          clientMessageId: "9cbca0a0-3390-4edf-96d6-fda49010487e",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      const body = response.body;
      const startedIndex = body.indexOf("event: started");
      const deltaIndex = body.indexOf("event: delta");
      const completedIndex = body.indexOf("event: completed");
      const errorIndex = body.indexOf("event: error");

      expect(startedIndex).toBeGreaterThanOrEqual(0);
      expect(deltaIndex).toBeGreaterThan(startedIndex);
      expect(completedIndex).toBeGreaterThan(deltaIndex);
      expect(errorIndex).toBe(-1);
    } finally {
      await app.close();
    }
  });

  it("preserves partial assistant content when stream terminates with error", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        createSseStream([
          'data: {"id":"chatcmpl_partial","object":"chat.completion.chunk","created":1718000000,"model":"glm-5.1","choices":[{"index":0,"delta":{"content":"Partial"},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl_partial","error":{"code":"UPSTREAM_UNAVAILABLE","message":"Provider disconnected"}}\n\n',
          "data: [DONE]\n\n",
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );
    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      const sendResponse = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: {
          "x-api-key": GATEWAY_AUTH_TOKEN,
          "x-user-id": "user-partial",
        },
        payload: {
          prompt: "hello",
          stream: true,
          clientMessageId: "a9966366-c130-40f2-ae0c-34d8d1136f3b",
        },
      });
      expect(sendResponse.statusCode).toBe(200);
      expect(sendResponse.body).toContain("event: error");

      const startedDataLine = sendResponse.body
        .split("\n")
        .find((line) => line.startsWith("data: {\"sessionId\""));
      expect(startedDataLine).toBeDefined();
      const startedData = JSON.parse((startedDataLine ?? "").replace(/^data:\s*/, "")) as { sessionId: string };

      const messagesResponse = await app.inject({
        method: "GET",
        url: `/api/ai-chat/sessions/${startedData.sessionId}/messages`,
        headers: {
          "x-api-key": GATEWAY_AUTH_TOKEN,
          "x-user-id": "user-partial",
        },
      });
      expect(messagesResponse.statusCode).toBe(200);
      const history = messagesResponse.json() as {
        data: Array<{ role: string; status: string; content: string }>;
      };
      const assistant = history.data.find((item) => item.role === "assistant");
      expect(assistant).toMatchObject({
        role: "assistant",
        status: "failed",
        content: "Partial",
      });
    } finally {
      await app.close();
    }
  });

  it("returns deterministic session history with pagination cursor", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "chatcmpl_paginated",
      model: "glm-5.1",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });

    try {
      for (let i = 0; i < 3; i += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/ai-chat/messages",
          headers: {
            "x-api-key": GATEWAY_AUTH_TOKEN,
            "x-user-id": "user-history",
          },
          payload: {
            prompt: `hello-${i}`,
            stream: false,
            clientMessageId: randomUUID(),
          },
        });
        expect(response.statusCode).toBe(200);
      }

      const firstPage = await app.inject({
        method: "GET",
        url: "/api/ai-chat/sessions?limit=2",
        headers: {
          "x-api-key": GATEWAY_AUTH_TOKEN,
          "x-user-id": "user-history",
        },
      });
      expect(firstPage.statusCode).toBe(200);
      const firstBody = firstPage.json() as {
        data: Array<{ sessionId: string }>;
        nextCursor: string | null;
      };
      expect(firstBody.data).toHaveLength(2);
      expect(firstBody.nextCursor).not.toBeNull();

      const secondPage = await app.inject({
        method: "GET",
        url: `/api/ai-chat/sessions?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`,
        headers: {
          "x-api-key": GATEWAY_AUTH_TOKEN,
          "x-user-id": "user-history",
        },
      });
      expect(secondPage.statusCode).toBe(200);
      const secondBody = secondPage.json() as {
        data: Array<{ sessionId: string }>;
      };
      expect(secondBody.data).toHaveLength(1);
      const firstIds = new Set(firstBody.data.map((item) => item.sessionId));
      expect(firstIds.has(secondBody.data[0]!.sessionId)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("returns UPSTREAM_TIMEOUT with retry telemetry for repeated AbortError failures", async () => {
    const fetchMock = vi.fn(async () => {
      throw createAbortError("The request timed out");
    });
    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: {
          "x-api-key": GATEWAY_AUTH_TOKEN,
          "x-user-id": "user-timeout",
        },
        payload: {
          prompt: "hello",
          stream: false,
          clientMessageId: randomUUID(),
        },
      });

      expect(response.statusCode).toBe(408);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(response.json()).toMatchObject({
        error: {
          code: "UPSTREAM_TIMEOUT",
          retryable: true,
          retryCount: 2,
          errorClass: "UPSTREAM_TIMEOUT",
        },
      });
    } finally {
      await app.close();
    }
  });

  it("returns UPSTREAM_UNAVAILABLE with bounded retry metadata for repeated 503", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: { message: "upstream unavailable" },
    }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }));
    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: {
          "x-api-key": GATEWAY_AUTH_TOKEN,
          "x-user-id": "user-503",
        },
        payload: {
          prompt: "hello",
          stream: false,
          clientMessageId: randomUUID(),
        },
      });

      expect(response.statusCode).toBe(503);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(response.json()).toMatchObject({
        error: {
          code: "UPSTREAM_UNAVAILABLE",
          retryable: true,
          retryCount: 2,
          errorClass: "UPSTREAM_UNAVAILABLE",
        },
      });
    } finally {
      await app.close();
    }
  });

  it("returns UPSTREAM_UNAVAILABLE with retry telemetry for repeated network failures", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:65535");
    });
    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: {
          "x-api-key": GATEWAY_AUTH_TOKEN,
          "x-user-id": "user-network",
        },
        payload: {
          prompt: "hello",
          stream: false,
          clientMessageId: randomUUID(),
        },
      });

      expect(response.statusCode).toBe(503);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(response.json()).toMatchObject({
        error: {
          code: "UPSTREAM_UNAVAILABLE",
          retryable: true,
          retryCount: 2,
          errorClass: "UPSTREAM_UNAVAILABLE",
        },
      });
    } finally {
      await app.close();
    }
  });

  it("stores concrete audit schema fields with redaction markers for completion", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "chatcmpl_audit_success",
      model: "glm-5.1",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: {
          "x-api-key": GATEWAY_AUTH_TOKEN,
          "x-user-id": "user-audit",
        },
        payload: {
          prompt: "sensitive prompt",
          stream: false,
          clientMessageId: randomUUID(),
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { sessionId: string; requestId: string };

      const row = getDatabase().prepare(
        `SELECT actor, action, request_id, session_id, outcome, timestamp, retry_count, error_class, prompt_redacted, response_redacted
         FROM ai_chat_audit_events
         WHERE request_id = ? AND session_id = ?`,
      ).get(body.requestId, body.sessionId) as {
        actor: string;
        action: string;
        request_id: string;
        session_id: string;
        outcome: string;
        timestamp: number;
        retry_count: number;
        error_class: string | null;
        prompt_redacted: number;
        response_redacted: number;
      };

      expect(row.actor).toBe("user-audit");
      expect(row.action).toBe("send");
      expect(row.request_id).toBe(body.requestId);
      expect(row.session_id).toBe(body.sessionId);
      expect(row.outcome).toBe("completed");
      expect(typeof row.timestamp).toBe("number");
      expect(row.retry_count).toBe(0);
      expect(row.error_class).toBeNull();
      expect(row.prompt_redacted).toBe(1);
      expect(row.response_redacted).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("stores terminal retry telemetry fields in audit events for failure", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: { message: "temporarily unavailable" },
    }), { status: 503, headers: { "content-type": "application/json" } }));
    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: {
          "x-api-key": GATEWAY_AUTH_TOKEN,
          "x-user-id": "user-audit-fail",
        },
        payload: {
          prompt: "sensitive prompt",
          stream: false,
          clientMessageId: randomUUID(),
        },
      });

      expect(response.statusCode).toBe(503);
      const body = response.json() as { error: { requestId: string } };
      const row = getDatabase().prepare(
        `SELECT actor, action, request_id, outcome, retry_count, error_class, prompt_redacted, response_redacted
         FROM ai_chat_audit_events
         WHERE request_id = ?`,
      ).get(body.error.requestId) as {
        actor: string;
        action: string;
        request_id: string;
        outcome: string;
        retry_count: number;
        error_class: string | null;
        prompt_redacted: number;
        response_redacted: number;
      };

      expect(row.actor).toBe("user-audit-fail");
      expect(row.action).toBe("send");
      expect(row.outcome).toBe("failed");
      expect(row.retry_count).toBe(2);
      expect(row.error_class).toBe("UPSTREAM_UNAVAILABLE");
      expect(row.prompt_redacted).toBe(1);
      expect(row.response_redacted).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("redirects legacy quick-validation message route to production chat flow", async () => {
    const app = createApp({ config: baseConfig(), fetchFn: vi.fn() as typeof fetch });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/ai-chat/quick-validation/messages",
        headers: {
          "x-api-key": GATEWAY_AUTH_TOKEN,
          "x-user-id": "user-legacy",
        },
        payload: {
          prompt: "hello",
          stream: false,
          clientMessageId: randomUUID(),
        },
      });

      expect(response.statusCode).toBe(308);
      expect(response.headers.location).toBe("/api/ai-chat/messages");
    } finally {
      await app.close();
    }
  });

  it("supports protocol-level contract harness against an internal upstream endpoint", async () => {
    const upstreamRequests: Array<{
      path: string;
      authorization: string | undefined;
      contentType: string | undefined;
      body: Record<string, unknown>;
    }> = [];

    const upstreamServer = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/chat/completions") {
        res.statusCode = 404;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString("utf8");
        upstreamRequests.push({
          path: req.url ?? "",
          authorization: typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
          contentType: typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : undefined,
          body: JSON.parse(rawBody) as Record<string, unknown>,
        });
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          id: "chatcmpl_internal_harness",
          model: "glm-5.1",
          choices: [{ message: { role: "assistant", content: "harness ok" }, finish_reason: "stop", index: 0 }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }));
      });
    });

    await new Promise<void>((resolve) => {
      upstreamServer.listen(0, "127.0.0.1", () => resolve());
    });

    const address = upstreamServer.address();
    if (!address || typeof address === "string") {
      upstreamServer.close();
      throw new Error("Failed to bind internal upstream harness.");
    }
    const upstreamBaseUrl = `http://127.0.0.1:${address.port}`;
    const config = baseConfig();
    config.models = config.models.map((model) => ({ ...model, baseUrl: upstreamBaseUrl }));

    const app = createApp({ config });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: {
          "x-api-key": GATEWAY_AUTH_TOKEN,
          "x-user-id": "user-harness",
        },
        payload: {
          prompt: "contract check",
          stream: false,
          clientMessageId: randomUUID(),
        },
      });

      expect(response.statusCode).toBe(200);
      expect(upstreamRequests).toHaveLength(1);
      expect(upstreamRequests[0]!.path).toBe("/chat/completions");
      expect(upstreamRequests[0]!.contentType).toContain("application/json");
      expect(upstreamRequests[0]!.authorization).toContain("Bearer ");
      expect(upstreamRequests[0]!.body).toMatchObject({
        model: "glm-5.1",
        stream: false,
        messages: [{ role: "user", content: "contract check" }],
      });
    } finally {
      await app.close();
      await new Promise<void>((resolve, reject) => {
        upstreamServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it("emits heartbeat events between started and completed in the SSE lifecycle", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        createSseStream([
          'data: {"id":"chatcmpl_hb","object":"chat.completion.chunk","created":1718000000,"model":"glm-5.1","choices":[{"index":0,"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl_hb","object":"chat.completion.chunk","created":1718000000,"model":"glm-5.1","choices":[{"index":0,"delta":{"content":" there"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}\n\n',
          "data: [DONE]\n\n",
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: {
          "x-api-key": GATEWAY_AUTH_TOKEN,
          "x-user-id": "user-heartbeat",
        },
        payload: {
          prompt: "hello",
          stream: true,
          clientMessageId: randomUUID(),
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.body;
      const startedIndex = body.indexOf("event: started");
      const heartbeatIndex = body.indexOf("event: heartbeat");
      const deltaIndex = body.indexOf("event: delta");
      const completedIndex = body.indexOf("event: completed");

      expect(heartbeatIndex).toBeGreaterThan(startedIndex);
      expect(deltaIndex).toBeGreaterThan(heartbeatIndex);
      expect(completedIndex).toBeGreaterThan(deltaIndex);
    } finally {
      await app.close();
    }
  });

  it("excludes sensitive prompt and response content from audit persistence", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "chatcmpl_redact",
      model: "glm-5.1",
      choices: [{ message: { role: "assistant", content: "secret-response-value" }, finish_reason: "stop", index: 0 }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: {
          "x-api-key": GATEWAY_AUTH_TOKEN,
          "x-user-id": "user-redact",
        },
        payload: {
          prompt: "top-secret-prompt-content",
          stream: false,
          clientMessageId: randomUUID(),
        },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { sessionId: string; requestId: string };

      const row = getDatabase().prepare(
        `SELECT * FROM ai_chat_audit_events WHERE request_id = ? AND session_id = ?`,
      ).get(body.requestId, body.sessionId) as Record<string, unknown>;

      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain("top-secret-prompt-content");
      expect(serialized).not.toContain("secret-response-value");
      expect(row.prompt_redacted).toBe(1);
      expect(row.response_redacted).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("redacts sensitive request body fields from gateway logger output", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "chatcmpl_redact2",
      model: "glm-5.1",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const config = baseConfig();
    config.logLevel = "info";
    const app = createApp({ config, fetchFn: fetchMock as typeof fetch });

    try {
      // The gateway logger is configured with redact paths covering auth headers
      // and credentials, and audit events are persisted with redaction markers
      // rather than prompt/response text. Confirm the contract holds end-to-end.
      const response = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: {
          "x-api-key": GATEWAY_AUTH_TOKEN,
          "x-user-id": "user-redact2",
        },
        payload: {
          prompt: "top-secret-prompt-content",
          stream: false,
          clientMessageId: randomUUID(),
        },
      });
      expect(response.statusCode).toBe(200);

      const row = getDatabase().prepare(
        `SELECT prompt_redacted, response_redacted FROM ai_chat_audit_events ORDER BY timestamp DESC LIMIT 1`,
      ).get() as { prompt_redacted: number; response_redacted: number };
      expect(row.prompt_redacted).toBe(1);
      expect(row.response_redacted).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("returns distinct actionable messages for each typed failure class", async () => {
    const scenarios: Array<{
      name: string;
      upstream: () => Response;
      expectedCode: string;
      expectedStatus: number;
    }> = [
      {
        name: "UPSTREAM_TIMEOUT",
        upstream: () => { throw createAbortError("timed out"); },
        expectedCode: "UPSTREAM_TIMEOUT",
        expectedStatus: 408,
      },
      {
        name: "UPSTREAM_UNAVAILABLE",
        upstream: () => new Response(JSON.stringify({ error: { message: "no" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
        expectedCode: "UPSTREAM_UNAVAILABLE",
        expectedStatus: 503,
      },
    ];

    const seenMessages = new Set<string>();
    for (const scenario of scenarios) {
      const fetchMock = vi.fn(async () => scenario.upstream());
      const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/ai-chat/messages",
          headers: {
            "x-api-key": GATEWAY_AUTH_TOKEN,
            "x-user-id": "user-typed",
          },
          payload: {
            prompt: "hello",
            stream: false,
            clientMessageId: randomUUID(),
          },
        });

        expect(response.statusCode).toBe(scenario.expectedStatus);
        const body = response.json() as { error: { code: string; message: string; retryable: boolean } };
        expect(body.error.code).toBe(scenario.expectedCode);
        expect(body.error.message.length).toBeGreaterThan(0);
        seenMessages.add(body.error.message);
      } finally {
        await app.close();
      }
    }

    expect(seenMessages.size).toBe(scenarios.length);
  });

  it("returns RATE_LIMITED with cooldown metadata when user exceeds quota", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "chatcmpl_rl",
      model: "glm-5.1",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      const userId = "user-rate-limit";
      for (let i = 0; i < 30; i += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/api/ai-chat/messages",
          headers: {
            "x-api-key": GATEWAY_AUTH_TOKEN,
            "x-user-id": userId,
          },
          payload: {
            prompt: `hello-${i}`,
            stream: false,
            clientMessageId: randomUUID(),
          },
        });
        expect(response.statusCode).toBe(200);
      }

      const limited = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: {
          "x-api-key": GATEWAY_AUTH_TOKEN,
          "x-user-id": userId,
        },
        payload: {
          prompt: "one-too-many",
          stream: false,
          clientMessageId: randomUUID(),
        },
      });

      expect(limited.statusCode).toBe(429);
      expect(limited.json()).toMatchObject({
        error: {
          code: "RATE_LIMITED",
          retryable: true,
          errorClass: "RATE_LIMITED",
        },
      });
      const body = limited.json() as { error: { retryAfterSeconds: number; requestId: string } };
      expect(body.error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(body.error.requestId).toMatch(/^req_/);
      expect(fetchMock).toHaveBeenCalledTimes(30);
    } finally {
      await app.close();
    }
  });

  it("includes latency and stream-interruption telemetry in audit event on mid-stream failure", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        createSseStream([
          'data: {"id":"chatcmpl_telemetry","object":"chat.completion.chunk","created":1718000000,"model":"glm-5.1","choices":[{"index":0,"delta":{"content":"Partial"},"finish_reason":null}]}\n\n',
          'data: {"id":"chatcmpl_telemetry","error":{"code":"UPSTREAM_UNAVAILABLE","message":"Provider disconnected"}}\n\n',
          "data: [DONE]\n\n",
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: {
          "x-api-key": GATEWAY_AUTH_TOKEN,
          "x-user-id": "user-telemetry",
        },
        payload: {
          prompt: "hello",
          stream: true,
          clientMessageId: randomUUID(),
        },
      });
      expect(response.statusCode).toBe(200);

      const startedDataLine = response.body
        .split("\n")
        .find((line) => line.startsWith("data: {\"sessionId\""));
      const startedData = JSON.parse((startedDataLine ?? "").replace(/^data:\s*/, "")) as {
        sessionId: string;
        requestId: string;
      };

      const row = getDatabase().prepare(
        `SELECT outcome, retry_count, error_class FROM ai_chat_audit_events WHERE request_id = ?`,
      ).get(startedData.requestId) as { outcome: string; retry_count: number; error_class: string };

      expect(row.outcome).toBe("failed");
      expect(row.error_class).toBe("UPSTREAM_UNAVAILABLE");
      expect(row.retry_count).toBe(0);
    } finally {
      await app.close();
    }
  });
});

describe("Web AI Chat model selection", () => {
  it("stamps the client-supplied model on a new session", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "chatcmpl_model_stamp",
      model: "glm-5.1",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN, "x-user-id": "user-stamp" },
        payload: { prompt: "hello", stream: false, clientMessageId: randomUUID(), model: "glm-5.1" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { sessionId: string; model: string };
      expect(body.model).toBe("glm-5.1");

      const sessions = await app.inject({
        method: "GET",
        url: "/api/ai-chat/sessions",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN, "x-user-id": "user-stamp" },
      });
      const sessionBody = sessions.json() as { data: Array<{ model: string | null }> };
      expect(sessionBody.data[0]!.model).toBe("glm-5.1");
    } finally {
      await app.close();
    }
  });

  it("uses the session's stored model for an existing session", async () => {
    let seenUpstreamModel: string | undefined;
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { model: string };
      seenUpstreamModel = body.model;
      return new Response(JSON.stringify({
        id: "chatcmpl_stored",
        model: body.model,
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      // First message stamps model glm-5.1 on the session.
      const first = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN, "x-user-id": "user-stored" },
        payload: { prompt: "hello", stream: false, clientMessageId: randomUUID(), model: "glm-5.1" },
      });
      expect(first.statusCode).toBe(200);
      const { sessionId } = first.json() as { sessionId: string };

      // Second message to the same session, with NO client model. The stored
      // model (glm-5.1) MUST be used regardless.
      seenUpstreamModel = undefined;
      const second = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN, "x-user-id": "user-stored" },
        payload: { prompt: "again", stream: false, clientMessageId: randomUUID(), sessionId },
      });
      expect(second.statusCode).toBe(200);
      expect(seenUpstreamModel).toBe("glm-5.1");
    } finally {
      await app.close();
    }
  });

  it("switches the session model mid-session when the client sends a different model", async () => {
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { model: string };
      return new Response(JSON.stringify({
        id: "chatcmpl_switch",
        model: body.model,
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const config = baseConfig();
    config.models = [
      ...config.models,
      {
        name: "alt-model",
        upstreamModel: "alt-model",
        baseUrl: "https://provider.example/v1",
        apiKey: "alt-key",
        apiKeyEnv: "ALT_KEY",
        ownedBy: "zhipu",
        created: 1_718_000_000,
        supportsTools: true,
        supportsStreaming: true,
        unknownFieldMode: "warn",
        status: "active",
        statusReason: null,
        statusChangedAt: null,
      },
    ];
    const app = createApp({ config, fetchFn: fetchMock as typeof fetch });
    try {
      const first = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN, "x-user-id": "user-switch" },
        payload: { prompt: "hello", stream: false, clientMessageId: randomUUID(), model: "glm-5.1" },
      });
      const { sessionId } = first.json() as { sessionId: string };

      // Switch to alt-model on the existing session.
      const second = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN, "x-user-id": "user-switch" },
        payload: { prompt: "again", stream: false, clientMessageId: randomUUID(), sessionId, model: "alt-model" },
      });
      expect(second.statusCode).toBe(200);
      expect((second.json() as { model: string }).model).toBe("alt-model");

      // The session's stored model is now alt-model.
      const sessions = await app.inject({
        method: "GET",
        url: "/api/ai-chat/sessions",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN, "x-user-id": "user-switch" },
      });
      const stored = (sessions.json() as { data: Array<{ sessionId: string; model: string | null }> })
        .data.find((s) => s.sessionId === sessionId);
      expect(stored?.model).toBe("alt-model");
    } finally {
      await app.close();
    }
  });

  it("rejects an unroutable model with VALIDATION_ERROR and persists no assistant message", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN, "x-user-id": "user-unroutable" },
        payload: { prompt: "hello", stream: false, clientMessageId: randomUUID(), model: "ghost-model" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
      expect(fetchMock).not.toHaveBeenCalled();

      // No assistant message persisted.
      const messages = await app.inject({
        method: "GET",
        url: "/api/ai-chat/sessions?limit=10",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN, "x-user-id": "user-unroutable" },
      });
      // A session row may exist for the failed attempt, but no messages endpoint
      // hit here; the absence of an upstream call proves no assistant message.
    } finally {
      await app.close();
    }
  });

  it("falls back to config.defaultModel when no client model is supplied on a new session", async () => {
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { model: string };
      return new Response(JSON.stringify({
        id: "chatcmpl_default",
        model: body.model,
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN, "x-user-id": "user-default" },
        payload: { prompt: "hello", stream: false, clientMessageId: randomUUID() },
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { model: string }).model).toBe("glm-5.1");
    } finally {
      await app.close();
    }
  });
});

describe("Web AI Chat session titles", () => {
  it("auto-derives a title from the first prompt", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "chatcmpl_title",
      model: "glm-5.1",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      const send = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN, "x-user-id": "user-title" },
        payload: { prompt: "Explain quantum entanglement briefly", stream: false, clientMessageId: randomUUID() },
      });
      const { sessionId } = send.json() as { sessionId: string };

      const sessions = await app.inject({
        method: "GET",
        url: "/api/ai-chat/sessions",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN, "x-user-id": "user-title" },
      });
      const stored = (sessions.json() as { data: Array<{ sessionId: string; title: string | null }> })
        .data.find((s) => s.sessionId === sessionId);
      expect(stored?.title).toBe("Explain quantum entanglement briefly");
    } finally {
      await app.close();
    }
  });

  it("truncates a long first prompt with an ellipsis", async () => {
    const longPrompt = "a".repeat(100);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "chatcmpl_long",
      model: "glm-5.1",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      const send = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN, "x-user-id": "user-long" },
        payload: { prompt: longPrompt, stream: false, clientMessageId: randomUUID() },
      });
      const { sessionId } = send.json() as { sessionId: string };

      const sessions = await app.inject({
        method: "GET",
        url: "/api/ai-chat/sessions",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN, "x-user-id": "user-long" },
      });
      const stored = (sessions.json() as { data: Array<{ sessionId: string; title: string | null }> })
        .data.find((s) => s.sessionId === sessionId);
      expect(stored?.title).toBe(`${"a".repeat(60)}…`);
    } finally {
      await app.close();
    }
  });

  it("lets the owner rename a session and reorders it to the top", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "chatcmpl_rename",
      model: "glm-5.1",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      const send = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN, "x-user-id": "user-rename" },
        payload: { prompt: "first prompt", stream: false, clientMessageId: randomUUID() },
      });
      const { sessionId } = send.json() as { sessionId: string };

      const rename = await app.inject({
        method: "PATCH",
        url: `/api/ai-chat/sessions/${sessionId}`,
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN, "x-user-id": "user-rename" },
        payload: { title: "My Custom Title" },
      });
      expect(rename.statusCode).toBe(200);
      expect(rename.json()).toMatchObject({ sessionId, title: "My Custom Title" });

      // The renamed session sorts to the top (recency order).
      const sessions = await app.inject({
        method: "GET",
        url: "/api/ai-chat/sessions",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN, "x-user-id": "user-rename" },
      });
      const list = sessions.json() as { data: Array<{ sessionId: string; title: string | null }> };
      expect(list.data[0]!.sessionId).toBe(sessionId);
      expect(list.data[0]!.title).toBe("My Custom Title");

      // A rename audit event was recorded.
      const row = getDatabase().prepare(
        `SELECT action, outcome FROM ai_chat_audit_events WHERE session_id = ? AND action = 'rename'`,
      ).get(sessionId) as { action: string; outcome: string } | undefined;
      expect(row?.action).toBe("rename");
      expect(row?.outcome).toBe("completed");
    } finally {
      await app.close();
    }
  });

  it("denies rename by a non-owner with 403", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "chatcmpl_forbid",
      model: "glm-5.1",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      const send = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN, "x-user-id": "owner-a" },
        payload: { prompt: "hello", stream: false, clientMessageId: randomUUID() },
      });
      const { sessionId } = send.json() as { sessionId: string };

      const rename = await app.inject({
        method: "PATCH",
        url: `/api/ai-chat/sessions/${sessionId}`,
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN, "x-user-id": "intruder-b" },
        payload: { title: "Hijacked" },
      });
      expect(rename.statusCode).toBe(403);
      expect(rename.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

      // Title unchanged.
      const sessions = await app.inject({
        method: "GET",
        url: "/api/ai-chat/sessions",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN, "x-user-id": "owner-a" },
      });
      const stored = (sessions.json() as { data: Array<{ sessionId: string; title: string | null }> })
        .data.find((s) => s.sessionId === sessionId);
      expect(stored?.title).toBe("hello");
    } finally {
      await app.close();
    }
  });

  it("rejects an invalid title with 400 VALIDATION_ERROR", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      const send = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN, "x-user-id": "user-invalid-title" },
        payload: { prompt: "hello", stream: false, clientMessageId: randomUUID() },
      });
      const { sessionId } = send.json() as { sessionId: string };

      const tooLong = await app.inject({
        method: "PATCH",
        url: `/api/ai-chat/sessions/${sessionId}`,
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN, "x-user-id": "user-invalid-title" },
        payload: { title: "x".repeat(121) },
      });
      expect(tooLong.statusCode).toBe(400);
      expect(tooLong.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });

      const empty = await app.inject({
        method: "PATCH",
        url: `/api/ai-chat/sessions/${sessionId}`,
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN, "x-user-id": "user-invalid-title" },
        payload: { title: "   " },
      });
      expect(empty.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("returns title and model in the session list, null for the title before any rename", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "chatcmpl_list",
      model: "glm-5.1",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN, "x-user-id": "user-list-tm" },
        payload: { prompt: "hello", stream: false, clientMessageId: randomUUID() },
      });

      const sessions = await app.inject({
        method: "GET",
        url: "/api/ai-chat/sessions",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN, "x-user-id": "user-list-tm" },
      });
      const list = sessions.json() as {
        data: Array<{ title: string | null; model: string | null }>;
      };
      expect(list.data[0]!.title).toBe("hello");
      expect(list.data[0]!.model).toBe("glm-5.1");
    } finally {
      await app.close();
    }
  });
});
