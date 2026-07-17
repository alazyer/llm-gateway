import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config as loadDotenv } from "dotenv";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { ChainModelEntry, ModelChainConfig } from "./contracts.js";
import type {
  ModelRow,
  ModelChainRow,
  ChainModelRow,
  GatewayConfigRow,
} from "./db/types.js";
import { openDatabase } from "./db/index.js";
import { runMigrations } from "./db/migrations/index.js";
import { allMigrations } from "./db/migrations/all.js";
import { seedFromConfig } from "./db/seed.js";
import {
  getAllModels,
  getAllChains,
  getChainModels,
  getGatewayConfig,
} from "./db/repository.js";

loadDotenv();

const envSchema = z.object({
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal", "silent"])
    .default("info"),
  GATEWAY_CONFIG_PATH: z.string().trim().min(1),
});

const yamlModelSchema = z
  .object({
    name: z.string().trim().min(1),
    upstream_model: z.string().trim().min(1).optional(),
    base_url: z.string().trim().url(),
    api_key: z.string().trim().min(1).optional(),
    api_key_env: z.string().trim().min(1).optional(),
    owned_by: z.string().trim().min(1).default("llm-gateway"),
    created: z.number().int().nonnegative().optional(),
    supports_tools: z.boolean().default(true),
    supports_streaming: z.boolean().default(true),
    unknown_field_mode: z.enum(["warn", "enforce"]).default("warn"),
    unknown_field_window_requests: z.coerce.number().int().positive().default(100),
  })
  .superRefine((value, ctx) => {
    if (value.api_key) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Inline api_key values are not supported. Use api_key_env instead.",
        path: ["api_key"],
      });
    }

    if (!value.api_key_env) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Each model must define api_key_env.",
        path: ["api_key_env"],
      });
    }
  });

const yamlChainModelEntrySchema = z.union([
  z.string().trim().min(1),
  z.object({
    name: z.string().trim().min(1),
    timeout_ms: z.number().positive().optional(),
    max_retries: z.number().nonnegative().optional(),
  }),
]);

const yamlModelChainEntrySchema = z.object({
  name: z.string().min(1),
  models: z.array(yamlChainModelEntrySchema).min(1),
  timeout_ms: z.number().positive().optional(),
  max_retries: z.number().nonnegative().optional(),
  chain_timeout_ms: z.number().positive().optional(),
});

const yamlGatewaySchema = z.object({
  default_model: z.string().trim().min(1).optional(),
  request_timeout_ms: z.coerce.number().int().positive().default(30000),
  max_retries: z.coerce.number().int().nonnegative().default(0),
  max_body_size_kb: z.coerce.number().int().positive().default(1024),
  gateway_auth_token_env: z.string().trim().min(1).optional(),
  health_probe_enabled: z.boolean().default(false),
  cors_origin: z.union([z.string(), z.array(z.string())]).optional(),
  copilot_proxy_enabled: z.boolean().default(false),
  copilot_proxy_require_token_auth: z.boolean().default(true),
  copilot_proxy_token_ttl_seconds: z.coerce.number().int().positive().default(86400),
  copilot_proxy_heartbeat_interval_ms: z.coerce.number().int().positive().default(30000),
  copilot_proxy_heartbeat_timeout_ms: z.coerce.number().int().positive().default(10000),
  copilot_proxy_max_inflight_per_connection: z.coerce.number().int().positive().default(4),
  copilot_proxy_allowed_prefixes: z.array(z.string().trim().min(1)).default(["copilot-"]),
  models: z.array(yamlModelSchema).min(1),
  model_chains: z.array(yamlModelChainEntrySchema).optional(),
});

export interface GatewayModelConfig {
  name: string;
  upstreamModel: string;
  baseUrl: string;
  apiKey: string | undefined;
  apiKeyEnv: string;
  ownedBy: string;
  created: number;
  supportsTools: boolean;
  supportsStreaming: boolean;
  unknownFieldMode: "warn" | "enforce";
  unknownFieldWindowRequests: number;
  status: string;
  statusReason: string | null;
  statusChangedAt: number | null;
}

