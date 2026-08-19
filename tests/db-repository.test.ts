import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { openDatabase, closeDatabase, getDatabase } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations/index.js";
import { allMigrations } from "../src/db/migrations/all.js";
import type { ModelRow, ModelChainRow, ChainModelRow, GatewayConfigRow } from "../src/db/types.js";
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
} from "../src/db/repository.js";

let tempDir: string;

/** Helper: create a minimal ModelRow with sensible defaults. */
function makeModel(overrides: Partial<ModelRow> & { name: string }): ModelRow {
  return {
    upstream_model: overrides.upstream_model ?? overrides.name,
    base_url: overrides.base_url ?? "https://api.example.com",
    api_key_env: overrides.api_key_env ?? "API_KEY",
    owned_by: overrides.owned_by ?? "llm-gateway",
    created: overrides.created ?? Math.floor(Date.now() / 1000),
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
    updated_at: overrides.updated_at ?? Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

/** Helper: create a minimal ModelChainRow with sensible defaults. */
function makeChain(overrides: Partial<ModelChainRow> & { name: string }): ModelChainRow {
  return {
    timeout_ms: overrides.timeout_ms ?? 30000,
    max_retries: overrides.max_retries ?? 0,
    chain_timeout_ms: overrides.chain_timeout_ms ?? null,
    status: overrides.status ?? "active",
    status_reason: overrides.status_reason ?? null,
    status_changed_at: overrides.status_changed_at ?? null,
    updated_at: overrides.updated_at ?? Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

/** Helper: create a minimal ChainModelRow. */
function makeChainModel(overrides: Partial<ChainModelRow> & { chain_name: string; position: number; model_name: string }): ChainModelRow {
  return {
    timeout_ms: overrides.timeout_ms ?? null,
    max_retries: overrides.max_retries ?? null,
    ...overrides,
  };
}

/** Helper: create a minimal GatewayConfigRow. */
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
// Task 2.1 — Model repository tests
// ---------------------------------------------------------------------------

describe("Model repository", () => {
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

    it("returns empty when all models are inactive", () => {
      insertModel(makeModel({ name: "off", status: "inactive", status_reason: "Down" }));
      expect(getActiveModels()).toEqual([]);
    });
  });

  describe("insertModel", () => {
    it("persists all fields correctly", () => {
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
        created: 1700000000,
        updated_at: 1700000000,
      });

      insertModel(model);

      const fetched = getModelByName("copilot-gpt-4")!;
      expect(fetched.name).toBe("copilot-gpt-4");
      expect(fetched.upstream_model).toBe("gpt-4");
      expect(fetched.base_url).toBe("https://copilot.example.com");
      expect(fetched.api_key_env).toBe("COPILOT_KEY");
      expect(fetched.owned_by).toBe("copilot");
      expect(fetched.supports_tools).toBe(0);
      expect(fetched.supports_streaming).toBe(1);
      expect(fetched.unknown_field_mode).toBe("enforce");
      expect(fetched.unknown_field_window_requests).toBe(50);
      expect(fetched.source).toBe("copilot-proxy");
      expect(fetched.source_prefix).toBe("copilot-");
      expect(fetched.connection_id).toBe("conn-123");
      expect(fetched.status).toBe("active");
      expect(fetched.status_reason).toBe("Initial registration");
      expect(fetched.capabilities_json).toBe('{"tools":true}');
      expect(fetched.created).toBe(1700000000);
    });

    it("throws on duplicate model name", () => {
      insertModel(makeModel({ name: "dup" }));
      expect(() => insertModel(makeModel({ name: "dup" }))).toThrow();
    });
  });

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
      expect(() =>
        updateModelStatus("ghost", "inactive", "No model"),
      ).toThrow("model 'ghost' not found");
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

  describe("updateModelConnection", () => {
    it("updates connection_id and capabilities_json", () => {
      insertModel(makeModel({ name: "copilot-model", connection_id: "conn-old", capabilities_json: null }));

      updateModelConnection("copilot-model", "conn-new", '{"streaming":true}');

      const model = getModelByName("copilot-model")!;
      expect(model.connection_id).toBe("conn-new");
      expect(model.capabilities_json).toBe('{"streaming":true}');
    });

    it("can clear connection_id by passing null", () => {
      insertModel(makeModel({ name: "copilot-model", connection_id: "conn-old" }));

      updateModelConnection("copilot-model", null, null);

      const model = getModelByName("copilot-model")!;
      expect(model.connection_id).toBeNull();
      expect(model.capabilities_json).toBeNull();
    });
  });

  describe("getModelsByConnection", () => {
    it("returns models matching the connection ID", () => {
      insertModel(makeModel({ name: "a", connection_id: "conn-1" }));
      insertModel(makeModel({ name: "b", connection_id: "conn-2" }));
      insertModel(makeModel({ name: "c", connection_id: "conn-1" }));

      const models = getModelsByConnection("conn-1");
      expect(models).toHaveLength(2);
      expect(models.map((m) => m.name).sort()).toEqual(["a", "c"]);
    });

    it("returns empty for unknown connection ID", () => {
      insertModel(makeModel({ name: "a", connection_id: "conn-1" }));
      expect(getModelsByConnection("conn-999")).toEqual([]);
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
      // Insert an inactive copilot-proxy model (simulating prior disconnection).
      insertModel(makeModel({
        name: "copilot-gpt-4",
        source: "copilot-proxy",
        status: "inactive",
        status_reason: "Copilot proxy connection closed",
        connection_id: "conn-old",
      }));

      // Reconnect with same name.
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
      expect(fetched.capabilities_json).toBe('{"tools":true}');
      expect(fetched.status_changed_at).not.toBeNull();

      // Should NOT have inserted a duplicate.
      expect(getAllModels()).toHaveLength(1);
    });

    it("updates connection for an already-active copilot-proxy model", () => {
      insertModel(makeModel({
        name: "copilot-gpt-4",
        source: "copilot-proxy",
        status: "active",
        connection_id: "conn-old",
      }));

      reactivateOrInsertModel(makeModel({
        name: "copilot-gpt-4",
        source: "copilot-proxy",
        connection_id: "conn-new",
        capabilities_json: '{"updated":true}',
      }));

      const fetched = getModelByName("copilot-gpt-4")!;
      expect(fetched.status).toBe("active"); // Still active, no status change.
      expect(fetched.connection_id).toBe("conn-new");
      expect(fetched.capabilities_json).toBe('{"updated":true}');

      // No duplicate.
      expect(getAllModels()).toHaveLength(1);
    });

    it("throws when a copilot-proxy model shares name with an existing static model", () => {
      // A static model with the same name — should NOT match the reactivation logic.
      insertModel(makeModel({
        name: "copilot-gpt-4",
        source: "static",
        status: "inactive",
      }));

      // Attempt to reactivate as copilot-proxy source.
      // The existing row is source='static', so the reactivation check does not match.
      // The insert path will then hit a PRIMARY KEY conflict.
      expect(() =>
        reactivateOrInsertModel(makeModel({
          name: "copilot-gpt-4",
          source: "copilot-proxy",
          connection_id: "conn-1",
        })),
      ).toThrow();

      // The original static model is unchanged.
      const model = getModelByName("copilot-gpt-4")!;
      expect(model.source).toBe("static");
      expect(model.status).toBe("inactive");
    });
  });
});

