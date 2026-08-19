/**
 * Phase 9 - Task 9.2: Unit tests for chain executor with status
 *
 * Tests for:
 * - Filtering inactive models
 * - Degraded chain execution
 * - All-inactive chain returns error
 */

import { describe, expect, it } from "vitest";

import type { GatewayModelConfig } from "../src/config.js";
import type { ChainModelEntry } from "../src/contracts.js";
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

// ---------------------------------------------------------------------------
// filterActiveModels tests
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

  it("preserves order of active models", () => {
    const modelA = makeModel({ name: "gpt-5", status: "active" });
    const modelB = makeModel({ name: "glm-5", status: "inactive" });
    const modelC = makeModel({ name: "claude-5", status: "active" });
    const entries = [
      makeChainEntry("gpt-5", modelA),
      makeChainEntry("glm-5", modelB),
      makeChainEntry("claude-5", modelC),
    ];

    const result = filterActiveModels(entries);

    expect(result.activeModels).toHaveLength(2);
    expect(result.activeModels[0]!.name).toBe("gpt-5");
    expect(result.activeModels[1]!.name).toBe("claude-5");
  });
});

// ---------------------------------------------------------------------------
// isChainDegraded tests
// ---------------------------------------------------------------------------

describe("isChainDegraded", () => {
  it("returns false when all models are active", () => {
    expect(isChainDegraded(2, 2)).toBe(false);
  });

  it("returns true when some but not all models are inactive", () => {
    expect(isChainDegraded(1, 2)).toBe(true);
    expect(isChainDegraded(2, 3)).toBe(true);
    expect(isChainDegraded(1, 5)).toBe(true);
  });

  it("returns false when all models are inactive", () => {
    expect(isChainDegraded(0, 2)).toBe(false);
    expect(isChainDegraded(0, 5)).toBe(false);
  });

  it("returns false for single active model", () => {
    expect(isChainDegraded(1, 1)).toBe(false);
  });

  it("returns false for single inactive model", () => {
    expect(isChainDegraded(0, 1)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ChainInactiveError tests
// ---------------------------------------------------------------------------

describe("ChainInactiveError", () => {
  it("constructs with correct properties", () => {
    const error = new ChainInactiveError("test-chain", 0, 3);
    expect(error.name).toBe("ChainInactiveError");
    expect(error.chainName).toBe("test-chain");
    expect(error.activeModels).toBe(0);
    expect(error.totalModels).toBe(3);
    expect(error.message).toContain("no active models");
    expect(error.message).toContain("test-chain");
  });

  it("includes active/total counts in message", () => {
    const error = new ChainInactiveError("my-chain", 0, 5);
    expect(error.message).toContain("0/5");
  });

  it("is an instance of Error", () => {
    const error = new ChainInactiveError("chain", 0, 1);
    expect(error).toBeInstanceOf(Error);
  });
});
