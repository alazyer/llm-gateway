import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";


import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { loadConfig } from "../src/config.js";
import { openDatabase, closeDatabase } from "../src/db/index.js";
import { runMigrations } from "../src/db/migrations/index.js";
import { allMigrations } from "../src/db/migrations/all.js";
import { insertModel } from "../src/db/repository.js";

let tempDir: string;

beforeEach(() => {
  closeDatabase();
  tempDir = mkdtempSync(join(tmpdir(), "llm-gateway-config-"));
});

afterEach(() => {
  closeDatabase();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("loads a multi-provider YAML catalog and resolves api_key_env references", () => {
    const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

    writeFileSync(
      configPath,
      `default_model: glm-5.1
models:
  - name: glm-5.1
    base_url: https://provider-a.example/v1
    api_key_env: GLM_API_KEY
    owned_by: zhipu
  - name: coder-alias
    upstream_model: provider-internal-coder
    base_url: https://provider-b.example/v1
    api_key_env: CODER_API_KEY
    owned_by: custom-provider
`,
      "utf8",
    );

    const config = loadConfig({
      HOST: "127.0.0.1",
      PORT: "4000",
      GATEWAY_CONFIG_PATH: configPath,
      GATEWAY_DB_PATH: dbPath,
      GLM_API_KEY: "api-key-a",
      CODER_API_KEY: "api-key-b",
    });

    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(4000);
    expect(config.logLevel).toBe("info");
    expect(config.defaultModel).toBe("glm-5.1");
    expect(config.upstreamBaseUrl).toBe("https://provider-a.example/v1");
    expect(config.models).toHaveLength(2);
    // Models are sorted alphabetically by name from the database
    const glmModel = config.models.find((m) => m.name === "glm-5.1")!;
    const coderModel = config.models.find((m) => m.name === "coder-alias")!;
    expect(glmModel).toMatchObject({
      name: "glm-5.1",
      upstreamModel: "glm-5.1",
      baseUrl: "https://provider-a.example/v1",
      apiKey: "api-key-a",
      ownedBy: "zhipu",
      supportsTools: true,
      supportsStreaming: true,
      unknownFieldMode: "warn",
      status: "active",
    });
    expect(coderModel).toMatchObject({
      name: "coder-alias",
      upstreamModel: "provider-internal-coder",
      baseUrl: "https://provider-b.example/v1",
      apiKey: "api-key-b",
      ownedBy: "custom-provider",
      supportsTools: true,
      supportsStreaming: true,
      unknownFieldMode: "warn",
      status: "active",
    });
  });

  it("requires GATEWAY_CONFIG_PATH and no longer uses legacy upstream env vars", () => {
    expect(() =>
      loadConfig({
        HOST: "127.0.0.1",
        PORT: "4000",
        UPSTREAM_BASE_URL: "https://provider.example/v1",
        UPSTREAM_API_KEY: "legacy-secret",
        UPSTREAM_MODEL: "glm-5.1",
      }),
    ).toThrowError();
  });

  it("rejects inline api_key values in the YAML catalog", () => {
        const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

    writeFileSync(
      configPath,
      `models:
  - name: glm-5.1
    base_url: https://provider-a.example/v1
    api_key: hardcoded-secret
    owned_by: zhipu
`,
      "utf8",
    );

          expect(() =>
        loadConfig({
          HOST: "127.0.0.1",
          PORT: "4000",
          GATEWAY_CONFIG_PATH: configPath,
        GATEWAY_DB_PATH: dbPath,
        }),
      ).toThrowError(/Inline api_key values are not supported/);
      });

  it("rejects invalid unknown_field_mode enum values", () => {
        const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

    writeFileSync(
      configPath,
      `models:
  - name: glm-5.1
    base_url: https://provider-a.example/v1
    api_key_env: GLM_API_KEY
    unknown_field_mode: strict
`,
      "utf8",
    );

          expect(() =>
        loadConfig({
          HOST: "127.0.0.1",
          PORT: "4000",
          GATEWAY_CONFIG_PATH: configPath,
        GATEWAY_DB_PATH: dbPath,
          GLM_API_KEY: "api-key-a",
        }),
      ).toThrowError();
      });

  it("loads gateway_auth_token_env and resolves the token from env", () => {
        const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

    writeFileSync(
      configPath,
      `models:
  - name: glm-5.1
    base_url: https://provider-a.example/v1
    api_key_env: GLM_API_KEY
gateway_auth_token_env: GATEWAY_AUTH_TOKEN
`,
      "utf8",
    );

          const config = loadConfig({
        HOST: "127.0.0.1",
        PORT: "4000",
        GATEWAY_CONFIG_PATH: configPath,
        GATEWAY_DB_PATH: dbPath,
        GLM_API_KEY: "api-key-a",
        GATEWAY_AUTH_TOKEN: "my-secret-token",
      });

      expect(config.gatewayAuthToken).toBe("my-secret-token");
      });

  it("skips gatewayAuthToken when the env var is empty or missing", () => {
        const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

    writeFileSync(
      configPath,
      `models:
  - name: glm-5.1
    base_url: https://provider-a.example/v1
    api_key_env: GLM_API_KEY
gateway_auth_token_env: GATEWAY_AUTH_TOKEN
`,
      "utf8",
    );

          const config = loadConfig({
        HOST: "127.0.0.1",
        PORT: "4000",
        GATEWAY_CONFIG_PATH: configPath,
        GATEWAY_DB_PATH: dbPath,
        GLM_API_KEY: "api-key-a",
        // GATEWAY_AUTH_TOKEN is intentionally omitted
      });

      expect(config.gatewayAuthToken).toBeUndefined();
      });

  it("loads health_probe_enabled from YAML with default of false", () => {
        const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

    writeFileSync(
      configPath,
      `models:
  - name: glm-5.1
    base_url: https://provider-a.example/v1
    api_key_env: GLM_API_KEY
`,
      "utf8",
    );

          const config = loadConfig({
        HOST: "127.0.0.1",
        PORT: "4000",
        GATEWAY_CONFIG_PATH: configPath,
        GATEWAY_DB_PATH: dbPath,
        GLM_API_KEY: "api-key-a",
      });

      expect(config.healthProbeEnabled).toBe(false);
      });

  it("loads health_probe_enabled: true from YAML", () => {
        const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

    writeFileSync(
      configPath,
      `health_probe_enabled: true
models:
  - name: glm-5.1
    base_url: https://provider-a.example/v1
    api_key_env: GLM_API_KEY
`,
      "utf8",
    );

          const config = loadConfig({
        HOST: "127.0.0.1",
        PORT: "4000",
        GATEWAY_CONFIG_PATH: configPath,
        GATEWAY_DB_PATH: dbPath,
        GLM_API_KEY: "api-key-a",
      });

      expect(config.healthProbeEnabled).toBe(true);
      });

  it("loads cors_origin as a single string", () => {
        const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

    writeFileSync(
      configPath,
      `cors_origin: http://localhost:5173
models:
  - name: glm-5.1
    base_url: https://provider-a.example/v1
    api_key_env: GLM_API_KEY
`,
      "utf8",
    );

          const config = loadConfig({
        HOST: "127.0.0.1",
        PORT: "4000",
        GATEWAY_CONFIG_PATH: configPath,
        GATEWAY_DB_PATH: dbPath,
        GLM_API_KEY: "api-key-a",
      });

      expect(config.corsOrigin).toBe("http://localhost:5173");
      });

  it("loads cors_origin as an array of strings", () => {
        const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

    writeFileSync(
      configPath,
      `cors_origin:
  - http://localhost:5173
  - https://admin.example.com
models:
  - name: glm-5.1
    base_url: https://provider-a.example/v1
    api_key_env: GLM_API_KEY
`,
      "utf8",
    );

          const config = loadConfig({
        HOST: "127.0.0.1",
        PORT: "4000",
        GATEWAY_CONFIG_PATH: configPath,
        GATEWAY_DB_PATH: dbPath,
        GLM_API_KEY: "api-key-a",
      });

      expect(config.corsOrigin).toEqual(["http://localhost:5173", "https://admin.example.com"]);
      });

  it("loads cors_origin as wildcard string", () => {
        const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

    writeFileSync(
      configPath,
      `cors_origin: "*"
models:
  - name: glm-5.1
    base_url: https://provider-a.example/v1
    api_key_env: GLM_API_KEY
`,
      "utf8",
    );

          const config = loadConfig({
        HOST: "127.0.0.1",
        PORT: "4000",
        GATEWAY_CONFIG_PATH: configPath,
        GATEWAY_DB_PATH: dbPath,
        GLM_API_KEY: "api-key-a",
      });

      expect(config.corsOrigin).toBe("*");
      });

  it("does not set corsOrigin when not configured", () => {
        const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

    writeFileSync(
      configPath,
      `models:
  - name: glm-5.1
    base_url: https://provider-a.example/v1
    api_key_env: GLM_API_KEY
`,
      "utf8",
    );

          const config = loadConfig({
        HOST: "127.0.0.1",
        PORT: "4000",
        GATEWAY_CONFIG_PATH: configPath,
        GATEWAY_DB_PATH: dbPath,
        GLM_API_KEY: "api-key-a",
      });

      expect(config.corsOrigin).toBeUndefined();
      });

  it("loads Copilot proxy config with disabled defaults", () => {
        const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

    writeFileSync(
      configPath,
      `models:
  - name: glm-5.1
    base_url: https://provider-a.example/v1
    api_key_env: GLM_API_KEY
`,
      "utf8",
    );

          const config = loadConfig({
        HOST: "127.0.0.1",
        PORT: "4000",
        GATEWAY_CONFIG_PATH: configPath,
        GATEWAY_DB_PATH: dbPath,
        GLM_API_KEY: "api-key-a",
      });

      expect(config.copilotProxy).toEqual({
        enabled: false,
        requireTokenAuth: true,
        tokenTtlSeconds: 86400,
        heartbeatIntervalMs: 30000,
        heartbeatTimeoutMs: 10000,
        maxInflightPerConnection: 4,
        allowedPrefixes: ["copilot-"],
      });
      });

  it("loads custom Copilot proxy config", () => {
        const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

    writeFileSync(
      configPath,
      `copilot_proxy_enabled: true
copilot_proxy_require_token_auth: false
copilot_proxy_token_ttl_seconds: 120
copilot_proxy_heartbeat_interval_ms: 5000
copilot_proxy_heartbeat_timeout_ms: 2000
copilot_proxy_max_inflight_per_connection: 2
models:
  - name: glm-5.1
    base_url: https://provider-a.example/v1
    api_key_env: GLM_API_KEY
`,
      "utf8",
    );

          const config = loadConfig({
        HOST: "127.0.0.1",
        PORT: "4000",
        GATEWAY_CONFIG_PATH: configPath,
        GATEWAY_DB_PATH: dbPath,
        GLM_API_KEY: "api-key-a",
      });

      expect(config.copilotProxy).toEqual({
        enabled: true,
        requireTokenAuth: false,
        tokenTtlSeconds: 120,
        heartbeatIntervalMs: 5000,
        heartbeatTimeoutMs: 2000,
        maxInflightPerConnection: 2,
        allowedPrefixes: ["copilot-"],
      });
      });

  it("loads copilot_proxy_allowed_prefixes from YAML", () => {
        const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

    writeFileSync(
      configPath,
      `copilot_proxy_enabled: true
copilot_proxy_allowed_prefixes:
  - copilot-
  - alazyer-
models:
  - name: glm-5.1
    base_url: https://provider-a.example/v1
    api_key_env: GLM_API_KEY
`,
      "utf8",
    );

          const config = loadConfig({
        HOST: "127.0.0.1",
        PORT: "4000",
        GATEWAY_CONFIG_PATH: configPath,
        GATEWAY_DB_PATH: dbPath,
        GLM_API_KEY: "api-key-a",
      });

      expect(config.copilotProxy?.allowedPrefixes).toEqual(["copilot-", "alazyer-"]);
      });

  // ---------------------------------------------------------------------------
  // Chain config validation tests
  // ---------------------------------------------------------------------------

  const chainBaseEnv = {
    HOST: "127.0.0.1",
    PORT: "4000",
    GLM_API_KEY: "api-key-a",
    GPT_API_KEY: "api-key-b",
  };

  const twoModelsYaml = `models:
  - name: glm-5.1
    base_url: https://provider-a.example/v1
    api_key_env: GLM_API_KEY
  - name: gpt-5
    base_url: https://provider-b.example/v1
    api_key_env: GPT_API_KEY
`;

  describe("chain config validation", () => {
    it("parses valid chain config successfully", () => {
            const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

      writeFileSync(
        configPath,
        `model_chains:
  - name: production
    models:
      - gpt-5
      - glm-5.1
${twoModelsYaml}`,
        "utf8",
      );

              const config = loadConfig({ ...chainBaseEnv, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath });

        expect(config.modelChains).toHaveLength(1);
        const chain = config.modelChains![0]!;
        expect(chain.name).toBe("production");
        expect(chain.models).toHaveLength(2);
        expect(chain.models[0]!.name).toBe("gpt-5");
        expect(chain.models[1]!.name).toBe("glm-5.1");
        expect(chain.timeoutMs).toBe(30000); // gateway default
        expect(chain.maxRetries).toBe(0); // gateway default
          });

    it("rejects chain with non-existent model reference with startup validation error", () => {
            const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

      writeFileSync(
        configPath,
        `model_chains:
  - name: production
    models:
      - nonexistent-model
${twoModelsYaml}`,
        "utf8",
      );

              expect(() =>
          loadConfig({ ...chainBaseEnv, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath }),
        ).toThrowError(/not present in the configured model catalog/);
          });

    it("rejects chain name matching a model name with startup validation error", () => {
            const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

      writeFileSync(
        configPath,
        `model_chains:
  - name: glm-5.1
    models:
      - gpt-5
${twoModelsYaml}`,
        "utf8",
      );

              expect(() =>
          loadConfig({ ...chainBaseEnv, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath }),
        ).toThrowError(/Chain name "glm-5\.1" conflicts with a configured model name/);
          });

    it("rejects chain-<name> matching a model name with startup validation error", () => {
            const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

      writeFileSync(
        configPath,
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
        "utf8",
      );

              expect(() =>
          loadConfig({ ...chainBaseEnv, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath }),
        ).toThrowError(/Chain identifier "chain-fallback" conflicts with a configured model name/);
          });

    it("rejects duplicate chain names with startup validation error", () => {
            const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

      writeFileSync(
        configPath,
        `model_chains:
  - name: production
    models:
      - gpt-5
  - name: production
    models:
      - glm-5.1
${twoModelsYaml}`,
        "utf8",
      );

              expect(() =>
          loadConfig({ ...chainBaseEnv, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath }),
        ).toThrowError(/Duplicate chain name "production"/);
          });

    it("rejects chain referencing chain-<name> in models list with startup validation error (nesting)", () => {
            const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

      writeFileSync(
        configPath,
        `model_chains:
  - name: production
    models:
      - gpt-5
  - name: fallback
    models:
      - chain-production
${twoModelsYaml}`,
        "utf8",
      );

              expect(() =>
          loadConfig({ ...chainBaseEnv, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath }),
        ).toThrowError(/Chain nesting is not supported/);
          });

    it("rejects chain referencing copilot-prefixed model with startup validation error", () => {
            const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

      writeFileSync(
        configPath,
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
        "utf8",
      );

              expect(() =>
          loadConfig({ ...chainBaseEnv, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath }),
        ).toThrowError(/Copilot-proxied models cannot be used in chains/);
          });

    it("rejects empty models list with Zod validation error", () => {
            const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

      writeFileSync(
        configPath,
        `model_chains:
  - name: production
    models: []
${twoModelsYaml}`,
        "utf8",
      );

              expect(() =>
          loadConfig({ ...chainBaseEnv, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath }),
        ).toThrowError();
          });

    it("rejects empty chain name with Zod validation error", () => {
            const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

      writeFileSync(
        configPath,
        `model_chains:
  - name: ""
    models:
      - gpt-5
${twoModelsYaml}`,
        "utf8",
      );

              expect(() =>
          loadConfig({ ...chainBaseEnv, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath }),
        ).toThrowError();
          });

    it("accepts config with optional model_chains section omitted (backward compatible)", () => {
            const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

      writeFileSync(configPath, twoModelsYaml, "utf8");

              const config = loadConfig({ ...chainBaseEnv, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath });

        expect(config.modelChains).toEqual([]);
          });

    it("accepts config with empty model_chains array", () => {
            const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

      writeFileSync(
        configPath,
        `model_chains: []
${twoModelsYaml}`,
        "utf8",
      );

              const config = loadConfig({ ...chainBaseEnv, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath });

        expect(config.modelChains).toEqual([]);
          });

    it("accepts default_model set to chain-<name> when chain exists", () => {
            const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

      writeFileSync(
        configPath,
        `default_model: chain-production
model_chains:
  - name: production
    models:
      - gpt-5
${twoModelsYaml}`,
        "utf8",
      );

              const config = loadConfig({ ...chainBaseEnv, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath });

        expect(config.defaultModel).toBe("chain-production");
          });

    it("rejects default_model set to chain-<name> when chain does not exist", () => {
            const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

      writeFileSync(
        configPath,
        `default_model: chain-nonexistent
${twoModelsYaml}`,
        "utf8",
      );

              expect(() =>
          loadConfig({ ...chainBaseEnv, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath }),
        ).toThrowError(/not present in the configured model catalog or model chains/);
          });

    it("resolves per-model overrides correctly in AppConfig output", () => {
            const configPath = join(tempDir, "gateway.config.yaml");
    const dbPath = join(tempDir, "gateway.db");

      writeFileSync(
        configPath,
        `request_timeout_ms: 15000
max_retries: 0
model_chains:
  - name: production
    timeout_ms: 45000
    max_retries: 1
    models:
      - name: gpt-5
        timeout_ms: 60000
        max_retries: 3
      - glm-5.1
${twoModelsYaml}`,
        "utf8",
      );

              const config = loadConfig({ ...chainBaseEnv, GATEWAY_CONFIG_PATH: configPath, GATEWAY_DB_PATH: dbPath });

        const chain = config.modelChains![0]!;
        // Model override wins over chain default
        expect(chain.models[0]!.timeoutMs).toBe(60000);
        expect(chain.models[0]!.maxRetries).toBe(3);
        // Chain default wins over gateway default
        expect(chain.models[1]!.timeoutMs).toBe(45000);
        expect(chain.models[1]!.maxRetries).toBe(1);
        // Chain-level settings
        expect(chain.timeoutMs).toBe(45000);
        expect(chain.maxRetries).toBe(1);
          });
  });

  // ---------------------------------------------------------------------------
  // Copilot-proxy model API key resolution
  // ---------------------------------------------------------------------------

  describe("copilot-proxy model API key handling", () => {
    it("skips API key resolution for copilot-proxy models in database", () => {
      const configPath = join(tempDir, "gateway.config.yaml");
      const dbPath = join(tempDir, "gateway.db");

      // First, seed the database with a normal YAML config (static model only).
      writeFileSync(
        configPath,
        `models:
  - name: glm-5.1
    base_url: https://provider-a.example/v1
    api_key_env: GLM_API_KEY
`,
        "utf8",
      );

      const env = {
        HOST: "127.0.0.1",
        PORT: "4000",
        GATEWAY_CONFIG_PATH: configPath,
        GATEWAY_DB_PATH: dbPath,
        GLM_API_KEY: "api-key-a",
      };

      // Seed the database.
      loadConfig(env);
      closeDatabase();

      // Now insert a copilot-proxy model directly into the database
      // (simulating a VS Code extension having registered the model).
      const db = openDatabase(env);
      runMigrations(db, allMigrations);

      const now = Math.floor(Date.now() / 1000);
      insertModel({
        name: "copilot-gpt-4o",
        upstream_model: "gpt-4o",
        base_url: "",
        api_key_env: "",
        owned_by: "copilot-proxy",
        created: now,
        supports_tools: 1,
        supports_streaming: 1,
        unknown_field_mode: "warn",
        unknown_field_window_requests: 100,
        source: "copilot-proxy",
        source_prefix: "copilot-",
        connection_id: "test-conn-1",
        status: "active",
        status_reason: "Copilot proxy registered",
        status_changed_at: now,
        capabilities_json: null,
        updated_at: now,
      });

      closeDatabase();

      // Now load config again — the database is already populated, so
      // loadConfigFromDatabase() is used. It should NOT throw for the
      // copilot-proxy model that has no API key.
      const config = loadConfig(env);

      // Static model still has its API key resolved.
      const staticModel = config.models.find((m) => m.name === "glm-5.1")!;
      expect(staticModel.apiKey).toBe("api-key-a");
      expect(staticModel.apiKeyEnv).toBe("GLM_API_KEY");

      // Copilot-proxy model has undefined apiKey (no static key).
      const copilotModel = config.models.find((m) => m.name === "copilot-gpt-4o")!;
      expect(copilotModel.apiKey).toBeUndefined();
      expect(copilotModel.apiKeyEnv).toBe("");
      expect(copilotModel.ownedBy).toBe("copilot-proxy");
    });

    it("still requires API key for static models in database", () => {
      const configPath = join(tempDir, "gateway.config.yaml");
      const dbPath = join(tempDir, "gateway.db");

      writeFileSync(
        configPath,
        `models:
  - name: glm-5.1
    base_url: https://provider-a.example/v1
    api_key_env: GLM_API_KEY
`,
        "utf8",
      );

      const env = {
        HOST: "127.0.0.1",
        PORT: "4000",
        GATEWAY_CONFIG_PATH: configPath,
        GATEWAY_DB_PATH: dbPath,
        GLM_API_KEY: "api-key-a",
      };

      // Seed the database.
      loadConfig(env);
      closeDatabase();

      // Modify the static model's api_key_env to point to a missing env var
      // to simulate a misconfiguration after seeding.
      const db2 = openDatabase(env);
      db2.prepare(
        "UPDATE models SET api_key_env = ? WHERE name = ?",
      ).run("MISSING_KEY_ENV", "glm-5.1");
      closeDatabase();

      // Loading config should now throw because the static model's env var
      // is missing.
      expect(() =>
        loadConfig({
          ...env,
          // Intentionally omit MISSING_KEY_ENV
        }),
      ).toThrowError(/Missing API key for model glm-5.1/);
    });
  });
});


