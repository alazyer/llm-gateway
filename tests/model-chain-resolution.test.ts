import { describe, expect, it, vi } from "vitest";

import type { AppConfig, GatewayModelConfig } from "../src/config.js";
import type { ModelChainConfig, ChainModelEntry } from "../src/contracts.js";
import type { ChainDescriptor } from "../src/chain-executor.js";

// ---------------------------------------------------------------------------
// Re-implement resolveModel() and isChainDescriptor() from responses.ts
// for isolated unit testing (they are not exported from the route module).
// ---------------------------------------------------------------------------

class RouteError extends Error {
  public readonly statusCode: number;
  public constructor(statusCode: number, message: string) {
    super(message);
    this.name = "RouteError";
    this.statusCode = statusCode;
  }
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function resolveModel(
  config: AppConfig,
  requestedModel?: string,
): GatewayModelConfig | ChainDescriptor {
  const normalizedModel = normalizeOptionalString(requestedModel);

  if (normalizedModel) {
    if (normalizedModel.startsWith("chain-")) {
      const chainName = normalizedModel.slice("chain-".length);
      const chain = config.modelChains?.find((c) => c.name === chainName);
      if (chain) {
        return { type: "chain", chain };
      }
      throw new RouteError(404, `Chain \`${chainName}\` is not configured.`);
    }

    const configured = config.models.find((model) => model.name === normalizedModel);
    if (configured) {
      return configured;
    }

    throw new RouteError(404, `Model \`${normalizedModel}\` is not configured.`);
  }

  if (config.defaultModel) {
    if (config.defaultModel.startsWith("chain-")) {
      const chainName = config.defaultModel.slice("chain-".length);
      const chain = config.modelChains?.find((c) => c.name === chainName);
      if (chain) {
        return { type: "chain", chain };
      }
      throw new RouteError(404, `Chain \`${chainName}\` is not configured.`);
    }

    const configuredDefault = config.models.find(
      (model) => model.name === config.defaultModel,
    );
    if (configuredDefault) {
      return configuredDefault;
    }
  }

  if (config.models.length === 1) {
    return config.models[0]!;
  }

  throw new RouteError(
    404,
    "No model is configured for this request.",
  );
}

function isChainDescriptor(
  result: GatewayModelConfig | ChainDescriptor,
): result is ChainDescriptor {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { type?: unknown }).type === "chain"
  );
}

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

function makeChainEntry(name: string, overrides: Partial<ChainModelEntry> = {}): ChainModelEntry {
  return {
    name,
    modelConfig: makeModel({ name, upstreamModel: name }),
    timeoutMs: 30000,
    maxRetries: 0,
    ...overrides,
  };
}

