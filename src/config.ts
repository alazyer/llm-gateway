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
  GATEWAY_CONFIG_PATH: z.string().trim().min(1).optional(),
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
    input_modalities: z.array(z.enum(["text", "image", "audio", "video"])).default(["text"]),
    output_modalities: z.array(z.enum(["text", "image"])).default(["text"]),
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

const yamlChainModelRefSchema = z.union([
  z.string().trim().min(1),
  z.object({
    name: z.string().trim().min(1),
    timeout_ms: z.coerce.number().int().positive().optional(),
    max_retries: z.coerce.number().int().nonnegative().optional(),
  }),
]);

const yamlModelChainSchema = z.object({
  name: z.string().trim().min(1),
  timeout_ms: z.coerce.number().int().positive().optional(),
  max_retries: z.coerce.number().int().nonnegative().optional(),
  chain_timeout_ms: z.coerce.number().int().positive().optional(),
  models: z.array(yamlChainModelRefSchema).min(1),
});

const yamlGatewaySchema = z.object({
  default_model: z.string().trim().min(1).optional(),
  request_timeout_ms: z.coerce.number().int().positive().default(30000),
  max_retries: z.coerce.number().int().nonnegative().default(0),
  max_body_size_kb: z.coerce.number().int().positive().default(1024),
  gateway_auth_token_env: z.string().trim().min(1).optional(),
  health_probe_enabled: z.boolean().default(false),
  cors_origin: z.union([z.string(), z.array(z.string())]).optional(),
  workspace_enabled: z.boolean().default(false),
  copilot_proxy_enabled: z.boolean().default(false),
  copilot_proxy_require_token_auth: z.boolean().default(true),
  copilot_proxy_token_ttl_seconds: z.coerce.number().int().positive().default(86400),
  copilot_proxy_heartbeat_interval_ms: z.coerce.number().int().positive().default(30000),
  copilot_proxy_heartbeat_timeout_ms: z.coerce.number().int().positive().default(10000),
  copilot_proxy_max_inflight_per_connection: z.coerce.number().int().positive().default(4),
  copilot_proxy_allowed_prefixes: z.array(z.string().trim().min(1)).default(["copilot-"]),
  models: z.array(yamlModelSchema).min(1).optional(),
  model_chains: z.array(yamlModelChainSchema).optional(),
});

/**
 * Modalities a model can accept as input or produce as output. Stored in the
 * `models` table as a comma-joined TEXT column (e.g. `"text,image"`) and parsed
 * back via {@link parseInputModalities} / {@link parseOutputModalities}.
 *
 * `text` is always present in a well-formed record — helpers guarantee it.
 */
export type InputModality = "text" | "image" | "audio" | "video";
export type OutputModality = "text" | "image";

const INPUT_MODALITY_VALUES: readonly InputModality[] = ["text", "image", "audio", "video"];
const OUTPUT_MODALITY_VALUES: readonly OutputModality[] = ["text", "image"];

/**
 * Parse a comma-joined modality string (as stored in the DB) into a validated
 * `InputModality[]`. Unknown entries are dropped. `text` is always present in
 * the result — a model must accept text input.
 */
export function parseInputModalities(raw: string | null | undefined): InputModality[] {
  return parseModalities(raw, INPUT_MODALITY_VALUES);
}

/**
 * Parse a comma-joined modality string into a validated `OutputModality[]`.
 * `text` is always present in the result.
 */
export function parseOutputModalities(raw: string | null | undefined): OutputModality[] {
  return parseModalities(raw, OUTPUT_MODALITY_VALUES);
}

function parseModalities<T extends string>(
  raw: string | null | undefined,
  allowed: readonly T[],
): T[] {
  const text = firstModality(allowed);
  if (!raw) {
    return [text];
  }
  const seen = new Set<T>();
  for (const token of raw.split(",")) {
    const value = token.trim() as T;
    if (allowed.includes(value) && !seen.has(value)) {
      seen.add(value);
    }
  }
  if (!seen.has(text)) {
    seen.add(text);
  }
  // Preserve declared order but keep `text` first for stable serialization.
  const ordered = allowed.filter((value) => seen.has(value));
  return ordered.length > 0 ? ordered : [text];
}

