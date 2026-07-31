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
});
