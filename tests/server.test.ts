import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { type AppConfig } from "../src/config.js";

const compatibilityInstructions =
  "You are a helpful AI assistant. Follow developer and user instructions, keep responses accurate, and prefer concise plain-text output unless the caller asks for a specific format.";

const singleModelConfig: AppConfig = {
  host: "127.0.0.1",
  port: 3001,
  logLevel: "silent",
  upstreamBaseUrl: "https://provider.example/v1",
  defaultModel: "glm-5.1",
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
      unknownFieldMode: "warn",
    },
  ],
};

const multiModelConfig: AppConfig = {
  host: "127.0.0.1",
  port: 3001,
  logLevel: "silent",
  upstreamBaseUrl: "https://provider-a.example/v1",
  defaultModel: "glm-5.1",
  models: [
    {
      name: "glm-5.1",
      upstreamModel: "glm-5.1",
      baseUrl: "https://provider-a.example/v1",
      apiKey: "api-key-a",
      ownedBy: "zhipu",
      created: 1_718_000_000,
      supportsTools: true,
      supportsStreaming: true,
      unknownFieldMode: "warn",
    },
    {
      name: "coder-alias",
      upstreamModel: "provider-internal-coder",
      baseUrl: "https://provider-b.example/v1",
      apiKey: "api-key-b",
      ownedBy: "custom-provider",
      created: 1_718_000_001,
      supportsTools: true,
      supportsStreaming: true,
      unknownFieldMode: "warn",
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
      expect(response.json()).toEqual({ ok: true });
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
});
