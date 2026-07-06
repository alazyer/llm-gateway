import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("loads a multi-provider YAML catalog and resolves api_key_env references", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "llm-gateway-config-"));
    const configPath = join(tempDir, "gateway.config.yaml");

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

    try {
      const config = loadConfig({
        HOST: "127.0.0.1",
        PORT: "4000",
        GATEWAY_CONFIG_PATH: configPath,
        GLM_API_KEY: "api-key-a",
        CODER_API_KEY: "api-key-b",
      });

      expect(config.host).toBe("127.0.0.1");
      expect(config.port).toBe(4000);
      expect(config.logLevel).toBe("info");
      expect(config.defaultModel).toBe("glm-5.1");
      expect(config.upstreamBaseUrl).toBe("https://provider-a.example/v1");
      expect(config.models).toMatchObject([
        {
          name: "glm-5.1",
          upstreamModel: "glm-5.1",
          baseUrl: "https://provider-a.example/v1",
          apiKey: "api-key-a",
          ownedBy: "zhipu",
          supportsTools: true,
          supportsStreaming: true,
          unknownFieldMode: "warn",
        },
        {
          name: "coder-alias",
          upstreamModel: "provider-internal-coder",
          baseUrl: "https://provider-b.example/v1",
          apiKey: "api-key-b",
          ownedBy: "custom-provider",
          supportsTools: true,
          supportsStreaming: true,
          unknownFieldMode: "warn",
        },
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
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
    const tempDir = mkdtempSync(join(tmpdir(), "llm-gateway-config-"));
    const configPath = join(tempDir, "gateway.config.yaml");

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

    try {
      expect(() =>
        loadConfig({
          HOST: "127.0.0.1",
          PORT: "4000",
          GATEWAY_CONFIG_PATH: configPath,
        }),
      ).toThrowError(/Inline api_key values are not supported/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects invalid unknown_field_mode enum values", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "llm-gateway-config-"));
    const configPath = join(tempDir, "gateway.config.yaml");

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

    try {
      expect(() =>
        loadConfig({
          HOST: "127.0.0.1",
          PORT: "4000",
          GATEWAY_CONFIG_PATH: configPath,
          GLM_API_KEY: "api-key-a",
        }),
      ).toThrowError();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("loads gateway_auth_token_env and resolves the token from env", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "llm-gateway-config-"));
    const configPath = join(tempDir, "gateway.config.yaml");

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

    try {
      const config = loadConfig({
        HOST: "127.0.0.1",
        PORT: "4000",
        GATEWAY_CONFIG_PATH: configPath,
        GLM_API_KEY: "api-key-a",
        GATEWAY_AUTH_TOKEN: "my-secret-token",
      });

      expect(config.gatewayAuthToken).toBe("my-secret-token");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("skips gatewayAuthToken when the env var is empty or missing", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "llm-gateway-config-"));
    const configPath = join(tempDir, "gateway.config.yaml");

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

    try {
      const config = loadConfig({
        HOST: "127.0.0.1",
        PORT: "4000",
        GATEWAY_CONFIG_PATH: configPath,
        GLM_API_KEY: "api-key-a",
        // GATEWAY_AUTH_TOKEN is intentionally omitted
      });

      expect(config.gatewayAuthToken).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("loads health_probe_enabled from YAML with default of false", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "llm-gateway-config-"));
    const configPath = join(tempDir, "gateway.config.yaml");

    writeFileSync(
      configPath,
      `models:
  - name: glm-5.1
    base_url: https://provider-a.example/v1
    api_key_env: GLM_API_KEY
`,
      "utf8",
    );

    try {
      const config = loadConfig({
        HOST: "127.0.0.1",
        PORT: "4000",
        GATEWAY_CONFIG_PATH: configPath,
        GLM_API_KEY: "api-key-a",
      });

      expect(config.healthProbeEnabled).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("loads health_probe_enabled: true from YAML", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "llm-gateway-config-"));
    const configPath = join(tempDir, "gateway.config.yaml");

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

    try {
      const config = loadConfig({
        HOST: "127.0.0.1",
        PORT: "4000",
        GATEWAY_CONFIG_PATH: configPath,
        GLM_API_KEY: "api-key-a",
      });

      expect(config.healthProbeEnabled).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("loads cors_origin as a single string", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "llm-gateway-config-"));
    const configPath = join(tempDir, "gateway.config.yaml");

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

    try {
      const config = loadConfig({
        HOST: "127.0.0.1",
        PORT: "4000",
        GATEWAY_CONFIG_PATH: configPath,
        GLM_API_KEY: "api-key-a",
      });

      expect(config.corsOrigin).toBe("http://localhost:5173");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("loads cors_origin as an array of strings", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "llm-gateway-config-"));
    const configPath = join(tempDir, "gateway.config.yaml");

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

    try {
      const config = loadConfig({
        HOST: "127.0.0.1",
        PORT: "4000",
        GATEWAY_CONFIG_PATH: configPath,
        GLM_API_KEY: "api-key-a",
      });

      expect(config.corsOrigin).toEqual(["http://localhost:5173", "https://admin.example.com"]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("loads cors_origin as wildcard string", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "llm-gateway-config-"));
    const configPath = join(tempDir, "gateway.config.yaml");

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

    try {
      const config = loadConfig({
        HOST: "127.0.0.1",
        PORT: "4000",
        GATEWAY_CONFIG_PATH: configPath,
        GLM_API_KEY: "api-key-a",
      });

      expect(config.corsOrigin).toBe("*");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not set corsOrigin when not configured", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "llm-gateway-config-"));
    const configPath = join(tempDir, "gateway.config.yaml");

    writeFileSync(
      configPath,
      `models:
  - name: glm-5.1
    base_url: https://provider-a.example/v1
    api_key_env: GLM_API_KEY
`,
      "utf8",
    );

    try {
      const config = loadConfig({
        HOST: "127.0.0.1",
        PORT: "4000",
        GATEWAY_CONFIG_PATH: configPath,
        GLM_API_KEY: "api-key-a",
      });

      expect(config.corsOrigin).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("loads Copilot proxy config with disabled defaults", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "llm-gateway-config-"));
    const configPath = join(tempDir, "gateway.config.yaml");

    writeFileSync(
      configPath,
      `models:
  - name: glm-5.1
    base_url: https://provider-a.example/v1
    api_key_env: GLM_API_KEY
`,
      "utf8",
    );

    try {
      const config = loadConfig({
        HOST: "127.0.0.1",
        PORT: "4000",
        GATEWAY_CONFIG_PATH: configPath,
        GLM_API_KEY: "api-key-a",
      });

      expect(config.copilotProxy).toEqual({
        enabled: false,
        requireTokenAuth: true,
        tokenTtlSeconds: 86400,
        heartbeatIntervalMs: 30000,
        heartbeatTimeoutMs: 10000,
        maxInflightPerConnection: 4,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("loads custom Copilot proxy config", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "llm-gateway-config-"));
    const configPath = join(tempDir, "gateway.config.yaml");

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

    try {
      const config = loadConfig({
        HOST: "127.0.0.1",
        PORT: "4000",
        GATEWAY_CONFIG_PATH: configPath,
        GLM_API_KEY: "api-key-a",
      });

      expect(config.copilotProxy).toEqual({
        enabled: true,
        requireTokenAuth: false,
        tokenTtlSeconds: 120,
        heartbeatIntervalMs: 5000,
        heartbeatTimeoutMs: 2000,
        maxInflightPerConnection: 2,
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
