import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  host: "127.0.0.1",
  port: 3001,
  logLevel: "silent",
  upstreamBaseUrl: "https://provider.example/v1",
  defaultModel: "claude-gateway",
  requestTimeoutMs: 30000,
  maxRetries: 0,
  maxBodySizeKb: 1024,
  models: [
    {
      name: "claude-gateway",
      upstreamModel: "provider-internal-coder",
      baseUrl: "https://provider.example/v1",
      apiKey: "secret-key",
      apiKeyEnv: "CLAUDE_GATEWAY_API_KEY",
      ownedBy: "gateway",
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

describe("Claude Code compatibility routes", () => {
  it("serves Anthropic model discovery when anthropic-version is present", async () => {
    const app = createApp({
      config,
      fetchFn: vi.fn() as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: {
          "anthropic-version": "2023-06-01",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        object: "list",
        data: [
          {
            id: "claude-gateway",
            type: "model",
            display_name: "claude-gateway",
            created_at: "2024-06-10T06:13:20.000Z",
            status: "active",
          },
        ],
      });
    } finally {
      await app.close();
    }
  });

  it("translates non-stream Anthropic messages requests to chat completions", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(input.toString()).toBe("https://provider.example/v1/chat/completions");
      expect(init?.method).toBe("POST");
      expect(getRequestHeader(init, "authorization")).toBe("Bearer secret-key");
      expect(getRequestHeader(init, "content-type")).toContain("application/json");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "provider-internal-coder",
        messages: [
          {
            role: "system",
            content: "You are a gateway-backed Claude runtime.",
          },
          {
            role: "user",
            content: "Reply with pong only.",
          },
        ],
        max_completion_tokens: 1024,
      });

      return new Response(
        JSON.stringify({
          id: "chatcmpl_json",
          object: "chat.completion",
          created: 1_718_000_000,
          model: "provider-internal-coder",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "pong",
              },
            },
          ],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 1,
            total_tokens: 9,
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    });

    const app = createApp({
      config,
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: {
          "anthropic-version": "2023-06-01",
        },
        payload: {
          system: "You are a gateway-backed Claude runtime.",
          messages: [
            {
              role: "user",
              content: "Reply with pong only.",
            },
          ],
          max_tokens: 1024,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(response.json()).toEqual({
        id: "chatcmpl_json",
        type: "message",
        role: "assistant",
        model: "claude-gateway",
        content: [
          {
            type: "text",
            text: "pong",
          },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 8,
          output_tokens: 1,
        },
      });
    } finally {
      await app.close();
    }
  });

  it("accepts mid-conversation system messages without returning a 400", async () => {
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "provider-internal-coder",
        messages: [
          {
            role: "user",
            content: "Initial prompt",
          },
          {
            role: "system",
            content: "System reminder one.\nSystem reminder two.",
          },
          {
            role: "user",
            content: "Continue.",
          },
        ],
        max_completion_tokens: 1024,
      });

      return new Response(
        JSON.stringify({
          id: "chatcmpl_mid_system",
          object: "chat.completion",
          created: 1_718_000_001,
          model: "provider-internal-coder",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "pong",
              },
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 1,
            total_tokens: 11,
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    });

    const app = createApp({
      config,
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: {
          "anthropic-version": "2023-06-01",
        },
        payload: {
          messages: [
            {
              role: "user",
              content: "Initial prompt",
            },
            {
              role: "system",
              content: [
                { type: "text", text: "System reminder one." },
                { type: "text", text: "System reminder two." },
              ],
            },
            {
              role: "user",
              content: "Continue.",
            },
          ],
          max_tokens: 1024,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(response.json()).toMatchObject({
        id: "chatcmpl_mid_system",
        type: "message",
        role: "assistant",
        model: "claude-gateway",
      });
    } finally {
      await app.close();
    }
  });

  it("streams Anthropic message events from chat completions SSE", async () => {
    const fetchMock = vi.fn(async () => {
      const body = createSseStream([
        'data: {"id":"chatcmpl_stream","object":"chat.completion.chunk","created":1718000000,"model":"provider-internal-coder","choices":[{"index":0,"delta":{"role":"assistant","content":"pon"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl_stream","object":"chat.completion.chunk","created":1718000000,"model":"provider-internal-coder","choices":[{"index":0,"delta":{"content":"g"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl_stream","object":"chat.completion.chunk","created":1718000000,"model":"provider-internal-coder","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":1,"total_tokens":9}}\n\n',
        "data: [DONE]\n\n",
      ]);

      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
        },
      });
    });

    const app = createApp({
      config,
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: {
          "anthropic-version": "2023-06-01",
        },
        payload: {
          messages: [
            {
              role: "user",
              content: "Reply with pong only.",
            },
          ],
          max_tokens: 1024,
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.body).toContain("event: message_start");
      expect(response.body).toContain("event: content_block_start");
      expect(response.body).toContain("event: content_block_delta");
      expect(response.body).toContain('"text":"pon"');
      expect(response.body).toContain('"text":"g"');
      expect(response.body).toContain("event: content_block_stop");
      expect(response.body).toContain("event: message_delta");
      expect(response.body).toContain('"stop_reason":"end_turn"');
      expect(response.body).toContain("event: message_stop");
    } finally {
      await app.close();
    }
  });

  it("falls back to non-stream Anthropic output when upstream rejects SSE accept headers", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (_input: URL | RequestInfo, init?: RequestInit) => {
        expect(getRequestHeader(init, "authorization")).toBe("Bearer secret-key");
        expect(getRequestHeader(init, "content-type")).toContain("application/json");

        return new Response(
          JSON.stringify({
            error: "Not Acceptable",
          }),
          {
            status: 406,
            statusText: "Not Acceptable",
            headers: {
              "content-type": "application/json",
            },
          },
        );
      })
      .mockImplementationOnce(async (_input: URL | RequestInfo, init?: RequestInit) => {
        expect(getRequestHeader(init, "authorization")).toBe("Bearer secret-key");
        expect(getRequestHeader(init, "content-type")).toContain("application/json");
        expect(JSON.parse(String(init?.body))).toEqual({
          model: "provider-internal-coder",
          messages: [
            {
              role: "user",
              content: "Reply with pong only.",
            },
          ],
          max_completion_tokens: 1024,
        });

        return new Response(
          JSON.stringify({
            id: "chatcmpl_fallback",
            object: "chat.completion",
            created: 1_718_000_000,
            model: "provider-internal-coder",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: "pong",
                },
              },
            ],
            usage: {
              prompt_tokens: 8,
              completion_tokens: 1,
              total_tokens: 9,
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
            },
          },
        );
      });

    const app = createApp({
      config,
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: {
          "anthropic-version": "2023-06-01",
        },
        payload: {
          messages: [
            {
              role: "user",
              content: "Reply with pong only.",
            },
          ],
          max_tokens: 1024,
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.body).toContain("event: message_start");
      expect(response.body).toContain("event: content_block_delta");
      expect(response.body).toContain('"text":"pong"');
      expect(response.body).toContain("event: message_delta");
      expect(response.body).toContain("event: message_stop");
    } finally {
      await app.close();
    }
  });

  it("rejects /v1/messages streaming when model does not support streaming", async () => {
    const app = createApp({
      config: {
        ...config,
        models: [
          {
            ...config.models[0]!,
            supportsStreaming: false,
          },
        ],
      },
      fetchFn: vi.fn() as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: {
          "anthropic-version": "2023-06-01",
        },
        payload: {
          messages: [
            {
              role: "user",
              content: "Reply with pong only.",
            },
          ],
          max_tokens: 1024,
          stream: true,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Model `claude-gateway` does not support streaming.",
        },
      });
    } finally {
      await app.close();
    }
  });

  it("rejects /v1/messages tools when model does not support tools", async () => {
    const app = createApp({
      config: {
        ...config,
        models: [
          {
            ...config.models[0]!,
            supportsTools: false,
          },
        ],
      },
      fetchFn: vi.fn() as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: {
          "anthropic-version": "2023-06-01",
        },
        payload: {
          messages: [
            {
              role: "user",
              content: "Reply with pong only.",
            },
          ],
          max_tokens: 1024,
          tools: [
            {
              name: "Bash",
              input_schema: {
                type: "object",
              },
            },
          ],
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Model `claude-gateway` does not support tools.",
        },
      });
    } finally {
      await app.close();
    }
  });
});
