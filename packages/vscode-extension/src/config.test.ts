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
    values.set("reconnectInitialDelayMs", 500);
    values.set("reconnectMaxDelayMs", 5000);

    const { isExtensionConfigComplete, loadExtensionConfig } = await import("./config.js");
    const config = loadExtensionConfig();

    expect(config).toEqual({
      gatewayUrl: "ws://gateway/ws/copilot-proxy",
      proxyToken: "cpx_secret",
      reconnectInitialDelayMs: 500,
      reconnectMaxDelayMs: 5000,
    });
    expect(isExtensionConfigComplete(config)).toBe(true);
  });

  it("detects incomplete config", async () => {
    const { isExtensionConfigComplete, loadExtensionConfig } = await import("./config.js");
    expect(isExtensionConfigComplete(loadExtensionConfig())).toBe(false);
  });
});
