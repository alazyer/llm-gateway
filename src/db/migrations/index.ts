import type { DatabaseSync } from "node:sqlite";

import type { SchemaMigrationRow } from "../types.js";

/**
 * A migration is a numbered function that receives the database connection
 * and executes DDL/DML to evolve the schema.
 */
export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

/**
 * Return the current schema version recorded in `schema_migrations`,
 * or 0 if the table does not exist yet (fresh database).
 */
export function getCurrentVersion(db: DatabaseSync): number {
  // Check whether the schema_migrations table exists.
  const tableCheck = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    )
    .get();

  if (!tableCheck) {
    return 0;
  }

  const row = db
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as SchemaMigrationRow | undefined;

  return row?.version ?? 0;
}

/**
 * Apply all pending migrations sequentially.
 *
 * Each migration is wrapped in its own transaction. If any migration fails,
 * the process throws and the database is left at the last successful version.
 */
export function runMigrations(db: DatabaseSync, migrations: Migration[]): void {
  const currentVersion = getCurrentVersion(db);
  const pending = migrations
    .filter((m) => m.version > currentVersion)
    .sort((a, b) => a.version - b.version);

  if (pending.length === 0) {
    return;
  }

  for (const migration of pending) {
    console.log(
      `[db] Applying migration ${String(migration.version).padStart(3, "0")}: ${migration.name}`,
    );

    db.exec("BEGIN TRANSACTION");
    try {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(
        migration.version,
      );
      db.exec("COMMIT");
      console.log(
        `[db] Migration ${String(migration.version).padStart(3, "0")} applied successfully`,
      );
    } catch (error) {
      db.exec("ROLLBACK");
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Migration ${String(migration.version).padStart(3, "0")} (${migration.name}) failed: ${message}`,
      );
    }
  }
}
