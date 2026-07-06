import type { FastifyInstance } from "fastify";
import type { RawData, WebSocket } from "ws";
import type {
  CopilotProxyGatewayMessage,
  CopilotProxyModel,
} from "@llm-gateway/shared";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const copilotModel: CopilotProxyModel = {
  id: "copilot-gpt-4o",
  name: "GPT-4o via Copilot",
  native_id: "gpt-4o",
  source: "copilot-proxy",
  capabilities: {
    supports_streaming: true,
    supports_tools: false,
    supports_usage: false,
    supports_progress: true,
  },
};

const config: AppConfig = {
  host: "127.0.0.1",
  port: 3001,
  logLevel: "silent",
  upstreamBaseUrl: "https://provider.example/v1",
  defaultModel: "glm-5.1",
  requestTimeoutMs: 30000,
  maxRetries: 0,
  maxBodySizeKb: 1024,
  gatewayAuthToken: "gateway-token",
  healthProbeEnabled: false,
  copilotProxy: {
    enabled: true,
    requireTokenAuth: true,
    tokenTtlSeconds: 60,
    heartbeatIntervalMs: 20,
    heartbeatTimeoutMs: 100,
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
      unknownFieldMode: "warn",
      unknownFieldWindowRequests: 100,
    },
  ],
};

function decodeMessage(data: RawData): unknown {
  const raw = Array.isArray(data)
    ? Buffer.concat(data).toString("utf8")
    : data.toString();
  return JSON.parse(raw) as unknown;
}

async function issueProxyToken(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/proxy-token",
    headers: {
      "x-api-key": "gateway-token",
    },
  });

  expect(response.statusCode).toBe(201);
  return (response.json() as { token: string }).token;
}

function waitForMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    ws.once("message", (data) => {
      resolve(decodeMessage(data));
    });
  });
}

async function waitForGatewayMessage(
  ws: WebSocket,
  type: CopilotProxyGatewayMessage["type"],
): Promise<CopilotProxyGatewayMessage> {
  while (true) {
    const message = await waitForMessage(ws);
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === type
    ) {
      return message as CopilotProxyGatewayMessage;
    }
  }
}

function waitForClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.once("close", (code) => {
      resolve(code);
    });
  });
}

async function waitForModel(
  app: FastifyInstance,
  modelId: string,
  present: boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
    });
    const body = response.json() as { data: Array<{ id: string }> };
    const found = body.data.some((model) => model.id === modelId);
    if (found === present) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(
    `Expected model ${modelId} to be ${present ? "present" : "absent"} in /v1/models.`,
  );
}

