import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config as loadDotenv } from "dotenv";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

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

const yamlGatewaySchema = z.object({
  default_model: z.string().trim().min(1).optional(),
  request_timeout_ms: z.coerce.number().int().positive().default(30000),
  max_retries: z.coerce.number().int().nonnegative().default(0),
  max_body_size_kb: z.coerce.number().int().positive().default(1024),
  gateway_auth_token_env: z.string().trim().min(1).optional(),
  health_probe_enabled: z.boolean().default(false),
  cors_origin: z.union([z.string(), z.array(z.string())]).optional(),
  models: z.array(yamlModelSchema).min(1),
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
  models: GatewayModelConfig[];
}

type YamlModelConfig = z.infer<typeof yamlModelSchema>;

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

function loadYamlConfig(
  configPath: string,
  env: NodeJS.ProcessEnv,
): { models: GatewayModelConfig[]; upstreamBaseUrl: string; defaultModel?: string; requestTimeoutMs: number; maxRetries: number; maxBodySizeKb: number; gatewayAuthToken?: string; healthProbeEnabled: boolean; corsOrigin?: string | string[] } {
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

  if (defaultModel && !models.some((model) => model.name === defaultModel)) {
    throw new Error(
      `default_model ${defaultModel} is not present in the configured model catalog.`,
    );
  }

  const config: { models: GatewayModelConfig[]; upstreamBaseUrl: string; defaultModel?: string; requestTimeoutMs: number; maxRetries: number; maxBodySizeKb: number; gatewayAuthToken?: string; healthProbeEnabled: boolean; corsOrigin?: string | string[] } = {
    models,
    upstreamBaseUrl: models[0]!.baseUrl,
    requestTimeoutMs: parsed.request_timeout_ms,
    maxRetries: parsed.max_retries,
    maxBodySizeKb: parsed.max_body_size_kb,
    healthProbeEnabled: parsed.health_probe_enabled,
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
    models: configSource.models,
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