// ---------------------------------------------------------------------------
// Task 2.2 — Chain repository tests
// ---------------------------------------------------------------------------

describe("Chain repository", () => {
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
      expect(chain.max_retries).toBe(3);
    });
  });

  describe("getChainModels", () => {
    it("returns empty array when chain has no models", () => {
      insertChain(makeChain({ name: "empty" }), []);
      expect(getChainModels("empty")).toEqual([]);
    });

    it("returns chain models ordered by position", () => {
      const chain = makeChain({ name: "fallback" });
      const models = [
        makeChainModel({ chain_name: "fallback", position: 1, model_name: "model-b" }),
        makeChainModel({ chain_name: "fallback", position: 0, model_name: "model-a" }),
      ];

      // Insert the referenced models first.
      insertModel(makeModel({ name: "model-a" }));
      insertModel(makeModel({ name: "model-b" }));

      insertChain(chain, models);

      const chainModels = getChainModels("fallback");
      expect(chainModels).toHaveLength(2);
      expect(chainModels[0]!.position).toBe(0);
      expect(chainModels[0]!.model_name).toBe("model-a");
      expect(chainModels[1]!.position).toBe(1);
      expect(chainModels[1]!.model_name).toBe("model-b");
    });

    it("includes timeout_ms and max_reries overrides", () => {
      insertModel(makeModel({ name: "model-a" }));
      insertChain(makeChain({ name: "test" }), [
        makeChainModel({ chain_name: "test", position: 0, model_name: "model-a", timeout_ms: 10000, max_retries: 2 }),
      ]);

      const cm = getChainModels("test");
      expect(cm[0]!.timeout_ms).toBe(10000);
      expect(cm[0]!.max_retries).toBe(2);
    });
  });

  describe("insertChain", () => {
    it("inserts chain row and chain-model rows atomically", () => {
      insertModel(makeModel({ name: "m1" }));
      insertModel(makeModel({ name: "m2" }));

      insertChain(
        makeChain({ name: "chain-1", timeout_ms: 10000, max_retries: 1, chain_timeout_ms: 20000 }),
        [
          makeChainModel({ chain_name: "chain-1", position: 0, model_name: "m1" }),
          makeChainModel({ chain_name: "chain-1", position: 1, model_name: "m2" }),
        ],
      );

      const chain = getChainByName("chain-1")!;
      expect(chain).not.toBeNull();
      expect(chain.timeout_ms).toBe(10000);
      expect(chain.chain_timeout_ms).toBe(20000);

      const models = getChainModels("chain-1");
      expect(models).toHaveLength(2);
    });

    it("rolls back chain-model inserts if the chain insert fails (duplicate name)", () => {
      insertModel(makeModel({ name: "m1" }));
      insertChain(makeChain({ name: "dup" }), []);

      // Second insert with same name should fail, and no stray chain_model rows.
      expect(() =>
        insertChain(
          makeChain({ name: "dup" }),
          [makeChainModel({ chain_name: "dup", position: 0, model_name: "m1" })],
        ),
      ).toThrow();

      // Verify no chain_model rows were left behind.
      const db = getDatabase();
      const rows = db.prepare("SELECT COUNT(*) AS cnt FROM chain_models").get() as unknown as { cnt: number };
      expect(rows.cnt).toBe(0);
    });
  });

  describe("updateChainStatus", () => {
    it("updates chain status, reason, and timestamps", () => {
      insertChain(makeChain({ name: "my-chain", status: "active" }), []);

      updateChainStatus("my-chain", "degraded", "1 of 2 models inactive: model-b");

      const chain = getChainByName("my-chain")!;
      expect(chain.status).toBe("degraded");
      expect(chain.status_reason).toBe("1 of 2 models inactive: model-b");
      expect(chain.status_changed_at).not.toBeNull();
      expect(chain.updated_at).not.toBeNull();
    });

    it("throws when the chain does not exist", () => {
      expect(() =>
        updateChainStatus("ghost", "inactive", "No chain"),
      ).toThrow("chain 'ghost' not found");
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
      insertChain(makeChain({ name: "chain-c" }), [
        makeChainModel({ chain_name: "chain-c", position: 0, model_name: "other" }),
      ]);

      const chains = getChainsReferencingModel("shared");
      expect(chains).toEqual(["chain-a", "chain-b"]);
    });

    it("returns empty when the model is not in any chain", () => {
      insertModel(makeModel({ name: "solo" }));
      expect(getChainsReferencingModel("solo")).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Task 2.3 — Gateway config repository tests
// ---------------------------------------------------------------------------

describe("Gateway config repository", () => {
  describe("getGatewayConfig", () => {
    it("returns null when no config row exists", () => {
      expect(getGatewayConfig()).toBeNull();
    });

    it("returns the singleton config row after insertion", () => {
      insertGatewayConfig(makeGatewayConfig({ default_model: "glm-5" }));

      const config = getGatewayConfig()!;
      expect(config).not.toBeNull();
      expect(config.default_model).toBe("glm-5");
      expect(config.id).toBe(1);
    });
  });

  describe("insertGatewayConfig", () => {
    it("persists all fields correctly", () => {
      const config = makeGatewayConfig({
        default_model: "glm-5",
        request_timeout_ms: 60000,
        max_retries: 2,
        max_body_size_kb: 2048,
        gateway_auth_token_env: "GW_TOKEN",
        health_probe_enabled: 1,
        cors_origin: "*",
        copilot_proxy_enabled: 1,
        copilot_proxy_require_token_auth: 0,
        copilot_proxy_token_ttl_seconds: 43200,
        copilot_proxy_heartbeat_interval_ms: 15000,
        copilot_proxy_heartbeat_timeout_ms: 5000,
        copilot_proxy_max_inflight_per_connection: 8,
        copilot_proxy_allowed_prefixes: '["copilot-", "ext-"]',
      });

      insertGatewayConfig(config);

      const fetched = getGatewayConfig()!;
      expect(fetched.default_model).toBe("glm-5");
      expect(fetched.request_timeout_ms).toBe(60000);
      expect(fetched.max_retries).toBe(2);
      expect(fetched.max_body_size_kb).toBe(2048);
      expect(fetched.gateway_auth_token_env).toBe("GW_TOKEN");
      expect(fetched.health_probe_enabled).toBe(1);
      expect(fetched.cors_origin).toBe("*");
      expect(fetched.copilot_proxy_enabled).toBe(1);
      expect(fetched.copilot_proxy_require_token_auth).toBe(0);
      expect(fetched.copilot_proxy_token_ttl_seconds).toBe(43200);
      expect(fetched.copilot_proxy_heartbeat_interval_ms).toBe(15000);
      expect(fetched.copilot_proxy_heartbeat_timeout_ms).toBe(5000);
      expect(fetched.copilot_proxy_max_inflight_per_connection).toBe(8);
      expect(fetched.copilot_proxy_allowed_prefixes).toBe('["copilot-", "ext-"]');
    });

    it("throws on duplicate insert (singleton)", () => {
      insertGatewayConfig(makeGatewayConfig());
      expect(() => insertGatewayConfig(makeGatewayConfig())).toThrow();
    });
  });

  describe("updateGatewayConfig", () => {
    it("updates only the specified fields", () => {
      insertGatewayConfig(makeGatewayConfig({
        default_model: "glm-5",
        request_timeout_ms: 30000,
        max_retries: 0,
      }));

      updateGatewayConfig({
        default_model: "deepseek-v4",
        max_retries: 3,
      });

      const config = getGatewayConfig()!;
      expect(config.default_model).toBe("deepseek-v4");
      expect(config.max_retries).toBe(3);
      // Unchanged fields.
      expect(config.request_timeout_ms).toBe(30000);
    });

    it("is a no-op when called with an empty partial", () => {
      insertGatewayConfig(makeGatewayConfig({ default_model: "glm-5" }));

      updateGatewayConfig({});

      const config = getGatewayConfig()!;
      expect(config.default_model).toBe("glm-5");
    });

    it("can set fields to null", () => {
      insertGatewayConfig(makeGatewayConfig({ default_model: "glm-5" }));

      updateGatewayConfig({ default_model: null });

      const config = getGatewayConfig()!;
      expect(config.default_model).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Task 2.4 — Chain status recalculation tests
// ---------------------------------------------------------------------------

describe("Chain status recalculation", () => {
  it("sets status to 'active' when all models are active", () => {
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

  it("sets status to 'inactive' when all models are inactive", () => {
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

  it("sets status to 'degraded' when some models are inactive", () => {
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

  it("handles multiple inactive models in the reason string", () => {
    insertModel(makeModel({ name: "m1", status: "active" }));
    insertModel(makeModel({ name: "m2", status: "inactive", status_reason: "Down" }));
    insertModel(makeModel({ name: "m3", status: "inactive", status_reason: "Down" }));
    insertChain(makeChain({ name: "test-chain" }), [
      makeChainModel({ chain_name: "test-chain", position: 0, model_name: "m1" }),
      makeChainModel({ chain_name: "test-chain", position: 1, model_name: "m2" }),
      makeChainModel({ chain_name: "test-chain", position: 2, model_name: "m3" }),
    ]);

    recalculateChainStatus("test-chain");

    const chain = getChainByName("test-chain")!;
    expect(chain.status).toBe("degraded");
    expect(chain.status_reason).toBe("2 of 3 models inactive: m2, m3");
  });

  it("handles chain with a single model going inactive", () => {
    insertModel(makeModel({ name: "m1", status: "inactive", status_reason: "Offline" }));
    insertChain(makeChain({ name: "solo-chain" }), [
      makeChainModel({ chain_name: "solo-chain", position: 0, model_name: "m1" }),
    ]);

    recalculateChainStatus("solo-chain");

    const chain = getChainByName("solo-chain")!;
    expect(chain.status).toBe("inactive");
    expect(chain.status_reason).toBe("All models inactive");
  });

  it("handles chain with no models as inactive", () => {
    insertChain(makeChain({ name: "empty-chain" }), []);

    recalculateChainStatus("empty-chain");

    const chain = getChainByName("empty-chain")!;
    expect(chain.status).toBe("inactive");
    expect(chain.status_reason).toBe("No models in chain");
  });

  it("updates status_changed_at and updated_at on recalculation", () => {
    insertModel(makeModel({ name: "m1", status: "active" }));
    insertChain(makeChain({ name: "test-chain", status: "degraded", status_reason: "Old reason", status_changed_at: 0, updated_at: 0 }), [
      makeChainModel({ chain_name: "test-chain", position: 0, model_name: "m1" }),
    ]);

    recalculateChainStatus("test-chain");

    const chain = getChainByName("test-chain")!;
    expect(chain.status_changed_at).toBeGreaterThan(0);
    expect(chain.updated_at).toBeGreaterThan(0);
  });

  it("recalculates correctly when a model is reactivated", () => {
    // Start with one active, one inactive.
    insertModel(makeModel({ name: "m1", status: "active" }));
    insertModel(makeModel({ name: "m2", status: "inactive", status_reason: "Down" }));
    insertChain(makeChain({ name: "test-chain" }), [
      makeChainModel({ chain_name: "test-chain", position: 0, model_name: "m1" }),
      makeChainModel({ chain_name: "test-chain", position: 1, model_name: "m2" }),
    ]);

    recalculateChainStatus("test-chain");
    expect(getChainByName("test-chain")!.status).toBe("degraded");

    // Reactivate m2.
    updateModelStatus("m2", "active", "Back up");
    recalculateChainStatus("test-chain");
    expect(getChainByName("test-chain")!.status).toBe("active");
    expect(getChainByName("test-chain")!.status_reason).toBe("All models active");
  });

  it("recalculates correctly when the last active model goes inactive", () => {
    insertModel(makeModel({ name: "m1", status: "active" }));
    insertModel(makeModel({ name: "m2", status: "inactive", status_reason: "Down" }));
    insertChain(makeChain({ name: "test-chain" }), [
      makeChainModel({ chain_name: "test-chain", position: 0, model_name: "m1" }),
      makeChainModel({ chain_name: "test-chain", position: 1, model_name: "m2" }),
    ]);

    recalculateChainStatus("test-chain");
    expect(getChainByName("test-chain")!.status).toBe("degraded");

    // Deactivate the last active model.
    updateModelStatus("m1", "inactive", "Gone");
    recalculateChainStatus("test-chain");
    expect(getChainByName("test-chain")!.status).toBe("inactive");
    expect(getChainByName("test-chain")!.status_reason).toBe("All models inactive");
  });
});
