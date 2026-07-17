import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { DatabaseSync } from "node:sqlite";

export { type ModelRow, type ModelChainRow, type ChainModelRow, type GatewayConfigRow, type SchemaMigrationRow } from "./types.js";

/** Default database path when GATEWAY_DB_PATH is not set. */
const DEFAULT_DB_PATH = "./data/gateway.db";

let dbInstance: DatabaseSync | null = null;
let dbPath: string | null = null;

/**
 * Open (or return the existing) SQLite database connection.
 *
 * - Reads `GATEWAY_DB_PATH` from the environment, defaulting to
 *   `./data/gateway.db`.
 * - Creates parent directories if they do not exist.
 * - Enables WAL mode for better concurrent read performance.
 *
 * If the requested path differs from the current singleton's path, the current
 * connection is closed and a new one is opened at the requested path. This
 * allows test isolation with different database paths.
 *
 * Call `closeDatabase()` when shutting down to close the connection cleanly.
 */
export function openDatabase(env: NodeJS.ProcessEnv = process.env): DatabaseSync {
  const requestedPath = resolve(env.GATEWAY_DB_PATH ?? DEFAULT_DB_PATH);

  // If we have an existing instance at the same path, return it.
  if (dbInstance && dbPath === requestedPath) {
    return dbInstance;
  }

  // If the path changed, close the existing connection.
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    dbPath = null;
  }

  // Ensure the parent directory exists.
  mkdirSync(dirname(requestedPath), { recursive: true });

  const db = new DatabaseSync(requestedPath);

  // Enable WAL mode for better concurrency (single-writer, multi-reader).
  db.exec("PRAGMA journal_mode = WAL");

  // Enforce foreign keys.
  db.exec("PRAGMA foreign_keys = ON");

  dbInstance = db;
  dbPath = requestedPath;
  return db;
}

/**
 * Close the singleton database connection, if one is open.
 * Safe to call multiple times; subsequent calls are no-ops.
 */
export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    dbPath = null;
  }
}

/**
 * Return the current singleton connection, or throw if the database
 * has not been opened yet. Useful for code paths that expect the
 * database to already be initialized.
 */
export function getDatabase(): DatabaseSync {
  if (!dbInstance) {
    throw new Error("Database has not been opened. Call openDatabase() first.");
  }
  return dbInstance;
}
