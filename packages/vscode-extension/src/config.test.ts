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
    values.set("modelPrefix", " custom- ");
    values.set("reconnectInitialDelayMs", 500);
    values.set("reconnectMaxDelayMs", 5000);
    values.set("logLevel", "debug");

    const { isExtensionConfigComplete, loadExtensionConfig } = await import("./config.js");
    const config = loadExtensionConfig();

    expect(config).toEqual({
      gatewayUrl: "ws://gateway/ws/copilot-proxy",
      proxyToken: "cpx_secret",
      enableGatewayAuth: false,
      modelPrefix: "custom-",
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
});
