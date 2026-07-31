import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { type AppConfig, type GatewayModelConfig } from "../src/config.js";
import type { ChainModelEntry, ModelChainConfig } from "../src/contracts.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<GatewayModelConfig> = {}): GatewayModelConfig {
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

function makeConfig(models: GatewayModelConfig[], chains: ModelChainConfig[] = [], overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: "127.0.0.1",
    port: 3001,
    logLevel: "silent",
    upstreamBaseUrl: models[0]?.baseUrl ?? "https://provider.example/v1",
    requestTimeoutMs: 30000,
    maxRetries: 0,
    maxBodySizeKb: 1024,
    healthProbeEnabled: false,
  workspace: { enabled: false },
    models,
    modelChains: chains,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Chain handler integration", () => {
  // --- Chain model discovery ---

  it("includes chain virtual models in /v1/models list", async () => {
    const modelA = makeModel({ name: "gpt-5", apiKey: "key-a" });
    const modelB = makeModel({ name: "glm-5.1", apiKey: "key-b", baseUrl: "https://provider-b.example/v1" });
    const chain = makeChain([
      makeChainEntry("gpt-5", modelA),
      makeChainEntry("glm-5.1", modelB),
    ]);
    const config = makeConfig([modelA, modelB], [chain]);

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
      expect(data.data).toHaveLength(3); // 2 models + 1 chain

      const chainModel = data.data.find((m: { id: string }) => m.id === "chain-production");
      expect(chainModel).toBeDefined();
      expect(chainModel.owned_by).toBe("llm-gateway-chain");
      expect(chainModel.capabilities.supports_streaming).toBe(true);
      expect(chainModel.capabilities.supports_tool_calls).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("returns chain model detail from /v1/models/chain-<name>", async () => {
    const modelA = makeModel({ name: "gpt-5", apiKey: "key-a" });
    const chain = makeChain([makeChainEntry("gpt-5", modelA)]);
    const config = makeConfig([modelA], [chain]);

    const app = createApp({
      config,
      fetchFn: vi.fn() as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/models/chain-production",
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.id).toBe("chain-production");
      expect(data.owned_by).toBe("llm-gateway-chain");
    } finally {
      await app.close();
    }
  });

  it("returns 404 for unknown chain in /v1/models/chain-<name>", async () => {
    const modelA = makeModel({ name: "gpt-5", apiKey: "key-a" });
    const config = makeConfig([modelA], []);

    const app = createApp({
      config,
      fetchFn: vi.fn() as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/models/chain-nonexistent",
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: "Chain `nonexistent` is not configured.",
      });
    } finally {
      await app.close();
    }
  });

  // --- Chain execution via /responses ---

  it("executes chain for non-stream /responses request and sets x-chain-model header", async () => {
    const modelA = makeModel({
      name: "gpt-5",
      apiKey: "key-a",
      baseUrl: "https://provider-a.example/v1",
      upstreamModel: "gpt-5-upstream",
    });
    const modelB = makeModel({
      name: "glm-5.1",
      apiKey: "key-b",
      baseUrl: "https://provider-b.example/v1",
      upstreamModel: "glm-5.1-upstream",
    });
    const chain = makeChain([
      makeChainEntry("gpt-5", modelA),
      makeChainEntry("glm-5.1", modelB),
    ]);
    const config = makeConfig([modelA, modelB], [chain]);

    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = input.toString();
      // First model succeeds
      if (url.includes("provider-a.example")) {
        return new Response(
          JSON.stringify({
            id: "chatcmpl-chain",
            object: "chat.completion",
            created: 1_718_000_000,
            model: "gpt-5-upstream",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: "Hello from chain",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }
      // Second model should not be called
      return new Response("unexpected call", { status: 500 });
    });

    const app = createApp({
      config,
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: {
          model: "chain-production",
          input: "Hello",
        },
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

  it("falls back to second model in chain when first fails with retryable error", async () => {
    const modelA = makeModel({
      name: "gpt-5",
      apiKey: "key-a",
      baseUrl: "https://provider-a.example/v1",
    });
    const modelB = makeModel({
      name: "glm-5.1",
      apiKey: "key-b",
      baseUrl: "https://provider-b.example/v1",
    });
    const chain = makeChain([
      makeChainEntry("gpt-5", modelA),
      makeChainEntry("glm-5.1", modelB),
    ]);
    const config = makeConfig([modelA, modelB], [chain]);

    let callCount = 0;
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      callCount++;
      const url = input.toString();

      if (url.includes("provider-a.example")) {
        // First model fails with 503 (retryable)
        return new Response(
          JSON.stringify({ error: "Service unavailable" }),
          { status: 503, statusText: "Service Unavailable" },
        );
      }

      if (url.includes("provider-b.example")) {
        // Second model succeeds
        return new Response(
          JSON.stringify({
            id: "chatcmpl-fallback",
            object: "chat.completion",
            created: 1_718_000_000,
            model: "glm-5.1",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: "Hello from fallback",
                },
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }

      return new Response("unexpected", { status: 500 });
    });

    const app = createApp({
      config,
      fetchFn: fetchMock as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: {
          model: "chain-production",
          input: "Hello",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["x-chain-model"]).toBe("chain-production");
      expect(response.json().output_text).toBe("Hello from fallback");
      expect(callCount).toBe(2); // First model tried, then second
    } finally {
      await app.close();
    }
  });

  it("returns 502 ChainExhaustedError when all models fail with retryable errors", async () => {
    const modelA = makeModel({
      name: "gpt-5",
      apiKey: "key-a",
      baseUrl: "https://provider-a.example/v1",
    });
    const modelB = makeModel({
      name: "glm-5.1",
      apiKey: "key-b",
      baseUrl: "https://provider-b.example/v1",
    });
    const chain = makeChain([
      makeChainEntry("gpt-5", modelA),
      makeChainEntry("glm-5.1", modelB),
    ]);
    const config = makeConfig([modelA, modelB], [chain]);

    const fetchMock = vi.fn(async () => {
      // All models fail with 503 (retryable)
      return new Response(
        JSON.stringify({ error: "Service unavailable" }),
        { status: 503, statusText: "Service Unavailable" },
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
        payload: {
          model: "chain-production",
          input: "Hello",
        },
      });

      expect(response.statusCode).toBe(502);
      const data = response.json();
      expect(data.error).toContain("exhausted");
      expect(data.chain).toBe("production");
      expect(data.modelsTried).toBe(2);
    } finally {
      await app.close();
    }
  });

  // --- Chain execution via /v1/chat/completions ---

  it("executes chain for non-stream /v1/chat/completions request", async () => {
    const modelA = makeModel({
      name: "gpt-5",
      apiKey: "key-a",
      baseUrl: "https://provider-a.example/v1",
    });
    const chain = makeChain([makeChainEntry("gpt-5", modelA)]);
    const config = makeConfig([modelA], [chain]);

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-chain",
          object: "chat.completion",
          created: 1_718_000_000,
          model: "gpt-5",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "Hello from chain",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
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
        url: "/v1/chat/completions",
        payload: {
          model: "chain-production",
          messages: [{ role: "user", content: "Hello" }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["x-chain-model"]).toBe("chain-production");
      expect(response.json()).toMatchObject({
        id: "chatcmpl-chain",
        object: "chat.completion",
      });
    } finally {
      await app.close();
    }
  });

  // --- Chain execution via /v1/messages ---

  it("executes chain for non-stream /v1/messages request", async () => {
    const modelA = makeModel({
      name: "gpt-5",
      apiKey: "key-a",
      baseUrl: "https://provider-a.example/v1",
    });
    const chain = makeChain([makeChainEntry("gpt-5", modelA)]);
    const config = makeConfig([modelA], [chain]);

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-chain",
          object: "chat.completion",
          created: 1_718_000_000,
          model: "gpt-5",
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "Hello from chain",
              },
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
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
        payload: {
          model: "chain-production",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 100,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["x-chain-model"]).toBe("chain-production");
      const data = response.json();
      expect(data.type).toBe("message");
      expect(data.model).toBe("chain-production");
    } finally {
      await app.close();
    }
  });

  // --- Chain capability checks ---

  it("rejects streaming request when first model in chain does not support streaming", async () => {
    const modelA = makeModel({
      name: "gpt-5",
      apiKey: "key-a",
      supportsStreaming: false,
    });
    const chain = makeChain([makeChainEntry("gpt-5", modelA)]);
    const config = makeConfig([modelA], [chain]);

    const app = createApp({
      config,
      fetchFn: vi.fn() as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: {
          model: "chain-production",
          input: "Hello",
          stream: true,
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain("does not support streaming");
    } finally {
      await app.close();
    }
  });

  it("rejects tool request when first model in chain does not support tools", async () => {
    const modelA = makeModel({
      name: "gpt-5",
      apiKey: "key-a",
      supportsTools: false,
    });
    const chain = makeChain([makeChainEntry("gpt-5", modelA)]);
    const config = makeConfig([modelA], [chain]);

    const app = createApp({
      config,
      fetchFn: vi.fn() as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: {
          model: "chain-production",
          input: "Hello",
          tools: [{ type: "function", name: "test" }],
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain("does not support tools");
    } finally {
      await app.close();
    }
  });
});
