/**
 * Admin API routes for gateway lifecycle management.
 *
 * All endpoints require gateway_auth_token authentication.
 * These routes provide read/write status views and model/chain CRUD
 * operations that also trigger chain status recalculation.
 */

import type { FastifyPluginAsync } from "fastify";

import {
  getAllModels,
  getModelByName,
  updateModelStatus,
  updateModel,
  deleteModel,
  getModelsFiltered,
  getChainsReferencingModel,
  getAllChains,
  getChainByName,
  getChainModels,
  getGatewayConfig,
  updateGatewayConfig,
  insertModel,
  insertChain,
  updateChain,
  deleteChain,
  replaceChainModels,
  recalculateChainStatus,
  getChainsFiltered,
} from "../db/repository.js";
import type { ModelRow, ModelChainRow, ChainModelRow, GatewayConfigRow } from "../db/types.js";
import {
  type AppConfig,
  coerceInputModalities,
  coerceOutputModalities,
  parseInputModalities,
  parseOutputModalities,
} from "../config.js";
import { refreshRuntimeModels } from "../runtime-config.js";
import { getDatabase } from "../db/index.js";

// ---------------------------------------------------------------------------
// Response shape types
// ---------------------------------------------------------------------------

interface AdminModelSummary {
  name: string;
  upstream_model: string;
  base_url: string;
  owned_by: string;
  status: string;
  status_reason: string | null;
  status_changed_at: number | null;
  supports_tools: boolean;
  supports_streaming: boolean;
  input_modalities: string[];
  output_modalities: string[];
}

interface AdminModelDetail extends AdminModelSummary {
  api_key_env: string;
  created: number;
  unknown_field_mode: string;
  unknown_field_window_requests: number;
  source: string | null;
  source_prefix: string | null;
  connection_id: string | null;
  capabilities_json: string | null;
  updated_at: number;
}

interface AdminChainSummary {
  name: string;
  status: string;
  status_reason: string | null;
  status_changed_at: number | null;
  active_models: number;
  total_models: number;
  timeout_ms: number;
  max_retries: number;
  chain_timeout_ms: number | null;
}

interface AdminChainDetail extends AdminChainSummary {
  models: Array<{
    position: number;
    model_name: string;
    timeout_ms: number | null;
    max_retries: number | null;
    status: string;
  }>;
  updated_at: number;
}

interface AdminGatewayStatus {
  status: "ok";
  models: { total: number; active: number; inactive: number };
  chains: { total: number; active: number; degraded: number; inactive: number };
  default_model: string | null;
  uptime_seconds: number;
}

interface AdminDatabaseInfo {
  type: "sqlite";
  gateway_config: {
    id: number;
    default_model: string | null;
    request_timeout_ms: number;
    max_retries: number;
    max_body_size_kb: number;
    health_probe_enabled: boolean;
    cors_origin: string | null;
    copilot_proxy_enabled: boolean;
  };
  model_count: number;
  chain_count: number;
}

// ---------------------------------------------------------------------------
// Request body schemas (lightweight — just typed, no zod for admin routes)
// ---------------------------------------------------------------------------

interface CreateModelBody {
  name: string;
  upstream_model: string;
  base_url: string;
  api_key_env: string;
  owned_by?: string;
  supports_tools?: boolean;
  supports_streaming?: boolean;
  input_modalities?: string[];
  output_modalities?: string[];
  unknown_field_mode?: "warn" | "enforce";
  unknown_field_window_requests?: number;
  source?: string;
  source_prefix?: string | null;
}

interface UpdateModelBody {
  upstream_model?: string;
  base_url?: string;
  api_key_env?: string;
  owned_by?: string;
  supports_tools?: boolean;
  supports_streaming?: boolean;
  input_modalities?: string[];
  output_modalities?: string[];
  unknown_field_mode?: "warn" | "enforce";
  unknown_field_window_requests?: number;
  source?: string;
  source_prefix?: string | null;
  status?: "active" | "inactive";
  status_reason?: string;
}

