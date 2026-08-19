/**
 * Tests for structured model modalities (`input_modalities` /
 * `output_modalities`), which replaced the single `supports_image_input`
 * boolean.
 *
 * Covers:
 * - Discovery: `/v1/models` surfaces stored modalities verbatim.
 * - Chain derivation: a chain advertises only modalities ALL members support.
 * - Migration 006 backfill: a model previously flagged `supports_image_input=1`
 *   is backfilled to `input_modalities='text,image'`.
 * - Admin CRUD: modalities round-trip through create/update/read.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AppConfig, GatewayModelConfig } from "../src/config.js";
import type { ChainModelEntry, ModelChainConfig } from "../src/contracts.js";
import { closeDatabase, openDatabase, getDatabase } from "../src/db/index.js";
import { allMigrations } from "../src/db/migrations/all.js";
import { runMigrations } from "../src/db/migrations/index.js";
import { getAllModels, getModelByName, updateModel } from "../src/db/repository.js";
import { seedFromConfig } from "../src/db/seed.js";
import type { ModelRow } from "../src/db/types.js";

const GATEWAY_AUTH_TOKEN = "test-modality-token";

let tempDir = "";

beforeEach(() => {
  closeDatabase();
  tempDir = join(tmpdir(), `llm-gateway-modality-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
});

afterEach(() => {
  closeDatabase();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function makeModel(overrides: Partial<GatewayModelConfig> & { name: string }): GatewayModelConfig {
  return {
    upstreamModel: overrides.name,
    baseUrl: "https://provider.example/v1",
    apiKey: "secret-key",
    apiKeyEnv: "API_KEY",
    ownedBy: "zhipu",
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

function makeChainEntry(modelConfig: GatewayModelConfig): ChainModelEntry {
  return { name: modelConfig.name, modelConfig, timeoutMs: 30000, maxRetries: 0 };
}

function makeConfig(
  models: GatewayModelConfig[],
  chains: ModelChainConfig[] = [],
): AppConfig {
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
    gatewayAuthToken: GATEWAY_AUTH_TOKEN,
    models,
    modelChains: chains.length > 0 ? chains : undefined,
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe("Model modalities — discovery", () => {
  it("surfaces stored input/output modalities verbatim on /v1/models", async () => {
    const model = makeModel({
      name: "glm-5.1-vision",
      inputModalities: ["text", "image"],
      outputModalities: ["text", "image"],
    });
    const app = createApp({ config: makeConfig([model]), fetchFn: vi.fn() as typeof fetch });

    try {
      const response = await app.inject({ method: "GET", url: "/v1/models" });
      expect(response.statusCode).toBe(200);

      const record = response.json().data.find((m: { id: string }) => m.id === "glm-5.1-vision");
      expect(record.capabilities.input_modalities).toEqual(["text", "image"]);
      expect(record.capabilities.output_modalities).toEqual(["text", "image"]);
    } finally {
      await app.close();
    }
  });

  it("defaults a text-only model to ['text'] for both directions", async () => {
    const model = makeModel({ name: "text-only" });
    const app = createApp({ config: makeConfig([model]), fetchFn: vi.fn() as typeof fetch });

    try {
      const response = await app.inject({ method: "GET", url: "/v1/models" });
      const record = response.json().data.find((m: { id: string }) => m.id === "text-only");
      expect(record.capabilities.input_modalities).toEqual(["text"]);
      expect(record.capabilities.output_modalities).toEqual(["text"]);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Chain derivation — intersection of all members
// ---------------------------------------------------------------------------

describe("Model modalities — chain intersection", () => {
  function chainOf(models: GatewayModelConfig[]): ModelChainConfig {
    return {
      name: "production",
      models: models.map(makeChainEntry),
      timeoutMs: 30000,
      maxRetries: 0,
      status: "active",
      statusReason: "ok",
      statusChangedAt: 1_718_000_000,
      activeModels: models.length,
      totalModels: models.length,
    };
  }

  it("advertises a modality only when ALL members support it", async () => {
    const vision = makeModel({ name: "vision", inputModalities: ["text", "image", "audio"] });
    const textImage = makeModel({ name: "text-image", inputModalities: ["text", "image"] });
    const app = createApp({
      config: makeConfig([vision, textImage], [chainOf([vision, textImage])]),
      fetchFn: vi.fn() as typeof fetch,
    });

    try {
      const response = await app.inject({ method: "GET", url: "/v1/models" });
      const chain = response.json().data.find((m: { id: string }) => m.id === "chain-production");
      // image is in both; audio is only in one; text is always present.
      expect(chain.capabilities.input_modalities).toEqual(["text", "image"]);
    } finally {
      await app.close();
    }
  });

  it("collapses to text-only when members disagree on every non-text modality", async () => {
    const audio = makeModel({ name: "audio-only-extra", inputModalities: ["text", "audio"] });
    const image = makeModel({ name: "image-only-extra", inputModalities: ["text", "image"] });
    const app = createApp({
      config: makeConfig([audio, image], [chainOf([audio, image])]),
      fetchFn: vi.fn() as typeof fetch,
    });

    try {
      const response = await app.inject({ method: "GET", url: "/v1/models" });
      const chain = response.json().data.find((m: { id: string }) => m.id === "chain-production");
      expect(chain.capabilities.input_modalities).toEqual(["text"]);
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Migration 006 backfill
// ---------------------------------------------------------------------------

describe("Migration 006 — backfill from supports_image_input", () => {
  it("migrates an image-flagged row to input_modalities='text,image'", () => {
    // Build a database at migration 005 (pre-modalities) so we can plant a
    // legacy `supports_image_input=1` row, then apply migration 006 and assert
    // the backfill.
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "backfill.db") });
    const upTo005 = allMigrations.filter((m) => m.version <= 5);
    runMigrations(db, upTo005);

    db.prepare(
      `INSERT INTO models (
         name, upstream_model, base_url, api_key_env, owned_by, created,
         supports_tools, supports_streaming, supports_image_input,
         unknown_field_mode, unknown_field_window_requests,
         source, source_prefix, connection_id,
         status, status_reason, status_changed_at, capabilities_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "legacy-vision", "legacy-vision", "https://provider.example/v1", "API_KEY", "zhipu", 1_718_000_000,
      1, 1, 1,
      "warn", 100,
      "static", null, null,
      "active", "legacy", 1_718_000_000, null, 1_718_000_000,
    );
    db.prepare(
      `INSERT INTO models (
         name, upstream_model, base_url, api_key_env, owned_by, created,
         supports_tools, supports_streaming, supports_image_input,
         unknown_field_mode, unknown_field_window_requests,
         source, source_prefix, connection_id,
         status, status_reason, status_changed_at, capabilities_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "legacy-text", "legacy-text", "https://provider.example/v1", "API_KEY", "zhipu", 1_718_000_000,
      1, 1, 0,
      "warn", 100,
      "static", null, null,
      "active", "legacy", 1_718_000_000, null, 1_718_000_000,
    );

    // Apply migration 006.
    runMigrations(db, allMigrations.filter((m) => m.version === 6));

    const vision = db.prepare("SELECT input_modalities, output_modalities FROM models WHERE name = 'legacy-vision'").get() as ModelRow;
    const text = db.prepare("SELECT input_modalities, output_modalities FROM models WHERE name = 'legacy-text'").get() as ModelRow;

    expect(vision.input_modalities).toBe("text,image");
    expect(vision.output_modalities).toBe("text");
    expect(text.input_modalities).toBe("text");
    expect(text.output_modalities).toBe("text");

    closeDatabase();
  });
});

// ---------------------------------------------------------------------------
// Admin CRUD round-trip
// ---------------------------------------------------------------------------

describe("Model modalities — admin CRUD round-trip", () => {
  function boot() {
    openDatabase({ GATEWAY_DB_PATH: join(tempDir, "crud.db") });
    runMigrations(getDatabase(), allMigrations);
  }

  it("persists modalities on create and returns them on read", async () => {
    boot();
    const app = createApp({
      config: makeConfig([makeModel({ name: "anchor" })]),
      fetchFn: vi.fn() as typeof fetch,
    });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/admin/models",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
        payload: {
          name: "multimodal",
          upstream_model: "multimodal",
          base_url: "https://provider.example/v1",
          api_key_env: "API_KEY",
          input_modalities: ["text", "image", "audio"],
          output_modalities: ["text", "image"],
        },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().model.input_modalities).toEqual(["text", "image", "audio"]);
      expect(created.json().model.output_modalities).toEqual(["text", "image"]);

      const detail = await app.inject({
        method: "GET",
        url: "/admin/models/multimodal",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
      });
      expect(detail.json().model.input_modalities).toEqual(["text", "image", "audio"]);
    } finally {
      await app.close();
    }
  });

  it("drops unknown tokens and guarantees text on create", async () => {
    boot();
    const app = createApp({
      config: makeConfig([makeModel({ name: "anchor" })]),
      fetchFn: vi.fn() as typeof fetch,
    });

    try {
      const created = await app.inject({
        method: "POST",
        url: "/admin/models",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
        payload: {
          name: "scrubbed",
          upstream_model: "scrubbed",
          base_url: "https://provider.example/v1",
          api_key_env: "API_KEY",
          input_modalities: ["image", "telepathy", "video"],
        },
      });
      expect(created.statusCode).toBe(201);
      // 'telepathy' dropped; 'text' guaranteed even though not requested.
      expect(created.json().model.input_modalities).toEqual(["text", "image", "video"]);
      expect(created.json().model.output_modalities).toEqual(["text"]);
    } finally {
      await app.close();
    }
  });

  it("updates modalities via PUT", async () => {
    boot();
    const app = createApp({
      config: makeConfig([makeModel({ name: "anchor" })]),
      fetchFn: vi.fn() as typeof fetch,
    });

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

      const updated = await app.inject({
        method: "PUT",
        url: "/admin/models/evolving",
        headers: { "x-api-key": GATEWAY_AUTH_TOKEN },
        payload: { input_modalities: ["text", "image"] },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().model.input_modalities).toEqual(["text", "image"]);

      // Repository reflects the stored TEXT form.
      const row = getModelByName("evolving")!;
      expect(row.input_modalities).toBe("text,image");
    } finally {
      await app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Repository storage + seed
// ---------------------------------------------------------------------------

describe("Model modalities — repository storage", () => {
  it("seeds modalities as comma-joined TEXT", () => {
    openDatabase({ GATEWAY_DB_PATH: join(tempDir, "repo.db") });
    runMigrations(getDatabase(), allMigrations);

    const config = makeConfig([
      makeModel({ name: "vision", inputModalities: ["text", "image"], outputModalities: ["text"] }),
    ]);
    seedFromConfig(config);

    const row = getModelByName("vision")!;
    expect(row.input_modalities).toBe("text,image");
    expect(row.output_modalities).toBe("text");
    expect(getAllModels()).toHaveLength(1);
  });

  it("updateModel persists modalities through allowedKeys", () => {
    openDatabase({ GATEWAY_DB_PATH: join(tempDir, "repo-update.db") });
    runMigrations(getDatabase(), allMigrations);

    const config = makeConfig([makeModel({ name: "m" })]);
    seedFromConfig(config);

    updateModel("m", { input_modalities: "text,image,audio", output_modalities: "text,image" });
    const row = getModelByName("m")!;
    expect(row.input_modalities).toBe("text,image,audio");
    expect(row.output_modalities).toBe("text,image");
  });
});
