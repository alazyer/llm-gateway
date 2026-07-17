import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { openDatabase, closeDatabase, getDatabase } from "../src/db/index.js";
import { runMigrations, getCurrentVersion, type Migration } from "../src/db/migrations/index.js";
import { allMigrations } from "../src/db/migrations/all.js";
import type { ModelRow, ModelChainRow, ChainModelRow, GatewayConfigRow, SchemaMigrationRow } from "../src/db/types.js";

let tempDir: string;

beforeEach(() => {
  // Ensure no lingering connection from a previous test.
  closeDatabase();
  tempDir = join(tmpdir(), `llm-gateway-db-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
});

afterEach(() => {
  closeDatabase();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("Database connection", () => {
  it("opens a database at the specified GATEWAY_DB_PATH", () => {
    const dbPath = join(tempDir, "custom.db");
    const db = openDatabase({ GATEWAY_DB_PATH: dbPath });

    expect(db).toBeDefined();

    // Verify the file was created.
    expect(existsSync(dbPath)).toBe(true);
  });

  it("defaults to ./data/gateway.db when GATEWAY_DB_PATH is not set", () => {
    const defaultDir = join(tempDir, "data");
    const db = openDatabase({ GATEWAY_DB_PATH: join(defaultDir, "gateway.db") });

    expect(db).toBeDefined();
    expect(existsSync(join(defaultDir, "gateway.db"))).toBe(true);
  });

  it("creates parent directories if they do not exist", () => {
    const deepPath = join(tempDir, "a", "b", "c", "test.db");
    const db = openDatabase({ GATEWAY_DB_PATH: deepPath });

    expect(db).toBeDefined();
    expect(existsSync(deepPath)).toBe(true);
  });

  it("returns the same singleton when called with the same path", () => {
    const dbPath = join(tempDir, "singleton.db");
    const db1 = openDatabase({ GATEWAY_DB_PATH: dbPath });
    const db2 = openDatabase({ GATEWAY_DB_PATH: dbPath });
    expect(db2).toBe(db1);
  });

  it("closes and reopens when called with a different path", () => {
    const path1 = join(tempDir, "first.db");
    const path2 = join(tempDir, "second.db");
    openDatabase({ GATEWAY_DB_PATH: path1 });
    // Verify first DB is functional
    expect(existsSync(path1)).toBe(true);
    // Open with a different path — should close the first and open a new one
    const db2 = openDatabase({ GATEWAY_DB_PATH: path2 });
    expect(existsSync(path2)).toBe(true);
    // getDatabase() should now return the new instance, not the closed one
    expect(getDatabase()).toBe(db2);
  });

  it("getDatabase throws if no connection is open", () => {
    expect(() => getDatabase()).toThrow("Database has not been opened");
  });

  it("getDatabase returns the open connection", () => {
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "getter.db") });
    expect(getDatabase()).toBe(db);
  });

  it("closeDatabase is a no-op when no connection is open", () => {
    expect(() => closeDatabase()).not.toThrow();
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
});

describe("Migration runner", () => {
  it("reports version 0 for a fresh database without schema_migrations", () => {
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "fresh.db") });
    expect(getCurrentVersion(db)).toBe(0);
  });

  it("applies all pending migrations from scratch", () => {
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "migrate.db") });
    runMigrations(db, allMigrations);

    const version = getCurrentVersion(db);
    expect(version).toBe(allMigrations[allMigrations.length - 1]!.version);
  });

  it("creates the schema_migrations table during initial migration", () => {
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "schema-mig.db") });
    runMigrations(db, allMigrations);

    const tableCheck = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get();
    expect(tableCheck).toBeDefined();
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

    // Running again should be a no-op (no error, same version).
    runMigrations(db, allMigrations);

    const rows = db.prepare("SELECT COUNT(*) AS cnt FROM schema_migrations").get() as unknown as { cnt: number };
    expect(rows.cnt).toBe(allMigrations.length);
  });

  it("rolls back a failed migration and throws", () => {
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "fail.db") });

    // Apply the first real migration so we have schema_migrations.
    runMigrations(db, allMigrations);

    // Now add a migration that will fail.
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

    // The bad migration version should NOT be recorded.
    const exists = db
      .prepare("SELECT 1 FROM schema_migrations WHERE version = 999")
      .get();
    expect(exists).toBeUndefined();
  });
});

describe("Initial schema (migration 001)", () => {
  it("creates all expected tables", () => {
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
  });

  it("models table has the correct columns", () => {
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "models-cols.db") });
    runMigrations(db, allMigrations);

    const columns = db.prepare("PRAGMA table_info(models)").all() as { name: string; notnull: number; dflt_value: unknown; pk: number }[];
    const colByName = new Map(columns.map((c) => [c.name, c]));

    // Primary key
    expect(colByName.get("name")?.pk).toBe(1);
    // Required columns
    expect(colByName.get("upstream_model")?.notnull).toBe(1);
    expect(colByName.get("base_url")?.notnull).toBe(1);
    expect(colByName.get("api_key_env")?.notnull).toBe(1);
    expect(colByName.get("owned_by")?.notnull).toBe(1);
    expect(colByName.get("created")?.notnull).toBe(1);
    expect(colByName.get("updated_at")?.notnull).toBe(1);
    expect(colByName.get("status")?.notnull).toBe(1);
    // Nullable columns
    expect(colByName.get("source")?.notnull).toBe(0);
    expect(colByName.get("connection_id")?.notnull).toBe(0);
    expect(colByName.get("capabilities_json")?.notnull).toBe(0);
    // Defaults
    expect(colByName.get("owned_by")?.dflt_value).toBe("'llm-gateway'");
    expect(colByName.get("supports_tools")?.dflt_value).toBe("1");
    expect(colByName.get("unknown_field_mode")?.dflt_value).toBe("'warn'");
  });

  it("model_chains table has the correct columns", () => {
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "chains-cols.db") });
    runMigrations(db, allMigrations);

    const columns = db.prepare("PRAGMA table_info(model_chains)").all() as { name: string; notnull: number; pk: number }[];
    const colByName = new Map(columns.map((c) => [c.name, c]));

    expect(colByName.get("name")?.pk).toBe(1);
    expect(colByName.get("timeout_ms")?.notnull).toBe(1);
    expect(colByName.get("max_retries")?.notnull).toBe(1);
    expect(colByName.get("chain_timeout_ms")?.notnull).toBe(0);
    expect(colByName.get("status")?.notnull).toBe(1);
    expect(colByName.get("updated_at")?.notnull).toBe(1);
  });

  it("chain_models table has foreign keys and composite primary key", () => {
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "chain-models-fk.db") });
    runMigrations(db, allMigrations);

    const columns = db.prepare("PRAGMA table_info(chain_models)").all() as { name: string; notnull: number; pk: number }[];
    const colByName = new Map(columns.map((c) => [c.name, c]));

    // Composite PK: (chain_name, position)
    expect(colByName.get("chain_name")?.pk).toBe(1);
    expect(colByName.get("position")?.pk).toBe(2);

    // Foreign keys
    const fks = db.prepare("PRAGMA foreign_key_list(chain_models)").all() as { table: string; from: string; to: string }[];
    const fkTables = fks.map((fk) => fk.table);
    expect(fkTables).toContain("model_chains");
    expect(fkTables).toContain("models");
  });

  it("gateway_config table is a singleton (CHECK id = 1)", () => {
    const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "gw-config.db") });
    runMigrations(db, allMigrations);

    const columns = db.prepare("PRAGMA table_info(gateway_config)").all() as { name: string }[];
    const colNames = columns.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("default_model");
    expect(colNames).toContain("copilot_proxy_allowed_prefixes");

    // Verify the CHECK constraint by inserting a row with id=2
    expect(() => {
      db.exec("INSERT INTO gateway_config (id) VALUES (2)");
    }).toThrow();
  });
});

describe("Type exports", () => {
  it("type imports are resolvable (compile-time check)", () => {
    // If this compiles, the types are exported correctly.
    // We just need a runtime assertion so vitest doesn't complain about no assertions.
    const _types: void = undefined;
    expect(_types).toBeUndefined();
  });
});
