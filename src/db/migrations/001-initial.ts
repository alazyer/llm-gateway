import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "./index.js";

/**
 * Migration 001: Initial schema.
 *
 * Creates the core tables needed for database persistence:
 * - schema_migrations: tracks applied migration versions
 * - models: model catalog
 * - model_chains: chain definitions
 * - chain_models: chain ↔ model junction table
 * - gateway_config: singleton gateway settings row
 */
export const migration001Initial: Migration = {
  version: 1,
  name: "initial_schema",
  up(db: DatabaseSync): void {
    // Schema migrations tracking table.
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY
      )
    `);

    // Models table — REQ-PERSIST-006.
    db.exec(`
      CREATE TABLE IF NOT EXISTS models (
        name                            TEXT    PRIMARY KEY,
        upstream_model                  TEXT    NOT NULL,
        base_url                        TEXT    NOT NULL,
        api_key_env                     TEXT    NOT NULL,
        owned_by                        TEXT    NOT NULL DEFAULT 'llm-gateway',
        created                         INTEGER NOT NULL,
        supports_tools                  INTEGER NOT NULL DEFAULT 1,
        supports_streaming              INTEGER NOT NULL DEFAULT 1,
        unknown_field_mode              TEXT    NOT NULL DEFAULT 'warn',
        unknown_field_window_requests   INTEGER NOT NULL DEFAULT 100,
        source                          TEXT,
        source_prefix                   TEXT,
        connection_id                   TEXT,
        status                          TEXT    NOT NULL DEFAULT 'active',
        status_reason                   TEXT,
        status_changed_at               INTEGER,
        capabilities_json               TEXT,
        updated_at                      INTEGER NOT NULL
      )
    `);

    // Model chains table — REQ-PERSIST-007.
    db.exec(`
      CREATE TABLE IF NOT EXISTS model_chains (
        name                TEXT    PRIMARY KEY,
        timeout_ms          INTEGER NOT NULL,
        max_retries         INTEGER NOT NULL,
        chain_timeout_ms    INTEGER,
        status              TEXT    NOT NULL DEFAULT 'active',
        status_reason       TEXT,
        status_changed_at   INTEGER,
        updated_at          INTEGER NOT NULL
      )
    `);

    // Chain models junction table — REQ-PERSIST-008.
    db.exec(`
      CREATE TABLE IF NOT EXISTS chain_models (
        chain_name  TEXT    NOT NULL,
        position    INTEGER NOT NULL,
        model_name  TEXT    NOT NULL,
        timeout_ms  INTEGER,
        max_retries INTEGER,
        PRIMARY KEY (chain_name, position),
        FOREIGN KEY (chain_name) REFERENCES model_chains(name) ON DELETE CASCADE,
        FOREIGN KEY (model_name)  REFERENCES models(name)       ON DELETE CASCADE
      )
    `);

    // Gateway configuration singleton table — REQ-PERSIST-009.
    db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_config (
        id                                            INTEGER PRIMARY KEY DEFAULT 1,
        default_model                                 TEXT,
        request_timeout_ms                            INTEGER NOT NULL DEFAULT 30000,
        max_retries                                   INTEGER NOT NULL DEFAULT 0,
        max_body_size_kb                              INTEGER NOT NULL DEFAULT 1024,
        gateway_auth_token_env                        TEXT,
        health_probe_enabled                          INTEGER NOT NULL DEFAULT 0,
        cors_origin                                   TEXT,
        copilot_proxy_enabled                         INTEGER NOT NULL DEFAULT 0,
        copilot_proxy_require_token_auth              INTEGER NOT NULL DEFAULT 1,
        copilot_proxy_token_ttl_seconds               INTEGER NOT NULL DEFAULT 86400,
        copilot_proxy_heartbeat_interval_ms           INTEGER NOT NULL DEFAULT 30000,
        copilot_proxy_heartbeat_timeout_ms            INTEGER NOT NULL DEFAULT 10000,
        copilot_proxy_max_inflight_per_connection     INTEGER NOT NULL DEFAULT 4,
        copilot_proxy_allowed_prefixes                TEXT    NOT NULL DEFAULT '["copilot-"]',
        CHECK (id = 1)
      )
    `);
  },
};