export interface AppConfig {
  host: string;
  port: number;
  logLevel: "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "silent";
  upstreamBaseUrl: string;
  defaultModel?: string;
  requestTimeoutMs: number;
  maxRetries: number;
  maxBodySizeKb: number;
  gatewayAuthToken?: string;
  gatewayAuthTokenEnv?: string;
  healthProbeEnabled: boolean;
  corsOrigin?: string | string[];
  copilotProxy?: CopilotProxyConfig;
  models: GatewayModelConfig[];
  modelChains?: ModelChainConfig[];
}

export interface CopilotProxyConfig {
  enabled: boolean;
  requireTokenAuth: boolean;
  tokenTtlSeconds: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  maxInflightPerConnection: number;
  allowedPrefixes: string[];
}

export const DEFAULT_COPILOT_PROXY_CONFIG: CopilotProxyConfig = {
  enabled: false,
  requireTokenAuth: true,
  tokenTtlSeconds: 86400,
  heartbeatIntervalMs: 30000,
  heartbeatTimeoutMs: 10000,
  maxInflightPerConnection: 4,
  allowedPrefixes: ["copilot-"],
};

type YamlModelConfig = z.infer<typeof yamlModelSchema>;
type YamlChainModelEntry = z.infer<typeof yamlChainModelEntrySchema>;
type YamlModelChainEntry = z.infer<typeof yamlModelChainEntrySchema>;

function getCurrentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function normalizeModelEntry(
  value: YamlModelConfig,
  env: NodeJS.ProcessEnv,
): GatewayModelConfig {
  const apiKey = value.api_key_env ? env[value.api_key_env] : undefined;

  if (!apiKey) {
    throw new Error(
      `Missing API key for model ${value.name} from environment variable ${value.api_key_env}.`,
    );
  }

  return {
    name: value.name,
    upstreamModel: value.upstream_model ?? value.name,
    baseUrl: normalizeBaseUrl(value.base_url),
    apiKey,
    apiKeyEnv: value.api_key_env!,
    ownedBy: value.owned_by,
    created: value.created ?? getCurrentTimestamp(),
    supportsTools: value.supports_tools,
    supportsStreaming: value.supports_streaming,
    unknownFieldMode: value.unknown_field_mode,
    unknownFieldWindowRequests: value.unknown_field_window_requests,
    status: "active",
    statusReason: "Loaded from gateway.config.yaml",
    statusChangedAt: getCurrentTimestamp(),
  };
}

function resolveChainModelRef(
  ref: YamlChainModelEntry,
  modelsByName: Map<string, GatewayModelConfig>,
  chainTimeoutMs: number | undefined,
  chainMaxRetries: number | undefined,
  gatewayTimeoutMs: number,
  gatewayMaxRetries: number,
): ChainModelEntry {
  const name = typeof ref === "string" ? ref : ref.name;
  const modelConfig = modelsByName.get(name);

  if (!modelConfig) {
    throw new Error(
      `Model "${name}" referenced in a chain is not present in the configured model catalog.`,
    );
  }

  const modelOverride = typeof ref === "object" ? ref : undefined;
  const timeoutMs = modelOverride?.timeout_ms ?? chainTimeoutMs ?? gatewayTimeoutMs;
  const maxRetries = modelOverride?.max_retries ?? chainMaxRetries ?? gatewayMaxRetries;

  return { name, modelConfig, timeoutMs, maxRetries };
}