interface CreateChainBody {
  name: string;
  timeout_ms?: number;
  max_retries?: number;
  chain_timeout_ms?: number | null;
  models: Array<{
    model_name: string;
    timeout_ms?: number | null;
    max_retries?: number | null;
  }>;
}

interface UpdateChainBody {
  timeout_ms?: number;
  max_retries?: number;
  chain_timeout_ms?: number | null;
  models?: Array<{
    model_name: string;
    timeout_ms?: number | null;
    max_retries?: number | null;
  }>;
}

interface PatchGatewayConfigBody {
  default_model?: string | null;
  request_timeout_ms?: number;
  max_retries?: number;
  max_body_size_kb?: number;
  gateway_auth_token_env?: string | null;
  health_probe_enabled?: boolean;
  cors_origin?: string | string[] | null;
  copilot_proxy_enabled?: boolean;
  copilot_proxy_require_token_auth?: boolean;
  copilot_proxy_token_ttl_seconds?: number;
  copilot_proxy_heartbeat_interval_ms?: number;
  copilot_proxy_heartbeat_timeout_ms?: number;
  copilot_proxy_max_inflight_per_connection?: number;
  copilot_proxy_allowed_prefixes?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const START_TIME = Math.floor(Date.now() / 1000);

function modelRowToSummary(row: ModelRow): AdminModelSummary {
  return {
    name: row.name,
    upstream_model: row.upstream_model,
    base_url: row.base_url,
    owned_by: row.owned_by,
    status: row.status,
    status_reason: row.status_reason,
    status_changed_at: row.status_changed_at,
    supports_tools: row.supports_tools === 1,
    supports_streaming: row.supports_streaming === 1,
    input_modalities: parseInputModalities(row.input_modalities),
    output_modalities: parseOutputModalities(row.output_modalities),
  };
}

function modelRowToDetail(row: ModelRow): AdminModelDetail {
  return {
    ...modelRowToSummary(row),
    api_key_env: row.api_key_env,
    created: row.created,
    unknown_field_mode: row.unknown_field_mode,
    unknown_field_window_requests: row.unknown_field_window_requests,
    source: row.source,
    source_prefix: row.source_prefix,
    connection_id: row.connection_id,
    capabilities_json: row.capabilities_json,
    updated_at: row.updated_at,
  };
}

function chainRowToSummary(row: ModelChainRow, activeModels: number, totalModels: number): AdminChainSummary {
  return {
    name: row.name,
    status: row.status,
    status_reason: row.status_reason,
    status_changed_at: row.status_changed_at,
    active_models: activeModels,
    total_models: totalModels,
    timeout_ms: row.timeout_ms,
    max_retries: row.max_retries,
    chain_timeout_ms: row.chain_timeout_ms,
  };
}

function chainRowToDetail(
  row: ModelChainRow,
  chainModels: ChainModelRow[],
  modelStatusByName: Map<string, string>,
): AdminChainDetail {
  let activeCount = 0;
  const modelEntries = chainModels.map((cm) => {
    const status = modelStatusByName.get(cm.model_name) ?? "unknown";
    if (status === "active") activeCount++;
    return {
      position: cm.position,
      model_name: cm.model_name,
      timeout_ms: cm.timeout_ms,
      max_retries: cm.max_retries,
      status,
    };
  });

  return {
    ...chainRowToSummary(row, activeCount, chainModels.length),
    models: modelEntries,
    updated_at: row.updated_at,
  };
}

/**
 * After a model status change, recalculate the status of all chains that
 * reference the affected model (REQ-CHAIN-007).
 */
function recalculateAffectedChains(modelName: string): void {
  const affectedChains = getChainsReferencingModel(modelName);
  for (const chainName of affectedChains) {
    recalculateChainStatus(chainName);
  }
}

/**
 * Parse query filters from the request query string.
 */
function parseListFilters(query: Record<string, string | undefined>): {
  status?: string;
  source?: string;
} {
  const filters: { status?: string; source?: string } = {};
  if (query.status) {
    filters.status = query.status;
  }
  if (query.source) {
    filters.source = query.source;
  }
  return filters;
}

/** Convert a boolean to its SQLite integer representation. */
function boolToInt(value: boolean): number {
  return value ? 1 : 0;
}

/** Serialise a string or string array for the `cors_origin` column. */
function serialiseCorsOrigin(origin: string | string[] | null | undefined): string | null {
  if (origin === undefined || origin === null) return null;
  if (Array.isArray(origin)) return JSON.stringify(origin);
  return origin;
}

/** Serialise the copilot-proxy allowed prefixes as a JSON string. */
function serialisePrefixes(prefixes: string[]): string {
  return JSON.stringify(prefixes);
}

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

interface AdminRoutesOptions {
  /**
   * The shared, mutable in-memory AppConfig (the same reference held by the
   * responses and ai-chat route plugins). Admin write handlers call
   * {@link refreshRuntimeModels} on it after a successful DB mutation so that
   * `/v1/models` discovery and `resolveModel` routing reflect the edit without a
   * server restart.
   */
  config: AppConfig;
}

export const adminRoutes: FastifyPluginAsync<AdminRoutesOptions> = async (app, options) => {
  /**
   * Rebuild the shared config's models/chains from the current DB state. Called
   * after every successful model or chain write. Synchronous (no await between
   * the write and the refresh within a handler), so the in-place array
   * replacement is atomic from JS's single-threaded perspective.
   */
  const refresh = (): void => {
    refreshRuntimeModels(options.config, process.env);
  };

  // =======================================================================
  // Models
  // =======================================================================

  // GET /admin/models — list models with optional ?status=&source= filters
  app.get("/admin/models", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const filters = parseListFilters(query);
    const models = getModelsFiltered(filters);
    const summaries = models.map(modelRowToSummary);
    return reply.send({ models: summaries });
  });