/** Join a modality array into the comma-joined TEXT form stored in the DB. */
export function joinModalities(modalities: readonly string[]): string {
  return modalities.join(",");
}

/**
 * Coerce a request-body modality value (array from JSON) into the
 * comma-joined TEXT form stored in the DB, dropping unknown tokens and
 * guaranteeing `text` is present. Returns `null` when `declared` is `null`
 * so callers can distinguish "unset" from "explicitly text-only".
 */
export function coerceInputModalities(declared: readonly string[] | null): string | null {
  return coerceModalities(declared, INPUT_MODALITY_VALUES);
}

export function coerceOutputModalities(declared: readonly string[] | null): string | null {
  return coerceModalities(declared, OUTPUT_MODALITY_VALUES);
}

function coerceModalities<T extends string>(
  declared: readonly T[] | null,
  allowed: readonly T[],
): string | null {
  if (declared === null) {
    return null;
  }
  return joinModalities(normalizeModalities(declared, allowed));
}

/**
 * Normalize a declared modality list (from YAML or admin request body) into a
 * deduplicated, ordered array with `text` guaranteed present. Mirrors the
 * guarantees of {@link parseInputModalities} / {@link parseOutputModalities}
 * but works on already-validated arrays.
 */
function normalizeModalities<T extends string>(
  declared: readonly T[],
  allowed: readonly T[],
): T[] {
  const text = firstModality(allowed);
  const seen = new Set<T>();
  for (const value of declared) {
    if (allowed.includes(value) && !seen.has(value)) {
      seen.add(value);
    }
  }
  if (!seen.has(text)) {
    seen.add(text);
  }
  return allowed.filter((value) => seen.has(value));
}

/** The first element of a non-empty allowed-modality list (`text`). */
function firstModality<T>(allowed: readonly T[]): T {
  const first = allowed[0];
  if (first === undefined) {
    throw new Error("modality allowed list must be non-empty");
  }
  return first;
}

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
  inputModalities: InputModality[];
  outputModalities: OutputModality[];
  unknownFieldMode: "warn" | "enforce";
  unknownFieldWindowRequests: number;
  status: "active" | "inactive";
  statusReason: string | null;
  statusChangedAt: number | null;
}

export interface WorkspaceConfig {
  enabled: boolean;
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
  workspace: WorkspaceConfig;
  copilotProxy?: CopilotProxyConfig;
  models: GatewayModelConfig[];
  modelChains: ModelChainConfig[];
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

export interface ConfigSourcePresence {
  missingModels: boolean;
  missingModelChains: boolean;
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
type YamlChainModelRef = z.infer<typeof yamlChainModelRefSchema>;
type YamlModelChainConfig = z.infer<typeof yamlModelChainSchema>;

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
  const apiKeyEnv = value.api_key_env;
  const apiKey = apiKeyEnv ? env[apiKeyEnv] : undefined;

  if (!apiKeyEnv || !apiKey) {
    throw new Error(
      `Missing API key for model ${value.name} from environment variable ${value.api_key_env}.`,
    );
  }

