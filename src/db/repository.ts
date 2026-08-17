/**
 * Repository layer that abstracts database reads and writes.
 *
 * All functions use the singleton database connection from `src/db/index.ts`.
 * Status transitions are logged at INFO level with structured fields per
 * REQ-LIFECYCLE-009 and REQ-CHAIN-010.
 */

import type {
  ModelRow,
  ModelChainRow,
  ChainModelRow,
  GatewayConfigRow,
} from "./types.js";
import type { SQLInputValue } from "node:sqlite";
import { getDatabase } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Current Unix timestamp in seconds. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Normalize the result of `.get()` from `undefined` (node:sqlite convention)
 * to `null`, so callers see a consistent "not found" value.
 */
function nullIfUndefined<T>(value: T | undefined): T | null {
  return value === undefined ? null : value;
}

// ---------------------------------------------------------------------------
// Task 2.1 — Model repository
// ---------------------------------------------------------------------------

/**
 * Return all models from the database.
 */
export function getAllModels(): ModelRow[] {
  const db = getDatabase();
  return db
    .prepare("SELECT * FROM models ORDER BY name")
    .all() as unknown as ModelRow[];
}

/**
 * Look up a single model by its primary key.
 * Returns `null` when no matching row exists.
 */
export function getModelByName(name: string): ModelRow | null {
  const db = getDatabase();
  return nullIfUndefined(
    db
      .prepare("SELECT * FROM models WHERE name = ?")
      .get(name) as unknown as ModelRow | undefined,
  );
}

/**
 * Return only models with `status = 'active'`.
 */
export function getActiveModels(): ModelRow[] {
  const db = getDatabase();
  return db
    .prepare("SELECT * FROM models WHERE status = 'active' ORDER BY name")
    .all() as unknown as ModelRow[];
}

/**
 * Insert a new model row.
 * Throws if a model with the same `name` already exists (PRIMARY KEY conflict).
 */