describe("Copilot proxy WebSocket", () => {
  it("rejects unauthorized WebSocket connections", async () => {
    const app = createApp({ config });

    try {
      await app.ready();
      const ws = await app.injectWS("/ws/copilot-proxy?token=cpx_invalid");
      const closeCode = await waitForClose(ws);

      expect(closeCode).toBe(1008);
    } finally {
      await app.close();
    }
  });

  it("accepts WebSocket connections without token when token auth is disabled", async () => {
    const app = createApp({
      config: {
        ...config,
        copilotProxy: {
          ...config.copilotProxy!,
          requireTokenAuth: false,
        },
      },
    });

    try {
      await app.ready();
      const ws = await app.injectWS("/ws/copilot-proxy");

      const message = await waitForMessage(ws);
      expect(message).toEqual({ type: "ping" });

      ws.send(JSON.stringify({ type: "pong" }));
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("registers models from an authorized extension and exposes them in discovery", async () => {
    const app = createApp({ config });

    try {
      await app.ready();
      const token = await issueProxyToken(app);
      const ws = await app.injectWS(`/ws/copilot-proxy?token=${encodeURIComponent(token)}`);

      ws.send(
        JSON.stringify({
          type: "register",
          extension_version: "0.1.0",
          copilot_status: "connected",
          models: [copilotModel],
        }),
      );

      await waitForModel(app, "copilot-gpt-4o", true);

      const detail = await app.inject({
        method: "GET",
        url: "/models/copilot-gpt-4o",
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({
        id: "copilot-gpt-4o",
        source: "copilot-proxy",
        owned_by: "github-copilot",
        capabilities: {
          supports_responses_api: true,
          supports_streaming: true,
          supports_tool_calls: false,
        },
      });

      ws.close();
    } finally {
      await app.close();
    }
  });

  it("removes registered models when the extension disconnects", async () => {
    const app = createApp({ config });

    try {
      await app.ready();
      const token = await issueProxyToken(app);
      const ws = await app.injectWS(`/ws/copilot-proxy?token=${encodeURIComponent(token)}`);

      ws.send(
        JSON.stringify({
          type: "register",
          extension_version: "0.1.0",
          copilot_status: "connected",
          models: [copilotModel],
        }),
      );
      await waitForModel(app, "copilot-gpt-4o", true);

      ws.send(JSON.stringify({ type: "disconnect", reason: "test complete" }));
      await waitForClose(ws);
      await waitForModel(app, "copilot-gpt-4o", false);
    } finally {
      await app.close();
    }
  });

  it("sends heartbeat ping frames and accepts pong responses", async () => {
    const app = createApp({ config });

    try {
      await app.ready();
      const token = await issueProxyToken(app);
      const ws = await app.injectWS(`/ws/copilot-proxy?token=${encodeURIComponent(token)}`);

      const message = await waitForMessage(ws);
      expect(message).toEqual({ type: "ping" });

      ws.send(JSON.stringify({ type: "pong" }));
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("rejects invalid model registrations", async () => {
    const app = createApp({ config });

    try {
      await app.ready();
      const token = await issueProxyToken(app);
      const ws = await app.injectWS(`/ws/copilot-proxy?token=${encodeURIComponent(token)}`);

      ws.send(
        JSON.stringify({
          type: "register",
          extension_version: "0.1.0",
          copilot_status: "connected",
          models: [{ ...copilotModel, id: "gpt-4o" }],
        }),
      );

      const closeCode = await waitForClose(ws);
      expect(closeCode).toBe(1003);
      await waitForModel(app, "copilot-gpt-4o", false);
    } finally {
      await app.close();
    }
  });

  it("preserves direct and Copilot-backed model records when native names collide", async () => {
    const app = createApp({
      config: {
        ...config,
        defaultModel: "gpt-4o",
        models: [
          {
            ...config.models[0]!,
            name: "gpt-4o",
            upstreamModel: "gpt-4o",
          },
        ],
      },
    });

    try {
      await app.ready();
      const token = await issueProxyToken(app);
      const ws = await app.injectWS(`/ws/copilot-proxy?token=${encodeURIComponent(token)}`);
      ws.send(
        JSON.stringify({
          type: "register",
          extension_version: "0.1.0",
          copilot_status: "connected",
          models: [copilotModel],
        }),
      );
      await waitForModel(app, "copilot-gpt-4o", true);

      const response = await app.inject({
        method: "GET",
        url: "/v1/models",
      });
      const ids = (response.json() as { data: Array<{ id: string }> }).data.map(
        (entry) => entry.id,
      );
      expect(ids).toContain("gpt-4o");
      expect(ids).toContain("copilot-gpt-4o");
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("routes non-stream OpenAI chat completions through the extension", async () => {
    const app = createApp({ config });

    try {
      await app.ready();
      const token = await issueProxyToken(app);
      const ws = await app.injectWS(`/ws/copilot-proxy?token=${encodeURIComponent(token)}`);
      ws.send(
        JSON.stringify({
          type: "register",
          extension_version: "0.1.0",
          copilot_status: "connected",
          models: [copilotModel],
        }),
      );
      await waitForModel(app, "copilot-gpt-4o", true);

      const responsePromise = app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "x-api-key": "gateway-token",
        },
        payload: {
          model: "copilot-gpt-4o",
          messages: [{ role: "user", content: "Hello" }],
        },
      });

      const requestMessage = await waitForGatewayMessage(ws, "request");
      expect(requestMessage).toMatchObject({
        type: "request",
        model: "copilot-gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      });

      ws.send(
        JSON.stringify({
          type: "stream_delta",
          id: requestMessage.id,
          content_type: "text",
          content: "Hello from Copilot",
        }),
      );
      ws.send(
        JSON.stringify({
          type: "stream_done",
          id: requestMessage.id,
          usage: {
            input_tokens: 4,
            output_tokens: 3,
            total_tokens: 7,
          },
        }),
      );

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        object: "chat.completion",
        model: "copilot-gpt-4o",
        choices: [
          {
            message: {
              role: "assistant",
              content: "Hello from Copilot",
            },
          },
        ],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 3,
          total_tokens: 7,
        },
      });
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("routes non-stream Responses requests through the extension", async () => {
    const app = createApp({ config });

    try {
      await app.ready();
      const token = await issueProxyToken(app);
      const ws = await app.injectWS(`/ws/copilot-proxy?token=${encodeURIComponent(token)}`);
      ws.send(
        JSON.stringify({
          type: "register",
          extension_version: "0.1.0",
          copilot_status: "connected",
          models: [copilotModel],
        }),
      );
      await waitForModel(app, "copilot-gpt-4o", true);

      const responsePromise = app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: {
          "x-api-key": "gateway-token",
        },
        payload: {
          model: "copilot-gpt-4o",
          instructions: "Be concise.",
          input: "Hello",
        },
      });

      const requestMessage = await waitForGatewayMessage(ws, "request");
      expect(requestMessage).toMatchObject({
        type: "request",
        model: "copilot-gpt-4o",
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "Hello" },
        ],
      });

      ws.send(
        JSON.stringify({
          type: "stream_delta",
          id: requestMessage.id,
          content_type: "text",
          content: "Hello from Copilot",
        }),
      );
      ws.send(
        JSON.stringify({
          type: "stream_done",
          id: requestMessage.id,
          usage: {
            input_tokens: 4,
            output_tokens: 3,
            total_tokens: 7,
          },
        }),
      );

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        object: "response",
        model: "copilot-gpt-4o",
        output_text: "Hello from Copilot",
        usage: {
          input_tokens: 4,
          output_tokens: 3,
          total_tokens: 7,
        },
      });
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("returns an error when the extension disconnects during an in-flight request", async () => {
    const app = createApp({ config });

    try {
      await app.ready();
      const token = await issueProxyToken(app);
      const ws = await app.injectWS(`/ws/copilot-proxy?token=${encodeURIComponent(token)}`);
      ws.send(
        JSON.stringify({
          type: "register",
          extension_version: "0.1.0",
          copilot_status: "connected",
          models: [copilotModel],
        }),
      );
      await waitForModel(app, "copilot-gpt-4o", true);

      const responsePromise = app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "x-api-key": "gateway-token",
        },
        payload: {
          model: "copilot-gpt-4o",
          messages: [{ role: "user", content: "Hello" }],
        },
      });

      await waitForGatewayMessage(ws, "request");
      ws.send(JSON.stringify({ type: "disconnect", reason: "test disconnect" }));

      const response = await responsePromise;
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        error: {
          message: "Copilot proxy extension disconnected before the request completed.",
          type: "api_error",
        },
      });
    } finally {
      await app.close();
    }
  });

  it("routes streaming OpenAI chat completions through the extension", async () => {
    const app = createApp({ config });

    try {
      await app.ready();
      const token = await issueProxyToken(app);
      const ws = await app.injectWS(`/ws/copilot-proxy?token=${encodeURIComponent(token)}`);
      ws.send(
        JSON.stringify({
          type: "register",
          extension_version: "0.1.0",
          copilot_status: "connected",
          models: [copilotModel],
        }),
      );
      await waitForModel(app, "copilot-gpt-4o", true);

      const responsePromise = app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "x-api-key": "gateway-token",
        },
        payload: {
          model: "copilot-gpt-4o",
          messages: [{ role: "user", content: "Hello" }],
          stream: true,
        },
      });

      const requestMessage = await waitForGatewayMessage(ws, "request");
      expect(requestMessage).toMatchObject({
        type: "request",
        model: "copilot-gpt-4o",
        params: { stream: true },
      });

      ws.send(
        JSON.stringify({
          type: "stream_delta",
          id: requestMessage.id,
          content_type: "text",
          content: "Hi",
        }),
      );
      ws.send(JSON.stringify({ type: "stream_done", id: requestMessage.id }));

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.body).toContain('"content":"Hi"');
      expect(response.body).toContain("data: [DONE]");
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("routes streaming Responses requests through the extension", async () => {
    const app = createApp({ config });

    try {
      await app.ready();
      const token = await issueProxyToken(app);
      const ws = await app.injectWS(`/ws/copilot-proxy?token=${encodeURIComponent(token)}`);
      ws.send(
        JSON.stringify({
          type: "register",
          extension_version: "0.1.0",
          copilot_status: "connected",
          models: [copilotModel],
        }),
      );
      await waitForModel(app, "copilot-gpt-4o", true);

      const responsePromise = app.inject({
        method: "POST",
        url: "/responses",
        headers: {
          "x-api-key": "gateway-token",
        },
        payload: {
          model: "copilot-gpt-4o",
          input: "Hello",
          stream: true,
        },
      });

      const requestMessage = await waitForGatewayMessage(ws, "request");
      expect(requestMessage).toMatchObject({
        type: "request",
        model: "copilot-gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        params: { stream: true },
      });

      ws.send(
        JSON.stringify({
          type: "stream_delta",
          id: requestMessage.id,
          content_type: "text",
          content: "Hi",
        }),
      );
      ws.send(
        JSON.stringify({
          type: "stream_delta",
          id: requestMessage.id,
          content_type: "text",
          content: " there",
        }),
      );
      ws.send(
        JSON.stringify({
          type: "stream_done",
          id: requestMessage.id,
          usage: {
            input_tokens: 2,
            output_tokens: 2,
            total_tokens: 4,
          },
        }),
      );

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.body).toContain("event: response.created");
      expect(response.body).toContain("event: response.output_item.added");
      expect(response.body).toContain("event: response.output_text.delta");
      expect(response.body).toContain("\"delta\":\"Hi\"");
      expect(response.body).toContain("\"delta\":\" there\"");
      expect(response.body).toContain("event: response.completed");
      expect(response.body).toContain("\"model\":\"copilot-gpt-4o\"");
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("routes non-stream Anthropic messages through the extension", async () => {
    const app = createApp({ config });

    try {
      await app.ready();
      const token = await issueProxyToken(app);
      const ws = await app.injectWS(`/ws/copilot-proxy?token=${encodeURIComponent(token)}`);
      ws.send(
        JSON.stringify({
          type: "register",
          extension_version: "0.1.0",
          copilot_status: "connected",
          models: [copilotModel],
        }),
      );
      await waitForModel(app, "copilot-gpt-4o", true);

      const responsePromise = app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: {
          "x-api-key": "gateway-token",
        },
        payload: {
          model: "copilot-gpt-4o",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 100,
        },
      });

      const requestMessage = await waitForGatewayMessage(ws, "request");
      ws.send(
        JSON.stringify({
          type: "stream_delta",
          id: requestMessage.id,
          content_type: "text",
          content: "Anthropic via Copilot",
        }),
      );
      ws.send(JSON.stringify({ type: "stream_done", id: requestMessage.id }));

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        type: "message",
        role: "assistant",
        model: "copilot-gpt-4o",
        content: [{ type: "text", text: "Anthropic via Copilot" }],
      });
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("clamps tiny Anthropic max_tokens values on Copilot requests", async () => {
    const app = createApp({ config });

    try {
      await app.ready();
      const token = await issueProxyToken(app);
      const ws = await app.injectWS(`/ws/copilot-proxy?token=${encodeURIComponent(token)}`);
      ws.send(
        JSON.stringify({
          type: "register",
          extension_version: "0.1.0",
          copilot_status: "connected",
          models: [copilotModel],
        }),
      );
      await waitForModel(app, "copilot-gpt-4o", true);

      const responsePromise = app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: {
          "x-api-key": "gateway-token",
        },
        payload: {
          model: "copilot-gpt-4o",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 1,
        },
      });

      const requestMessage = await waitForGatewayMessage(ws, "request");
      expect(requestMessage).toMatchObject({
        type: "request",
        model: "copilot-gpt-4o",
        params: {
          max_tokens: 16,
        },
      });

      ws.send(
        JSON.stringify({
          type: "stream_delta",
          id: requestMessage.id,
          content_type: "text",
          content: "Anthropic via Copilot",
        }),
      );
      ws.send(JSON.stringify({ type: "stream_done", id: requestMessage.id }));

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("routes streaming Anthropic messages through the extension", async () => {
    const app = createApp({ config });

    try {
      await app.ready();
      const token = await issueProxyToken(app);
      const ws = await app.injectWS(`/ws/copilot-proxy?token=${encodeURIComponent(token)}`);
      ws.send(
        JSON.stringify({
          type: "register",
          extension_version: "0.1.0",
          copilot_status: "connected",
          models: [copilotModel],
        }),
      );
      await waitForModel(app, "copilot-gpt-4o", true);

      const responsePromise = app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: {
          "x-api-key": "gateway-token",
        },
        payload: {
          model: "copilot-gpt-4o",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 100,
          stream: true,
        },
      });

      const requestMessage = await waitForGatewayMessage(ws, "request");
      ws.send(
        JSON.stringify({
          type: "stream_delta",
          id: requestMessage.id,
          content_type: "text",
          content: "Streamed Anthropic",
        }),
      );
      ws.send(JSON.stringify({ type: "stream_done", id: requestMessage.id }));

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.body).toContain("event: message_start");
      expect(response.body).toContain("event: content_block_delta");
      expect(response.body).toContain("Streamed Anthropic");
      expect(response.body).toContain("event: message_stop");
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("clamps tiny Responses max_output_tokens values on Copilot requests", async () => {
    const app = createApp({ config });

    try {
      await app.ready();
      const token = await issueProxyToken(app);
      const ws = await app.injectWS(`/ws/copilot-proxy?token=${encodeURIComponent(token)}`);
      ws.send(
        JSON.stringify({
          type: "register",
          extension_version: "0.1.0",
          copilot_status: "connected",
          models: [copilotModel],
        }),
      );
      await waitForModel(app, "copilot-gpt-4o", true);

      const responsePromise = app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: {
          "x-api-key": "gateway-token",
        },
        payload: {
          model: "copilot-gpt-4o",
          input: "Hello",
          max_output_tokens: 1,
        },
      });

      const requestMessage = await waitForGatewayMessage(ws, "request");
      expect(requestMessage).toMatchObject({
        type: "request",
        model: "copilot-gpt-4o",
        params: {
          max_tokens: 16,
        },
      });

      ws.send(
        JSON.stringify({
          type: "stream_delta",
          id: requestMessage.id,
          content_type: "text",
          content: "Hello from Copilot",
        }),
      );
      ws.send(JSON.stringify({ type: "stream_done", id: requestMessage.id }));

      const response = await responsePromise;
      expect(response.statusCode).toBe(200);
      ws.close();
    } finally {
      await app.close();
    }
  });

  it("returns endpoint-native 503 when a Copilot model has no connected extension", async () => {
    const app = createApp({ config });

    try {
      const openAiResponse = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "x-api-key": "gateway-token",
        },
        payload: {
          model: "copilot-gpt-4o",
          messages: [{ role: "user", content: "Hello" }],
        },
      });
      expect(openAiResponse.statusCode).toBe(503);
      expect(openAiResponse.json()).toEqual({
        error: {
          message: "Copilot models unavailable — VS Code extension not connected.",
          type: "api_error",
        },
      });

      const anthropicResponse = await app.inject({
        method: "POST",
        url: "/v1/messages",
        headers: {
          "x-api-key": "gateway-token",
        },
        payload: {
          model: "copilot-gpt-4o",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 100,
        },
      });
      expect(anthropicResponse.statusCode).toBe(503);
      expect(anthropicResponse.json()).toEqual({
        type: "error",
        error: {
          type: "api_error",
          message: "Copilot models unavailable — VS Code extension not connected.",
        },
      });

      const responsesResponse = await app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: {
          "x-api-key": "gateway-token",
        },
        payload: {
          model: "copilot-gpt-4o",
          input: "Hello",
        },
      });
      expect(responsesResponse.statusCode).toBe(503);
      expect(responsesResponse.json()).toEqual({
        error: "Copilot models unavailable — VS Code extension not connected.",
      });
    } finally {
      await app.close();
    }
  });

  it("rejects tool requests when the extension reports no tool support", async () => {
    const app = createApp({ config });

    try {
      await app.ready();
      const token = await issueProxyToken(app);
      const ws = await app.injectWS(`/ws/copilot-proxy?token=${encodeURIComponent(token)}`);
      ws.send(
        JSON.stringify({
          type: "register",
          extension_version: "0.1.0",
          copilot_status: "connected",
          models: [copilotModel],
        }),
      );
      await waitForModel(app, "copilot-gpt-4o", true);

      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          "x-api-key": "gateway-token",
        },
        payload: {
          model: "copilot-gpt-4o",
          messages: [{ role: "user", content: "Hello" }],
          tools: [
            {
              type: "function",
              function: {
                name: "lookup",
              },
            },
          ],
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: {
          message: "Model `copilot-gpt-4o` does not support tools.",
          type: "invalid_request_error",
        },
      });

      const responsesResponse = await app.inject({
        method: "POST",
        url: "/v1/responses",
        headers: {
          "x-api-key": "gateway-token",
        },
        payload: {
          model: "copilot-gpt-4o",
          input: "Hello",
          tools: [
            {
              type: "function",
              name: "lookup",
            },
          ],
        },
      });
      expect(responsesResponse.statusCode).toBe(400);
      expect(responsesResponse.json()).toEqual({
        error: "Model `copilot-gpt-4o` does not support tools.",
      });
      ws.close();
    } finally {
      await app.close();
    }
  });
});
