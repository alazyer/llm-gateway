import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { openDatabase, closeDatabase } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations/index.js";
import { allMigrations } from "../src/db/migrations/all.js";
import type { ModelRow, ModelChainRow, ChainModelRow, GatewayConfigRow } from "../src/db/types.js";
import {
  insertModel,
  insertChain,
  insertGatewayConfig,
  getModelByName,
  getChainByName,
  getAllModels,
  getAllChains,
} from "../src/db/repository.js";

// ---------------------------------------------------------------------------
// Test config and helpers
// ---------------------------------------------------------------------------

const GATEWAY_AUTH_TOKEN = "test-admin-token";

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
    unknown_field_mode: overrides.unknown_field_mode ?? "warn",
    unknown_field_window_requests: overrides.unknown_field_window_requests ?? 100,
    source: overrides.source ?? "static",
    source_prefix: overrides.source_prefix ?? null,
    connection_id: overrides.connection_id ?? null,
    status: overrides.status ?? "active",
    status_reason: overrides.status_reason ?? "Seeded",
    status_changed_at: overrides.status_changed_at ?? Math.floor(Date.now() / 1000),
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
    status_reason: overrides.status_reason ?? "Seeded",
    status_changed_at: overrides.status_changed_at ?? Math.floor(Date.now() / 1000),
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
    default_model: overrides?.default_model ?? "glm-5",
    request_timeout_ms: overrides?.request_timeout_ms ?? 30000,
    max_retries: overrides?.max_retries ?? 0,
    max_body_size_kb: overrides?.max_body_size_kb ?? 1024,
    gateway_auth_token_env: overrides?.gateway_auth_token_env ?? "GW_AUTH_TOKEN",
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

function baseConfig(): AppConfig {
  return {
    host: "127.0.0.1",
    port: 3001,
    logLevel: "silent",
    upstreamBaseUrl: "https://provider.example/v1",
    defaultModel: "glm-5",
    requestTimeoutMs: 30000,
    maxRetries: 0,
    maxBodySizeKb: 1024,
    healthProbeEnabled: false,
  workspace: { enabled: false },
    gatewayAuthToken: GATEWAY_AUTH_TOKEN,
    models: [
      {
        name: "glm-5",
        upstreamModel: "glm-5",
        baseUrl: "https://provider.example/v1",
        apiKey: "secret-key",
        apiKeyEnv: "GLM5_API_KEY",
        ownedBy: "zhipu",
        created: 1_718_000_000,
        supportsTools: true,
        supportsStreaming: true,
        unknownFieldMode: "warn",
        unknownFieldWindowRequests: 100,
        status: "active",
        statusReason: "Seeded",
        statusChangedAt: 1_718_000_000,
      },
    ],
  };
}

/** Seed the temp database with sample data. */
function seedTestData(): void {
  insertModel(makeModel({ name: "glm-5", status: "active" }));
  insertModel(makeModel({ name: "deepseek-v4", status: "active" }));
  insertModel(makeModel({ name: "offline-model", status: "inactive", status_reason: "Maintenance", source: "copilot-proxy" }));
  insertGatewayConfig(makeGatewayConfig({ default_model: "glm-5" }));
}

