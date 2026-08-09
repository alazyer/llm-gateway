import type { AppConfig, ConfigSourcePresence, GatewayModelConfig } from "./config.js";
import {
  getAllChains,
  getChainModels,
  getModelsFiltered,
} from "./db/repository.js";

function fromSqlBool(value: number): boolean {
  return value === 1;
}

function mapDbModelToGatewayModel(row: import("./db/types.js").ModelRow, env: NodeJS.ProcessEnv): GatewayModelConfig {
  const apiKeyEnv = row.api_key_env.trim();
  const apiKey = apiKeyEnv ? env[apiKeyEnv] : undefined;
  if (!apiKey) {
    const detail = apiKeyEnv.length > 0 ? `environment variable ${apiKeyEnv}` : "an empty api_key_env value";
    throw new Error(
      `Missing API key for model ${row.name} from ${detail} while loading fallback config from database.`,
    );
  }

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
    unknownFieldMode: row.unknown_field_mode === "enforce" ? "enforce" : "warn",
    unknownFieldWindowRequests: row.unknown_field_window_requests,
    status: row.status === "inactive" ? "inactive" : "active",
    statusReason: row.status_reason,
    statusChangedAt: row.status_changed_at,
  };
}

function validateDefaultModel(config: AppConfig): void {
  if (!config.defaultModel) {
    return;
  }

  const modelExists = config.models.some((model) => model.name === config.defaultModel);
  const chainExists = config.modelChains.some((chain) => `chain-${chain.name}` === config.defaultModel);

  if (!modelExists && !chainExists) {
    throw new Error(
      `default_model ${config.defaultModel} is not present in the effective model catalog or model chains.`,
    );
  }
}

export function applyDatabaseFallbackConfig(
  baseConfig: AppConfig,
  sourcePresence: ConfigSourcePresence,
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const nextConfig: AppConfig = {
    ...baseConfig,
    models: [...baseConfig.models],
    modelChains: [...baseConfig.modelChains],
  };

  if (sourcePresence.missingModels) {
    const staticRows = getModelsFiltered({ source: "static" });
    const dbModels = staticRows.map((row) => mapDbModelToGatewayModel(row, env));

    if (dbModels.length === 0) {
      throw new Error(
        "Gateway config is missing `models` and database fallback found no persisted static models.",
      );
    }

    nextConfig.models = dbModels;
    nextConfig.upstreamBaseUrl = dbModels[0]!.baseUrl;

    console.info(
      `[startup] Config file missing models; loaded ${dbModels.length} static model(s) from database fallback.`,
    );
  }

  if (sourcePresence.missingModelChains) {
    const modelByName = new Map(nextConfig.models.map((model) => [model.name, model]));

    nextConfig.modelChains = getAllChains().map((chainRow) => {
      const chainModels = getChainModels(chainRow.name)
        .sort((left, right) => left.position - right.position)
        .map((entry) => {
          const modelConfig = modelByName.get(entry.model_name);
          if (!modelConfig) {
            throw new Error(
              `Chain \"${chainRow.name}\" references model \"${entry.model_name}\" that is missing from the effective model catalog.`,
            );
          }

          return {
            name: entry.model_name,
            modelConfig,
            timeoutMs: entry.timeout_ms ?? chainRow.timeout_ms,
            maxRetries: entry.max_retries ?? chainRow.max_retries,
          };
        });

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

    console.info(
      `[startup] Config file missing model_chains; loaded ${nextConfig.modelChains.length} chain(s) from database fallback.`,
    );
  }

  validateDefaultModel(nextConfig);

  return nextConfig;
}
