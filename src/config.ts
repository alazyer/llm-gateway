import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config as loadDotenv } from "dotenv";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { ChainModelEntry, ModelChainConfig } from "./contracts.js";

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
  apiKey: string;
  ownedBy: string;
  created: number;
  supportsTools: boolean;
  supportsStreaming: boolean;
  unknownFieldMode: "warn" | "enforce";
  unknownFieldWindowRequests: number;
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
    ownedBy: value.owned_by,
    created: value.created ?? getCurrentTimestamp(),
    supportsTools: value.supports_tools,
    supportsStreaming: value.supports_streaming,
    unknownFieldMode: value.unknown_field_mode,
    unknownFieldWindowRequests: value.unknown_field_window_requests,
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
): { models: GatewayModelConfig[]; modelChains: ModelChainConfig[]; upstreamBaseUrl: string; defaultModel?: string; requestTimeoutMs: number; maxRetries: number; maxBodySizeKb: number; gatewayAuthToken?: string; healthProbeEnabled: boolean; corsOrigin?: string | string[]; copilotProxy: CopilotProxyConfig } {
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
    const result: ModelChainConfig = {
      name: chain.name,
      models: chain.models.map((ref) =>
        resolveChainModelRef(
          ref,
          modelsByName,
          chain.timeout_ms,
          chain.max_retries,
          parsed.request_timeout_ms,
          parsed.max_retries,
        ),
      ),
      timeoutMs: chain.timeout_ms ?? parsed.request_timeout_ms,
      maxRetries: chain.max_retries ?? parsed.max_retries,
    };
    if (chain.chain_timeout_ms !== undefined) {
      result.chainTimeoutMs = chain.chain_timeout_ms;
    }
    return result;
  });

  const config: { models: GatewayModelConfig[]; modelChains: ModelChainConfig[]; upstreamBaseUrl: string; defaultModel?: string; requestTimeoutMs: number; maxRetries: number; maxBodySizeKb: number; gatewayAuthToken?: string; healthProbeEnabled: boolean; corsOrigin?: string | string[]; copilotProxy: CopilotProxyConfig } = {
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
  const configSource = loadYamlConfig(parsed.GATEWAY_CONFIG_PATH, env);

  const config: AppConfig = {
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    upstreamBaseUrl: configSource.upstreamBaseUrl,
    requestTimeoutMs: configSource.requestTimeoutMs,
    maxRetries: configSource.maxRetries,
    maxBodySizeKb: configSource.maxBodySizeKb,
    healthProbeEnabled: configSource.healthProbeEnabled,
    copilotProxy: configSource.copilotProxy,
    models: configSource.models,
    modelChains: configSource.modelChains,
  };

  if (configSource.defaultModel) {
    config.defaultModel = configSource.defaultModel;
  }

  if (configSource.gatewayAuthToken) {
    config.gatewayAuthToken = configSource.gatewayAuthToken;
  }

  if (configSource.corsOrigin) {
    config.corsOrigin = configSource.corsOrigin;
  }

  return config;
}
