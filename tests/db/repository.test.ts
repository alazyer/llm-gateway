/**
 * Phase 9 - Task 9.1: Unit tests for repository
 *
 * Comprehensive tests for the database repository layer.
 * Re-exports tests from db-repository.test.ts for the required path.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { openDatabase, closeDatabase } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrations/index.js";
import { allMigrations } from "../../src/db/migrations/all.js";
import type { ModelRow, ModelChainRow, ChainModelRow, GatewayConfigRow } from "../../src/db/types.js";
import {
  getAllModels,
  getModelByName,
  getActiveModels,
  insertModel,
  updateModelStatus,
  updateModelConnection,
  getModelsByConnection,
  reactivateOrInsertModel,
  getAllChains,
  getChainByName,
  getChainModels,
  insertChain,
  updateChainStatus,
  getChainsReferencingModel,
  getGatewayConfig,
  insertGatewayConfig,
  updateGatewayConfig,
  recalculateChainStatus,
} from "../../src/db/repository.js";

let tempDir: string;

function makeModel(overrides: Partial<ModelRow> & { name: string }): ModelRow {
  const now = Math.floor(Date.now() / 1000);
  return {
    upstream_model: overrides.upstream_model ?? overrides.name,
    base_url: overrides.base_url ?? "https://api.example.com",
    api_key_env: overrides.api_key_env ?? "API_KEY",
    owned_by: overrides.owned_by ?? "llm-gateway",
    created: overrides.created ?? now,
    supports_tools: overrides.supports_tools ?? 1,
    supports_streaming: overrides.supports_streaming ?? 1,
    input_modalities: overrides.input_modalities ?? "text",
    output_modalities: overrides.output_modalities ?? "text",
    unknown_field_mode: overrides.unknown_field_mode ?? "warn",
    unknown_field_window_requests: overrides.unknown_field_window_requests ?? 100,
    source: overrides.source ?? null,
    source_prefix: overrides.source_prefix ?? null,
    connection_id: overrides.connection_id ?? null,
    status: overrides.status ?? "active",
    status_reason: overrides.status_reason ?? null,
    status_changed_at: overrides.status_changed_at ?? null,
    capabilities_json: overrides.capabilities_json ?? null,
    updated_at: overrides.updated_at ?? now,
    ...overrides,
  };
}

function makeChain(overrides: Partial<ModelChainRow> & { name: string }): ModelChainRow {
  const now = Math.floor(Date.now() / 1000);
  return {
    timeout_ms: overrides.timeout_ms ?? 30000,
    max_retries: overrides.max_retries ?? 0,
    chain_timeout_ms: overrides.chain_timeout_ms ?? null,
    status: overrides.status ?? "active",
    status_reason: overrides.status_reason ?? null,
    status_changed_at: overrides.status_changed_at ?? null,
    updated_at: overrides.updated_at ?? now,
    ...overrides,
  };
}

function makeChainModel(overrides: Partial<ChainModelRow> & { chain_name: string; position: number; model_name: string }): ChainModelRow {
  return {
    timeout_ms: overrides.timeout_ms ?? null,
    max_retries: overrides.max_retries ?? null,
    ...overrides,
  };
}

function makeGatewayConfig(overrides?: Partial<GatewayConfigRow>): GatewayConfigRow {
  return {
    id: 1,
    default_model: overrides?.default_model ?? null,
    request_timeout_ms: overrides?.request_timeout_ms ?? 30000,
    max_retries: overrides?.max_retries ?? 0,
    max_body_size_kb: overrides?.max_body_size_kb ?? 1024,
    gateway_auth_token_env: overrides?.gateway_auth_token_env ?? null,
    health_probe_enabled: overrides?.health_probe_enabled ?? 0,
    cors_origin: overrides?.cors_origin ?? null,
    copilot_proxy_enabled: overrides?.copilot_proxy_enabled ?? 0,
    copilot_proxy_require_token_auth: overrides?.copilot_proxy_require_token_auth ?? 1,
    copilot_proxy_token_ttl_seconds: overrides?.copilot_proxy_token_ttl_seconds ?? 86400,
    copilot_proxy_heartbeat_interval_ms: overrides?.copilot_proxy_heartbeat_interval_ms ?? 30000,
    copilot_proxy_heartbeat_timeout_ms: overrides?.copilot_proxy_heartbeat_timeout_ms ?? 10000,
    copilot_proxy_max_inflight_per_connection: overrides?.copilot_proxy_max_inflight_per_connection ?? 4,
    copilot_proxy_allowed_prefixes: overrides?.copilot_proxy_allowed_prefixes ?? '["copilot-"]',
  };
}

beforeEach(() => {
  closeDatabase();
  tempDir = join(tmpdir(), `llm-gateway-repo-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "test.db") });
  runMigrations(db, allMigrations);
});

afterEach(() => {
  closeDatabase();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Model CRUD operations
// ---------------------------------------------------------------------------

describe("Model CRUD operations", () => {
  describe("getAllModels", () => {
    it("returns an empty array when no models exist", () => {
      const models = getAllModels();
      expect(models).toEqual([]);
    });

    it("returns all inserted models ordered by name", () => {
      insertModel(makeModel({ name: "beta" }));
      insertModel(makeModel({ name: "alpha" }));

      const models = getAllModels();
      expect(models).toHaveLength(2);
      expect(models[0]!.name).toBe("alpha");
      expect(models[1]!.name).toBe("beta");
    });
  });

  describe("getModelByName", () => {
    it("returns null when the model does not exist", () => {
      expect(getModelByName("nonexistent")).toBeNull();
    });

    it("returns the matching model row", () => {
      insertModel(makeModel({ name: "glm-5", upstream_model: "glm-5.1" }));
      const model = getModelByName("glm-5")!;
      expect(model).not.toBeNull();
      expect(model.name).toBe("glm-5");
      expect(model.upstream_model).toBe("glm-5.1");
    });
  });

  describe("getActiveModels", () => {
    it("returns only active models", () => {
      insertModel(makeModel({ name: "active-model", status: "active" }));
      insertModel(makeModel({ name: "inactive-model", status: "inactive", status_reason: "Testing" }));

      const models = getActiveModels();
      expect(models).toHaveLength(1);
      expect(models[0]!.name).toBe("active-model");
    });
  });

  describe("insertModel", () => {
    it("persists all fields correctly", () => {
      const now = Math.floor(Date.now() / 1000);
      const model = makeModel({
        name: "copilot-gpt-4",
        upstream_model: "gpt-4",
        base_url: "https://copilot.example.com",
        api_key_env: "COPILOT_KEY",
        owned_by: "copilot",
        supports_tools: 0,
        supports_streaming: 1,
        unknown_field_mode: "enforce",
        unknown_field_window_requests: 50,
        source: "copilot-proxy",
        source_prefix: "copilot-",
        connection_id: "conn-123",
        status: "active",
        status_reason: "Initial registration",
        capabilities_json: '{"tools":true}',
        created: now,
        updated_at: now,
      });

      insertModel(model);

      const fetched = getModelByName("copilot-gpt-4")!;
      expect(fetched.name).toBe("copilot-gpt-4");
      expect(fetched.upstream_model).toBe("gpt-4");
      expect(fetched.source).toBe("copilot-proxy");
      expect(fetched.connection_id).toBe("conn-123");
    });

    it("throws on duplicate model name", () => {
      insertModel(makeModel({ name: "dup" }));
      expect(() => insertModel(makeModel({ name: "dup" }))).toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

describe("Status transitions", () => {
  describe("updateModelStatus", () => {
    it("updates status, reason, and timestamps", () => {
      insertModel(makeModel({ name: "glm-5", status: "active" }));

      updateModelStatus("glm-5", "inactive", "Upstream maintenance");

      const model = getModelByName("glm-5")!;
      expect(model.status).toBe("inactive");
      expect(model.status_reason).toBe("Upstream maintenance");
      expect(model.status_changed_at).not.toBeNull();
      expect(model.updated_at).not.toBeNull();
    });

    it("throws when the model does not exist", () => {
      expect(() => updateModelStatus("ghost", "inactive", "No model")).toThrow("model 'ghost' not found");
    });

    it("can reactivate an inactive model", () => {
      insertModel(makeModel({ name: "glm-5", status: "active" }));
      updateModelStatus("glm-5", "inactive", "Down");
      updateModelStatus("glm-5", "active", "Back up");

      const model = getModelByName("glm-5")!;
      expect(model.status).toBe("active");
      expect(model.status_reason).toBe("Back up");
    });
  });

  describe("reactivateOrInsertModel", () => {
    it("inserts a new model when no matching row exists", () => {
      const model = makeModel({
        name: "copilot-new",
        source: "copilot-proxy",
        connection_id: "conn-1",
      });

      reactivateOrInsertModel(model);

      const fetched = getModelByName("copilot-new")!;
      expect(fetched).not.toBeNull();
      expect(fetched.status).toBe("active");
      expect(fetched.source).toBe("copilot-proxy");
    });

    it("reactivates an existing inactive copilot-proxy model", () => {
      insertModel(makeModel({
        name: "copilot-gpt-4",
        source: "copilot-proxy",
        status: "inactive",
        status_reason: "Copilot proxy connection closed",
        connection_id: "conn-old",
      }));

      reactivateOrInsertModel(makeModel({
        name: "copilot-gpt-4",
        source: "copilot-proxy",
        connection_id: "conn-new",
        capabilities_json: '{"tools":true}',
      }));

      const fetched = getModelByName("copilot-gpt-4")!;
      expect(fetched.status).toBe("active");
      expect(fetched.status_reason).toBe("Copilot proxy reconnected");
      expect(fetched.connection_id).toBe("conn-new");
      expect(getAllModels()).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Chain CRUD operations
// ---------------------------------------------------------------------------

describe("Chain CRUD operations", () => {
  describe("getAllChains", () => {
    it("returns an empty array when no chains exist", () => {
      expect(getAllChains()).toEqual([]);
    });

    it("returns all chains ordered by name", () => {
      insertChain(makeChain({ name: "fallback" }), []);
      insertChain(makeChain({ name: "primary" }), []);

      const chains = getAllChains();
      expect(chains).toHaveLength(2);
      expect(chains[0]!.name).toBe("fallback");
      expect(chains[1]!.name).toBe("primary");
    });
  });

  describe("getChainByName", () => {
    it("returns null when the chain does not exist", () => {
      expect(getChainByName("nonexistent")).toBeNull();
    });

    it("returns the matching chain row", () => {
      insertChain(makeChain({ name: "primary", timeout_ms: 5000, max_retries: 3 }), []);

      const chain = getChainByName("primary")!;
      expect(chain).not.toBeNull();
      expect(chain.name).toBe("primary");
      expect(chain.timeout_ms).toBe(5000);
    });
  });

  describe("getChainModels", () => {
    it("returns chain models ordered by position", () => {
      insertModel(makeModel({ name: "model-a" }));
      insertModel(makeModel({ name: "model-b" }));

      insertChain(makeChain({ name: "fallback" }), [
        makeChainModel({ chain_name: "fallback", position: 1, model_name: "model-b" }),
        makeChainModel({ chain_name: "fallback", position: 0, model_name: "model-a" }),
      ]);

      const chainModels = getChainModels("fallback");
      expect(chainModels).toHaveLength(2);
      expect(chainModels[0]!.position).toBe(0);
      expect(chainModels[0]!.model_name).toBe("model-a");
      expect(chainModels[1]!.position).toBe(1);
      expect(chainModels[1]!.model_name).toBe("model-b");
    });
  });

  describe("getChainsReferencingModel", () => {
    it("returns chain names that reference the given model", () => {
      insertModel(makeModel({ name: "shared" }));
      insertModel(makeModel({ name: "other" }));
      insertChain(makeChain({ name: "chain-a" }), [
        makeChainModel({ chain_name: "chain-a", position: 0, model_name: "shared" }),
      ]);
      insertChain(makeChain({ name: "chain-b" }), [
        makeChainModel({ chain_name: "chain-b", position: 0, model_name: "shared" }),
        makeChainModel({ chain_name: "chain-b", position: 1, model_name: "other" }),
      ]);

      const chains = getChainsReferencingModel("shared");
      expect(chains).toEqual(["chain-a", "chain-b"]);
    });
  });
});

// ---------------------------------------------------------------------------
// Chain status recalculation
// ---------------------------------------------------------------------------

describe("Chain status recalculation", () => {
  it("sets status to active when all models are active", () => {
    insertModel(makeModel({ name: "m1", status: "active" }));
    insertModel(makeModel({ name: "m2", status: "active" }));
    insertChain(makeChain({ name: "test-chain", status: "degraded" }), [
      makeChainModel({ chain_name: "test-chain", position: 0, model_name: "m1" }),
      makeChainModel({ chain_name: "test-chain", position: 1, model_name: "m2" }),
    ]);

    recalculateChainStatus("test-chain");

    const chain = getChainByName("test-chain")!;
    expect(chain.status).toBe("active");
    expect(chain.status_reason).toBe("All models active");
  });

  it("sets status to inactive when all models are inactive", () => {
    insertModel(makeModel({ name: "m1", status: "inactive", status_reason: "Down" }));
    insertModel(makeModel({ name: "m2", status: "inactive", status_reason: "Down" }));
    insertChain(makeChain({ name: "test-chain", status: "active" }), [
      makeChainModel({ chain_name: "test-chain", position: 0, model_name: "m1" }),
      makeChainModel({ chain_name: "test-chain", position: 1, model_name: "m2" }),
    ]);

    recalculateChainStatus("test-chain");

    const chain = getChainByName("test-chain")!;
    expect(chain.status).toBe("inactive");
    expect(chain.status_reason).toBe("All models inactive");
  });

  it("sets status to degraded when some models are inactive", () => {
    insertModel(makeModel({ name: "m1", status: "active" }));
    insertModel(makeModel({ name: "m2", status: "inactive", status_reason: "Maintenance" }));
    insertModel(makeModel({ name: "m3", status: "active" }));
    insertChain(makeChain({ name: "test-chain", status: "active" }), [
      makeChainModel({ chain_name: "test-chain", position: 0, model_name: "m1" }),
      makeChainModel({ chain_name: "test-chain", position: 1, model_name: "m2" }),
      makeChainModel({ chain_name: "test-chain", position: 2, model_name: "m3" }),
    ]);

    recalculateChainStatus("test-chain");

    const chain = getChainByName("test-chain")!;
    expect(chain.status).toBe("degraded");
    expect(chain.status_reason).toBe("1 of 3 models inactive: m2");
  });

  it("handles chain with no models as inactive", () => {
    insertChain(makeChain({ name: "empty-chain" }), []);

    recalculateChainStatus("empty-chain");

    const chain = getChainByName("empty-chain")!;
    expect(chain.status).toBe("inactive");
    expect(chain.status_reason).toBe("No models in chain");
  });
});
