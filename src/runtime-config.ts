import {
  parseInputModalities,
  parseOutputModalities,
} from "./config.js";
import type { AppConfig, ConfigSourcePresence, GatewayModelConfig } from "./config.js";
import {
  getAllChains,
  getChainModels,
  getGatewayConfig,
  getModelsFiltered,
  insertGatewayConfig,
} from "./db/repository.js";
import type { ChainModelRow, GatewayConfigRow, ModelRow } from "./db/types.js";

function fromSqlBool(value: number): boolean {
  return value === 1;
}

function createDefaultGatewayConfigRow(): GatewayConfigRow {
  return {
    id: 1,
    default_model: null,
    request_timeout_ms: 30000,
    max_retries: 0,
    max_body_size_kb: 1024,
    gateway_auth_token_env: null,
    health_probe_enabled: 0,
    cors_origin: null,
    copilot_proxy_enabled: 0,
    copilot_proxy_require_token_auth: 1,
    copilot_proxy_token_ttl_seconds: 86400,
    copilot_proxy_heartbeat_interval_ms: 30000,
    copilot_proxy_heartbeat_timeout_ms: 10000,
    copilot_proxy_max_inflight_per_connection: 4,
    copilot_proxy_allowed_prefixes: "[\"copilot-\"]",
  };
}

function ensureGatewayConfigRow(): GatewayConfigRow {
  const existing = getGatewayConfig();
  if (existing) {
    return existing;
  }

  const defaults = createDefaultGatewayConfigRow();
  insertGatewayConfig(defaults);
  return defaults;
}

function parseCorsOrigin(value: string | null): string | string[] | undefined {
  if (value === null) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    // Keep the stored string when it is not JSON.
  }

  return value;
}

function mapDbModelToGatewayModel(row: ModelRow, env: NodeJS.ProcessEnv): GatewayModelConfig {
  const apiKeyEnv = row.api_key_env.trim();
  const apiKey = apiKeyEnv ? env[apiKeyEnv] : undefined;

  return {
    name: row.name,
    upstreamModel: row.upstream_model,
    baseUrl: row.base_url,
    apiKey,
    apiKeyEnv,
    ownedBy: row.owned_by,
    created: row.created,
    supportsTools: fromSqlBool(row.supports_tools),
    supportsStreaming: fromSqlBool(row.supports_streaming),
    inputModalities: parseInputModalities(row.input_modalities),
    outputModalities: parseOutputModalities(row.output_modalities),
    unknownFieldMode: row.unknown_field_mode === "enforce" ? "enforce" : "warn",
    unknownFieldWindowRequests: row.unknown_field_window_requests,
    status: row.status === "inactive" ? "inactive" : "active",
    statusReason: row.status_reason,
    statusChangedAt: row.status_changed_at,
  };
}

function createBrokenModelConfig(modelName: string): GatewayModelConfig {
  const now = Math.floor(Date.now() / 1000);
  return {
    name: modelName,
    upstreamModel: modelName,
    baseUrl: "",
    apiKey: undefined,
    apiKeyEnv: "",
    ownedBy: "llm-gateway",
    created: now,
    supportsTools: true,
    supportsStreaming: true,
    inputModalities: ["text"],
    outputModalities: ["text"],
    unknownFieldMode: "warn",
    unknownFieldWindowRequests: 100,
    status: "inactive",
    statusReason: "Missing model row in database.",
    statusChangedAt: now,
  };
}

function mapChainModels(
  rows: ChainModelRow[],
  modelByName: ReadonlyMap<string, GatewayModelConfig>,
  chainTimeoutMs: number,
  chainMaxRetries: number,
): Array<{
  name: string;
  modelConfig: GatewayModelConfig;
  timeoutMs: number;
  maxRetries: number;
}> {
  return rows.map((entry) => {
    const modelConfig = modelByName.get(entry.model_name) ?? createBrokenModelConfig(entry.model_name);

    return {
      name: entry.model_name,
      modelConfig,
      timeoutMs: entry.timeout_ms ?? chainTimeoutMs,
      maxRetries: entry.max_retries ?? chainMaxRetries,
    };
  });
}

