import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { type AppConfig, type GatewayModelConfig } from "../src/config.js";
import type { ChainModelEntry, ModelChainConfig } from "../src/contracts.js";

const compatibilityInstructions =
  "You are a helpful AI assistant. Follow developer and user instructions, keep responses accurate, and prefer concise plain-text output unless the caller asks for a specific format.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModel(overrides: Partial<GatewayModelConfig> = {}): GatewayModelConfig {
  return {
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
    modelChains: chains.length > 0 ? chains : undefined,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: Model record status field
// ---------------------------------------------------------------------------

describe("Model listing — status field", () => {
  it("includes status field on each plain model record", async () => {
    const modelA = makeModel({ name: "glm-5.1", status: "active" });
    const modelB = makeModel({ name: "gpt-5", status: "inactive" });
    const config = makeConfig([modelA, modelB]);

    const app = createApp({ config, fetchFn: vi.fn() as typeof fetch });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/models",
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.object).toBe("list");

      const glm = data.data.find((m: { id: string }) => m.id === "glm-5.1");
      const gpt = data.data.find((m: { id: string }) => m.id === "gpt-5");

      expect(glm.status).toBe("active");
      expect(gpt.status).toBe("inactive");
    } finally {
      await app.close();
    }
  });

  it("includes status field on /models/:model detail endpoint", async () => {
    const model = makeModel({ name: "glm-5.1", status: "active" });
    const config = makeConfig([model]);

    const app = createApp({ config, fetchFn: vi.fn() as typeof fetch });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/models/glm-5.1",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe("active");
    } finally {
      await app.close();
    }
  });

  it("includes status field on Anthropic-format model list", async () => {
    const model = makeModel({ name: "glm-5.1", status: "active" });
    const config = makeConfig([model]);

    const app = createApp({ config, fetchFn: vi.fn() as typeof fetch });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { "anthropic-version": "2023-06-01" },
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.data[0].status).toBe("active");
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Chain model record status fields
// ---------------------------------------------------------------------------

describe("Model listing — chain status fields", () => {
  it("includes status, active_models, total_models on chain model record", async () => {
    const modelA = makeChainModel({ name: "gpt-5" });
    const modelB = makeChainModel({ name: "glm-5.1" });
    const chain = makeChain([makeChainEntry("gpt-5", modelA), makeChainEntry("glm-5.1", modelB)]);
    const config = makeConfig([modelA, modelB], [chain]);

    const app = createApp({ config, fetchFn: vi.fn() as typeof fetch });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/models",
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      const chainModel = data.data.find((m: { id: string }) => m.id === "chain-production");

      expect(chainModel).toBeDefined();
      expect(chainModel.status).toBe("active");
      expect(chainModel.active_models).toBe(2);
      expect(chainModel.total_models).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("shows degraded status when some chain models are inactive", async () => {
    const modelA = makeChainModel({ name: "gpt-5" });
    const modelB = makeChainModel({ name: "glm-5.1", status: "inactive" });
    const chain = makeChain([makeChainEntry("gpt-5", modelA), makeChainEntry("glm-5.1", modelB)]);
    const config = makeConfig([modelA, modelB], [chain]);

    const app = createApp({ config, fetchFn: vi.fn() as typeof fetch });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/models",
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      const chainModel = data.data.find((m: { id: string }) => m.id === "chain-production");

      expect(chainModel).toBeDefined();
      expect(chainModel.status).toBe("degraded");
      expect(chainModel.active_models).toBe(1);
      expect(chainModel.total_models).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("shows inactive status when all chain models are inactive", async () => {
    const modelA = makeChainModel({ name: "gpt-5", status: "inactive" });
    const chain = makeChain([makeChainEntry("gpt-5", modelA)]);
    const config = makeConfig([modelA], [chain]);

    const app = createApp({ config, fetchFn: vi.fn() as typeof fetch });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/models",
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      const chainModel = data.data.find((m: { id: string }) => m.id === "chain-production");

      expect(chainModel).toBeDefined();
      expect(chainModel.status).toBe("inactive");
      expect(chainModel.active_models).toBe(0);
      expect(chainModel.total_models).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("includes chain status fields in Anthropic-format model list", async () => {
    const modelA = makeChainModel({ name: "gpt-5" });
    const modelB = makeChainModel({ name: "glm-5.1", status: "inactive" });
    const chain = makeChain([makeChainEntry("gpt-5", modelA), makeChainEntry("glm-5.1", modelB)]);
    const config = makeConfig([modelA, modelB], [chain]);

    const app = createApp({ config, fetchFn: vi.fn() as typeof fetch });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/models",
        headers: { "anthropic-version": "2023-06-01" },
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      const chainModel = data.data.find((m: { id: string }) => m.id === "chain-production");

      expect(chainModel).toBeDefined();
      expect(chainModel.status).toBe("degraded");
      expect(chainModel.active_models).toBe(1);
      expect(chainModel.total_models).toBe(2);
    } finally {
      await app.close();
    }
  });

  it("includes chain status fields on /models/:model detail endpoint", async () => {
    const modelA = makeChainModel({ name: "gpt-5" });
    const chain = makeChain([makeChainEntry("gpt-5", modelA)]);
    const config = makeConfig([modelA], [chain]);

    const app = createApp({ config, fetchFn: vi.fn() as typeof fetch });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/models/chain-production",
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.status).toBe("active");
      expect(data.active_models).toBe(1);
      expect(data.total_models).toBe(1);
    } finally {
      await app.close();
    }
  });

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
});

// ---------------------------------------------------------------------------
// Tests: ?status=active query parameter filtering
// ---------------------------------------------------------------------------

describe("Model listing — ?status=active filtering", () => {
  it("filters to only active models when ?status=active is provided", async () => {
    const modelA = makeModel({ name: "glm-5.1", status: "active" });
    const modelB = makeModel({ name: "gpt-5", status: "inactive" });
    const modelC = makeModel({ name: "claude-5", status: "active" });
    const config = makeConfig([modelA, modelB, modelC]);

    const app = createApp({ config, fetchFn: vi.fn() as typeof fetch });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/models?status=active",
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.object).toBe("list");

      const ids = data.data.map((m: { id: string }) => m.id);
      expect(ids).toContain("glm-5.1");
      expect(ids).toContain("claude-5");
      expect(ids).not.toContain("gpt-5");
    } finally {
      await app.close();
    }
  });

  it("returns all models when no status filter is provided", async () => {
    const modelA = makeModel({ name: "glm-5.1", status: "active" });
    const modelB = makeModel({ name: "gpt-5", status: "inactive" });
    const config = makeConfig([modelA, modelB]);

    const app = createApp({ config, fetchFn: vi.fn() as typeof fetch });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/models",
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      const ids = data.data.map((m: { id: string }) => m.id);
      expect(ids).toContain("glm-5.1");
      expect(ids).toContain("gpt-5");
    } finally {
      await app.close();
    }
  });

  it("filters chain models by status", async () => {
    const modelA = makeModel({ name: "gpt-5", status: "active" });
    const modelB = makeModel({ name: "glm-5.1", status: "inactive" });
    const chain = makeChain(
      [makeChainEntry("gpt-5", modelA), makeChainEntry("glm-5.1", modelB)],
    );
    const config = makeConfig([modelA, modelB], [chain]);

    const app = createApp({ config, fetchFn: vi.fn() as typeof fetch });

    try {
      // Chain has degraded status (1/2 active) so ?status=active should exclude it
      const activeResponse = await app.inject({
        method: "GET",
        url: "/v1/models?status=active",
      });

      expect(activeResponse.statusCode).toBe(200);
      const activeData = activeResponse.json();
      const activeIds = activeData.data.map((m: { id: string }) => m.id);
      expect(activeIds).toContain("gpt-5");
      // Chain is degraded, not active, so it should be excluded
      expect(activeIds).not.toContain("chain-production");
      // Inactive model should be excluded
      expect(activeIds).not.toContain("glm-5.1");

      // ?status=degraded should include only the chain
      const degradedResponse = await app.inject({
        method: "GET",
        url: "/v1/models?status=degraded",
      });

      expect(degradedResponse.statusCode).toBe(200);
      const degradedData = degradedResponse.json();
      const degradedIds = degradedData.data.map((m: { id: string }) => m.id);
      expect(degradedIds).toContain("chain-production");
      expect(degradedIds).not.toContain("gpt-5");
      expect(degradedIds).not.toContain("glm-5.1");
    } finally {
      await app.close();
    }
  });

  it("filters active chain with all active models", async () => {
    const modelA = makeModel({ name: "gpt-5", status: "active" });
    const chain = makeChain([makeChainEntry("gpt-5", modelA)]);
    const config = makeConfig([modelA], [chain]);

    const app = createApp({ config, fetchFn: vi.fn() as typeof fetch });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/models?status=active",
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      const ids = data.data.map((m: { id: string }) => m.id);
      // Both model and chain are active
      expect(ids).toContain("gpt-5");
      expect(ids).toContain("chain-production");
    } finally {
      await app.close();
    }
  });

  it("works on /models endpoint (non-versioned)", async () => {
    const modelA = makeModel({ name: "glm-5.1", status: "active" });
    const modelB = makeModel({ name: "gpt-5", status: "inactive" });
    const config = makeConfig([modelA, modelB]);

    const app = createApp({ config, fetchFn: vi.fn() as typeof fetch });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/models?status=active",
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      const ids = data.data.map((m: { id: string }) => m.id);
      expect(ids).toContain("glm-5.1");
      expect(ids).not.toContain("gpt-5");
    } finally {
      await app.close();
    }
  });

  it("filters in Anthropic-format model list", async () => {
    const modelA = makeModel({ name: "glm-5.1", status: "active" });
    const modelB = makeModel({ name: "gpt-5", status: "inactive" });
    const config = makeConfig([modelA, modelB]);

    const app = createApp({ config, fetchFn: vi.fn() as typeof fetch });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/models?status=active",
        headers: { "anthropic-version": "2023-06-01" },
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      const ids = data.data.map((m: { id: string }) => m.id);
      expect(ids).toContain("glm-5.1");
      expect(ids).not.toContain("gpt-5");
    } finally {
      await app.close();
    }
  });

  it("returns empty data array when no models match the filter", async () => {
    const modelA = makeModel({ name: "glm-5.1", status: "inactive" });
    const config = makeConfig([modelA]);

    const app = createApp({ config, fetchFn: vi.fn() as typeof fetch });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/models?status=active",
      });

      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.data).toHaveLength(0);
    } finally {
      await app.close();
    }
  });
});
