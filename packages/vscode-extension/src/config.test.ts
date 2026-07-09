import { beforeEach, describe, expect, it, vi } from "vitest";

const values = new Map<string, unknown>();

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, fallback: T) => (values.has(key) ? values.get(key) : fallback),
    }),
  },
}));

describe("extension config", () => {
  beforeEach(() => {
    values.clear();
  });

  it("loads configured gateway settings", async () => {
    values.set("gatewayUrl", " ws://gateway/ws/copilot-proxy ");
    values.set("proxyToken", " cpx_secret ");
    values.set("enableGatewayAuth", false);
    values.set("reconnectInitialDelayMs", 500);
    values.set("reconnectMaxDelayMs", 5000);
    values.set("logLevel", "debug");

    const { isExtensionConfigComplete, loadExtensionConfig } = await import("./config.js");
    const config = loadExtensionConfig();

    expect(config).toEqual({
      gatewayUrl: "ws://gateway/ws/copilot-proxy",
      proxyToken: "cpx_secret",
      enableGatewayAuth: false,
      modelPrefix: "copilot-",
      reconnectInitialDelayMs: 500,
      reconnectMaxDelayMs: 5000,
      logLevel: "debug",
    });
    expect(isExtensionConfigComplete(config)).toBe(true);
  });

  it("detects incomplete config when auth is enabled", async () => {
    values.set("gatewayUrl", "ws://gateway/ws/copilot-proxy");
    values.set("enableGatewayAuth", true);
    const { isExtensionConfigComplete, loadExtensionConfig } = await import("./config.js");
    expect(isExtensionConfigComplete(loadExtensionConfig())).toBe(false);
  });

  it("allows missing proxyToken when auth is disabled", async () => {
    values.set("gatewayUrl", "ws://gateway/ws/copilot-proxy");
    values.set("enableGatewayAuth", false);

    const { isExtensionConfigComplete, loadExtensionConfig } = await import("./config.js");
    expect(isExtensionConfigComplete(loadExtensionConfig())).toBe(true);
  });

  it("defaults modelPrefix to copilot-", async () => {
    values.set("gatewayUrl", "ws://gateway/ws/copilot-proxy");
    values.set("enableGatewayAuth", false);

    const { loadExtensionConfig } = await import("./config.js");
    const config = loadExtensionConfig();
    expect(config.modelPrefix).toBe("copilot-");
  });

  it("reads a custom modelPrefix from configuration", async () => {
    values.set("gatewayUrl", "ws://gateway/ws/copilot-proxy");
    values.set("enableGatewayAuth", false);
    values.set("modelPrefix", "alazyer-");

    const { loadExtensionConfig } = await import("./config.js");
    const config = loadExtensionConfig();
    expect(config.modelPrefix).toBe("alazyer-");
  });

  it("trims whitespace from modelPrefix", async () => {
    values.set("gatewayUrl", "ws://gateway/ws/copilot-proxy");
    values.set("enableGatewayAuth", false);
    values.set("modelPrefix", " custom- ");

    const { loadExtensionConfig } = await import("./config.js");
    const config = loadExtensionConfig();
    expect(config.modelPrefix).toBe("custom-");
  });

  it("detects incomplete config when modelPrefix is empty", async () => {
    values.set("gatewayUrl", "ws://gateway/ws/copilot-proxy");
    values.set("enableGatewayAuth", false);
    values.set("modelPrefix", "");

    const { isExtensionConfigComplete, loadExtensionConfig } = await import("./config.js");
    expect(isExtensionConfigComplete(loadExtensionConfig())).toBe(false);
  });
});

describe("getChangedSettings", () => {
  let getChangedSettings: typeof import("./config.js").getChangedSettings;
  let loadExtensionConfig: typeof import("./config.js").loadExtensionConfig;

  function makeConfig(overrides?: Partial<import("./config.js").ExtensionConfig>): import("./config.js").ExtensionConfig {
    return {
      gatewayUrl: "ws://gateway/ws/copilot-proxy",
      proxyToken: "cpx_test",
      enableGatewayAuth: true,
      modelPrefix: "copilot-",
      reconnectInitialDelayMs: 1000,
      reconnectMaxDelayMs: 30000,
      logLevel: "info",
      ...overrides,
    };
  }

  beforeEach(async () => {
    values.clear();
    ({ getChangedSettings, loadExtensionConfig } = await import("./config.js"));
  });

  it("returns empty changedKeys when configs are identical", () => {
    const config = makeConfig();
    const result = getChangedSettings(config, config);
    expect(result.changedKeys).toEqual([]);
    expect(result.requiresReconnect).toBe(false);
  });

  it("detects gatewayUrl change and requires reconnect", () => {
    const result = getChangedSettings(makeConfig(), makeConfig({ gatewayUrl: "ws://new-gateway/ws/copilot-proxy" }));
    expect(result.changedKeys).toContain("gatewayUrl");
    expect(result.requiresReconnect).toBe(true);
  });

  it("detects proxyToken change and requires reconnect", () => {
    const result = getChangedSettings(makeConfig(), makeConfig({ proxyToken: "cpx_new_token" }));
    expect(result.changedKeys).toContain("proxyToken");
    expect(result.requiresReconnect).toBe(true);
  });

  it("detects enableGatewayAuth change and requires reconnect", () => {
    const result = getChangedSettings(makeConfig(), makeConfig({ enableGatewayAuth: false }));
    expect(result.changedKeys).toContain("enableGatewayAuth");
    expect(result.requiresReconnect).toBe(true);
  });

  it("detects modelPrefix change and requires reconnect", () => {
    const result = getChangedSettings(makeConfig(), makeConfig({ modelPrefix: "custom-" }));
    expect(result.changedKeys).toContain("modelPrefix");
    expect(result.requiresReconnect).toBe(true);
  });

  it("detects logLevel change without requiring reconnect", () => {
    const result = getChangedSettings(makeConfig(), makeConfig({ logLevel: "debug" }));
    expect(result.changedKeys).toContain("logLevel");
    expect(result.requiresReconnect).toBe(false);
  });

  it("detects reconnect delay changes without requiring reconnect", () => {
    const result = getChangedSettings(makeConfig(), makeConfig({ reconnectInitialDelayMs: 2000, reconnectMaxDelayMs: 60000 }));
    expect(result.changedKeys).toContain("reconnectInitialDelayMs");
    expect(result.changedKeys).toContain("reconnectMaxDelayMs");
    expect(result.requiresReconnect).toBe(false);
  });

  it("detects multiple changes including reconnect-required ones", () => {
    const result = getChangedSettings(makeConfig(), makeConfig({ logLevel: "debug", modelPrefix: "custom-" }));
    expect(result.changedKeys).toContain("logLevel");
    expect(result.changedKeys).toContain("modelPrefix");
    expect(result.requiresReconnect).toBe(true);
  });
});