beforeEach(() => {
  closeDatabase();
  tempDir = join(tmpdir(), `llm-gateway-crud-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "test.db") });
  runMigrations(db, allMigrations);
  seedTestData();
});

afterEach(() => {
  closeDatabase();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

const authHeaders = { "x-api-key": GATEWAY_AUTH_TOKEN };

// ---------------------------------------------------------------------------
// POST /admin/models — create
// ---------------------------------------------------------------------------

describe("POST /admin/models", () => {
  it("creates a new model and returns 201", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/admin/models",
        headers: { ...authHeaders, "content-type": "application/json" },
        payload: {
          name: "new-model",
          upstream_model: "new-model-v1",
          base_url: "https://new.example.com",
          api_key_env: "NEW_MODEL_KEY",
          owned_by: "test-org",
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.model.name).toBe("new-model");
      expect(body.model.status).toBe("active");
      expect(body.model.api_key_env).toBe("NEW_MODEL_KEY");

      // Verify in database
      const dbModel = getModelByName("new-model");
      expect(dbModel).toBeDefined();
      expect(dbModel!.upstream_model).toBe("new-model-v1");
    } finally {
      await app.close();
    }
  });

  it("returns 400 when required fields are missing", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/admin/models",
        headers: { ...authHeaders, "content-type": "application/json" },
        payload: { name: "incomplete" },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.type).toBe("invalid_request_error");
    } finally {
      await app.close();
    }
  });

  it("returns 409 when model already exists", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/admin/models",
        headers: { ...authHeaders, "content-type": "application/json" },
        payload: {
          name: "glm-5",
          upstream_model: "glm-5",
          base_url: "https://api.example.com",
          api_key_env: "KEY",
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error.type).toBe("conflict_error");
    } finally {
      await app.close();
    }
  });

  it("requires authentication", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/admin/models",
        payload: {
          name: "no-auth-model",
          upstream_model: "no-auth-model",
          base_url: "https://api.example.com",
          api_key_env: "KEY",
        },
      });

      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// PUT /admin/models/:name — update
// ---------------------------------------------------------------------------

describe("PUT /admin/models/:name", () => {
  it("updates model fields", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/admin/models/glm-5",
        headers: { ...authHeaders, "content-type": "application/json" },
        payload: {
          upstream_model: "glm-5-v2",
          owned_by: "updated-org",
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.model.upstream_model).toBe("glm-5-v2");
      expect(body.model.owned_by).toBe("updated-org");

      // Verify in database
      const dbModel = getModelByName("glm-5");
      expect(dbModel!.upstream_model).toBe("glm-5-v2");
    } finally {
      await app.close();
    }
  });

  it("triggers chain recalculation when status changes", async () => {
    // Set up a chain that references deepseek-v4
    insertChain(
      makeChain({ name: "test-chain", status: "active" }),
      [makeChainModel({ chain_name: "test-chain", position: 0, model_name: "deepseek-v4" })],
    );

    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/admin/models/deepseek-v4",
        headers: { ...authHeaders, "content-type": "application/json" },
        payload: { status: "inactive" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().model.status).toBe("inactive");

      // Chain should now be inactive (all models inactive or none active)
      const chain = getChainByName("test-chain");
      expect(chain!.status).toBe("inactive");
    } finally {
      await app.close();
    }
  });

  it("returns 404 for non-existent model", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/admin/models/nonexistent",
        headers: { ...authHeaders, "content-type": "application/json" },
        payload: { owned_by: "someone" },
      });

      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// DELETE /admin/models/:name — delete
// ---------------------------------------------------------------------------

describe("DELETE /admin/models/:name", () => {
  it("deletes a model and returns affected chains", async () => {
    // Create a chain that references deepseek-v4
    insertChain(
      makeChain({ name: "chain-with-deepseek", status: "active" }),
      [makeChainModel({ chain_name: "chain-with-deepseek", position: 0, model_name: "deepseek-v4" })],
    );

    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "DELETE",
        url: "/admin/models/deepseek-v4",
        headers: authHeaders,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.message).toContain("deleted successfully");
      expect(body.affected_chains).toContain("chain-with-deepseek");

      // Verify model is gone
      const dbModel = getModelByName("deepseek-v4");
      expect(dbModel).toBeNull();

      // Chain should have been recalculated (now has no active models)
      const chain = getChainByName("chain-with-deepseek");
      expect(chain!.status).toBe("inactive");
    } finally {
      await app.close();
    }
  });

  it("returns 404 for non-existent model", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "DELETE",
        url: "/admin/models/ghost",
        headers: authHeaders,
      });

      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("requires authentication", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "DELETE",
        url: "/admin/models/glm-5",
      });

      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /admin/models?status=&source= — query filters
// ---------------------------------------------------------------------------

describe("GET /admin/models — query filters", () => {
  it("filters by status", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/models?status=inactive",
        headers: authHeaders,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.models).toHaveLength(1);
      expect(body.models[0].name).toBe("offline-model");
      expect(body.models[0].status).toBe("inactive");
    } finally {
      await app.close();
    }
  });

  it("filters by source", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/models?source=copilot-proxy",
        headers: authHeaders,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.models).toHaveLength(1);
      expect(body.models[0].name).toBe("offline-model");
    } finally {
      await app.close();
    }
  });

  it("filters by both status and source", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/models?status=active&source=static",
        headers: authHeaders,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.models).toHaveLength(2);
      const names = body.models.map((m: { name: string }) => m.name).sort();
      expect(names).toEqual(["deepseek-v4", "glm-5"]);
    } finally {
      await app.close();
    }
  });

  it("returns all models when no filters provided", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/models",
        headers: authHeaders,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().models).toHaveLength(3);
    } finally {
      await app.close();
    }
  });

  it("returns empty array for non-matching filter", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/models?status=degraded",
        headers: authHeaders,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().models).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /admin/chains — create
// ---------------------------------------------------------------------------

describe("POST /admin/chains", () => {
  it("creates a new chain with models and returns 201", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/admin/chains",
        headers: { ...authHeaders, "content-type": "application/json" },
        payload: {
          name: "my-chain",
          timeout_ms: 60000,
          models: [
            { model_name: "glm-5" },
            { model_name: "deepseek-v4", timeout_ms: 10000 },
          ],
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.chain.name).toBe("my-chain");
      expect(body.chain.models).toHaveLength(2);
      expect(body.chain.models[0].model_name).toBe("glm-5");
      expect(body.chain.models[1].timeout_ms).toBe(10000);

      // Verify in database
      const dbChain = getChainByName("my-chain");
      expect(dbChain).toBeDefined();
    } finally {
      await app.close();
    }
  });

  it("returns 400 when name is missing", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/admin/chains",
        headers: { ...authHeaders, "content-type": "application/json" },
        payload: {
          models: [{ model_name: "glm-5" }],
        },
      });

      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("returns 400 when models array is empty", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/admin/chains",
        headers: { ...authHeaders, "content-type": "application/json" },
        payload: {
          name: "empty-chain",
          models: [],
        },
      });

      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("returns 400 when referencing non-existent model", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/admin/chains",
        headers: { ...authHeaders, "content-type": "application/json" },
        payload: {
          name: "bad-chain",
          models: [{ model_name: "nonexistent" }],
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.message).toContain("not found");
    } finally {
      await app.close();
    }
  });

  it("returns 409 when chain already exists", async () => {
    insertChain(
      makeChain({ name: "existing-chain" }),
      [makeChainModel({ chain_name: "existing-chain", position: 0, model_name: "glm-5" })],
    );

    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/admin/chains",
        headers: { ...authHeaders, "content-type": "application/json" },
        payload: {
          name: "existing-chain",
          models: [{ model_name: "glm-5" }],
        },
      });

      expect(response.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it("calculates chain status correctly after creation", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      // Create chain with one active and one inactive model
      const response = await app.inject({
        method: "POST",
        url: "/admin/chains",
        headers: { ...authHeaders, "content-type": "application/json" },
        payload: {
          name: "mixed-chain",
          models: [
            { model_name: "glm-5" },
            { model_name: "offline-model" },
          ],
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().chain.status).toBe("degraded");
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// PUT /admin/chains/:name — update
// ---------------------------------------------------------------------------

describe("PUT /admin/chains/:name", () => {
  it("updates chain-level fields", async () => {
    insertChain(
      makeChain({ name: "update-me", timeout_ms: 30000 }),
      [makeChainModel({ chain_name: "update-me", position: 0, model_name: "glm-5" })],
    );

    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/admin/chains/update-me",
        headers: { ...authHeaders, "content-type": "application/json" },
        payload: { timeout_ms: 60000 },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().chain.timeout_ms).toBe(60000);
    } finally {
      await app.close();
    }
  });

  it("replaces model membership", async () => {
    insertChain(
      makeChain({ name: "swap-models" }),
      [makeChainModel({ chain_name: "swap-models", position: 0, model_name: "glm-5" })],
    );

    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/admin/chains/swap-models",
        headers: { ...authHeaders, "content-type": "application/json" },
        payload: {
          models: [
            { model_name: "deepseek-v4" },
            { model_name: "glm-5" },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      const models = response.json().chain.models;
      expect(models).toHaveLength(2);
      expect(models[0].model_name).toBe("deepseek-v4");
      expect(models[1].model_name).toBe("glm-5");
    } finally {
      await app.close();
    }
  });

  it("returns 404 for non-existent chain", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/admin/chains/nonexistent",
        headers: { ...authHeaders, "content-type": "application/json" },
        payload: { timeout_ms: 10000 },
      });

      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("returns 400 when referencing non-existent model in update", async () => {
    insertChain(
      makeChain({ name: "bad-update" }),
      [makeChainModel({ chain_name: "bad-update", position: 0, model_name: "glm-5" })],
    );

    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/admin/chains/bad-update",
        headers: { ...authHeaders, "content-type": "application/json" },
        payload: {
          models: [{ model_name: "nonexistent" }],
        },
      });

      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// DELETE /admin/chains/:name — delete
// ---------------------------------------------------------------------------

describe("DELETE /admin/chains/:name", () => {
  it("deletes a chain", async () => {
    insertChain(
      makeChain({ name: "delete-me" }),
      [makeChainModel({ chain_name: "delete-me", position: 0, model_name: "glm-5" })],
    );

    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "DELETE",
        url: "/admin/chains/delete-me",
        headers: authHeaders,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().message).toContain("deleted successfully");

      // Verify chain is gone
      const dbChain = getChainByName("delete-me");
      expect(dbChain).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("returns 404 for non-existent chain", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "DELETE",
        url: "/admin/chains/nonexistent",
        headers: authHeaders,
      });

      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /admin/chains?status=&source= — query filters
// ---------------------------------------------------------------------------

describe("GET /admin/chains — query filters", () => {
  it("filters by status", async () => {
    insertChain(
      makeChain({ name: "active-chain", status: "active" }),
      [makeChainModel({ chain_name: "active-chain", position: 0, model_name: "glm-5" })],
    );
    insertChain(
      makeChain({ name: "inactive-chain", status: "inactive" }),
      [makeChainModel({ chain_name: "inactive-chain", position: 0, model_name: "offline-model" })],
    );

    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/chains?status=active",
        headers: authHeaders,
      });

      expect(response.statusCode).toBe(200);
      const names = response.json().chains.map((c: { name: string }) => c.name);
      expect(names).toContain("active-chain");
      expect(names).not.toContain("inactive-chain");
    } finally {
      await app.close();
    }
  });

  it("filters by source (matches chains containing a model with that source)", async () => {
    insertChain(
      makeChain({ name: "copilot-chain" }),
      [makeChainModel({ chain_name: "copilot-chain", position: 0, model_name: "offline-model" })],
    );
    insertChain(
      makeChain({ name: "static-chain" }),
      [makeChainModel({ chain_name: "static-chain", position: 0, model_name: "glm-5" })],
    );

    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/chains?source=copilot-proxy",
        headers: authHeaders,
      });

      expect(response.statusCode).toBe(200);
      const names = response.json().chains.map((c: { name: string }) => c.name);
      expect(names).toContain("copilot-chain");
      expect(names).not.toContain("static-chain");
    } finally {
      await app.close();
    }
  });

  it("returns all chains when no filters provided", async () => {
    insertChain(
      makeChain({ name: "a-chain" }),
      [makeChainModel({ chain_name: "a-chain", position: 0, model_name: "glm-5" })],
    );

    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/chains",
        headers: authHeaders,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().chains.length).toBeGreaterThanOrEqual(1);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// PATCH /admin/database — gateway config
// ---------------------------------------------------------------------------

describe("PATCH /admin/database", () => {
  it("updates gateway config fields", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/admin/database",
        headers: { ...authHeaders, "content-type": "application/json" },
        payload: {
          default_model: "deepseek-v4",
          request_timeout_ms: 60000,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.gateway_config.default_model).toBe("deepseek-v4");
      expect(body.gateway_config.request_timeout_ms).toBe(60000);
    } finally {
      await app.close();
    }
  });

  it("updates boolean fields correctly", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/admin/database",
        headers: { ...authHeaders, "content-type": "application/json" },
        payload: {
          health_probe_enabled: true,
          copilot_proxy_enabled: true,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.gateway_config.health_probe_enabled).toBe(true);
      expect(body.gateway_config.copilot_proxy_enabled).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("updates cors_origin with an array", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/admin/database",
        headers: { ...authHeaders, "content-type": "application/json" },
        payload: {
          cors_origin: ["http://localhost:3000", "https://app.example.com"],
        },
      });

      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("returns 400 when no fields provided", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/admin/database",
        headers: { ...authHeaders, "content-type": "application/json" },
        payload: {},
      });

      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it("returns 503 when gateway config is missing", async () => {
    closeDatabase();
    tempDir = join(tmpdir(), `llm-gateway-crud-noconfig-${Date.now()}`);
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "test.db") });
    runMigrations(db, allMigrations);
    // No gateway config inserted

    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "PATCH",
        url: "/admin/database",
        headers: { ...authHeaders, "content-type": "application/json" },
        payload: { default_model: "test" },
      });

      expect(response.statusCode).toBe(503);
    } finally {
      await app.close();
    }
  });
});
