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
  // Models
  insertModel(makeModel({ name: "glm-5", status: "active" }));
  insertModel(makeModel({ name: "deepseek-v4", status: "active" }));
  insertModel(makeModel({ name: "offline-model", status: "inactive", status_reason: "Maintenance" }));

  // Chain with mixed model statuses
  insertChain(
    makeChain({ name: "fallback", status: "degraded", status_reason: "1 of 2 models inactive: offline-model" }),
    [
      makeChainModel({ chain_name: "fallback", position: 0, model_name: "deepseek-v4" }),
      makeChainModel({ chain_name: "fallback", position: 1, model_name: "offline-model" }),
    ],
  );

  // Gateway config
  insertGatewayConfig(makeGatewayConfig({ default_model: "glm-5" }));
}

beforeEach(() => {
  closeDatabase();
  tempDir = join(tmpdir(), `llm-gateway-admin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

// ---------------------------------------------------------------------------
// Auth tests
// ---------------------------------------------------------------------------

describe("Admin routes — authentication", () => {
  it("requires auth for GET /admin/models", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({ method: "GET", url: "/admin/models" });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("requires auth for GET /admin/models/:name", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({ method: "GET", url: "/admin/models/glm-5" });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("requires auth for POST /admin/models/:name/activate", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({ method: "POST", url: "/admin/models/offline-model/activate" });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("requires auth for POST /admin/models/:name/deactivate", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({ method: "POST", url: "/admin/models/glm-5/deactivate" });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("requires auth for GET /admin/chains", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({ method: "GET", url: "/admin/chains" });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("requires auth for GET /admin/chains/:name", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({ method: "GET", url: "/admin/chains/fallback" });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("requires auth for GET /admin/status", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({ method: "GET", url: "/admin/status" });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("requires auth for GET /admin/database", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({ method: "GET", url: "/admin/database" });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("accepts valid x-api-key for admin routes", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/models",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("accepts valid Authorization Bearer for admin routes", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/models",
        headers: { "authorization": `Bearer ${GATEWAY_AUTH_TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("rejects invalid token for admin routes", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/models",
        headers: { "x-api-key": "wrong-token" },
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /admin/models
// ---------------------------------------------------------------------------

describe("GET /admin/models", () => {
  it("returns all models with status summaries", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/models",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.models).toHaveLength(3);

      // Should be ordered by name
      const names = body.models.map((m: { name: string }) => m.name);
      expect(names).toEqual(["deepseek-v4", "glm-5", "offline-model"]);

      // Each summary should have key fields
      const offline = body.models.find((m: { name: string }) => m.name === "offline-model");
      expect(offline).toBeDefined();
      expect(offline.status).toBe("inactive");
      expect(offline.status_reason).toBe("Maintenance");
      expect(offline.supports_tools).toBe(true);
      expect(offline.supports_streaming).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("returns empty array when no models exist", async () => {
    closeDatabase();
    tempDir = join(tmpdir(), `llm-gateway-admin-empty-${Date.now()}`);
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "test.db") });
    runMigrations(db, allMigrations);
    insertGatewayConfig(makeGatewayConfig());

    const app = createApp({ config: { ...baseConfig(), models: [] } });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/models",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().models).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /admin/models/:name
// ---------------------------------------------------------------------------

describe("GET /admin/models/:name", () => {
  it("returns full model detail for an existing model", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/models/glm-5",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const model = body.model;
      expect(model.name).toBe("glm-5");
      expect(model.status).toBe("active");
      expect(model.api_key_env).toBe("API_KEY");
      expect(model.created).toBeDefined();
      expect(model.updated_at).toBeDefined();
      expect(model.unknown_field_mode).toBe("warn");
      expect(model.source).toBe("static");
    } finally {
      await app.close();
    }
  });

  it("returns 404 for non-existent model", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/models/nonexistent",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: {
          message: "Model 'nonexistent' not found.",
          type: "not_found_error",
        },
      });
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /admin/models/:name/activate
// ---------------------------------------------------------------------------

describe("POST /admin/models/:name/activate", () => {
  it("activates an inactive model", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      // Verify it's inactive before
      const modelBefore = getModelByName("offline-model");
      expect(modelBefore!.status).toBe("inactive");

      const response = await app.inject({
        method: "POST",
        url: "/admin/models/offline-model/activate",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.model.name).toBe("offline-model");
      expect(body.model.status).toBe("active");
      expect(body.message).toContain("activated successfully");

      // Verify in database
      const modelAfter = getModelByName("offline-model");
      expect(modelAfter!.status).toBe("active");
      expect(modelAfter!.status_reason).toBe("Activated via admin API");
    } finally {
      await app.close();
    }
  });

  it("returns message when model is already active", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/admin/models/glm-5/activate",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.model.status).toBe("active");
      expect(body.message).toContain("already active");

      // Verify status unchanged in database
      const model = getModelByName("glm-5");
      expect(model!.status).toBe("active");
    } finally {
      await app.close();
    }
  });

  it("returns 404 for non-existent model", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/admin/models/ghost/activate",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.message).toContain("not found");
    } finally {
      await app.close();
    }
  });

  it("recalculates affected chain status after activation", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      // The 'fallback' chain is degraded because offline-model is inactive
      const chainBefore = getChainByName("fallback");
      expect(chainBefore!.status).toBe("degraded");

      await app.inject({
        method: "POST",
        url: "/admin/models/offline-model/activate",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      // Chain should now be active since all its models are active
      const chainAfter = getChainByName("fallback");
      expect(chainAfter!.status).toBe("active");
      expect(chainAfter!.status_reason).toBe("All models active");
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /admin/models/:name/deactivate
// ---------------------------------------------------------------------------

describe("POST /admin/models/:name/deactivate", () => {
  it("deactivates an active model", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const modelBefore = getModelByName("glm-5");
      expect(modelBefore!.status).toBe("active");

      const response = await app.inject({
        method: "POST",
        url: "/admin/models/glm-5/deactivate",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.model.name).toBe("glm-5");
      expect(body.model.status).toBe("inactive");
      expect(body.message).toContain("deactivated successfully");

      const modelAfter = getModelByName("glm-5");
      expect(modelAfter!.status).toBe("inactive");
      expect(modelAfter!.status_reason).toBe("Deactivated via admin API");
    } finally {
      await app.close();
    }
  });

  it("returns message when model is already inactive", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/admin/models/offline-model/deactivate",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.model.status).toBe("inactive");
      expect(body.message).toContain("already inactive");
    } finally {
      await app.close();
    }
  });

  it("returns 404 for non-existent model", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/admin/models/ghost/deactivate",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("recalculates affected chain status after deactivation", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      // Deactivate deepseek-v4, which is in the 'fallback' chain
      await app.inject({
        method: "POST",
        url: "/admin/models/deepseek-v4/deactivate",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      // Now both models in 'fallback' chain are inactive
      const chain = getChainByName("fallback");
      expect(chain!.status).toBe("inactive");
      expect(chain!.status_reason).toBe("All models inactive");
    } finally {
      await app.close();
    }
  });

  it("sets chain to degraded when deactivating one of two models", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      // Activate offline-model first so fallback chain is active
      await app.inject({
        method: "POST",
        url: "/admin/models/offline-model/activate",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      // Now deactivate it again
      await app.inject({
        method: "POST",
        url: "/admin/models/offline-model/deactivate",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      // Chain should be degraded (1 active, 1 inactive)
      const chain = getChainByName("fallback");
      expect(chain!.status).toBe("degraded");
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /admin/chains
// ---------------------------------------------------------------------------

describe("GET /admin/chains", () => {
  it("returns all chains with status summaries", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/chains",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.chains).toHaveLength(1);

      const chain = body.chains[0];
      expect(chain.name).toBe("fallback");
      expect(chain.status).toBe("degraded");
      expect(chain.active_models).toBe(1);
      expect(chain.total_models).toBe(2);
      expect(chain.timeout_ms).toBe(30000);
      expect(chain.max_retries).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("returns empty array when no chains exist", async () => {
    closeDatabase();
    tempDir = join(tmpdir(), `llm-gateway-admin-nochain-${Date.now()}`);
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "test.db") });
    runMigrations(db, allMigrations);
    insertModel(makeModel({ name: "solo-model" }));
    insertGatewayConfig(makeGatewayConfig());

    const config = baseConfig();
    config.models = [{
      name: "solo-model",
      upstreamModel: "solo-model",
      baseUrl: "https://provider.example/v1",
      apiKey: "secret",
      apiKeyEnv: "SOLO_KEY",
      ownedBy: "test",
      created: 1_718_000_000,
      supportsTools: true,
      supportsStreaming: true,
      unknownFieldMode: "warn",
      unknownFieldWindowRequests: 100,
      status: "active",
      statusReason: "Seeded",
      statusChangedAt: 1_718_000_000,
    }];

    const app = createApp({ config });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/chains",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().chains).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /admin/chains/:name
// ---------------------------------------------------------------------------

describe("GET /admin/chains/:name", () => {
  it("returns full chain detail with models", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/chains/fallback",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const chain = body.chain;

      expect(chain.name).toBe("fallback");
      expect(chain.status).toBe("degraded");
      expect(chain.active_models).toBe(1);
      expect(chain.total_models).toBe(2);
      expect(chain.updated_at).toBeDefined();

      // Models should include status
      expect(chain.models).toHaveLength(2);
      expect(chain.models[0].model_name).toBe("deepseek-v4");
      expect(chain.models[0].status).toBe("active");
      expect(chain.models[1].model_name).toBe("offline-model");
      expect(chain.models[1].status).toBe("inactive");
    } finally {
      await app.close();
    }
  });

  it("returns 404 for non-existent chain", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/chains/nonexistent",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        error: {
          message: "Chain 'nonexistent' not found.",
          type: "not_found_error",
        },
      });
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /admin/status
// ---------------------------------------------------------------------------

describe("GET /admin/status", () => {
  it("returns gateway status summary", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/status",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.status).toBe("ok");
      expect(body.models).toEqual({ total: 3, active: 2, inactive: 1 });
      expect(body.chains).toEqual({ total: 1, active: 0, degraded: 1, inactive: 0 });
      expect(body.default_model).toBe("glm-5");
      expect(body.uptime_seconds).toBeGreaterThanOrEqual(0);
    } finally {
      await app.close();
    }
  });

  it("reflects correct counts after activation/deactivation", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      // Activate the offline model
      await app.inject({
        method: "POST",
        url: "/admin/models/offline-model/activate",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      const response = await app.inject({
        method: "GET",
        url: "/admin/status",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.models).toEqual({ total: 3, active: 3, inactive: 0 });
      expect(body.chains).toEqual({ total: 1, active: 1, degraded: 0, inactive: 0 });
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// GET /admin/database
// ---------------------------------------------------------------------------

describe("GET /admin/database", () => {
  it("returns database info and gateway config", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/database",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.type).toBe("sqlite");
      expect(body.model_count).toBe(3);
      expect(body.chain_count).toBe(1);
      expect(body.gateway_config).toBeDefined();
      expect(body.gateway_config.id).toBe(1);
      expect(body.gateway_config.default_model).toBe("glm-5");
      expect(body.gateway_config.request_timeout_ms).toBe(30000);
      expect(body.gateway_config.health_probe_enabled).toBe(false);
      expect(body.gateway_config.copilot_proxy_enabled).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("returns 503 when gateway config is missing", async () => {
    closeDatabase();
    tempDir = join(tmpdir(), `llm-gateway-admin-noconfig-${Date.now()}`);
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "test.db") });
    runMigrations(db, allMigrations);
    // Don't insert a gateway config row

    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({
        method: "GET",
        url: "/admin/database",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json().error.message).toContain("not found");
    } finally {
      await app.close();
    }
  });
});
