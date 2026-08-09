import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { loadConfig, loadConfigForRuntime } from "../src/config.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations/index.js";
import { allMigrations } from "../src/db/migrations/all.js";
import { seedFromConfig } from "../src/db/seed.js";
import { applyDatabaseFallbackConfig } from "../src/runtime-config.js";
import { insertModel } from "../src/db/repository.js";

let tempDir: string;

beforeEach(() => {
  closeDatabase();
  tempDir = mkdtempSync(join(tmpdir(), "llm-gateway-chain-config-"));
});

afterEach(() => {
  closeDatabase();
  rmSync(tempDir, { recursive: true, force: true });
});

function createTempConfig(yamlContent: string): { configPath: string; dbPath: string } {
  const configPath = join(tempDir, "gateway.config.yaml");
  const dbPath = join(tempDir, "gateway.db");
  writeFileSync(configPath, yamlContent, "utf8");
  return { configPath, dbPath };
}

const BASE_ENV = {
  HOST: "127.0.0.1",
  PORT: "4000",
  GLM_API_KEY: "api-key-a",
  CODER_API_KEY: "api-key-b",
  GPT_API_KEY: "api-key-c",
};

const FULL_CONFIG_YAML = `default_model: glm-5.1
request_timeout_ms: 30000
max_retries: 0
max_body_size_kb: 1024
health_probe_enabled: false
models:
  - name: glm-5.1
    base_url: https://provider-a.example/v1
    api_key_env: GLM_API_KEY
  - name: gpt-5
    base_url: https://provider-b.example/v1
    api_key_env: GPT_API_KEY
model_chains:
  - name: fallback
    models:
      - glm-5.1
      - gpt-5
`;

const TWO_MODELS_YAML = `models:
  - name: glm-5.1
    base_url: https://provider-a.example/v1
    api_key_env: GLM_API_KEY
  - name: gpt-5
    base_url: https://provider-b.example/v1
    api_key_env: GPT_API_KEY
`;