/**
 * Rebuild the in-memory `models` and `modelChains` arrays on the shared
 * `AppConfig` from the current database state, in place.
 *
 * Called at startup (via {@link applyDatabaseFallbackConfig}) and after every
 * admin write that changes models or chains. Because every route plugin closes
 * over the same `config` reference (see `src/app.ts`), an in-place mutation here
 * is immediately visible to `/v1/models` discovery, `resolveModel` routing, and
 * the ai-chat capability gate — keeping the admin view and the runtime view
 * consistent without a restart.
 *
 * Gateway-level fields (timeouts, CORS, auth, default model) are intentionally
 * NOT refreshed here; they are governed by the gateway-config singleton and are
 * not changed by model/chain writes.
 */
export function refreshRuntimeModels(config: AppConfig, env: NodeJS.ProcessEnv): void {
  const models = getModelsFiltered({ source: "static" }).map((row) => mapDbModelToGatewayModel(row, env));
  const modelByName = new Map(models.map((model) => [model.name, model]));

  const modelChains = getAllChains().map((chainRow) => {
    const chainModels = mapChainModels(
      getChainModels(chainRow.name).sort((left, right) => left.position - right.position),
      modelByName,
      chainRow.timeout_ms,
      chainRow.max_retries,
    );
    const activeModels = chainModels.filter((entry) => entry.modelConfig.status === "active").length;

    return {
      name: chainRow.name,
      models: chainModels,
      timeoutMs: chainRow.timeout_ms,
      maxRetries: chainRow.max_retries,
      ...(chainRow.chain_timeout_ms !== null ? { chainTimeoutMs: chainRow.chain_timeout_ms } : {}),
      status: chainRow.status,
      statusReason: chainRow.status_reason,
      statusChangedAt: chainRow.status_changed_at,
      activeModels,
      totalModels: chainModels.length,
    };
  });

  config.models = models;
  config.modelChains = modelChains;
}

export function applyDatabaseFallbackConfig(
  baseConfig: AppConfig,
  _sourcePresence: ConfigSourcePresence,
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const gatewayConfig = ensureGatewayConfigRow();

  const config: AppConfig = {
    ...baseConfig,
    requestTimeoutMs: gatewayConfig.request_timeout_ms,
    maxRetries: gatewayConfig.max_retries,
    maxBodySizeKb: gatewayConfig.max_body_size_kb,
    healthProbeEnabled: gatewayConfig.health_probe_enabled === 1,
    copilotProxy: {
      enabled: gatewayConfig.copilot_proxy_enabled === 1,
      requireTokenAuth: gatewayConfig.copilot_proxy_require_token_auth === 1,
      tokenTtlSeconds: gatewayConfig.copilot_proxy_token_ttl_seconds,
      heartbeatIntervalMs: gatewayConfig.copilot_proxy_heartbeat_interval_ms,
      heartbeatTimeoutMs: gatewayConfig.copilot_proxy_heartbeat_timeout_ms,
      maxInflightPerConnection: gatewayConfig.copilot_proxy_max_inflight_per_connection,
      allowedPrefixes: JSON.parse(gatewayConfig.copilot_proxy_allowed_prefixes) as string[],
    },
    models: [],
    modelChains: [],
  };

  // Populate models + chains from the DB (mutates the shared object in place).
  refreshRuntimeModels(config, env);
  config.upstreamBaseUrl = config.models[0]?.baseUrl ?? baseConfig.upstreamBaseUrl;

  if (gatewayConfig.default_model !== null) {
    config.defaultModel = gatewayConfig.default_model;
  }

  if (gatewayConfig.gateway_auth_token_env !== null) {
    config.gatewayAuthTokenEnv = gatewayConfig.gateway_auth_token_env;
  }

  const corsOrigin = parseCorsOrigin(gatewayConfig.cors_origin);
  if (corsOrigin !== undefined) {
    config.corsOrigin = corsOrigin;
  }

  if (gatewayConfig.gateway_auth_token_env) {
    const token = env[gatewayConfig.gateway_auth_token_env];
    if (token) {
      config.gatewayAuthToken = token;
    }
  }

  return config;
}