  return {
    name: value.name,
    upstreamModel: value.upstream_model ?? value.name,
    baseUrl: normalizeBaseUrl(value.base_url),
    apiKey,
    apiKeyEnv,
    ownedBy: value.owned_by,
    created: value.created ?? getCurrentTimestamp(),
    supportsTools: value.supports_tools,
    supportsStreaming: value.supports_streaming,
    inputModalities: normalizeModalities(value.input_modalities, INPUT_MODALITY_VALUES),
    outputModalities: normalizeModalities(value.output_modalities, OUTPUT_MODALITY_VALUES),
    unknownFieldMode: value.unknown_field_mode,
    unknownFieldWindowRequests: value.unknown_field_window_requests,
    status: "active",
    statusReason: "Configured from gateway config.",
    statusChangedAt: getCurrentTimestamp(),
  };
}

function getChainModelName(value: YamlChainModelRef): string {
  return typeof value === "string" ? value : value.name;
}

function isCopilotProxyModelReference(modelName: string, allowedPrefixes: readonly string[]): boolean {
  return allowedPrefixes.some((prefix) => modelName.startsWith(prefix));
}

function normalizeChainModelEntry(
  value: YamlChainModelRef,
  chainName: string,
  modelByName: ReadonlyMap<string, GatewayModelConfig>,
  chainTimeoutMs: number,
  chainMaxRetries: number,
  allowedPrefixes: readonly string[],
): ChainModelEntry {
  const name = getChainModelName(value);

  if (name.startsWith("chain-")) {
    throw new Error(`Chain nesting is not supported: model reference "${name}" in chain "${chainName}".`);
  }

  if (isCopilotProxyModelReference(name, allowedPrefixes)) {
    throw new Error(`Copilot-proxied models cannot be used in chains: "${name}" in chain "${chainName}".`);
  }

  const modelConfig = modelByName.get(name);
  if (!modelConfig) {
    throw new Error(`Model reference "${name}" in chain "${chainName}" is not present in the configured model catalog.`);
  }

  return {
    name,
    modelConfig,
    timeoutMs: typeof value === "string" ? chainTimeoutMs : value.timeout_ms ?? chainTimeoutMs,
    maxRetries: typeof value === "string" ? chainMaxRetries : value.max_retries ?? chainMaxRetries,
  };
}

function normalizeModelChains(
  values: YamlModelChainConfig[],
  models: GatewayModelConfig[],
  requestTimeoutMs: number,
  maxRetries: number,
  allowedPrefixes: readonly string[],
): ModelChainConfig[] {
  const modelByName = new Map(models.map((model) => [model.name, model]));
  const chainNames = new Set<string>();
  const chains: ModelChainConfig[] = [];

  for (const value of values) {
    if (chainNames.has(value.name)) {
      throw new Error(`Duplicate chain name "${value.name}".`);
    }
    chainNames.add(value.name);

    if (modelByName.has(value.name)) {
      throw new Error(`Chain name "${value.name}" conflicts with a configured model name.`);
    }

    const chainIdentifier = `chain-${value.name}`;
    if (modelByName.has(chainIdentifier)) {
      throw new Error(`Chain identifier "${chainIdentifier}" conflicts with a configured model name.`);
    }

    const chainTimeoutMs = value.timeout_ms ?? requestTimeoutMs;
    const chainMaxRetries = value.max_retries ?? maxRetries;
    const entries = value.models.map((modelRef) =>
      normalizeChainModelEntry(
        modelRef,
        value.name,
        modelByName,
        chainTimeoutMs,
        chainMaxRetries,
        allowedPrefixes,
      ),
    );
    const activeModels = entries.filter((entry) => entry.modelConfig.status === "active").length;
    const chain: ModelChainConfig = {
      name: value.name,
      models: entries,
      timeoutMs: chainTimeoutMs,
      maxRetries: chainMaxRetries,
      status: activeModels === entries.length ? "active" : activeModels > 0 ? "degraded" : "inactive",
      statusReason: "Configured from gateway config.",
      statusChangedAt: getCurrentTimestamp(),
      activeModels,
      totalModels: entries.length,
    };

    if (value.chain_timeout_ms !== undefined) {
      chain.chainTimeoutMs = value.chain_timeout_ms;
    }

    chains.push(chain);
  }

  return chains.sort((left, right) => left.name.localeCompare(right.name));
}

function loadYamlConfig(
  configPath: string,
  env: NodeJS.ProcessEnv,
): { models: GatewayModelConfig[]; modelChains: ModelChainConfig[]; upstreamBaseUrl?: string; defaultModel?: string; requestTimeoutMs: number; maxRetries: number; maxBodySizeKb: number; gatewayAuthToken?: string; gatewayAuthTokenEnv?: string; healthProbeEnabled: boolean; corsOrigin?: string | string[]; workspace: WorkspaceConfig; copilotProxy: CopilotProxyConfig; sourcePresence: ConfigSourcePresence } {
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

  const parsedRaw = (parsedYaml ?? {}) as Record<string, unknown>;
  const sourcePresence: ConfigSourcePresence = {
    missingModels: !Object.prototype.hasOwnProperty.call(parsedRaw, "models"),
    missingModelChains: !Object.prototype.hasOwnProperty.call(parsedRaw, "model_chains"),
  };

  const parsed = yamlGatewaySchema.parse(parsedYaml);
  const models = (parsed.models ?? []).map((model) => normalizeModelEntry(model, env));

  // If models are missing from YAML, defer chain loading to runtime DB fallback.
  // Chain normalization needs a model catalog and would fail eagerly here.
  const shouldDeferChainsToRuntime = sourcePresence.missingModels;
  if (shouldDeferChainsToRuntime) {
    sourcePresence.missingModelChains = true;
  }

  const modelChains = shouldDeferChainsToRuntime
    ? []
    : normalizeModelChains(
        parsed.model_chains ?? [],
        models,
        parsed.request_timeout_ms,
        parsed.max_retries,
        parsed.copilot_proxy_allowed_prefixes,
      );
  const defaultModel = parsed.default_model;

  const config: { models: GatewayModelConfig[]; modelChains: ModelChainConfig[]; upstreamBaseUrl?: string; defaultModel?: string; requestTimeoutMs: number; maxRetries: number; maxBodySizeKb: number; gatewayAuthToken?: string; gatewayAuthTokenEnv?: string; healthProbeEnabled: boolean; corsOrigin?: string | string[]; workspace: WorkspaceConfig; copilotProxy: CopilotProxyConfig; sourcePresence: ConfigSourcePresence } = {
    models,
    modelChains,
    requestTimeoutMs: parsed.request_timeout_ms,
    maxRetries: parsed.max_retries,
    maxBodySizeKb: parsed.max_body_size_kb,
    healthProbeEnabled: parsed.health_probe_enabled,
    workspace: {
      enabled: parsed.workspace_enabled,
    },
    copilotProxy: {
      enabled: parsed.copilot_proxy_enabled,
      requireTokenAuth: parsed.copilot_proxy_require_token_auth,
      tokenTtlSeconds: parsed.copilot_proxy_token_ttl_seconds,
      heartbeatIntervalMs: parsed.copilot_proxy_heartbeat_interval_ms,
      heartbeatTimeoutMs: parsed.copilot_proxy_heartbeat_timeout_ms,
      maxInflightPerConnection: parsed.copilot_proxy_max_inflight_per_connection,
      allowedPrefixes: parsed.copilot_proxy_allowed_prefixes,
    },
    sourcePresence,
  };

  if (models.length > 0) {
    config.upstreamBaseUrl = models[0]!.baseUrl;
  }

  if (parsed.gateway_auth_token_env) {
    config.gatewayAuthTokenEnv = parsed.gateway_auth_token_env;
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

export interface RuntimeConfigLoadResult {
  config: AppConfig;
  sourcePresence: ConfigSourcePresence;
}

export function loadConfigForRuntime(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeConfigLoadResult {
  const parsed = envSchema.parse(env);
  const config: AppConfig = {
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    upstreamBaseUrl: "",
    requestTimeoutMs: 30000,
    maxRetries: 0,
    maxBodySizeKb: 1024,
    healthProbeEnabled: false,
    workspace: { enabled: false },
    copilotProxy: DEFAULT_COPILOT_PROXY_CONFIG,
    models: [],
    modelChains: [],
  };

  return {
    config,
    sourcePresence: {
      missingModels: true,
      missingModelChains: true,
    },
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
      `default_model ${config.defaultModel} is not present in the configured model catalog or model chains.`,
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  if (!parsed.GATEWAY_CONFIG_PATH) {
    throw new Error("GATEWAY_CONFIG_PATH is required when loading YAML config.");
  }

  const configSource = loadYamlConfig(parsed.GATEWAY_CONFIG_PATH, env);
  const config: AppConfig = {
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    upstreamBaseUrl: configSource.upstreamBaseUrl ?? "",
    requestTimeoutMs: configSource.requestTimeoutMs,
    maxRetries: configSource.maxRetries,
    maxBodySizeKb: configSource.maxBodySizeKb,
    healthProbeEnabled: configSource.healthProbeEnabled,
    workspace: configSource.workspace,
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

  if (configSource.gatewayAuthTokenEnv) {
    config.gatewayAuthTokenEnv = configSource.gatewayAuthTokenEnv;
  }

  if (configSource.corsOrigin) {
    config.corsOrigin = configSource.corsOrigin;
  }

  if (config.models.length === 0) {
    throw new Error("Gateway config must include at least one model.");
  }

  if (!config.upstreamBaseUrl) {
    throw new Error("Gateway config must include a valid model base_url.");
  }

  validateDefaultModel(config);

  return config;
}
