/**
 * Integration tests: admin writes refresh the in-memory AppConfig so that
 * `/v1/models` (discovery) and routing reflect edits WITHOUT a server restart.
 *
 * This covers the staleness gap where `/admin/models` reads live from the DB but
 * `/v1/models` reads from the cached AppConfig built at startup. The app is
 * booted via the realistic path (applyDatabaseFallbackConfig → createApp), so
 * `config.models` is DB-sourced, then admin writes call refreshRuntimeModels
 * on the shared config reference.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { applyDatabaseFallbackConfig } from "../src/runtime-config.js";
import { closeDatabase, openDatabase, getDatabase } from "../src/db/index.js";
import { allMigrations } from "../src/db/migrations/all.js";
import { runMigrations } from "../src/db/migrations/index.js";
import { seedFromConfig } from "../src/db/seed.js";

const GATEWAY_AUTH_TOKEN = "test-refresh-token";
const BASE_ENV = {
  GATEWAY_AUTH_TOKEN,
  API_KEY: "secret-key",
} as NodeJS.ProcessEnv;

let tempDir = "";

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
    // Empty: the DB is the source of truth (mirrors server.ts using DB fallback).
    models: [],
    modelChains: [],
  };
}

function bootApp() {
  // Mirror server.ts: DB-sourced config via the fallback builder, so the app's
  // shared config reference reflects DB state and refreshRuntimeModels can
  // mutate it on admin writes.
  openDatabase({ GATEWAY_DB_PATH: join(tempDir, "test.db") });
  runMigrations(getDatabase(), allMigrations);
  seedFromConfig({
    ...baseConfig(),
    models: [
      {
        name: "glm-5",
        upstreamModel: "glm-5",
        baseUrl: "https://provider.example/v1",
        apiKey: "secret-key",
        apiKeyEnv: "API_KEY",
        ownedBy: "llm-gateway",
        created: 1_718_000_000,
        supportsTools: true,
        supportsStreaming: true,
        inputModalities: ["text"],
        outputModalities: ["text"],
        unknownFieldMode: "warn",
        unknownFieldWindowRequests: 100,
        status: "active",
        statusReason: "Seeded",
        statusChangedAt: 1_718_000_000,
      },
    ],
  });
  const config = applyDatabaseFallbackConfig(baseConfig(), { missingModels: false, missingModelChains: false }, BASE_ENV);
  return createApp({ config, fetchFn: vi.fn() as typeof fetch });
}

beforeEach(() => {
  closeDatabase();
  tempDir = join(tmpdir(), `llm-gateway-refresh-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
});

afterEach(() => {
  closeDatabase();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

async function listDiscoveryIds(app: ReturnType<typeof createApp>): Promise<string[]> {
  const res = await app.inject({ method: "GET", url: "/v1/models" });
  expect(res.statusCode).toBe(200);
  const data = res.json() as { data: { id: string }[] };
  return data.data.map((m) => m.id);
}

describe("Admin write → /v1/models refresh (no restart)", () => {
  it("a newly created model appears in discovery immediately", async () => {
    const app = bootApp();
    try {
      expect(await listDiscoveryIds(app)).toEqual(["glm-5"]);

      const created = await app.inject({
        method: "POST",
        url: "/admin/models",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
        payload: {
          name: "vision-new",
          upstream_model: "vision-new",
          base_url: "https://provider.example/v1",
          api_key_env: "API_KEY",
          input_modalities: ["text", "image"],
        },
      });
      expect(created.statusCode).toBe(201);

      const ids = await listDiscoveryIds(app);
      expect(ids).toContain("vision-new");

      // And its modalities are surfaced from the refreshed config.
      const res = await app.inject({ method: "GET", url: "/v1/models" });
      const record = res.json().data.find((m: { id: string }) => m.id === "vision-new");
      expect(record.capabilities.input_modalities).toEqual(["text", "image"]);
    } finally {
      await app.close();
    }
  });

  it("an updated model's modalities propagate to discovery", async () => {
    const app = bootApp();
    try {
      await app.inject({
        method: "POST",
        url: "/admin/models",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
        payload: {
          name: "evolving",
          upstream_model: "evolving",
          base_url: "https://provider.example/v1",
          api_key_env: "API_KEY",
        },
      });

      // Before: text-only.
      let res = await app.inject({ method: "GET", url: "/v1/models" });
      let record = res.json().data.find((m: { id: string }) => m.id === "evolving");
      expect(record.capabilities.input_modalities).toEqual(["text"]);

      await app.inject({
        method: "PUT",
        url: "/admin/models/evolving",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
        payload: { input_modalities: ["text", "image", "audio"] },
      });

      // After: refreshed config reflects the new modalities.
      res = await app.inject({ method: "GET", url: "/v1/models" });
      record = res.json().data.find((m: { id: string }) => m.id === "evolving");
      expect(record.capabilities.input_modalities).toEqual(["text", "image", "audio"]);
    } finally {
      await app.close();
    }
  });

  it("a deleted model disappears from discovery", async () => {
    const app = bootApp();
    try {
      await app.inject({
        method: "POST",
        url: "/admin/models",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
        payload: {
          name: "ephemeral",
          upstream_model: "ephemeral",
          base_url: "https://provider.example/v1",
          api_key_env: "API_KEY",
        },
      });
      expect(await listDiscoveryIds(app)).toContain("ephemeral");

      const res = await app.inject({
        method: "DELETE",
        url: "/admin/models/ephemeral",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });
      expect(res.statusCode).toBe(200);
      expect(await listDiscoveryIds(app)).not.toContain("ephemeral");
    } finally {
      await app.close();
    }
  });

  it("deactivating a model flips its status in discovery", async () => {
    const app = bootApp();
    try {
      await app.inject({
        method: "POST",
        url: "/admin/models",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
        payload: {
          name: "toggle-me",
          upstream_model: "toggle-me",
          base_url: "https://provider.example/v1",
          api_key_env: "API_KEY",
        },
      });

      let res = await app.inject({ method: "GET", url: "/v1/models" });
      let record = res.json().data.find((m: { id: string }) => m.id === "toggle-me");
      expect(record.status).toBe("active");

      await app.inject({
        method: "POST",
        url: "/admin/models/toggle-me/deactivate",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });

      res = await app.inject({ method: "GET", url: "/v1/models" });
      record = res.json().data.find((m: { id: string }) => m.id === "toggle-me");
      expect(record.status).toBe("inactive");
    } finally {
      await app.close();
    }
  });
});

describe("refreshRuntimeModels unit", () => {
  it("rebuilds config.models/modelChains from current DB state", async () => {
    openDatabase({ GATEWAY_DB_PATH: join(tempDir, "unit.db") });
    runMigrations(getDatabase(), allMigrations);
    seedFromConfig({
      ...baseConfig(),
      models: [
        {
          name: "glm-5",
          upstreamModel: "glm-5",
          baseUrl: "https://provider.example/v1",
          apiKey: "secret-key",
          apiKeyEnv: "API_KEY",
          ownedBy: "llm-gateway",
          created: 1_718_000_000,
          supportsTools: true,
          supportsStreaming: true,
          inputModalities: ["text"],
          outputModalities: ["text"],
          unknownFieldMode: "warn",
          unknownFieldWindowRequests: 100,
          status: "active",
          statusReason: "Seeded",
          statusChangedAt: 1_718_000_000,
        },
        {
          name: "gpt-5",
          upstreamModel: "gpt-5",
          baseUrl: "https://provider.example/v1",
          apiKey: "secret-key",
          apiKeyEnv: "API_KEY",
          ownedBy: "openai",
          created: 1_718_000_000,
          supportsTools: true,
          supportsStreaming: true,
          inputModalities: ["text", "image"],
          outputModalities: ["text"],
          unknownFieldMode: "warn",
          unknownFieldWindowRequests: 100,
          status: "active",
          statusReason: "Seeded",
          statusChangedAt: 1_718_000_000,
        },
      ],
    });

    const { refreshRuntimeModels } = await import("../src/runtime-config.js");
    const config = baseConfig();
    config.models = [];
    refreshRuntimeModels(config, BASE_ENV);

    expect(config.models.map((m) => m.name).sort()).toEqual(["glm-5", "gpt-5"]);
    expect(config.models.find((m) => m.name === "gpt-5")!.inputModalities).toEqual(["text", "image"]);
    expect(config.modelChains).toEqual([]);
  });
});