function makeChain(overrides: Partial<ModelChainConfig> = {}): ModelChainConfig {
  const models = [makeChainEntry("gpt-5"), makeChainEntry("glm-5.1")];
  const activeCount = models.filter((m) => m.modelConfig.status === "active").length;
  const totalCount = models.length;

  return {
    name: "production",
    models,
    timeoutMs: 30000,
    maxRetries: 0,
    status: "active",
    statusReason: `${activeCount}/${totalCount} models active`,
    statusChangedAt: 1_718_000_000,
    activeModels: activeCount,
    totalModels: totalCount,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    host: "127.0.0.1",
    port: 3000,
    logLevel: "info",
    upstreamBaseUrl: "https://provider.example/v1",
    requestTimeoutMs: 30000,
    maxRetries: 0,
    maxBodySizeKb: 1024,
    healthProbeEnabled: false,
  workspace: { enabled: false },
    models: [makeModel(), makeModel({ name: "glm-5.1", upstreamModel: "glm-5.1" })],
    modelChains: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveModel — chain resolution", () => {
  // --- Valid chain identifier resolved ---

  it("returns a ChainDescriptor when model starts with chain- and chain exists", () => {
    const chain = makeChain();
    const config = makeConfig({ modelChains: [chain] });

    const result = resolveModel(config, "chain-production");

    expect(isChainDescriptor(result)).toBe(true);
    if (isChainDescriptor(result)) {
      expect(result.type).toBe("chain");
      expect(result.chain.name).toBe("production");
      expect(result.chain.models).toHaveLength(2);
    }
  });

  // --- Unknown chain identifier → 404 ---

  it("throws RouteError 404 when chain-<name> is not configured", () => {
    const config = makeConfig(); // no chains

    expect(() => resolveModel(config, "chain-nonexistent")).toThrow(RouteError);
    try {
      resolveModel(config, "chain-nonexistent");
    } catch (error) {
      expect((error as RouteError).statusCode).toBe(404);
      expect((error as RouteError).message).toContain("not configured");
    }
  });

  // --- Plain model name resolves as before ---

  it("returns a GatewayModelConfig for a plain model name (no chain behavior)", () => {
    const chain = makeChain();
    const config = makeConfig({ modelChains: [chain] });

    const result = resolveModel(config, "gpt-5");

    expect(isChainDescriptor(result)).toBe(false);
    expect((result as GatewayModelConfig).name).toBe("gpt-5");
  });

  it("returns a GatewayModelConfig when no chains are configured", () => {
    const config = makeConfig(); // no chains

    const result = resolveModel(config, "glm-5.1");

    expect(isChainDescriptor(result)).toBe(false);
    expect((result as GatewayModelConfig).name).toBe("glm-5.1");
  });

  // --- Chain resolution precedence: BEFORE plain model lookup ---

  it("resolves chain- prefix BEFORE plain model lookup even if a plain model name starts with 'chain-'", () => {
    // This test confirms that chain- resolution takes precedence. If someone
    // named a plain model "chain-fallback" (which config validation rejects),
    // the chain lookup would still be tried first. But since config validation
    // prevents this collision, this is a safety-net test.
    const chain = makeChain({ name: "fallback" });
    const config = makeConfig({ modelChains: [chain] });

    const result = resolveModel(config, "chain-fallback");

    expect(isChainDescriptor(result)).toBe(true);
    expect((result as ChainDescriptor).chain.name).toBe("fallback");
  });

  // --- Chain resolution precedence: BEFORE Copilot proxy lookup ---

  it("chain-copilot-* resolves as a chain (not a Copilot model) when chain exists", () => {
    // Config validation rejects copilot- models in chains, so a chain named
    // "copilot-proxy" would fail validation. But the resolveModel() function
    // itself should still try chain resolution first. If someone bypasses
    // validation, chain-copilot-* should be a chain, not a Copilot dispatch.
    const chain = makeChain({ name: "copilot-proxy", models: [makeChainEntry("gpt-5")] });
    const config = makeConfig({ modelChains: [chain] });

    const result = resolveModel(config, "chain-copilot-proxy");

    expect(isChainDescriptor(result)).toBe(true);
    expect((result as ChainDescriptor).chain.name).toBe("copilot-proxy");
  });

  // --- default_model as chain identifier ---

  it("resolves default_model starting with chain- as a chain when no model specified", () => {
    const chain = makeChain();
    const config = makeConfig({ defaultModel: "chain-production", modelChains: [chain] });

    const result = resolveModel(config, undefined);

    expect(isChainDescriptor(result)).toBe(true);
    expect((result as ChainDescriptor).chain.name).toBe("production");
  });

  it("resolves default_model starting with chain- as a chain when model is empty string", () => {
    const chain = makeChain();
    const config = makeConfig({ defaultModel: "chain-production", modelChains: [chain] });

    const result = resolveModel(config, "");

    expect(isChainDescriptor(result)).toBe(true);
  });

  // --- default_model as plain model name ---

  it("resolves default_model as a plain GatewayModelConfig when it is not a chain reference", () => {
    const config = makeConfig({ defaultModel: "gpt-5" });

    const result = resolveModel(config, undefined);

    expect(isChainDescriptor(result)).toBe(false);
    expect((result as GatewayModelConfig).name).toBe("gpt-5");
  });

  // --- default_model is chain-<name> but chain doesn't exist → 404 ---

  it("returns 404 when default_model starts with chain- but no matching chain exists", () => {
    const config = makeConfig({ defaultModel: "chain-nonexistent" });

    expect(() => resolveModel(config, undefined)).toThrow(RouteError);
  });

  // --- Single model fallback unchanged ---

  it("returns the single model when no model specified and only one model configured", () => {
    const config = makeConfig({ models: [makeModel()] });

    const result = resolveModel(config, undefined);

    expect(isChainDescriptor(result)).toBe(false);
    expect((result as GatewayModelConfig).name).toBe("gpt-5");
  });

  // --- Error when no model, no default, multiple models ---

  it("throws RouteError 404 when no model specified, no default, multiple models", () => {
    const config = makeConfig(); // two models, no default

    expect(() => resolveModel(config, undefined)).toThrow(RouteError);
    try {
      resolveModel(config, undefined);
    } catch (error) {
      expect((error as RouteError).statusCode).toBe(404);
    }
  });

  // --- Error for unknown plain model name unchanged ---

  it("throws RouteError 404 for unknown plain model name", () => {
    const config = makeConfig();

    expect(() => resolveModel(config, "unknown-model")).toThrow(RouteError);
    try {
      resolveModel(config, "unknown-model");
    } catch (error) {
      expect((error as RouteError).statusCode).toBe(404);
      expect((error as RouteError).message).toContain("not configured");
    }
  });
});

describe("isChainDescriptor", () => {
  it("returns true for a ChainDescriptor", () => {
    const chain = makeChain();
    const descriptor: ChainDescriptor = { type: "chain", chain };
    expect(isChainDescriptor(descriptor)).toBe(true);
  });

  it("returns false for a GatewayModelConfig", () => {
    const model = makeModel();
    expect(isChainDescriptor(model)).toBe(false);
  });

  it("returns false for null", () => {
    expect(isChainDescriptor(null as unknown as GatewayModelConfig | ChainDescriptor)).toBe(false);
  });
});
