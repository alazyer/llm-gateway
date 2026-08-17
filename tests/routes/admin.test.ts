/**
 * Phase 9 - Task 9.3: Integration tests for admin API
 *
 * Tests for:
 * - All admin endpoints
 * - Authentication requirement
 * - Status transitions
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { createApp } from "../../src/app.js";
import type { AppConfig } from "../../src/config.js";
import { openDatabase, closeDatabase } from "../../src/db/index.js";
import { runMigrations } from "../../src/db/migrations/index.js";
import { allMigrations } from "../../src/db/migrations/all.js";
import type { ModelRow, ModelChainRow, ChainModelRow, GatewayConfigRow } from "../../src/db/types.js";
import {
  insertModel,
  insertChain,
  insertGatewayConfig,
  getModelByName,
  getChainByName,
} from "../../src/db/repository.js";

const GATEWAY_AUTH_TOKEN = "test-admin-token";
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
    supports_image_input: overrides.supports_image_input ?? 0,
    unknown_field_mode: overrides.unknown_field_mode ?? "warn",
    unknown_field_window_requests: overrides.unknown_field_window_requests ?? 100,
    source: overrides.source ?? "static",
    source_prefix: overrides.source_prefix ?? null,
    connection_id: overrides.connection_id ?? null,
    status: overrides.status ?? "active",
    status_reason: overrides.status_reason ?? "Seeded",
    status_changed_at: overrides.status_changed_at ?? now,
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
    status_reason: overrides.status_reason ?? "Seeded",
    status_changed_at: overrides.status_changed_at ?? now,
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

function seedTestData(): void {
  insertModel(makeModel({ name: "glm-5", status: "active" }));
  insertModel(makeModel({ name: "deepseek-v4", status: "active" }));
  insertModel(makeModel({ name: "offline-model", status: "inactive", status_reason: "Maintenance" }));
  insertChain(
    makeChain({ name: "fallback", status: "degraded", status_reason: "1 of 2 models inactive: offline-model" }),
    [
      makeChainModel({ chain_name: "fallback", position: 0, model_name: "deepseek-v4" }),
      makeChainModel({ chain_name: "fallback", position: 1, model_name: "offline-model" }),
    ],
  );
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
// Authentication tests
// ---------------------------------------------------------------------------

describe("Admin routes - authentication", () => {
  it("requires auth for GET /admin/models", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      const response = await app.inject({ method: "GET", url: "/admin/models" });
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
      const names = body.models.map((m: { name: string }) => m.name);
      expect(names).toEqual(["deepseek-v4", "glm-5", "offline-model"]);
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
      const response = await app.inject({
        method: "POST",
        url: "/admin/models/offline-model/activate",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.model.status).toBe("active");

      const modelAfter = getModelByName("offline-model");
      expect(modelAfter!.status).toBe("active");
    } finally {
      await app.close();
    }
  });

  it("recalculates affected chain status after activation", async () => {
    const app = createApp({ config: baseConfig() });
    try {
      await app.inject({
        method: "POST",
        url: "/admin/models/offline-model/activate",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      const chainAfter = getChainByName("fallback");
      expect(chainAfter!.status).toBe("active");
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
      const response = await app.inject({
        method: "POST",
        url: "/admin/models/glm-5/deactivate",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.model.status).toBe("inactive");

      const modelAfter = getModelByName("glm-5");
      expect(modelAfter!.status).toBe("inactive");
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
      expect(body.chains[0].status).toBe("degraded");
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
    } finally {
      await app.close();
    }
  });
});
