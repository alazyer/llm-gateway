import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { type AppConfig, type GatewayModelConfig } from "../src/config.js";
import type { ChainModelEntry, ModelChainConfig } from "../src/contracts.js";
import {
  ChainInactiveError,
  filterActiveModels,
  isChainDegraded,
} from "../src/chain-executor.js";

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
inputModalities: ["text"],
outputModalities: ["text"],
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
// Unit tests: filterActiveModels and isChainDegraded
// ---------------------------------------------------------------------------

describe("filterActiveModels", () => {
  it("returns all models when all are active", () => {
    const modelA = makeModel({ name: "gpt-5", status: "active" });
    const modelB = makeModel({ name: "glm-5", status: "active" });
    const entries = [
      makeChainEntry("gpt-5", modelA),
      makeChainEntry("glm-5", modelB),
    ];

    const result = filterActiveModels(entries);

    expect(result.activeModels).toHaveLength(2);
    expect(result.activeCount).toBe(2);
    expect(result.totalCount).toBe(2);
  });

  it("filters out inactive models", () => {
    const modelA = makeModel({ name: "gpt-5", status: "active" });
    const modelB = makeModel({ name: "glm-5", status: "inactive" });
    const entries = [
      makeChainEntry("gpt-5", modelA),
      makeChainEntry("glm-5", modelB),
    ];

    const result = filterActiveModels(entries);

    expect(result.activeModels).toHaveLength(1);
    expect(result.activeModels[0]!.name).toBe("gpt-5");
    expect(result.activeCount).toBe(1);
    expect(result.totalCount).toBe(2);
  });

  it("returns empty array when all models are inactive", () => {
    const modelA = makeModel({ name: "gpt-5", status: "inactive" });
    const modelB = makeModel({ name: "glm-5", status: "inactive" });
    const entries = [
      makeChainEntry("gpt-5", modelA),
      makeChainEntry("glm-5", modelB),
    ];

    const result = filterActiveModels(entries);

    expect(result.activeModels).toHaveLength(0);
    expect(result.activeCount).toBe(0);
    expect(result.totalCount).toBe(2);
  });
});

describe("isChainDegraded", () => {
  it("returns false when all models are active", () => {
    expect(isChainDegraded(2, 2)).toBe(false);
  });

  it("returns true when some but not all models are inactive", () => {
    expect(isChainDegraded(1, 2)).toBe(true);
  });

  it("returns false when all models are inactive", () => {
    expect(isChainDegraded(0, 2)).toBe(false);
  });
});

describe("ChainInactiveError", () => {
  it("constructs with correct properties", () => {
    const error = new ChainInactiveError("test-chain", 0, 3);
    expect(error.name).toBe("ChainInactiveError");
    expect(error.chainName).toBe("test-chain");
    expect(error.activeModels).toBe(0);
    expect(error.totalModels).toBe(3);
    expect(error.message).toContain("no active models");
  });
});

// ---------------------------------------------------------------------------
// Integration tests: chain resilience in routes
// ---------------------------------------------------------------------------