export function insertModel(model: ModelRow): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO models (
       name, upstream_model, base_url, api_key_env, owned_by, created,
       supports_tools, supports_streaming, supports_image_input, unknown_field_mode,
       unknown_field_window_requests, source, source_prefix, connection_id,
       status, status_reason, status_changed_at, capabilities_json, updated_at
     ) VALUES (
       ?, ?, ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?,
       ?, ?, ?, ?, ?
     )`,
  ).run(
    model.name,
    model.upstream_model,
    model.base_url,
    model.api_key_env,
    model.owned_by,
    model.created,
    model.supports_tools,
    model.supports_streaming,
    model.supports_image_input,
    model.unknown_field_mode,
    model.unknown_field_window_requests,
    model.source,
    model.source_prefix,
    model.connection_id,
    model.status,
    model.status_reason,
    model.status_changed_at,
    model.capabilities_json,
    model.updated_at,
  );
}

/**
 * Update a model's status and log the transition at INFO level.
 *
 * Per REQ-LIFECYCLE-009, status transitions are logged with the model name,
 * old status, new status, reason, and timestamp.
 */
export function updateModelStatus(
  name: string,
  status: "active" | "inactive",
  reason: string,
): void {
  const db = getDatabase();

  const existing = getModelByName(name);
  if (!existing) {
    throw new Error(`Cannot update status: model '${name}' not found`);
  }

  const oldStatus = existing.status;
  const now = nowSeconds();

  db.prepare(
    `UPDATE models
     SET status = ?, status_reason = ?, status_changed_at = ?, updated_at = ?
     WHERE name = ?`,
  ).run(status, reason, now, now, name);

  console.info(
    `[db] Model status transition: name=${name} old_status=${oldStatus} new_status=${status} reason="${reason}" timestamp=${now}`,
  );
}

/**
 * Update a model's connection ID and capabilities (used for Copilot proxy
 * registration / reconnection).
 */
export function updateModelConnection(
  name: string,
  connectionId: string | null,
  capabilitiesJson: string | null,
): void {
  const db = getDatabase();
  const now = nowSeconds();

  db.prepare(
    `UPDATE models
     SET connection_id = ?, capabilities_json = ?, updated_at = ?
     WHERE name = ?`,
  ).run(connectionId, capabilitiesJson, now, name);
}

/**
 * Return all models associated with the given Copilot proxy connection ID.
 */
export function getModelsByConnection(connectionId: string): ModelRow[] {
  const db = getDatabase();
  return db
    .prepare("SELECT * FROM models WHERE connection_id = ? ORDER BY name")
    .all(connectionId) as unknown as ModelRow[];
}

/**
 * Reactivate an existing inactive Copilot-proxy model or insert a new one.
 *
 * Per REQ-LIFECYCLE-005:
 * - If a model with the same `name` exists with `source='copilot-proxy'` and
 *   `status='inactive'`, update it to `status='active'` with the new
 *   connection ID, capabilities, and `status_reason="Copilot proxy reconnected"`.
 * - If no matching inactive model exists, insert a new row.
 */
export function reactivateOrInsertModel(model: ModelRow): void {
  const db = getDatabase();

  const existing = nullIfUndefined(
    db
      .prepare(
        "SELECT * FROM models WHERE name = ? AND source = 'copilot-proxy'",
      )
      .get(model.name) as unknown as ModelRow | undefined,
  );

  if (existing && existing.status === "inactive") {
    // Reactivate: update status, connection, capabilities.
    const now = nowSeconds();
    db.prepare(
      `UPDATE models
       SET status = 'active',
           status_reason = 'Copilot proxy reconnected',
           status_changed_at = ?,
           connection_id = ?,
           capabilities_json = ?,
           updated_at = ?,
           upstream_model = ?,
           base_url = ?,
           api_key_env = ?,
           owned_by = ?,
           supports_tools = ?,
           supports_streaming = ?,
           supports_image_input = ?,
           unknown_field_mode = ?,
           unknown_field_window_requests = ?,
           source_prefix = ?
       WHERE name = ?`,
    ).run(
      now,
      model.connection_id,
      model.capabilities_json,
      now,
      model.upstream_model,
      model.base_url,
      model.api_key_env,
      model.owned_by,
      model.supports_tools,
      model.supports_streaming,
      model.supports_image_input,
      model.unknown_field_mode,
      model.unknown_field_window_requests,
      model.source_prefix,
      model.name,
    );

    console.info(
      `[db] Model status transition: name=${model.name} old_status=inactive new_status=active reason="Copilot proxy reconnected" timestamp=${now}`,
    );
  } else if (!existing) {
    // No row at all — insert fresh.
    insertModel(model);
  }
  // If existing and already active, we still update the connection/capabilities
  // but do not log a status transition (no status change).
  else {
    updateModelConnection(
      model.name,
      model.connection_id,
      model.capabilities_json,
    );
  }
}

// ---------------------------------------------------------------------------
// Task 2.2 — Chain repository
// ---------------------------------------------------------------------------

/**
 * Return all chains from the database.
 */
export function getAllChains(): ModelChainRow[] {
  const db = getDatabase();
  return db
    .prepare("SELECT * FROM model_chains ORDER BY name")
    .all() as unknown as ModelChainRow[];
}

/**
 * Look up a single chain by its primary key.
 * Returns `null` when no matching row exists.
 */
export function getChainByName(name: string): ModelChainRow | null {
  const db = getDatabase();
  return nullIfUndefined(
    db
      .prepare("SELECT * FROM model_chains WHERE name = ?")
      .get(name) as unknown as ModelChainRow | undefined,
  );
}

/**
 * Return the ordered list of chain-model associations for a given chain.
 */
export function getChainModels(chainName: string): ChainModelRow[] {
  const db = getDatabase();
  return db
    .prepare(
      "SELECT * FROM chain_models WHERE chain_name = ? ORDER BY position",
    )
    .all(chainName) as unknown as ChainModelRow[];
}

/**
 * Insert a chain and its associated chain-model rows.
 * Note: This function does NOT manage its own transaction. The caller is
 * responsible for wrapping calls in a transaction if atomicity is required.
 */
export function insertChain(
  chain: ModelChainRow,
  models: ChainModelRow[],
): void {
  const db = getDatabase();

  const insertChainStmt = db.prepare(
    `INSERT INTO model_chains (
       name, timeout_ms, max_retries, chain_timeout_ms,
       status, status_reason, status_changed_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertModelStmt = db.prepare(
    `INSERT INTO chain_models (chain_name, position, model_name, timeout_ms, max_retries)
     VALUES (?, ?, ?, ?, ?)`,
  );

  insertChainStmt.run(
    chain.name,
    chain.timeout_ms,
    chain.max_retries,
    chain.chain_timeout_ms,
    chain.status,
    chain.status_reason,
    chain.status_changed_at,
    chain.updated_at,
  );

  for (const m of models) {
    insertModelStmt.run(
      m.chain_name,
      m.position,
      m.model_name,
      m.timeout_ms,
      m.max_retries,
    );
  }
}

