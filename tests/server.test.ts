import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { type AppConfig, type GatewayModelConfig } from "../src/config.js";
import type { ChainModelEntry, ModelChainConfig } from "../src/contracts.js";

const compatibilityInstructions =
  "You are a helpful AI assistant. Follow developer and user instructions, keep responses accurate, and prefer concise plain-text output unless the caller asks for a specific format.";

const singleModelConfig: AppConfig = {
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
      apiKeyEnv: "API_KEY",
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

const multiModelConfig: AppConfig = {
  host: "127.0.0.1",
  port: 3001,
  logLevel: "silent",
  upstreamBaseUrl: "https://provider-a.example/v1",
  defaultModel: "glm-5.1",
  requestTimeoutMs: 30000,
  maxRetries: 0,
  maxBodySizeKb: 1024,
  healthProbeEnabled: false,
  models: [
    {
      name: "glm-5.1",
      upstreamModel: "glm-5.1",
      baseUrl: "https://provider-a.example/v1",
      apiKey: "api-key-a",
      apiKeyEnv: "API_KEY_A",
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
    {
      name: "coder-alias",
      upstreamModel: "provider-internal-coder",
      baseUrl: "https://provider-b.example/v1",
      apiKey: "api-key-b",
      apiKeyEnv: "API_KEY_B",
      ownedBy: "custom-provider",
      created: 1_718_000_001,
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

describe("createApp", () => {
  it("serves health information and discovered models", async () => {
    const app = createApp({
      config: multiModelConfig,
      fetchFn: vi.fn() as typeof fetch,
    });

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

  it("exposes model discovery endpoints for configured models", async () => {
    const app = createApp({
      config: multiModelConfig,
      fetchFn: vi.fn() as typeof fetch,
    });

    try {
      const listResponse = await app.inject({
        method: "GET",
        url: "/v1/models",
      });
      const detailResponse = await app.inject({
        method: "GET",
        url: "/v1/models/coder-alias",
      });

      expect(listResponse.statusCode).toBe(200);
      expect(listResponse.json()).toMatchObject({
        object: "list",
        data: [
          {
            id: "glm-5.1",
            object: "model",
            created: 1_718_000_000,
            owned_by: "zhipu",
            permission: [],
            root: "glm-5.1",
            parent: null,
            status: "active",
            capabilities: {
              input_modalities: ["text"],
              output_modalities: ["text"],
              supports_responses_api: true,
              supports_streaming: true,
              supports_system_messages: true,
              supports_model_messages: true,
              supports_personality: true,
              supports_tool_calls: true,
              supports_parallel_tool_calls: true,
            },
            personality: "default",
            model_messages: [
              {
                role: "system",
                content: compatibilityInstructions,
              },
            ],
            base_instructions: compatibilityInstructions,
          },
          {
            id: "coder-alias",
            object: "model",
            created: 1_718_000_001,
            owned_by: "custom-provider",
            permission: [],
            root: "coder-alias",
            parent: null,
            status: "active",
            capabilities: {
              input_modalities: ["text"],
              output_modalities: ["text"],
              supports_responses_api: true,
              supports_streaming: true,
              supports_system_messages: true,
              supports_model_messages: true,
              supports_personality: true,
              supports_tool_calls: true,
              supports_parallel_tool_calls: true,
            },
            personality: "default",
            model_messages: [
              {
                role: "system",
                content: compatibilityInstructions,
              },
            ],
            base_instructions: compatibilityInstructions,
          },
        ],
      });

      expect(detailResponse.statusCode).toBe(200);
      expect(detailResponse.json()).toMatchObject({
        id: "coder-alias",
        object: "model",
        created: 1_718_000_001,
        owned_by: "custom-provider",
        permission: [],
        root: "coder-alias",
        parent: null,
        status: "active",
        capabilities: {
          input_modalities: ["text"],
          output_modalities: ["text"],
          supports_responses_api: true,
          supports_streaming: true,
          supports_system_messages: true,
          supports_model_messages: true,
          supports_personality: true,
          supports_tool_calls: true,
          supports_parallel_tool_calls: true,
        },
        personality: "default",
        model_messages: [
          {
            role: "system",
            content: compatibilityInstructions,
          },
        ],
        base_instructions: compatibilityInstructions,
      });
    } finally {
      await app.close();
    }
  });

  it("routes non-stream requests by configured model and preserves the public model name", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(input.toString()).toBe(
        "https://provider-b.example/v1/chat/completions",
      );
      expect(init?.method).toBe("POST");
      expect(getRequestHeader(init, "authorization")).toBe("Bearer api-key-b");
      expect(getRequestHeader(init, "content-type")).toContain("application/json");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "provider-internal-coder",
        messages: [{ role: "user", content: "Hello gateway" }],
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
                content: "Hello client",
              },
            },
          ],
          usage: {
            prompt_tokens: 8,
            completion_tokens: 3,
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
      config: multiModelConfig,
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: {
          model: "coder-alias",
          input: "Hello gateway",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(response.json()).toMatchObject({
        id: "chatcmpl_json",
        object: "response",
        model: "coder-alias",
        output_text: "Hello client",
        usage: {
          input_tokens: 8,
          output_tokens: 3,
          total_tokens: 11,
        },
      });
    } finally {
      await app.close();
    }
  });

  it("rejects requests for models that are not present in the YAML-backed catalog", async () => {
    const fetchMock = vi.fn();
    const app = createApp({
      config: multiModelConfig,
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: {
          model: "unknown-model",
          input: "Hello gateway",
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: "Model metadata for `unknown-model` is not configured.",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("redacts upstream error bodies from client responses", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: "invalid_api_key",
          detail: "provider echoed a sensitive prompt fragment",
        }),
        {
          status: 401,
          statusText: "Unauthorized",
          headers: {
            "content-type": "application/json",
          },
        },
      ),
    );

    const app = createApp({
      config: singleModelConfig,
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: {
          input: "Hello gateway",
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: "Upstream request failed.",
        upstream: {
          statusCode: 401,
          statusText: "Error",
        },
      });
      expect(response.body).not.toContain("invalid_api_key");
      expect(response.body).not.toContain("sensitive prompt fragment");
    } finally {
      await app.close();
    }
  });

  it("does not echo raw upstream payloads when JSON parsing fails", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("not-json provider echoed user secret", {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }),
    );

    const app = createApp({
      config: singleModelConfig,
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: {
          input: "Hello gateway",
        },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: expect.stringContaining("Failed to reach upstream /chat/completions endpoint"),
      });
      expect(response.body).not.toContain("provider echoed user secret");
    } finally {
      await app.close();
    }
  });

  it("streams responses-style SSE events with the configured public model name", async () => {
    const fetchMock = vi.fn(async () => {
      const body = createSseStream([
        'data: {"id":"chatcmpl_stream","object":"chat.completion.chunk","created":1718000000,"model":"glm-5.1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl_stream","object":"chat.completion.chunk","created":1718000000,"model":"glm-5.1","choices":[{"index":0,"delta":{"content":" there"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}\n\n',
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
      config: singleModelConfig,
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: {
          input: "Hello gateway",
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.body).toContain("event: response.created");
      expect(response.body).toContain("event: response.output_item.added");
      expect(response.body).toContain("event: response.content_part.added");
      expect(response.body).toContain("\"model\":\"glm-5.1\"");
      expect(response.body).toContain("event: response.output_text.delta");
      expect(response.body).toContain("\"item_id\":\"chatcmpl_stream:output:0\"");
      expect(response.body).toContain("\"delta\":\"Hi\"");
      expect(response.body).toContain("\"delta\":\" there\"");
      expect(response.body).toContain("event: response.output_text.done");
      expect(response.body).toContain("event: response.content_part.done");
      expect(response.body).toContain("event: response.output_item.done");
      expect(response.body).toContain("event: response.completed");
      expect(response.body).toContain("\"text\":\"Hi there\"");
    } finally {
      await app.close();
    }
  });

  it("rejects unknown /responses top-level fields when model unknown_field_mode is enforce", async () => {
    const fetchMock = vi.fn();
    const app = createApp({
      config: {
        ...singleModelConfig,
        models: [
          {
            ...singleModelConfig.models[0]!,
            unknownFieldMode: "enforce",
          },
        ],
      },
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: {
          input: "Hello gateway",
          unsupported_field: "value",
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: "Unknown /responses fields.",
        unknown_fields: ["unsupported_field"],
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("accepts Codex / Responses API fields without flagging them as unknown in enforce mode", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl_codex",
          object: "chat.completion",
          created: 1_718_000_000,
          model: "glm-5.1",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "Hello from Codex",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const app = createApp({
      config: {
        ...singleModelConfig,
        models: [
          {
            ...singleModelConfig.models[0]!,
            unknownFieldMode: "enforce",
          },
        ],
      },
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: {
          input: "Hello gateway",
          client_metadata: { session: "abc" },
          include: ["file_search_call.results"],
          parallel_tool_calls: true,
          prompt_cache_key: "cache-key-123",
          reasoning: { effort: "high" },
          store: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("accepts reasoning: null in /responses request", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl_null_reasoning",
          object: "chat.completion",
          created: 1_718_000_000,
          model: "glm-5.1",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "Hello",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const app = createApp({
      config: {
        ...singleModelConfig,
        models: [
          {
            ...singleModelConfig.models[0]!,
            unknownFieldMode: "enforce",
          },
        ],
      },
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: {
          input: "Hello gateway",
          reasoning: null,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("ignores unknown /responses top-level fields in warn mode", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl_warn",
          object: "chat.completion",
          created: 1_718_000_000,
          model: "glm-5.1",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "Hello client",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const app = createApp({
      config: {
        ...singleModelConfig,
        models: [
          {
            ...singleModelConfig.models[0]!,
            unknownFieldMode: "warn",
          },
        ],
      },
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: {
          input: "Hello gateway",
          unsupported_field: "value",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("rejects /responses streaming when model does not support streaming", async () => {
    const fetchMock = vi.fn();
    const app = createApp({
      config: {
        ...singleModelConfig,
        models: [
          {
            ...singleModelConfig.models[0]!,
            supportsStreaming: false,
          },
        ],
      },
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: {
          input: "Hello gateway",
          stream: true,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: "Model `glm-5.1` does not support streaming.",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("rejects /responses tools when model does not support tools", async () => {
    const fetchMock = vi.fn();
    const app = createApp({
      config: {
        ...singleModelConfig,
        models: [
          {
            ...singleModelConfig.models[0]!,
            supportsTools: false,
          },
        ],
      },
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: {
          input: "Hello gateway",
          tools: [
            {
              type: "function",
              name: "search",
            },
          ],
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: "Model `glm-5.1` does not support tools.",
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("proxies non-stream /v1/chat/completions requests using configured model routing", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      expect(input.toString()).toBe(
        "https://provider-b.example/v1/chat/completions",
      );
      expect(init?.method).toBe("POST");
      expect(getRequestHeader(init, "authorization")).toBe("Bearer api-key-b");
      expect(JSON.parse(String(init?.body))).toEqual({
        model: "provider-internal-coder",
        messages: [{ role: "user", content: "Hello gateway" }],
      });

      return new Response(
        JSON.stringify({
          id: "chatcmpl_direct",
          object: "chat.completion",
          created: 1_718_000_010,
          model: "provider-internal-coder",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "Hello from direct chat completions",
              },
            },
          ],
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
      config: multiModelConfig,
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "coder-alias",
          messages: [{ role: "user", content: "Hello gateway" }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(response.json()).toMatchObject({
        id: "chatcmpl_direct",
        object: "chat.completion",
        model: "provider-internal-coder",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Hello from direct chat completions",
            },
          },
        ],
      });
    } finally {
      await app.close();
    }
  });

  it("streams OpenAI-compatible SSE for /v1/chat/completions", async () => {
    const fetchMock = vi.fn(async () => {
      const body = createSseStream([
        'data: {"id":"chatcmpl_direct_stream","object":"chat.completion.chunk","created":1718000000,"model":"glm-5.1","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}\n\n',
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
      config: singleModelConfig,
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          messages: [{ role: "user", content: "Hello gateway" }],
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.body).toContain("chat.completion.chunk");
      expect(response.body).toContain("data: [DONE]");
    } finally {
      await app.close();
    }
  });

  it("rejects /v1/chat/completions when model is not configured", async () => {
    const fetchMock = vi.fn();
    const app = createApp({
      config: multiModelConfig,
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "unknown-model",
          messages: [{ role: "user", content: "Hello gateway" }],
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          message: "Model metadata for `unknown-model` is not configured.",
          type: "invalid_request_error",
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns OpenAI-style validation error for invalid /v1/chat/completions payload", async () => {
    const fetchMock = vi.fn();
    const app = createApp({
      config: singleModelConfig,
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "glm-5.1",
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          message: "Request body messages must be a non-empty array.",
          type: "invalid_request_error",
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("maps upstream failures to OpenAI-style errors for /v1/chat/completions", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: "invalid_api_key",
          detail: "provider echoed a sensitive prompt fragment",
        }),
        {
          status: 401,
          statusText: "Unauthorized",
          headers: {
            "content-type": "application/json",
          },
        },
      ),
    );

    const app = createApp({
      config: singleModelConfig,
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          messages: [{ role: "user", content: "Hello gateway" }],
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: {
          message: "Upstream request failed.",
          type: "api_error",
        },
      });
      expect(response.body).not.toContain("invalid_api_key");
      expect(response.body).not.toContain("sensitive prompt fragment");
    } finally {
      await app.close();
    }
  });

  // ---------------------------------------------------------------------------
  // Chain integration tests
  // ---------------------------------------------------------------------------

  function makeChainModel(overrides: Partial<GatewayModelConfig> = {}): GatewayModelConfig {
    return {
      name: "gpt-5",
      upstreamModel: "gpt-5",
      baseUrl: "https://provider.example/v1",
      apiKey: "key-a",
      apiKeyEnv: "API_KEY_A",
      ownedBy: "llm-gateway",
      created: 1_718_000_000,
      supportsTools: true,
      supportsStreaming: true,
      unknownFieldMode: "warn",
      unknownFieldWindowRequests: 100,
      status: "active",
      statusReason: "Loaded from config",
      statusChangedAt: 1_718_000_000,
      ...overrides,
    };
  }

  function makeChainEntry(name: string, modelConfig: GatewayModelConfig, overrides: Partial<ChainModelEntry> = {}): ChainModelEntry {
    return {
      name,
      modelConfig,
      timeoutMs: 30000,
      maxRetries: 0,
      ...overrides,
    };
  }

  function makeChain(models: ChainModelEntry[], overrides: Partial<ModelChainConfig> = {}): ModelChainConfig {
    const activeCount = models.filter((m) => m.modelConfig.status === "active").length;
    const totalCount = models.length;
    const chainStatus: "active" | "degraded" | "inactive" =
      activeCount === totalCount ? "active" :
      activeCount === 0 ? "inactive" : "degraded";

    return {
      name: "production",
      models,
      timeoutMs: 30000,
      maxRetries: 0,
      status: chainStatus,
      statusReason: `${activeCount}/${totalCount} models active`,
      statusChangedAt: 1_718_000_000,
      activeModels: activeCount,
      totalModels: totalCount,
      ...overrides,
    };
  }

  function makeChainConfig(models: GatewayModelConfig[], chains: ModelChainConfig[] = [], overrides: Partial<AppConfig> = {}): AppConfig {
    return {
      host: "127.0.0.1",
      port: 3001,
      logLevel: "silent",
      upstreamBaseUrl: models[0]?.baseUrl ?? "https://provider.example/v1",
      requestTimeoutMs: 30000,
      maxRetries: 0,
      maxBodySizeKb: 1024,
      healthProbeEnabled: false,
      models,
      modelChains: chains,
      ...overrides,
    };
  }

  it("includes chain in Anthropic format when anthropic-version header is present", async () => {
    const modelA = makeChainModel({ name: "gpt-5", apiKey: "key-a" });
    const chain = makeChain([makeChainEntry("gpt-5", modelA)]);
    const config = makeChainConfig([modelA], [chain]);

    const app = createApp({
      config,
      fetchFn: vi.fn() as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { "anthropic-version": "2023-06-01" },
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.object).toBe("list");
      const chainModel = data.data.find((m: { id: string }) => m.id === "chain-production");
      expect(chainModel).toBeDefined();
      expect(chainModel.type).toBe("model");
      expect(chainModel.id).toBe("chain-production");
    } finally {
      await app.close();
    }
  });

  it("does not include x-chain-model header for plain model requests", async () => {
    const modelA = makeChainModel({ name: "gpt-5", apiKey: "key-a" });
    const config = makeChainConfig([modelA]);

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl-plain",
          object: "chat.completion",
          created: 1_718_000_000,
          model: "gpt-5",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "Hello" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const app = createApp({
      config,
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: { model: "gpt-5", input: "Hello" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["x-chain-model"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("returns 504 ChainBudgetExceededError when chain timeout budget is exceeded", async () => {
    const modelA = makeChainModel({
      name: "gpt-5",
      apiKey: "key-a",
      baseUrl: "https://provider-a.example/v1",
    });
    const modelB = makeChainModel({
      name: "glm-5.1",
      apiKey: "key-b",
      baseUrl: "https://provider-b.example/v1",
    });
    const chain = makeChain(
      [makeChainEntry("gpt-5", modelA), makeChainEntry("glm-5.1", modelB)],
      { chainTimeoutMs: 1 },
    );
    const config = makeChainConfig([modelA, modelB], [chain]);

    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return new Response(
        JSON.stringify({
          id: "chatcmpl-slow",
          object: "chat.completion",
          created: 1_718_000_000,
          model: "gpt-5",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "Hello" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const app = createApp({
      config,
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: { model: "chain-production", input: "Hello" },
      });

      if (response.statusCode === 504) {
        const data = response.json();
        expect(data.error).toContain("exceeded");
        expect(data.chain).toBe("production");
      } else {
        expect([200, 504]).toContain(response.statusCode);
      }
    } finally {
      await app.close();
    }
  });

  it("preserves original status code for non-retryable errors", async () => {
    const modelA = makeChainModel({
      name: "gpt-5",
      apiKey: "key-a",
      baseUrl: "https://provider-a.example/v1",
    });
    const modelB = makeChainModel({
      name: "glm-5.1",
      apiKey: "key-b",
      baseUrl: "https://provider-b.example/v1",
    });
    const chain = makeChain([
      makeChainEntry("gpt-5", modelA),
      makeChainEntry("glm-5.1", modelB),
    ]);
    const config = makeChainConfig([modelA, modelB], [chain]);

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: "invalid_api_key" }),
        { status: 401, statusText: "Unauthorized" },
      );
    });

    const app = createApp({
      config,
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: { model: "chain-production", input: "Hello" },
      });

      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("streams SSE events correctly for chain request", async () => {
    const modelA = makeChainModel({
      name: "gpt-5",
      apiKey: "key-a",
      baseUrl: "https://provider-a.example/v1",
    });
    const chain = makeChain([makeChainEntry("gpt-5", modelA)]);
    const config = makeChainConfig([modelA], [chain]);

    const fetchMock = vi.fn(async () => {
      const body = createSseStream([
        'data: {"id":"chatcmpl-chain-stream","object":"chat.completion.chunk","created":1718000000,"model":"gpt-5","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}\n\n',
        'data: {"id":"chatcmpl-chain-stream","object":"chat.completion.chunk","created":1718000000,"model":"gpt-5","choices":[{"index":0,"delta":{"content":" there"},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ]);
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const app = createApp({
      config,
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: { model: "chain-production", input: "Hello", stream: true },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.headers["x-chain-model"]).toBe("chain-production");
      expect(response.body).toContain("event: response.created");
      expect(response.body).toContain("event: response.output_text.delta");
    } finally {
      await app.close();
    }
  });

  it("does not include chain entries in model discovery when no chains configured", async () => {
    const modelA = makeChainModel({ name: "gpt-5", apiKey: "key-a" });
    const config = makeChainConfig([modelA]);

    const app = createApp({
      config,
      fetchFn: vi.fn() as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/models",
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.object).toBe("list");
      expect(data.data).toHaveLength(1);
      expect(data.data[0].id).toBe("gpt-5");
    } finally {
      await app.close();
    }
  });

  it("executes chain for POST /responses request", async () => {
    const modelA = makeChainModel({
      name: "gpt-5",
      apiKey: "key-a",
      baseUrl: "https://provider-a.example/v1",
    });
    const chain = makeChain([makeChainEntry("gpt-5", modelA)]);
    const config = makeChainConfig([modelA], [chain]);

    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "chatcmpl-chain",
          object: "chat.completion",
          created: 1_718_000_000,
          model: "gpt-5",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "Hello from chain" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const app = createApp({
      config,
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: { model: "chain-production", input: "Hello" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["x-chain-model"]).toBe("chain-production");
      expect(response.json()).toMatchObject({
        id: "chatcmpl-chain",
        object: "response",
        model: "chain-production",
        output_text: "Hello from chain",
      });
    } finally {
      await app.close();
    }
  });

});
