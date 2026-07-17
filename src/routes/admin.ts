/**
 * Admin API routes for gateway lifecycle management.
 *
 * All endpoints require gateway_auth_token authentication.
 * These routes provide read-only status views and model activate/deactivate
 * operations that also trigger chain status recalculation.
 */

import type { FastifyPluginAsync } from "fastify";

import {
  getAllModels,
  getModelByName,
  updateModelStatus,
  getChainsReferencingModel,
  getAllChains,
  getChainByName,
  getChainModels,
  getGatewayConfig,
  recalculateChainStatus,
} from "../db/repository.js";
import type { ModelRow, ModelChainRow, ChainModelRow, GatewayConfigRow } from "../db/types.js";

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

// ---------------------------------------------------------------------------
// Route plugin
// ---------------------------------------------------------------------------

export const adminRoutes: FastifyPluginAsync = async (app) => {
  // GET /admin/models — list all models with status
  app.get("/admin/models", async (_request, reply) => {
    const models = getAllModels();
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

    const updated = getModelByName(name)!;
    return reply.send({
      model: modelRowToSummary(updated),
      message: `Model '${name}' deactivated successfully.`,
    });
  });

  // GET /admin/chains — list all chains with status
  app.get("/admin/chains", async (_request, reply) => {
    const chains = getAllChains();
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
};