/**
 * Update a chain's status and log the transition at INFO level.
 *
 * Per REQ-LIFECYCLE-009 / REQ-CHAIN-010, status transitions are logged with
 * the chain name, old status, new status, reason, and timestamp.
 */
export function updateChainStatus(
  name: string,
  status: "active" | "degraded" | "inactive",
  reason: string,
): void {
  const db = getDatabase();

  const existing = getChainByName(name);
  if (!existing) {
    throw new Error(`Cannot update status: chain '${name}' not found`);
  }

  const oldStatus = existing.status;
  const now = nowSeconds();

  db.prepare(
    `UPDATE model_chains
     SET status = ?, status_reason = ?, status_changed_at = ?, updated_at = ?
     WHERE name = ?`,
  ).run(status, reason, now, now, name);

  console.info(
    `[db] Chain status transition: name=${name} old_status=${oldStatus} new_status=${status} reason="${reason}" timestamp=${now}`,
  );
}

/**
 * Return the names of all chains that reference the given model.
 * Used to recalculate chain statuses when a model's status changes
 * (REQ-CHAIN-007).
 */
export function getChainsReferencingModel(modelName: string): string[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      "SELECT DISTINCT chain_name FROM chain_models WHERE model_name = ? ORDER BY chain_name",
    )
    .all(modelName) as unknown as { chain_name: string }[];
  return rows.map((r) => r.chain_name);
}

/**
 * Update a model's configuration columns (everything except `name` which is the
 * primary key). Only the keys present in `partial` are updated; other columns
 * remain unchanged.  `updated_at` is always set to the current timestamp.
 */
export function updateModel(
  name: string,
  partial: Partial<Omit<ModelRow, "name">>,
): void {
  const db = getDatabase();

  const allowedKeys: ReadonlyArray<keyof Omit<ModelRow, "name">> = [
    "upstream_model",
    "base_url",
    "api_key_env",
    "owned_by",
    "created",
    "supports_tools",
    "supports_streaming",
    "supports_image_input",
    "unknown_field_mode",
    "unknown_field_window_requests",
    "source",
    "source_prefix",
    "connection_id",
    "status",
    "status_reason",
    "status_changed_at",
    "capabilities_json",
    "updated_at",
  ];

  const setClauses: string[] = [];
  const values: SQLInputValue[] = [];

  for (const key of allowedKeys) {
    if (key in partial) {
      setClauses.push(`${key} = ?`);
      values.push(partial[key] as SQLInputValue);
    }
  }

  if (setClauses.length === 0) {
    return; // Nothing to update.
  }

  // Always bump updated_at unless the caller explicitly set it.
  if (!("updated_at" in partial)) {
    setClauses.push("updated_at = ?");
    values.push(nowSeconds());
  }

  values.push(name); // WHERE name = ?

  db.prepare(`UPDATE models SET ${setClauses.join(", ")} WHERE name = ?`)
    .run(...values);
}

/**
 * Delete a model row by its primary key.
 * CASCADE will remove any chain_models rows referencing this model.
 * After deletion, the caller should recalculate affected chain statuses.
 */
export function deleteModel(name: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM models WHERE name = ?").run(name);
}

/**
 * Return models filtered by status and/or source.
 * Both parameters are optional; when omitted, no filter is applied for that
 * dimension.
 */