function validateModelChains(
  chains: YamlModelChainEntry[],
  modelNames: Set<string>,
  copilotPrefixes: string[],
): void {
  const chainNames = new Set<string>();

  for (const chain of chains) {
    // No duplicate chain names
    if (chainNames.has(chain.name)) {
      throw new Error(
        `Duplicate chain name "${chain.name}" in model_chains. Chain names must be unique.`,
      );
    }
    chainNames.add(chain.name);

    // No chain name matching a model name
    if (modelNames.has(chain.name)) {
      throw new Error(
        `Chain name "${chain.name}" conflicts with a configured model name. Chain names must not match any model name in the catalog.`,
      );
    }

    // No chain-<name> matching a model name
    const chainIdentifier = `chain-${chain.name}`;
    if (modelNames.has(chainIdentifier)) {
      throw new Error(
        `Chain identifier "${chainIdentifier}" conflicts with a configured model name. The chain name "${chain.name}" would produce a "chain-${chain.name}" identifier that matches an existing model.`,
      );
    }

    // Validate each model reference in the chain
    for (const ref of chain.models) {
      const name = typeof ref === "string" ? ref : ref.name;

      // No chain nesting: model references must not start with "chain-"
      if (name.startsWith("chain-")) {
        throw new Error(
          `Model reference "${name}" in chain "${chain.name}" starts with "chain-". Chain nesting is not supported.`,
        );
      }

      // No copilot-proxy models in chains
      if (copilotPrefixes.some((prefix) => name.startsWith(prefix))) {
        throw new Error(
          `Model reference "${name}" in chain "${chain.name}" uses a Copilot-proxy prefix. Copilot-proxied models cannot be used in chains.`,
        );
      }

      // All model references must exist in the models catalog
      if (!modelNames.has(name)) {
        throw new Error(
          `Model "${name}" referenced in chain "${chain.name}" is not present in the configured model catalog.`,
        );
      }
    }
  }
}