describe("Chain resilience integration", () => {
  // --- ChainInactiveError when all models inactive ---

  it("returns 503 ChainInactiveError when chain has no active models (responses API)", async () => {
    const modelA = makeModel({
      name: "gpt-5",
      status: "inactive",
      statusReason: "Disabled for maintenance",
    });
    const modelB = makeModel({
      name: "glm-5",
      status: "inactive",
      statusReason: "Rate limited",
    });
    const chain = makeChain([
      makeChainEntry("gpt-5", modelA),
      makeChainEntry("glm-5", modelB),
    ]);
    const config = makeConfig([modelA, modelB], [chain]);

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
        },
      });

      expect(response.statusCode).toBe(503);
      const data = response.json();
      expect(data.error).toContain("no active models");
      expect(data.chain).toBe("production");
      expect(data.activeModels).toBe(0);
      expect(data.totalModels).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("returns 503 ChainInactiveError when chain has no active models (chat completions)", async () => {
    const modelA = makeModel({
      name: "gpt-5",
      status: "inactive",
      statusReason: "Disabled",
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
        url: "/v1/chat/completions",
        payload: {
          model: "chain-production",
          messages: [{ role: "user", content: "Hello" }],
        },
      });

      expect(response.statusCode).toBe(503);
      const data = response.json();
      expect(data.error.message).toContain("no active models");
    } finally {
      await app.close();
    }
  });

  it("returns 503 ChainInactiveError when chain has no active models (Anthropic)", async () => {
    const modelA = makeModel({
      name: "gpt-5",
      status: "inactive",
      statusReason: "Disabled",
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
        url: "/v1/messages",
        payload: {
          model: "chain-production",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 100,
        },
      });

      expect(response.statusCode).toBe(503);
      const data = response.json();
      expect(data.error.message).toContain("no active models");
    } finally {
      await app.close();
    }
  });

  // --- Degraded chain header ---

  it("adds x-chain-status: degraded header when chain is degraded (non-stream)", async () => {
    const modelA = makeModel({
      name: "gpt-5",
      status: "active",
    });
    const modelB = makeModel({
      name: "glm-5",
      status: "inactive",
      statusReason: "Disabled",
    });
    const chain = makeChain([
      makeChainEntry("gpt-5", modelA),
      makeChainEntry("glm-5", modelB),
    ]);
    const config = makeConfig([modelA, modelB], [chain]);

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-1",
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
        payload: {
          model: "chain-production",
          input: "Hello",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["x-chain-model"]).toBe("chain-production");
      expect(response.headers["x-chain-status"]).toBe("degraded");
    } finally {
      await app.close();
    }
  });

  it("does not add x-chain-status header when chain is fully active", async () => {
    const modelA = makeModel({ name: "gpt-5", status: "active" });
    const modelB = makeModel({ name: "glm-5", status: "active" });
    const chain = makeChain([
      makeChainEntry("gpt-5", modelA),
      makeChainEntry("glm-5", modelB),
    ]);
    const config = makeConfig([modelA, modelB], [chain]);

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          id: "chatcmpl-1",
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
        payload: {
          model: "chain-production",
          input: "Hello",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["x-chain-model"]).toBe("chain-production");
      expect(response.headers["x-chain-status"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  // --- Inactive models skipped in chain execution ---

  it("skips inactive models and only tries active models in chain", async () => {
    const modelA = makeModel({
      name: "gpt-5",
      status: "inactive",
      statusReason: "Disabled",
    });
    const modelB = makeModel({
      name: "glm-5",
      status: "active",
    });
    const chain = makeChain([
      makeChainEntry("gpt-5", modelA),
      makeChainEntry("glm-5", modelB),
    ]);
    const config = makeConfig([modelA, modelB], [chain]);

    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = input.toString();
      // First model (inactive) should NOT be called
      if (url.includes("provider.example")) {
        // glm-5 is the second model but should be the only one tried
        return new Response(
          JSON.stringify({
            id: "chatcmpl-1",
            object: "chat.completion",
            created: 1_718_000_000,
            model: "glm-5",
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: "Hello from glm-5" },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
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
      expect(response.json().output_text).toBe("Hello from glm-5");
      // Only one fetch call (to the active model)
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  // --- resolveModel respects status for direct model requests ---

  it("returns 503 when requesting inactive model directly (responses API)", async () => {
    const modelA = makeModel({
      name: "gpt-5",
      status: "inactive",
      statusReason: "Disabled for maintenance",
    });
    const config = makeConfig([modelA], []);

    const app = createApp({
      config,
      fetchFn: vi.fn() as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: {
          model: "gpt-5",
          input: "Hello",
        },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().error).toContain("Disabled for maintenance");
    } finally {
      await app.close();
    }
  });

  it("returns 503 when requesting inactive model directly (chat completions)", async () => {
    const modelA = makeModel({
      name: "gpt-5",
      status: "inactive",
      statusReason: "Rate limited",
    });
    const config = makeConfig([modelA], []);

    const app = createApp({
      config,
      fetchFn: vi.fn() as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        payload: {
          model: "gpt-5",
          messages: [{ role: "user", content: "Hello" }],
        },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().error.message).toContain("Rate limited");
    } finally {
      await app.close();
    }
  });

  it("returns 503 when requesting inactive model directly (Anthropic)", async () => {
    const modelA = makeModel({
      name: "gpt-5",
      status: "inactive",
      statusReason: "Provider outage",
    });
    const config = makeConfig([modelA], []);

    const app = createApp({
      config,
      fetchFn: vi.fn() as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/messages",
        payload: {
          model: "gpt-5",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 100,
        },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().error.message).toContain("Provider outage");
    } finally {
      await app.close();
    }
  });

  it("returns 503 with default message when inactive model has no status_reason", async () => {
    const modelA = makeModel({
      name: "gpt-5",
      status: "inactive",
      statusReason: null,
    });
    const config = makeConfig([modelA], []);

    const app = createApp({
      config,
      fetchFn: vi.fn() as typeof fetch,
    });

    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/responses",
        payload: {
          model: "gpt-5",
          input: "Hello",
        },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().error).toContain("gpt-5");
      expect(response.json().error).toContain("inactive");
    } finally {
      await app.close();
    }
  });
});