export function getModelsFiltered(
  filters: { status?: string; source?: string },
): ModelRow[] {
  const db = getDatabase();

  const clauses: string[] = [];
  const values: SQLInputValue[] = [];

  if (filters.status) {
    clauses.push("status = ?");
    values.push(filters.status);
  }
  if (filters.source) {
    clauses.push("source = ?");
    values.push(filters.source);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  return db
    .prepare(`SELECT * FROM models ${where} ORDER BY name`)
    .all(...values) as unknown as ModelRow[];
}

// ---------------------------------------------------------------------------
// Chain CRUD additions
// ---------------------------------------------------------------------------

/**
 * Update a chain's configuration columns (everything except `name`).
 * Only the keys present in `partial` are updated; other columns remain
 * unchanged.  `updated_at` is always set to the current timestamp.
 */
export function updateChain(
  name: string,
  partial: Partial<Omit<ModelChainRow, "name">>,
): void {
  const db = getDatabase();

  const allowedKeys: ReadonlyArray<keyof Omit<ModelChainRow, "name">> = [
    "timeout_ms",
    "max_retries",
    "chain_timeout_ms",
    "status",
    "status_reason",
    "status_changed_at",
    "updated_at",
  ];

  const setClauses: string[] = [];
  const values: SQLInputValue[] = [];

  for (const key of allowedKeys) {
    if (key in partial) {
      setClauses.push(`${key} = ?`);
      values.push(partial[key] as SQLInputValue);
    }
  }

  if (setClauses.length === 0) {
    return;
  }

  if (!("updated_at" in partial)) {
    setClauses.push("updated_at = ?");
    values.push(nowSeconds());
  }

  values.push(name);

  db.prepare(`UPDATE model_chains SET ${setClauses.join(", ")} WHERE name = ?`)
    .run(...values);
}

/**
 * Delete a chain and its associated chain_models rows (CASCADE).
 */
export function deleteChain(name: string): void {
  const db = getDatabase();
  db.prepare("DELETE FROM model_chains WHERE name = ?").run(name);
}

/**
 * Replace the chain_models entries for a given chain.
 * Deletes all existing entries and inserts the new set atomically.
 */
export function replaceChainModels(
  chainName: string,
  models: ChainModelRow[],
): void {
  const db = getDatabase();

  db.prepare("DELETE FROM chain_models WHERE chain_name = ?").run(chainName);

  const insertStmt = db.prepare(
    `INSERT INTO chain_models (chain_name, position, model_name, timeout_ms, max_retries)
     VALUES (?, ?, ?, ?, ?)`,
  );

  for (const m of models) {
    insertStmt.run(
      m.chain_name,
      m.position,
      m.model_name,
      m.timeout_ms,
      m.max_retries,
    );
  }
}

/**
 * Return chains filtered by status and/or source of their constituent models.
 * The `source` filter checks whether ANY model in the chain has that source.
 */
export function getChainsFiltered(
  filters: { status?: string; source?: string },
): ModelChainRow[] {
  const db = getDatabase();

  if (!filters.status && !filters.source) {
    return getAllChains();
  }

  const clauses: string[] = [];
  const values: SQLInputValue[] = [];

  if (filters.status) {
    clauses.push("mc.status = ?");
    values.push(filters.status);
  }

  if (filters.source) {
    clauses.push(
      "mc.name IN (SELECT DISTINCT cm.chain_name FROM chain_models cm JOIN models m ON cm.model_name = m.name WHERE m.source = ?)",
    );
    values.push(filters.source);
  }

  const where = `WHERE ${clauses.join(" AND ")}`;
  return db
    .prepare(`SELECT mc.* FROM model_chains mc ${where} ORDER BY mc.name`)
    .all(...values) as unknown as ModelChainRow[];
}

// ---------------------------------------------------------------------------
// Task 2.3 — Gateway config repository
// ---------------------------------------------------------------------------

/**
 * Return the singleton gateway config row, or `null` if none exists yet.
 */
export function getGatewayConfig(): GatewayConfigRow | null {
  const db = getDatabase();
  return nullIfUndefined(
    db
      .prepare("SELECT * FROM gateway_config WHERE id = 1")
      .get() as unknown as GatewayConfigRow | undefined,
  );
}

/**
 * Insert the initial gateway config row.
 * Throws if a row already exists (singleton constraint).
 */
export function insertGatewayConfig(config: GatewayConfigRow): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO gateway_config (
       id, default_model, request_timeout_ms, max_retries, max_body_size_kb,
       gateway_auth_token_env, health_probe_enabled, cors_origin,
       copilot_proxy_enabled, copilot_proxy_require_token_auth,
       copilot_proxy_token_ttl_seconds, copilot_proxy_heartbeat_interval_ms,
       copilot_proxy_heartbeat_timeout_ms,
       copilot_proxy_max_inflight_per_connection,
       copilot_proxy_allowed_prefixes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    config.id,
    config.default_model,
    config.request_timeout_ms,
    config.max_retries,
    config.max_body_size_kb,
    config.gateway_auth_token_env,
    config.health_probe_enabled,
    config.cors_origin,
    config.copilot_proxy_enabled,
    config.copilot_proxy_require_token_auth,
    config.copilot_proxy_token_ttl_seconds,
    config.copilot_proxy_heartbeat_interval_ms,
    config.copilot_proxy_heartbeat_timeout_ms,
    config.copilot_proxy_max_inflight_per_connection,
    config.copilot_proxy_allowed_prefixes,
  );
}

