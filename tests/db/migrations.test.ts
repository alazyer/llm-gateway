/**
 * Phase 9 - Task 9.5: Migration tests
 *
 * Tests for:
 * - Fresh database creation
 * - Seeding from YAML
 * - Schema upgrade (apply multiple migrations)
 * - Idempotent seeding
 */

import { existsSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { openDatabase, closeDatabase, getDatabase } from "../../src/db/index.js";
import { runMigrations, getCurrentVersion, type Migration } from "../../src/db/migrations/index.js";
import { allMigrations } from "../../src/db/migrations/all.js";
import { seedFromConfig } from "../../src/db/seed.js";
import type { AppConfig } from "../../src/config.js";
import type { SchemaMigrationRow } from "../../src/db/types.js";
import {
  getAllModels,
  getAllChains,
  getChainModels,
  getGatewayConfig,
} from "../../src/db/repository.js";

let tempDir: string;

beforeEach(() => {
  closeDatabase();
  tempDir = join(tmpdir(), `llm-gateway-migrations-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
});

afterEach(() => {
  closeDatabase();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fresh database creation
// ---------------------------------------------------------------------------

describe("Fresh database creation", () => {
  it("creates a new database file at the specified path", () => {
    const dbPath = join(tempDir, "fresh.db");
    const db = openDatabase({ GATEWAY_DB_PATH: dbPath });

    expect(db).toBeDefined();
    expect(existsSync(dbPath)).toBe(true);
  });

  it("creates parent directories if they do not exist", () => {
    const deepPath = join(tempDir, "a", "b", "c", "test.db");
    const db = openDatabase({ GATEWAY_DB_PATH: deepPath });

    expect(db).toBeDefined();
    expect(existsSync(deepPath)).toBe(true);
  });

  it("enables WAL mode", () => {
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "wal.db") });
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(row.journal_mode).toBe("wal");
  });

  it("enables foreign keys", () => {
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "fk.db") });
    const row = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
  });

  it("creates all expected tables after migration", () => {
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "tables.db") });
    runMigrations(db, allMigrations);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain("schema_migrations");
    expect(tableNames).toContain("models");
    expect(tableNames).toContain("model_chains");
    expect(tableNames).toContain("chain_models");
    expect(tableNames).toContain("gateway_config");
    expect(tableNames).toContain("ai_chat_sessions");
    expect(tableNames).toContain("ai_chat_messages");
    expect(tableNames).toContain("ai_chat_audit_events");
  });
});

// ---------------------------------------------------------------------------
// Seeding from YAML
// ---------------------------------------------------------------------------

describe("Seeding from YAML", () => {
  it("seeds models from AppConfig", () => {
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "seed.db") });
    runMigrations(db, allMigrations);

    const config: AppConfig = {
      host: "127.0.0.1",
      port: 3000,
      logLevel: "info",
      upstreamBaseUrl: "https://api.example.com/v1",
      defaultModel: "glm-5",
      requestTimeoutMs: 30000,
      maxRetries: 0,
      maxBodySizeKb: 1024,
      healthProbeEnabled: false,
      models: [
        {
          name: "glm-5",
          upstreamModel: "glm-5",
          baseUrl: "https://api.example.com/v1",
          apiKey: "secret",
          apiKeyEnv: "GLM5_KEY",
          ownedBy: "zhipu",
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
          baseUrl: "https://api.openai.com/v1",
          apiKey: "secret",
          apiKeyEnv: "OPENAI_KEY",
          ownedBy: "openai",
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
    };

    seedFromConfig(config);

    const models = getAllModels();
    expect(models).toHaveLength(2);
    expect(models.map((m) => m.name).sort()).toEqual(["glm-5", "gpt-5"]);

    for (const m of models) {
      expect(m.source).toBe("static");
      expect(m.status).toBe("active");
    }
  });

  it("seeds chains from AppConfig", () => {
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "seed-chains.db") });
    runMigrations(db, allMigrations);

    const config: AppConfig = {
      host: "127.0.0.1",
      port: 3000,
      logLevel: "info",
      upstreamBaseUrl: "https://api.example.com/v1",
      requestTimeoutMs: 30000,
      maxRetries: 0,
      maxBodySizeKb: 1024,
      healthProbeEnabled: false,
      models: [
        {
          name: "glm-5",
          upstreamModel: "glm-5",
          baseUrl: "https://api.example.com/v1",
          apiKey: "secret",
          apiKeyEnv: "GLM5_KEY",
          ownedBy: "zhipu",
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
          baseUrl: "https://api.openai.com/v1",
          apiKey: "secret",
          apiKeyEnv: "OPENAI_KEY",
          ownedBy: "openai",
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
      modelChains: [
        {
          name: "fallback",
          models: [
            { name: "glm-5", modelConfig: {} as any, timeoutMs: 30000, maxRetries: 0 },
            { name: "gpt-5", modelConfig: {} as any, timeoutMs: 30000, maxRetries: 0 },
          ],
          timeoutMs: 30000,
          maxRetries: 0,
          status: "active",
          statusReason: "Seeded",
          statusChangedAt: 1_718_000_000,
          activeModels: 2,
          totalModels: 2,
        },
      ],
    };

    seedFromConfig(config);

    const chains = getAllChains();
    expect(chains).toHaveLength(1);
    expect(chains[0]!.name).toBe("fallback");

    const chainModels = getChainModels("fallback");
    expect(chainModels).toHaveLength(2);
    expect(chainModels[0]!.model_name).toBe("glm-5");
    expect(chainModels[1]!.model_name).toBe("gpt-5");
  });

  it("seeds gateway config from AppConfig", () => {
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "seed-config.db") });
    runMigrations(db, allMigrations);

    const config: AppConfig = {
      host: "127.0.0.1",
      port: 3000,
      logLevel: "info",
      upstreamBaseUrl: "https://api.example.com/v1",
      defaultModel: "glm-5",
      requestTimeoutMs: 60000,
      maxRetries: 2,
      maxBodySizeKb: 2048,
      healthProbeEnabled: true,
      gatewayAuthToken: "test-token",
      gatewayAuthTokenEnv: "GW_TOKEN",
      corsOrigin: "*",
      models: [
        {
          name: "glm-5",
          upstreamModel: "glm-5",
          baseUrl: "https://api.example.com/v1",
          apiKey: "secret",
          apiKeyEnv: "GLM5_KEY",
          ownedBy: "zhipu",
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
    };

    seedFromConfig(config);

    const gwConfig = getGatewayConfig()!;
    expect(gwConfig).not.toBeNull();
    expect(gwConfig.default_model).toBe("glm-5");
    expect(gwConfig.request_timeout_ms).toBe(60000);
    expect(gwConfig.max_retries).toBe(2);
    expect(gwConfig.max_body_size_kb).toBe(2048);
    expect(gwConfig.health_probe_enabled).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Schema upgrade (apply multiple migrations)
// ---------------------------------------------------------------------------

describe("Schema upgrade", () => {
  it("reports version 0 for a fresh database", () => {
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "fresh.db") });
    expect(getCurrentVersion(db)).toBe(0);
  });

  it("applies all pending migrations from scratch", () => {
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "migrate.db") });
    runMigrations(db, allMigrations);

    const version = getCurrentVersion(db);
    expect(version).toBe(allMigrations[allMigrations.length - 1]!.version);
  });

  it("records each applied migration version", () => {
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "versions.db") });
    runMigrations(db, allMigrations);

    const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as SchemaMigrationRow[];
    const versions = rows.map((r) => r.version);
    const expected = allMigrations.map((m) => m.version);
    expect(versions).toEqual(expected);
  });

  it("does not re-apply already-applied migrations", () => {
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "idempotent.db") });
    runMigrations(db, allMigrations);

    runMigrations(db, allMigrations);

    const rows = db.prepare("SELECT COUNT(*) AS cnt FROM schema_migrations").get() as unknown as { cnt: number };
    expect(rows.cnt).toBe(allMigrations.length);
  });

  it("rolls back a failed migration and throws", () => {
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "fail.db") });
    runMigrations(db, allMigrations);

    const badMigration: Migration = {
      version: 999,
      name: "will_fail",
      up() {
        throw new Error("Intentional failure");
      },
    };

    expect(() => runMigrations(db, [...allMigrations, badMigration])).toThrow(
      "Migration 999 (will_fail) failed",
    );

    const exists = db.prepare("SELECT 1 FROM schema_migrations WHERE version = 999").get();
    expect(exists).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Idempotent seeding
// ---------------------------------------------------------------------------

describe("Idempotent seeding", () => {
  it("seeds successfully on first call", () => {
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "idempotent.db") });
    runMigrations(db, allMigrations);

    const config: AppConfig = {
      host: "127.0.0.1",
      port: 3000,
      logLevel: "info",
      upstreamBaseUrl: "https://api.example.com/v1",
      requestTimeoutMs: 30000,
      maxRetries: 0,
      maxBodySizeKb: 1024,
      healthProbeEnabled: false,
      models: [
        {
          name: "glm-5",
          upstreamModel: "glm-5",
          baseUrl: "https://api.example.com/v1",
          apiKey: "secret",
          apiKeyEnv: "GLM5_KEY",
          ownedBy: "zhipu",
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
    };

    seedFromConfig(config);
    expect(getAllModels()).toHaveLength(1);
  });

  it("throws on second seed attempt (duplicate keys)", () => {
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "double-seed.db") });
    runMigrations(db, allMigrations);

    const config: AppConfig = {
      host: "127.0.0.1",
      port: 3000,
      logLevel: "info",
      upstreamBaseUrl: "https://api.example.com/v1",
      requestTimeoutMs: 30000,
      maxRetries: 0,
      maxBodySizeKb: 1024,
      healthProbeEnabled: false,
      models: [
        {
          name: "glm-5",
          upstreamModel: "glm-5",
          baseUrl: "https://api.example.com/v1",
          apiKey: "secret",
          apiKeyEnv: "GLM5_KEY",
          ownedBy: "zhipu",
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
    };

    seedFromConfig(config);
    expect(() => seedFromConfig(config)).toThrow();
  });
});
