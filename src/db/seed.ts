/**
 * YAML-to-database seeding.
 *
 * Reads the gateway YAML configuration, validates it using the existing
 * parsing/validation logic, and inserts the resulting data into the
 * database. Seeding is idempotent at the startup level — it only runs
 * when the `models` table is empty — and the entire operation is wrapped
 * in a single transaction so that a partial seed never persists.
 */

import type { AppConfig, GatewayModelConfig, CopilotProxyConfig } from "../config.js";
import type {
  ModelRow,
  ModelChainRow,
  ChainModelRow,
  GatewayConfigRow,
} from "./types.js";
import type { ModelChainConfig, ChainModelEntry } from "../contracts.js";

import { getDatabase } from "./index.js";
import {
  insertModel,
  insertChain,
  insertGatewayConfig,
} from "./repository.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Current Unix timestamp in seconds. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Convert a boolean to its SQLite integer representation. */
function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

/** Serialise a string or string array for the `cors_origin` column. */
function serialiseCorsOrigin(origin: string | string[] | undefined): string | null {
  if (origin === undefined) return null;
  if (Array.isArray(origin)) return JSON.stringify(origin);
  return origin;
}

/** Serialise the copilot-proxy allowed prefixes as a JSON string. */
function serialisePrefixes(prefixes: string[]): string {
  return JSON.stringify(prefixes);
}

// ---------------------------------------------------------------------------
// Task 3.1 — Seed function
// ---------------------------------------------------------------------------

/**
 * Seed the database from a fully-validated `AppConfig`.
 *
 * Inserts in order:
 * 1. Models (with `source = 'static'`)
 * 2. Chains + chain_models
 * 3. Gateway config singleton row
 *
 * The whole operation runs inside a single transaction. On failure the
 * transaction is rolled back and the error propagates.
 */
export function seedFromConfig(config: AppConfig): void {
  const db = getDatabase();
  const now = nowSeconds();

  db.exec("BEGIN TRANSACTION");
  try {
    // --- Models ---
    for (const model of config.models) {
      const row: ModelRow = {
        name: model.name,
        upstream_model: model.upstreamModel,
        base_url: model.baseUrl,
        api_key_env: model.apiKeyEnv,
        owned_by: model.ownedBy,
        created: model.created,
        supports_tools: boolToInt(model.supportsTools),
        supports_streaming: boolToInt(model.supportsStreaming),
        supports_image_input: boolToInt(model.supportsImageInput),
        unknown_field_mode: model.unknownFieldMode,
        unknown_field_window_requests: model.unknownFieldWindowRequests,
        source: "static",
        source_prefix: null,
        connection_id: null,
        status: "active",
        status_reason: "Seeded from gateway.config.yaml",
        status_changed_at: now,
        capabilities_json: null,
        updated_at: now,
      };
      insertModel(row);
    }

    // --- Chains + chain_models ---
    if (config.modelChains) {
      for (const chain of config.modelChains) {
        const chainRow: ModelChainRow = {
          name: chain.name,
          timeout_ms: chain.timeoutMs,
          max_retries: chain.maxRetries,
          chain_timeout_ms: chain.chainTimeoutMs ?? null,
          status: "active",
          status_reason: "Seeded from gateway.config.yaml",
          status_changed_at: now,
          updated_at: now,
        };

        const chainModelRows: ChainModelRow[] = chain.models.map(
          (entry: ChainModelEntry, index: number) => ({
            chain_name: chain.name,
            position: index,
            model_name: entry.name,
            timeout_ms: entry.timeoutMs ?? null,
            max_retries: entry.maxRetries ?? null,
          }),
        );

        insertChain(chainRow, chainModelRows);
      }
    }

    // --- Gateway config ---
    const gatewayConfigRow: GatewayConfigRow = {
      id: 1,
      default_model: config.defaultModel ?? null,
      request_timeout_ms: config.requestTimeoutMs,
      max_retries: config.maxRetries,
      max_body_size_kb: config.maxBodySizeKb,
      gateway_auth_token_env: config.gatewayAuthTokenEnv ?? null,
      health_probe_enabled: boolToInt(config.healthProbeEnabled),
      cors_origin: serialiseCorsOrigin(config.corsOrigin),
      copilot_proxy_enabled: boolToInt(config.copilotProxy?.enabled ?? false),
      copilot_proxy_require_token_auth: boolToInt(config.copilotProxy?.requireTokenAuth ?? true),
      copilot_proxy_token_ttl_seconds: config.copilotProxy?.tokenTtlSeconds ?? 86400,
      copilot_proxy_heartbeat_interval_ms: config.copilotProxy?.heartbeatIntervalMs ?? 30000,
      copilot_proxy_heartbeat_timeout_ms: config.copilotProxy?.heartbeatTimeoutMs ?? 10000,
      copilot_proxy_max_inflight_per_connection: config.copilotProxy?.maxInflightPerConnection ?? 4,
      copilot_proxy_allowed_prefixes: serialisePrefixes(config.copilotProxy?.allowedPrefixes ?? ["copilot-"]),
    };
    insertGatewayConfig(gatewayConfigRow);

    db.exec("COMMIT");
    console.info("[seed] Database seeded from gateway.config.yaml");
  } catch (error) {
    db.exec("ROLLBACK");
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Seeding failed: ${message}`);
  }
}