function loadYamlConfig(
  configPath: string,
  env: NodeJS.ProcessEnv,
): { models: GatewayModelConfig[]; modelChains: ModelChainConfig[]; upstreamBaseUrl: string; defaultModel?: string; requestTimeoutMs: number; maxRetries: number; maxBodySizeKb: number; gatewayAuthToken?: string; gatewayAuthTokenEnv?: string; healthProbeEnabled: boolean; corsOrigin?: string | string[]; copilotProxy: CopilotProxyConfig } {
  let rawContent: string;
  try {
    rawContent = readFileSync(resolve(configPath), "utf8");
  } catch (error) {
    throw new Error(
      `Failed to read GATEWAY_CONFIG_PATH at ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let parsedYaml: unknown;
  try {
    parsedYaml = parseYaml(rawContent);
  } catch (error) {
    throw new Error(
      `Failed to parse GATEWAY_CONFIG_PATH at ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const parsed = yamlGatewaySchema.parse(parsedYaml);
  const models = parsed.models.map((model) => normalizeModelEntry(model, env));
  const defaultModel = parsed.default_model;

  // Build lookup structures for cross-field validation
  const modelNames = new Set(models.map((m) => m.name));
  const modelsByName = new Map(models.map((m) => [m.name, m]));

  // Validate model_chains cross-field rules
  const rawChains = parsed.model_chains ?? [];
  validateModelChains(rawChains, modelNames, parsed.copilot_proxy_allowed_prefixes);

  // Support chain-<name> as a valid default_model value
  const chainNames = new Set(rawChains.map((c) => c.name));
  if (defaultModel) {
    const isPlainModel = modelNames.has(defaultModel);
    const isChainRef = defaultModel.startsWith("chain-") && chainNames.has(defaultModel.slice("chain-".length));
    if (!isPlainModel && !isChainRef) {
      throw new Error(
        `default_model "${defaultModel}" is not present in the configured model catalog or model chains.`,
      );
    }
  }

  // Resolve chain entries to full ModelChainConfig objects
  const modelChains: ModelChainConfig[] = rawChains.map((chain) => {
    const chainModels = chain.models.map((ref) =>
      resolveChainModelRef(
        ref,
        modelsByName,
        chain.timeout_ms,
        chain.max_retries,
        parsed.request_timeout_ms,
        parsed.max_retries,
      ),
    );
    const activeCount = chainModels.filter((m) => m.modelConfig.status === "active").length;
    const totalCount = chainModels.length;
    const chainStatus: "active" | "degraded" | "inactive" =
      activeCount === totalCount ? "active" :
      activeCount === 0 ? "inactive" : "degraded";
    const chainStatusReason =
      activeCount === totalCount ? "All models active" :
      activeCount === 0 ? "All models inactive" :
      `${totalCount - activeCount} of ${totalCount} models inactive`;

    const result: ModelChainConfig = {
      name: chain.name,
      models: chainModels,
      timeoutMs: chain.timeout_ms ?? parsed.request_timeout_ms,
      maxRetries: chain.max_retries ?? parsed.max_retries,
      status: chainStatus,
      statusReason: chainStatusReason,
      statusChangedAt: getCurrentTimestamp(),
      activeModels: activeCount,
      totalModels: totalCount,
    };
    if (chain.chain_timeout_ms !== undefined) {
      result.chainTimeoutMs = chain.chain_timeout_ms;
    }
    return result;
  });

  const config: { models: GatewayModelConfig[]; modelChains: ModelChainConfig[]; upstreamBaseUrl: string; defaultModel?: string; requestTimeoutMs: number; maxRetries: number; maxBodySizeKb: number; gatewayAuthToken?: string; gatewayAuthTokenEnv?: string; healthProbeEnabled: boolean; corsOrigin?: string | string[]; copilotProxy: CopilotProxyConfig } = {
    models,
    modelChains,
    upstreamBaseUrl: models[0]!.baseUrl,
    requestTimeoutMs: parsed.request_timeout_ms,
    maxRetries: parsed.max_retries,
    maxBodySizeKb: parsed.max_body_size_kb,
    healthProbeEnabled: parsed.health_probe_enabled,
    copilotProxy: {
      enabled: parsed.copilot_proxy_enabled,
      requireTokenAuth: parsed.copilot_proxy_require_token_auth,
      tokenTtlSeconds: parsed.copilot_proxy_token_ttl_seconds,
      heartbeatIntervalMs: parsed.copilot_proxy_heartbeat_interval_ms,
      heartbeatTimeoutMs: parsed.copilot_proxy_heartbeat_timeout_ms,
      maxInflightPerConnection: parsed.copilot_proxy_max_inflight_per_connection,
      allowedPrefixes: parsed.copilot_proxy_allowed_prefixes,
    },
  };

  if (parsed.gateway_auth_token_env) {
    const token = env[parsed.gateway_auth_token_env];
    if (token) {
      config.gatewayAuthToken = token;
    }
    config.gatewayAuthTokenEnv = parsed.gateway_auth_token_env;
  }

  if (parsed.cors_origin) {
    config.corsOrigin = parsed.cors_origin;
  }

  if (defaultModel) {
    config.defaultModel = defaultModel;
  }

  return config;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);

  // Open the database and run migrations before any data access.
  const db = openDatabase(env);
  runMigrations(db, allMigrations);

  // If the database is empty, parse and validate the YAML config, then seed.
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM models").get() as unknown as { cnt: number };

  if (row.cnt === 0) {
    const yamlSource = loadYamlConfig(parsed.GATEWAY_CONFIG_PATH, env);
    const yamlConfig: AppConfig = {
      host: parsed.HOST,
      port: parsed.PORT,
      logLevel: parsed.LOG_LEVEL,
      upstreamBaseUrl: yamlSource.upstreamBaseUrl,
      requestTimeoutMs: yamlSource.requestTimeoutMs,
      maxRetries: yamlSource.maxRetries,
      maxBodySizeKb: yamlSource.maxBodySizeKb,
      healthProbeEnabled: yamlSource.healthProbeEnabled,
      copilotProxy: yamlSource.copilotProxy,
      models: yamlSource.models,
      modelChains: yamlSource.modelChains,
    };

    if (yamlSource.defaultModel) {
      yamlConfig.defaultModel = yamlSource.defaultModel;
    }
    if (yamlSource.gatewayAuthToken) {
      yamlConfig.gatewayAuthToken = yamlSource.gatewayAuthToken;
    }
    if (yamlSource.gatewayAuthTokenEnv) {
      yamlConfig.gatewayAuthTokenEnv = yamlSource.gatewayAuthTokenEnv;
    }
    if (yamlSource.corsOrigin) {
      yamlConfig.corsOrigin = yamlSource.corsOrigin;
    }

    try {
      seedFromConfig(yamlConfig);
    } catch (error) {
      console.error(
        `[seed] Seeding failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  }

  // Load AppConfig from the database (the source of truth after seeding).
  return loadConfigFromDatabase(parsed, env);
}

/**
 * Build an `AppConfig` by reading from the database.
 *
 * Models, chains, and gateway settings are loaded via the repository layer.
 * API keys are resolved from the environment at runtime using the `api_key_env`
 * column — they are never stored in the database.
 */
function loadConfigFromDatabase(
  parsed: { HOST: string; PORT: number; LOG_LEVEL: string },
  env: NodeJS.ProcessEnv,
): AppConfig {
  // --- Load models from database ---
  const modelRows = getAllModels();
  const models: GatewayModelConfig[] = modelRows.map((row) => {
    // Copilot-proxy models use the Copilot extension's authentication at
    // request time — they have no static API key to resolve from the env.
    const isCopilotProxy = row.source === "copilot-proxy";
    const apiKey = isCopilotProxy ? undefined : resolveApiKey(row.api_key_env, row.name, env);
    return {
      name: row.name,
      upstreamModel: row.upstream_model,
      baseUrl: normalizeBaseUrl(row.base_url),
      apiKey,
      apiKeyEnv: isCopilotProxy ? "" : row.api_key_env,
      ownedBy: row.owned_by,
      created: row.created,
      supportsTools: row.supports_tools === 1,
      supportsStreaming: row.supports_streaming === 1,
      unknownFieldMode: row.unknown_field_mode as "warn" | "enforce",
      unknownFieldWindowRequests: row.unknown_field_window_requests,
      status: row.status,
      statusReason: row.status_reason,
      statusChangedAt: row.status_changed_at,
    };
  });

  const modelsByName = new Map(models.map((m) => [m.name, m]));

  // --- Load chains from database ---
  const chainRows = getAllChains();
  const modelChains: ModelChainConfig[] = chainRows.map((chainRow) => {
    const chainModelRows = getChainModels(chainRow.name);
    const chainModelEntries: ChainModelEntry[] = chainModelRows.map((cm) => {
      const modelConfig = modelsByName.get(cm.model_name);
      if (!modelConfig) {
        throw new Error(
          `Model "${cm.model_name}" referenced in chain "${chainRow.name}" is not present in the model catalog.`,
        );
      }
      return {
        name: cm.model_name,
        modelConfig,
        timeoutMs: cm.timeout_ms ?? chainRow.timeout_ms,
        maxRetries: cm.max_retries ?? chainRow.max_retries,
      };
    });

    const activeCount = chainModelEntries.filter((m) => m.modelConfig.status === "active").length;
    const totalCount = chainModelEntries.length;

    const result: ModelChainConfig = {
      name: chainRow.name,
      models: chainModelEntries,
      timeoutMs: chainRow.timeout_ms,
      maxRetries: chainRow.max_retries,
      status: chainRow.status,
      statusReason: chainRow.status_reason,
      statusChangedAt: chainRow.status_changed_at,
      activeModels: activeCount,
      totalModels: totalCount,
    };

    if (chainRow.chain_timeout_ms !== null) {
      result.chainTimeoutMs = chainRow.chain_timeout_ms;
    }

    return result;
  });

  // --- Load gateway config from database ---
  const gatewayRow = getGatewayConfig();
  if (!gatewayRow) {
    throw new Error("Gateway config row not found in database. The database may not have been seeded.");
  }

  // Resolve gateway auth token from environment
  let gatewayAuthToken: string | undefined;
  let gatewayAuthTokenEnv: string | undefined;
  if (gatewayRow.gateway_auth_token_env) {
    const token = env[gatewayRow.gateway_auth_token_env];
    if (token) {
      gatewayAuthToken = token;
    }
    gatewayAuthTokenEnv = gatewayRow.gateway_auth_token_env;
  }

  // Parse cors_origin from database (may be JSON array or plain string)
  let corsOrigin: string | string[] | undefined;
  if (gatewayRow.cors_origin) {
    try {
      const parsed = JSON.parse(gatewayRow.cors_origin);
      corsOrigin = Array.isArray(parsed) ? parsed : gatewayRow.cors_origin;
    } catch {
      corsOrigin = gatewayRow.cors_origin;
    }
  }

  // Parse copilot proxy allowed prefixes from JSON
  let allowedPrefixes: string[] = ["copilot-"];
  try {
    allowedPrefixes = JSON.parse(gatewayRow.copilot_proxy_allowed_prefixes);
  } catch {
    // Fall back to default
  }

  const copilotProxy: CopilotProxyConfig = {
    enabled: gatewayRow.copilot_proxy_enabled === 1,
    requireTokenAuth: gatewayRow.copilot_proxy_require_token_auth === 1,
    tokenTtlSeconds: gatewayRow.copilot_proxy_token_ttl_seconds,
    heartbeatIntervalMs: gatewayRow.copilot_proxy_heartbeat_interval_ms,
    heartbeatTimeoutMs: gatewayRow.copilot_proxy_heartbeat_timeout_ms,
    maxInflightPerConnection: gatewayRow.copilot_proxy_max_inflight_per_connection,
    allowedPrefixes,
  };

  // Determine upstream base URL: prefer the default model, then the first
  // model by creation timestamp (closest to insertion order), then any model.
  let upstreamBaseUrl = "";
  if (gatewayRow.default_model) {
    const defaultModel = modelsByName.get(gatewayRow.default_model);
    if (defaultModel) {
      upstreamBaseUrl = defaultModel.baseUrl;
    }
  }
  if (!upstreamBaseUrl && models.length > 0) {
    const earliest = models.reduce((a, b) => (a.created < b.created ? a : b));
    upstreamBaseUrl = earliest.baseUrl;
  }

  const config: AppConfig = {
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL as AppConfig["logLevel"],
    upstreamBaseUrl,
    requestTimeoutMs: gatewayRow.request_timeout_ms,
    maxRetries: gatewayRow.max_retries,
    maxBodySizeKb: gatewayRow.max_body_size_kb,
    healthProbeEnabled: gatewayRow.health_probe_enabled === 1,
    copilotProxy,
    models,
    modelChains,
  };

  if (gatewayRow.default_model) {
    config.defaultModel = gatewayRow.default_model;
  }
  if (gatewayAuthToken) {
    config.gatewayAuthToken = gatewayAuthToken;
  }
  if (gatewayAuthTokenEnv) {
    config.gatewayAuthTokenEnv = gatewayAuthTokenEnv;
  }
  if (corsOrigin) {
    config.corsOrigin = corsOrigin;
  }

  return config;
}

/**
 * Resolve an API key from the environment using the `api_key_env` column value.
 * Throws if the environment variable is not set or empty.
 */
function resolveApiKey(apiKeyEnv: string, modelName: string, env: NodeJS.ProcessEnv): string {
  const apiKey = env[apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `Missing API key for model ${modelName} from environment variable ${apiKeyEnv}.`,
    );
  }
  return apiKey;
}

/**
 * Initialise the database and seed from the YAML config if the `models`
 * table is empty.
 *
 * This function is idempotent: on a fresh database it seeds all models,
 * chains, and the gateway config row; on an existing populated database
 * it is a no-op.
 *
 * Validation errors from the YAML config cause the process to exit with
 * code 1, matching the acceptance criteria.
 */
export function seedIfNeeded(config: AppConfig, env: NodeJS.ProcessEnv = process.env): void {
  const db = openDatabase(env);
  runMigrations(db, allMigrations);

  // Check if models table has any rows.
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM models").get() as unknown as { cnt: number };

  if (row.cnt === 0) {
    try {
      seedFromConfig(config);
    } catch (error) {
      console.error(
        `[seed] Seeding failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  } else {
    console.info("[seed] Database already populated — skipping seed");
  }
}