describe("model_chains config", () => {
  it("falls back to database models when YAML omits models", () => {
    const seedPath = join(tempDir, "seed-gateway.config.yaml");
    const fallbackPath = join(tempDir, "fallback-gateway.config.yaml");
    const dbPath = join(tempDir, "runtime-fallback.db");

    writeFileSync(seedPath, FULL_CONFIG_YAML, "utf8");
    writeFileSync(
      fallbackPath,
      `default_model: glm-5.1
request_timeout_ms: 30000
max_retries: 0
max_body_size_kb: 1024
health_probe_enabled: false
model_chains:
  - name: fallback
    models:
      - glm-5.1
      - gpt-5
`,
      "utf8",
    );

    const seeded = loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: seedPath, GATEWAY_DB_PATH: dbPath });

    openDatabase({ ...BASE_ENV, GATEWAY_DB_PATH: dbPath });
    runMigrations(openDatabase({ ...BASE_ENV, GATEWAY_DB_PATH: dbPath }), allMigrations);
    seedFromConfig(seeded);

    const runtimeLoaded = loadConfigForRuntime({
      ...BASE_ENV,
      GATEWAY_CONFIG_PATH: fallbackPath,
      GATEWAY_DB_PATH: dbPath,
    });

    const config = applyDatabaseFallbackConfig(runtimeLoaded.config, runtimeLoaded.sourcePresence, {
      ...BASE_ENV,
      GATEWAY_DB_PATH: dbPath,
    });

    expect(config.models).toHaveLength(2);
    expect(config.models.map((model) => model.name).sort()).toEqual(["glm-5.1", "gpt-5"]);
    expect(config.upstreamBaseUrl).toBe("https://provider-a.example/v1");
  });

  it("ignores copilot-proxy rows when models fallback reads persisted catalog", () => {
    const seedPath = join(tempDir, "seed-gateway.config.yaml");
    const fallbackPath = join(tempDir, "fallback-gateway.config.yaml");
    const dbPath = join(tempDir, "runtime-fallback.db");

    writeFileSync(seedPath, FULL_CONFIG_YAML, "utf8");
    writeFileSync(
      fallbackPath,
      `default_model: glm-5.1
request_timeout_ms: 30000
max_retries: 0
max_body_size_kb: 1024
health_probe_enabled: false
model_chains:
  - name: fallback
    models:
      - glm-5.1
      - gpt-5
`,
      "utf8",
    );

    const seeded = loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: seedPath, GATEWAY_DB_PATH: dbPath });

    const db = openDatabase({ ...BASE_ENV, GATEWAY_DB_PATH: dbPath });
    runMigrations(db, allMigrations);
    seedFromConfig(seeded);

    insertModel({
      name: "u0047928-auto",
      upstream_model: "u0047928-auto",
      base_url: "",
      api_key_env: "",
      owned_by: "copilot-proxy",
      created: 1_718_000_111,
      supports_tools: 1,
      supports_streaming: 1,
      unknown_field_mode: "warn",
      unknown_field_window_requests: 100,
      source: "copilot-proxy",
      source_prefix: "copilot-",
      connection_id: "conn-1",
      status: "active",
      status_reason: "Copilot proxy registered",
      status_changed_at: 1_718_000_111,
      capabilities_json: null,
      updated_at: 1_718_000_111,
    });

    const runtimeLoaded = loadConfigForRuntime({
      ...BASE_ENV,
      GATEWAY_CONFIG_PATH: fallbackPath,
      GATEWAY_DB_PATH: dbPath,
    });

    const config = applyDatabaseFallbackConfig(runtimeLoaded.config, runtimeLoaded.sourcePresence, {
      ...BASE_ENV,
      GATEWAY_DB_PATH: dbPath,
    });

    expect(config.models).toHaveLength(2);
    expect(config.models.map((model) => model.name).sort()).toEqual(["glm-5.1", "gpt-5"]);
  });

  it("falls back to database model_chains when YAML omits model_chains", () => {
    const seedPath = join(tempDir, "seed-gateway.config.yaml");
    const fallbackPath = join(tempDir, "fallback-gateway.config.yaml");
    const dbPath = join(tempDir, "runtime-fallback.db");

    writeFileSync(seedPath, FULL_CONFIG_YAML, "utf8");
    writeFileSync(
      fallbackPath,
      `default_model: glm-5.1
request_timeout_ms: 30000
max_retries: 0
max_body_size_kb: 1024
health_probe_enabled: false
models:
  - name: glm-5.1
    base_url: https://provider-a.example/v1
    api_key_env: GLM_API_KEY
  - name: gpt-5
    base_url: https://provider-b.example/v1
    api_key_env: GPT_API_KEY
`,
      "utf8",
    );

    const seeded = loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: seedPath, GATEWAY_DB_PATH: dbPath });

    openDatabase({ ...BASE_ENV, GATEWAY_DB_PATH: dbPath });
    runMigrations(openDatabase({ ...BASE_ENV, GATEWAY_DB_PATH: dbPath }), allMigrations);
    seedFromConfig(seeded);

    const runtimeLoaded = loadConfigForRuntime({
      ...BASE_ENV,
      GATEWAY_CONFIG_PATH: fallbackPath,
      GATEWAY_DB_PATH: dbPath,
    });

    const config = applyDatabaseFallbackConfig(runtimeLoaded.config, runtimeLoaded.sourcePresence, {
      ...BASE_ENV,
      GATEWAY_DB_PATH: dbPath,
    });

    expect(config.modelChains).toHaveLength(1);
    expect(config.modelChains[0]!.name).toBe("fallback");
    expect(config.modelChains[0]!.models.map((model) => model.name)).toEqual(["glm-5.1", "gpt-5"]);
  });

  it("loads config with no model_chains section (backward compatible)", () => {
    const { configPath, dbPath } = createTempConfig(TWO_MODELS_YAML);
          const config = loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath });
      expect(config.modelChains).toEqual([]);
  });

  it("loads config with empty model_chains array", () => {
    const { configPath, dbPath } = createTempConfig(
      `model_chains: []
${TWO_MODELS_YAML}`,
    );
          const config = loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath });
      expect(config.modelChains).toEqual([]);
  });

  it("loads a valid chain with simple string model references", () => {
    const { configPath, dbPath } = createTempConfig(
      `model_chains:
  - name: production
    models:
      - gpt-5
      - glm-5.1
${TWO_MODELS_YAML}`,
    );
          const config = loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath });
      expect(config.modelChains).toHaveLength(1);
      const chain = config.modelChains[0]!;
      expect(chain.name).toBe("production");
      expect(chain.models).toHaveLength(2);
      expect(chain.models[0]!.name).toBe("gpt-5");
      expect(chain.models[1]!.name).toBe("glm-5.1");
      expect(chain.timeoutMs).toBe(30000); // gateway default
      expect(chain.maxRetries).toBe(0); // gateway default
      expect(chain.chainTimeoutMs).toBeUndefined();
  });

  it("loads a chain with object model references with overrides", () => {
    const { configPath, dbPath } = createTempConfig(
      `model_chains:
  - name: production
    models:
      - name: gpt-5
        timeout_ms: 60000
        max_retries: 2
      - glm-5.1
${TWO_MODELS_YAML}`,
    );
          const config = loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath });
      const chain = config.modelChains[0]!;
      expect(chain.models[0]!.name).toBe("gpt-5");
      expect(chain.models[0]!.timeoutMs).toBe(60000);
      expect(chain.models[0]!.maxRetries).toBe(2);
      expect(chain.models[1]!.name).toBe("glm-5.1");
      expect(chain.models[1]!.timeoutMs).toBe(30000); // gateway default
      expect(chain.models[1]!.maxRetries).toBe(0); // gateway default
  });

  it("resolves chain-level timeout_ms and max_retries as defaults for models", () => {
    const { configPath, dbPath } = createTempConfig(
      `model_chains:
  - name: production
    timeout_ms: 45000
    max_retries: 1
    models:
      - gpt-5
      - glm-5.1
${TWO_MODELS_YAML}`,
    );
          const config = loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath });
      const chain = config.modelChains[0]!;
      expect(chain.timeoutMs).toBe(45000);
      expect(chain.maxRetries).toBe(1);
      expect(chain.models[0]!.timeoutMs).toBe(45000);
      expect(chain.models[0]!.maxRetries).toBe(1);
      expect(chain.models[1]!.timeoutMs).toBe(45000);
      expect(chain.models[1]!.maxRetries).toBe(1);
  });

  it("applies per-model overrides over chain-level defaults", () => {
    const { configPath, dbPath } = createTempConfig(
      `model_chains:
  - name: production
    timeout_ms: 45000
    max_retries: 1
    models:
      - name: gpt-5
        timeout_ms: 60000
        max_retries: 3
      - glm-5.1
${TWO_MODELS_YAML}`,
    );
          const config = loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath });
      const chain = config.modelChains[0]!;
      expect(chain.models[0]!.timeoutMs).toBe(60000); // model override
      expect(chain.models[0]!.maxRetries).toBe(3); // model override
      expect(chain.models[1]!.timeoutMs).toBe(45000); // chain default
      expect(chain.models[1]!.maxRetries).toBe(1); // chain default
  });

  it("loads chain_timeout_ms when specified", () => {
    const { configPath, dbPath } = createTempConfig(
      `model_chains:
  - name: production
    chain_timeout_ms: 90000
    models:
      - gpt-5
${TWO_MODELS_YAML}`,
    );
          const config = loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath });
      expect(config.modelChains[0]!.chainTimeoutMs).toBe(90000);
  });

  it("resolves model name references to full GatewayModelConfig objects", () => {
    const { configPath, dbPath } = createTempConfig(
      `model_chains:
  - name: production
    models:
      - glm-5.1
${TWO_MODELS_YAML}`,
    );
          const config = loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath });
      const entry = config.modelChains[0]!.models[0]!;
      expect(entry.modelConfig.name).toBe("glm-5.1");
      expect(entry.modelConfig.baseUrl).toBe("https://provider-a.example/v1");
      expect(entry.modelConfig.apiKey).toBe("api-key-a");
  });

  // Cross-field validation error cases

  it("rejects chain name that matches a model name", () => {
    const { configPath, dbPath } = createTempConfig(
      `model_chains:
  - name: glm-5.1
    models:
      - gpt-5
${TWO_MODELS_YAML}`,
    );
          expect(() =>
        loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath }),
      ).toThrowError(/Chain name "glm-5\.1" conflicts with a configured model name/);
  });

  it("rejects chain-<name> that matches a model name", () => {
    const { configPath, dbPath } = createTempConfig(
      `models:
  - name: chain-fallback
    base_url: https://provider-a.example/v1
    api_key_env: GLM_API_KEY
  - name: gpt-5
    base_url: https://provider-b.example/v1
    api_key_env: GPT_API_KEY
model_chains:
  - name: fallback
    models:
      - gpt-5
`,
    );
          expect(() =>
        loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath }),
      ).toThrowError(/Chain identifier "chain-fallback" conflicts with a configured model name/);
  });

  it("rejects duplicate chain names", () => {
    const { configPath, dbPath } = createTempConfig(
      `model_chains:
  - name: production
    models:
      - gpt-5
  - name: production
    models:
      - glm-5.1
${TWO_MODELS_YAML}`,
    );
          expect(() =>
        loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath }),
      ).toThrowError(/Duplicate chain name "production"/);
  });

  it("rejects model reference starting with chain- (nesting)", () => {
    const { configPath, dbPath } = createTempConfig(
      `model_chains:
  - name: production
    models:
      - gpt-5
  - name: fallback
    models:
      - chain-production
${TWO_MODELS_YAML}`,
    );
          expect(() =>
        loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath }),
      ).toThrowError(/Chain nesting is not supported/);
  });

  it("rejects copilot-proxy model reference in a chain (default prefix)", () => {
    const { configPath, dbPath } = createTempConfig(
      `models:
  - name: copilot-gpt-4o
    base_url: https://provider-a.example/v1
    api_key_env: GLM_API_KEY
  - name: gpt-5
    base_url: https://provider-b.example/v1
    api_key_env: GPT_API_KEY
model_chains:
  - name: production
    models:
      - copilot-gpt-4o
`,
    );
          expect(() =>
        loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath }),
      ).toThrowError(/Copilot-proxied models cannot be used in chains/);
  });

  it("rejects model reference with custom copilot prefix in a chain", () => {
    const { configPath, dbPath } = createTempConfig(
      `copilot_proxy_allowed_prefixes:
  - copilot-
  - alazyer-
models:
  - name: alazyer-model
    base_url: https://provider-a.example/v1
    api_key_env: GLM_API_KEY
  - name: gpt-5
    base_url: https://provider-b.example/v1
    api_key_env: GPT_API_KEY
model_chains:
  - name: production
    models:
      - alazyer-model
`,
    );
          expect(() =>
        loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath }),
      ).toThrowError(/Copilot-proxied models cannot be used in chains/);
  });

  it("rejects model reference not in models catalog", () => {
    const { configPath, dbPath } = createTempConfig(
      `model_chains:
  - name: production
    models:
      - nonexistent-model
${TWO_MODELS_YAML}`,
    );
          expect(() =>
        loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath }),
      ).toThrowError(/not present in the configured model catalog/);
  });

  it("rejects object model reference with name not in models catalog", () => {
    const { configPath, dbPath } = createTempConfig(
      `model_chains:
  - name: production
    models:
      - name: nonexistent-model
        timeout_ms: 60000
${TWO_MODELS_YAML}`,
    );
          expect(() =>
        loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath }),
      ).toThrowError(/not present in the configured model catalog/);
  });

  // Schema validation

  it("rejects chain with empty name", () => {
    const { configPath, dbPath } = createTempConfig(
      `model_chains:
  - name: ""
    models:
      - gpt-5
${TWO_MODELS_YAML}`,
    );
          expect(() =>
        loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath }),
      ).toThrowError();
  });

  it("rejects chain with empty models list", () => {
    const { configPath, dbPath } = createTempConfig(
      `model_chains:
  - name: production
    models: []
${TWO_MODELS_YAML}`,
    );
          expect(() =>
        loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath }),
      ).toThrowError();
  });

  // default_model validation with chains

  it("accepts chain-<name> as a valid default_model", () => {
    const { configPath, dbPath } = createTempConfig(
      `default_model: chain-production
model_chains:
  - name: production
    models:
      - gpt-5
${TWO_MODELS_YAML}`,
    );
          const config = loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath });
      expect(config.defaultModel).toBe("chain-production");
  });

  it("accepts plain model name as default_model alongside chains", () => {
    const { configPath, dbPath } = createTempConfig(
      `default_model: glm-5.1
model_chains:
  - name: production
    models:
      - gpt-5
${TWO_MODELS_YAML}`,
    );
          const config = loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath });
      expect(config.defaultModel).toBe("glm-5.1");
  });

  it("rejects default_model that is neither a model name nor a chain reference", () => {
    const { configPath, dbPath } = createTempConfig(
      `default_model: unknown-model
model_chains:
  - name: production
    models:
      - gpt-5
${TWO_MODELS_YAML}`,
    );
          expect(() =>
        loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath }),
      ).toThrowError(/not present in the configured model catalog or model chains/);
  });

  it("rejects chain-<name> default_model when no matching chain exists", () => {
    const { configPath, dbPath } = createTempConfig(
      `default_model: chain-nonexistent
${TWO_MODELS_YAML}`,
    );
          expect(() =>
        loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath }),
      ).toThrowError(/not present in the configured model catalog or model chains/);
  });

  // Multiple chains

  it("loads multiple chains simultaneously", () => {
    const { configPath, dbPath } = createTempConfig(
      `model_chains:
  - name: production
    models:
      - gpt-5
  - name: fallback
    models:
      - glm-5.1
${TWO_MODELS_YAML}`,
    );
          const config = loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath });
      expect(config.modelChains).toHaveLength(2);
      // Chains are sorted alphabetically by name from the database
      expect(config.modelChains[0]!.name).toBe("fallback");
      expect(config.modelChains[1]!.name).toBe("production");
  });

  // Timeout/retry resolution order

  it("applies resolution order: model override > chain default > gateway default", () => {
    const { configPath, dbPath } = createTempConfig(
      `request_timeout_ms: 15000
max_retries: 0
model_chains:
  - name: production
    timeout_ms: 30000
    max_retries: 1
    models:
      - name: gpt-5
        timeout_ms: 60000
        max_retries: 3
      - name: glm-5.1
        timeout_ms: 45000
      - gpt-5
models:
  - name: glm-5.1
    base_url: https://provider-a.example/v1
    api_key_env: GLM_API_KEY
  - name: gpt-5
    base_url: https://provider-b.example/v1
    api_key_env: GPT_API_KEY
`,
    );
          const config = loadConfig({ ...BASE_ENV, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath });
      const chain = config.modelChains[0]!;
      // Model override wins
      expect(chain.models[0]!.timeoutMs).toBe(60000);
      expect(chain.models[0]!.maxRetries).toBe(3);
      // Model override for timeout, chain default for retries
      expect(chain.models[1]!.timeoutMs).toBe(45000);
      expect(chain.models[1]!.maxRetries).toBe(1);
      // No overrides, chain default wins
      expect(chain.models[2]!.timeoutMs).toBe(30000);
      expect(chain.models[2]!.maxRetries).toBe(1);
  });
});