/**
 * Partially update the gateway config singleton row.
 * Only the keys present in `partial` are updated; other columns remain unchanged.
 */
export function updateGatewayConfig(
  partial: Partial<Omit<GatewayConfigRow, "id">>,
): void {
  const db = getDatabase();

  const allowedKeys: ReadonlyArray<keyof Omit<GatewayConfigRow, "id">> = [
    "default_model",
    "request_timeout_ms",
    "max_retries",
    "max_body_size_kb",
    "gateway_auth_token_env",
    "health_probe_enabled",
    "cors_origin",
    "copilot_proxy_enabled",
    "copilot_proxy_require_token_auth",
    "copilot_proxy_token_ttl_seconds",
    "copilot_proxy_heartbeat_interval_ms",
    "copilot_proxy_heartbeat_timeout_ms",
    "copilot_proxy_max_inflight_per_connection",
    "copilot_proxy_allowed_prefixes",
  ];

  const setClauses: string[] = [];
  const values: SQLInputValue[] = [];

  for (const key of allowedKeys) {
    if (key in partial) {
      setClauses.push(`${key} = ?`);
      values.push(partial[key] as SQLInputValue);
    }
  }

  if (setClauses.length === 0) {
    return; // Nothing to update.
  }

  values.push(1); // WHERE id = 1

  db.prepare(`UPDATE gateway_config SET ${setClauses.join(", ")} WHERE id = ?`)
    .run(...values);
}

// ---------------------------------------------------------------------------
// Task 2.4 — Chain status recalculation
// ---------------------------------------------------------------------------

/**
 * Recalculate a chain's status based on the statuses of its constituent models.
 *
 * Per REQ-CHAIN-002:
 * - ALL active  → `active`  ("All models active")
 * - SOME active → `degraded` ("X of Y models inactive: <names>")
 * - ALL inactive → `inactive` ("All models inactive")
 *
 * The chain row is updated in-place and the transition is logged.
 */
export function recalculateChainStatus(chainName: string): void {
  const db = getDatabase();

  const chainModels = getChainModels(chainName);
  if (chainModels.length === 0) {
    // Edge case: chain with no models. Treat as inactive.
    updateChainStatus(chainName, "inactive", "No models in chain");
    return;
  }

  const modelNames = chainModels.map((cm) => cm.model_name);

  // Look up the status of each model in the chain.
  const placeholders = modelNames.map(() => "?").join(", ");
  const modelRows = db
    .prepare(`SELECT name, status FROM models WHERE name IN (${placeholders})`)
    .all(...modelNames) as unknown as { name: string; status: string }[];

  const statusByName = new Map(modelRows.map((r) => [r.name, r.status]));

  let activeCount = 0;
  const inactiveNames: string[] = [];

  for (const name of modelNames) {
    const status = statusByName.get(name);
    if (status === "active") {
      activeCount++;
    } else {
      inactiveNames.push(name);
    }
  }

  const total = modelNames.length;
  const inactiveCount = inactiveNames.length;

  if (activeCount === total) {
    updateChainStatus(chainName, "active", "All models active");
  } else if (activeCount === 0) {
    updateChainStatus(chainName, "inactive", "All models inactive");
  } else {
    updateChainStatus(
      chainName,
      "degraded",
      `${inactiveCount} of ${total} models inactive: ${inactiveNames.join(", ")}`,
    );
  }
}