  // GET /admin/models/:name — single model detail
  app.get("/admin/models/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const model = getModelByName(name);

    if (!model) {
      return reply.code(404).send({
        error: {
          message: `Model '${name}' not found.`,
          type: "not_found_error",
        },
      });
    }

    return reply.send({ model: modelRowToDetail(model) });
  });

  // POST /admin/models — create a new model
  app.post("/admin/models", async (request, reply) => {
    const body = request.body as CreateModelBody;

    if (!body.name || !body.upstream_model || !body.base_url || !body.api_key_env) {
      return reply.code(400).send({
        error: {
          message: "Missing required fields: name, upstream_model, base_url, api_key_env.",
          type: "invalid_request_error",
        },
      });
    }

    const existing = getModelByName(body.name);
    if (existing) {
      return reply.code(409).send({
        error: {
          message: `Model '${body.name}' already exists.`,
          type: "conflict_error",
        },
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const row: ModelRow = {
      name: body.name,
      upstream_model: body.upstream_model,
      base_url: body.base_url,
      api_key_env: body.api_key_env,
      owned_by: body.owned_by ?? "llm-gateway",
      created: now,
      supports_tools: boolToInt(body.supports_tools ?? true),
      supports_streaming: boolToInt(body.supports_streaming ?? true),
      input_modalities: coerceInputModalities(body.input_modalities ?? null) ?? "text",
      output_modalities: coerceOutputModalities(body.output_modalities ?? null) ?? "text",
      unknown_field_mode: body.unknown_field_mode ?? "warn",
      unknown_field_window_requests: body.unknown_field_window_requests ?? 100,
      source: body.source ?? "static",
      source_prefix: body.source_prefix ?? null,
      connection_id: null,
      status: "active",
      status_reason: "Created via admin API",
      status_changed_at: now,
      capabilities_json: null,
      updated_at: now,
    };

    insertModel(row);
    refresh();
    const created = getModelByName(body.name)!;
    return reply.code(201).send({ model: modelRowToDetail(created) });
  });

  // PUT /admin/models/:name — update model config
  app.put("/admin/models/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const body = request.body as UpdateModelBody;

    const existing = getModelByName(name);
    if (!existing) {
      return reply.code(404).send({
        error: {
          message: `Model '${name}' not found.`,
          type: "not_found_error",
        },
      });
    }

    const partial: Partial<Omit<ModelRow, "name">> = {};

    if (body.upstream_model !== undefined) partial.upstream_model = body.upstream_model;
    if (body.base_url !== undefined) partial.base_url = body.base_url;
    if (body.api_key_env !== undefined) partial.api_key_env = body.api_key_env;
    if (body.owned_by !== undefined) partial.owned_by = body.owned_by;
    if (body.supports_tools !== undefined) partial.supports_tools = boolToInt(body.supports_tools);
    if (body.supports_streaming !== undefined) partial.supports_streaming = boolToInt(body.supports_streaming);
    if (body.input_modalities !== undefined) partial.input_modalities = coerceInputModalities(body.input_modalities) ?? "text";
    if (body.output_modalities !== undefined) partial.output_modalities = coerceOutputModalities(body.output_modalities) ?? "text";
    if (body.unknown_field_mode !== undefined) partial.unknown_field_mode = body.unknown_field_mode;
    if (body.unknown_field_window_requests !== undefined) partial.unknown_field_window_requests = body.unknown_field_window_requests;
    if (body.source !== undefined) partial.source = body.source;
    if (body.source_prefix !== undefined) partial.source_prefix = body.source_prefix ?? null;

    // Status changes via PUT also trigger chain recalculation.
    let statusChanged = false;
    if (body.status !== undefined && body.status !== existing.status) {
      partial.status = body.status;
      partial.status_reason = body.status_reason ?? `${body.status === "active" ? "Activated" : "Deactivated"} via admin API`;
      partial.status_changed_at = Math.floor(Date.now() / 1000);
      statusChanged = true;
    } else if (body.status_reason !== undefined) {
      partial.status_reason = body.status_reason;
    }

    updateModel(name, partial);

    if (statusChanged) {
      recalculateAffectedChains(name);
    }
    refresh();
    const updated = getModelByName(name)!;
    return reply.send({ model: modelRowToDetail(updated) });
  });

  // DELETE /admin/models/:name — delete model
  app.delete("/admin/models/:name", async (request, reply) => {
    const { name } = request.params as { name: string };

    const existing = getModelByName(name);
    if (!existing) {
      return reply.code(404).send({
        error: {
          message: `Model '${name}' not found.`,
          type: "not_found_error",
        },
      });
    }

    // Find affected chains before deleting (CASCADE removes chain_models refs).
    const affectedChains = getChainsReferencingModel(name);

    deleteModel(name);

    // Recalculate affected chain statuses (some may now be inactive/empty).
    for (const chainName of affectedChains) {
      const chain = getChainByName(chainName);
      if (chain) {
        recalculateChainStatus(chainName);
      }
      // If the chain no longer exists (shouldn't happen, but defensive), skip.
    }
    refresh();
    return reply.code(200).send({
      message: `Model '${name}' deleted successfully.`,
      affected_chains: affectedChains,
    });
  });

  // POST /admin/models/:name/activate — activate model
  app.post("/admin/models/:name/activate", async (request, reply) => {
    const { name } = request.params as { name: string };
    const model = getModelByName(name);

    if (!model) {
      return reply.code(404).send({
        error: {
          message: `Model '${name}' not found.`,
          type: "not_found_error",
        },
      });
    }

    if (model.status === "active") {
      return reply.send({
        model: modelRowToSummary(model),
        message: `Model '${name}' is already active.`,
      });
    }

    updateModelStatus(name, "active", "Activated via admin API");
    recalculateAffectedChains(name);
    refresh();
    const updated = getModelByName(name)!;
    return reply.send({
      model: modelRowToSummary(updated),
      message: `Model '${name}' activated successfully.`,
    });
  });

  // POST /admin/models/:name/deactivate — deactivate model
  app.post("/admin/models/:name/deactivate", async (request, reply) => {
    const { name } = request.params as { name: string };
    const model = getModelByName(name);

    if (!model) {
      return reply.code(404).send({
        error: {
          message: `Model '${name}' not found.`,
          type: "not_found_error",
        },
      });
    }

    if (model.status === "inactive") {
      return reply.send({
        model: modelRowToSummary(model),
        message: `Model '${name}' is already inactive.`,
      });
    }

    updateModelStatus(name, "inactive", "Deactivated via admin API");
    recalculateAffectedChains(name);
    refresh();
    const updated = getModelByName(name)!;
    return reply.send({
      model: modelRowToSummary(updated),
      message: `Model '${name}' deactivated successfully.`,
    });
  });

  // =======================================================================
  // Chains
  // =======================================================================

  // GET /admin/chains — list chains with optional ?status=&source= filters
  app.get("/admin/chains", async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const filters = parseListFilters(query);
    const chains = getChainsFiltered(filters);
    const summaries = chains.map((chain) => {
      const chainModels = getChainModels(chain.name);
      const activeCount = chainModels.filter((cm) => {
        const model = getModelByName(cm.model_name);
        return model?.status === "active";
      }).length;
      return chainRowToSummary(chain, activeCount, chainModels.length);
    });
    return reply.send({ chains: summaries });
  });

  // GET /admin/chains/:name — single chain detail
  app.get("/admin/chains/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const chain = getChainByName(name);

    if (!chain) {
      return reply.code(404).send({
        error: {
          message: `Chain '${name}' not found.`,
          type: "not_found_error",
        },
      });
    }

    const chainModels = getChainModels(name);
    const modelStatusByName = new Map<string, string>();
    for (const cm of chainModels) {
      const model = getModelByName(cm.model_name);
      if (model) {
        modelStatusByName.set(cm.model_name, model.status);
      }
    }

    return reply.send({ chain: chainRowToDetail(chain, chainModels, modelStatusByName) });
  });

  // POST /admin/chains — create a new chain
  app.post("/admin/chains", async (request, reply) => {
    const body = request.body as CreateChainBody;

    if (!body.name) {
      return reply.code(400).send({
        error: {
          message: "Missing required field: name.",
          type: "invalid_request_error",
        },
      });
    }

    if (!body.models || body.models.length === 0) {
      return reply.code(400).send({
        error: {
          message: "Chains must have at least one model.",
          type: "invalid_request_error",
        },
      });
    }

    // Validate that all referenced models exist
    for (const m of body.models) {
      const model = getModelByName(m.model_name);
      if (!model) {
        return reply.code(400).send({
          error: {
            message: `Model '${m.model_name}' not found. Cannot add non-existent model to chain.`,
            type: "invalid_request_error",
          },
        });
      }
    }

    const existing = getChainByName(body.name);
    if (existing) {
      return reply.code(409).send({
        error: {
          message: `Chain '${body.name}' already exists.`,
          type: "conflict_error",
        },
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const chainRow: ModelChainRow = {
      name: body.name,
      timeout_ms: body.timeout_ms ?? 30000,
      max_retries: body.max_retries ?? 0,
      chain_timeout_ms: body.chain_timeout_ms ?? null,
      status: "active",
      status_reason: "Created via admin API",
      status_changed_at: now,
      updated_at: now,
    };

    const chainModelRows: ChainModelRow[] = body.models.map((m, index) => ({
      chain_name: body.name,
      position: index,
      model_name: m.model_name,
      timeout_ms: m.timeout_ms ?? null,
      max_retries: m.max_retries ?? null,
    }));

    const db = getDatabase();
    db.exec("BEGIN TRANSACTION");
    try {
      insertChain(chainRow, chainModelRows);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    // Recalculate the chain status based on model statuses
    recalculateChainStatus(body.name);
    refresh();
    const created = getChainByName(body.name)!;
    const createdModels = getChainModels(body.name);
    const modelStatusByName = new Map<string, string>();
    for (const cm of createdModels) {
      const model = getModelByName(cm.model_name);
      if (model) {
        modelStatusByName.set(cm.model_name, model.status);
      }
    }

    return reply.code(201).send({ chain: chainRowToDetail(created, createdModels, modelStatusByName) });
  });

  // PUT /admin/chains/:name — update chain config and/or model membership
  app.put("/admin/chains/:name", async (request, reply) => {
    const { name } = request.params as { name: string };
    const body = request.body as UpdateChainBody;

    const existing = getChainByName(name);
    if (!existing) {
      return reply.code(404).send({
        error: {
          message: `Chain '${name}' not found.`,
          type: "not_found_error",
        },
      });
    }

    // Validate model references if models are being updated
    if (body.models) {
      if (body.models.length === 0) {
        return reply.code(400).send({
          error: {
            message: "Chains must have at least one model.",
            type: "invalid_request_error",
          },
        });
      }
      for (const m of body.models) {
        const model = getModelByName(m.model_name);
        if (!model) {
          return reply.code(400).send({
            error: {
              message: `Model '${m.model_name}' not found. Cannot add non-existent model to chain.`,
              type: "invalid_request_error",
            },
          });
        }
      }
    }

    const db = getDatabase();
    db.exec("BEGIN TRANSACTION");
    try {
      // Update chain-level fields
      const partial: Partial<Omit<ModelChainRow, "name">> = {};
      if (body.timeout_ms !== undefined) partial.timeout_ms = body.timeout_ms;
      if (body.max_retries !== undefined) partial.max_retries = body.max_retries;
      if (body.chain_timeout_ms !== undefined) partial.chain_timeout_ms = body.chain_timeout_ms;

      if (Object.keys(partial).length > 0) {
        updateChain(name, partial);
      }

      // Replace model membership if provided
      if (body.models) {
        const chainModelRows: ChainModelRow[] = body.models.map((m, index) => ({
          chain_name: name,
          position: index,
          model_name: m.model_name,
          timeout_ms: m.timeout_ms ?? null,
          max_retries: m.max_retries ?? null,
        }));
        replaceChainModels(name, chainModelRows);
      }

      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    // Recalculate chain status after membership/config change
    recalculateChainStatus(name);
    refresh();
    const updated = getChainByName(name)!;
    const updatedModels = getChainModels(name);
    const modelStatusByName = new Map<string, string>();
    for (const cm of updatedModels) {
      const model = getModelByName(cm.model_name);
      if (model) {
        modelStatusByName.set(cm.model_name, model.status);
      }
    }

    return reply.send({ chain: chainRowToDetail(updated, updatedModels, modelStatusByName) });
  });

  // DELETE /admin/chains/:name — delete chain
  app.delete("/admin/chains/:name", async (request, reply) => {
    const { name } = request.params as { name: string };

    const existing = getChainByName(name);
    if (!existing) {
      return reply.code(404).send({
        error: {
          message: `Chain '${name}' not found.`,
          type: "not_found_error",
        },
      });
    }

    deleteChain(name);
    refresh();
    return reply.code(200).send({
      message: `Chain '${name}' deleted successfully.`,
    });
  });

  // =======================================================================
  // Gateway status & config
  // =======================================================================

  // GET /admin/status — gateway status summary
  app.get("/admin/status", async (_request, reply) => {
    const models = getAllModels();
    const chains = getAllChains();
    const gatewayConfig = getGatewayConfig();

    const activeModels = models.filter((m) => m.status === "active").length;
    const inactiveModels = models.filter((m) => m.status === "inactive").length;

    const activeChains = chains.filter((c) => c.status === "active").length;
    const degradedChains = chains.filter((c) => c.status === "degraded").length;
    const inactiveChains = chains.filter((c) => c.status === "inactive").length;

    const now = Math.floor(Date.now() / 1000);
    const uptimeSeconds = now - START_TIME;

    const status: AdminGatewayStatus = {
      status: "ok",
      models: {
        total: models.length,
        active: activeModels,
        inactive: inactiveModels,
      },
      chains: {
        total: chains.length,
        active: activeChains,
        degraded: degradedChains,
        inactive: inactiveChains,
      },
      default_model: gatewayConfig?.default_model ?? null,
      uptime_seconds: uptimeSeconds,
    };

    return reply.send(status);
  });

  // GET /admin/database — database info
  app.get("/admin/database", async (_request, reply) => {
    const gatewayConfig = getGatewayConfig();
    const models = getAllModels();
    const chains = getAllChains();

    if (!gatewayConfig) {
      return reply.code(503).send({
        error: {
          message: "Gateway configuration not found in database.",
          type: "service_unavailable_error",
        },
      });
    }

    const info: AdminDatabaseInfo = {
      type: "sqlite",
      gateway_config: {
        id: gatewayConfig.id,
        default_model: gatewayConfig.default_model,
        request_timeout_ms: gatewayConfig.request_timeout_ms,
        max_retries: gatewayConfig.max_retries,
        max_body_size_kb: gatewayConfig.max_body_size_kb,
        health_probe_enabled: gatewayConfig.health_probe_enabled === 1,
        cors_origin: gatewayConfig.cors_origin,
        copilot_proxy_enabled: gatewayConfig.copilot_proxy_enabled === 1,
      },
      model_count: models.length,
      chain_count: chains.length,
    };

    return reply.send(info);
  });

  // PATCH /admin/database — partial-update gateway config singleton
  app.patch("/admin/database", async (request, reply) => {
    const body = request.body as PatchGatewayConfigBody;

    const existing = getGatewayConfig();
    if (!existing) {
      return reply.code(503).send({
        error: {
          message: "Gateway configuration not found in database.",
          type: "service_unavailable_error",
        },
      });
    }

    const partial: Partial<Omit<GatewayConfigRow, "id">> = {};

    if (body.default_model !== undefined) {
      partial.default_model = body.default_model ?? null;
    }
    if (body.request_timeout_ms !== undefined) {
      partial.request_timeout_ms = body.request_timeout_ms;
    }
    if (body.max_retries !== undefined) {
      partial.max_retries = body.max_retries;
    }
    if (body.max_body_size_kb !== undefined) {
      partial.max_body_size_kb = body.max_body_size_kb;
    }
    if (body.gateway_auth_token_env !== undefined) {
      partial.gateway_auth_token_env = body.gateway_auth_token_env ?? null;
    }
    if (body.health_probe_enabled !== undefined) {
      partial.health_probe_enabled = boolToInt(body.health_probe_enabled);
    }
    if (body.cors_origin !== undefined) {
      partial.cors_origin = serialiseCorsOrigin(body.cors_origin);
    }
    if (body.copilot_proxy_enabled !== undefined) {
      partial.copilot_proxy_enabled = boolToInt(body.copilot_proxy_enabled);
    }
    if (body.copilot_proxy_require_token_auth !== undefined) {
      partial.copilot_proxy_require_token_auth = boolToInt(body.copilot_proxy_require_token_auth);
    }
    if (body.copilot_proxy_token_ttl_seconds !== undefined) {
      partial.copilot_proxy_token_ttl_seconds = body.copilot_proxy_token_ttl_seconds;
    }
    if (body.copilot_proxy_heartbeat_interval_ms !== undefined) {
      partial.copilot_proxy_heartbeat_interval_ms = body.copilot_proxy_heartbeat_interval_ms;
    }
    if (body.copilot_proxy_heartbeat_timeout_ms !== undefined) {
      partial.copilot_proxy_heartbeat_timeout_ms = body.copilot_proxy_heartbeat_timeout_ms;
    }
    if (body.copilot_proxy_max_inflight_per_connection !== undefined) {
      partial.copilot_proxy_max_inflight_per_connection = body.copilot_proxy_max_inflight_per_connection;
    }
    if (body.copilot_proxy_allowed_prefixes !== undefined) {
      partial.copilot_proxy_allowed_prefixes = serialisePrefixes(body.copilot_proxy_allowed_prefixes);
    }

    if (Object.keys(partial).length === 0) {
      return reply.code(400).send({
        error: {
          message: "No fields provided to update.",
          type: "invalid_request_error",
        },
      });
    }

    updateGatewayConfig(partial);

    const updated = getGatewayConfig()!;
    const info: AdminDatabaseInfo = {
      type: "sqlite",
      gateway_config: {
        id: updated.id,
        default_model: updated.default_model,
        request_timeout_ms: updated.request_timeout_ms,
        max_retries: updated.max_retries,
        max_body_size_kb: updated.max_body_size_kb,
        health_probe_enabled: updated.health_probe_enabled === 1,
        cors_origin: updated.cors_origin,
        copilot_proxy_enabled: updated.copilot_proxy_enabled === 1,
      },
      model_count: getAllModels().length,
      chain_count: getAllChains().length,
    };

    return reply.send(info);
  });
};
