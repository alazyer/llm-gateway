import { beforeEach, describe, expect, it, vi } from "vitest";

const configValues = new Map<string, unknown>();
let onDidChangeConfigurationCallback: (() => void) | undefined;
const loggedMessages: string[] = [];
const mockStatusBarItem = {
  text: "",
  tooltip: "",
  command: "",
  show: vi.fn(),
  dispose: vi.fn(),
};

vi.mock("vscode", () => ({
  StatusBarAlignment: { Left: 1 },
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, fallback: T): T =>
        configValues.has(key) ? (configValues.get(key) as T) : fallback,
    }),
    onDidChangeConfiguration: (callback: () => void) => {
      onDidChangeConfigurationCallback = callback;
      return { dispose: () => {} };
    },
  },
  window: {
    createOutputChannel: () => ({
      appendLine: (msg: string) => loggedMessages.push(msg),
      show: () => {},
      dispose: () => {},
    }),
    createStatusBarItem: () => mockStatusBarItem,
    showErrorMessage: () => {},
  },
  commands: {
    registerCommand: () => ({ dispose: () => {} }),
  },
}));

// Mock ws-client so startProxy doesn't try to create a real WebSocket
vi.mock("./ws-client.js", () => {
  return {
    CopilotProxyWebSocketClient: vi.fn().mockImplementation(function () {
      this.connect = vi.fn();
      this.disconnect = vi.fn();
    }),
  };
});

// Mock copilot-bridge so discoverModels doesn't call real Copilot API
vi.mock("./copilot-bridge.js", () => {
  return {
    CopilotBridge: vi.fn().mockImplementation(function () {
      this.discoverModels = vi.fn().mockResolvedValue([]);
      this.executeRequest = vi.fn();
      this.cancel = vi.fn();
    }),
  };
});

function setDefaultConfig(): void {
  configValues.set("gatewayUrl", "ws://gateway/ws/copilot-proxy");
  configValues.set("proxyToken", "cpx_test");
  configValues.set("enableGatewayAuth", true);
  configValues.set("modelPrefix", "copilot-");
  configValues.set("logLevel", "info");
  configValues.set("reconnectInitialDelayMs", 1000);
  configValues.set("reconnectMaxDelayMs", 30000);
}

describe("extension configuration change listener", () => {
  beforeEach(async () => {
    vi.resetModules();
    configValues.clear();
    loggedMessages.length = 0;
    onDidChangeConfigurationCallback = undefined;
    mockStatusBarItem.show.mockClear();
    mockStatusBarItem.dispose.mockClear();

    setDefaultConfig();

    const { activate } = await import("./extension.js");
    const mockContext = { subscriptions: [] };
    activate(mockContext as unknown as Parameters<typeof activate>[0]);
  });

  it("updates logLevel immediately without reconnect when logLevel changes", async () => {
    configValues.set("logLevel", "debug");

    onDidChangeConfigurationCallback?.();

    expect(loggedMessages.some((m) => m.includes("Configuration changed: logLevel"))).toBe(true);
    expect(loggedMessages.some((m) => m.includes("Reconnecting due to configuration change"))).toBe(
      false,
    );
  });

  it("triggers reconnect when gatewayUrl changes", async () => {
    configValues.set("gatewayUrl", "ws://new-gateway/ws/copilot-proxy");

    onDidChangeConfigurationCallback?.();

    expect(loggedMessages.some((m) => m.includes("Configuration changed: gatewayUrl"))).toBe(true);
    expect(loggedMessages.some((m) => m.includes("Reconnecting due to configuration change"))).toBe(
      true,
    );
  });

  it("triggers reconnect when proxyToken changes", async () => {
    configValues.set("proxyToken", "cpx_new_token");

    onDidChangeConfigurationCallback?.();

    expect(loggedMessages.some((m) => m.includes("Configuration changed: proxyToken"))).toBe(true);
    expect(loggedMessages.some((m) => m.includes("Reconnecting due to configuration change"))).toBe(
      true,
    );
  });

  it("triggers reconnect when enableGatewayAuth changes", async () => {
    configValues.set("enableGatewayAuth", false);

    onDidChangeConfigurationCallback?.();

    expect(
      loggedMessages.some((m) => m.includes("Configuration changed: enableGatewayAuth")),
    ).toBe(true);
    expect(loggedMessages.some((m) => m.includes("Reconnecting due to configuration change"))).toBe(
      true,
    );
  });

  it("triggers reconnect when modelPrefix changes", async () => {
    configValues.set("modelPrefix", "custom-");

    onDidChangeConfigurationCallback?.();

    expect(loggedMessages.some((m) => m.includes("Configuration changed: modelPrefix"))).toBe(true);
    expect(loggedMessages.some((m) => m.includes("Reconnecting due to configuration change"))).toBe(
      true,
    );
  });

  it("does nothing when no settings change", async () => {
    onDidChangeConfigurationCallback?.();

    expect(loggedMessages.some((m) => m.includes("Configuration changed"))).toBe(false);
  });

  it("handles multiple setting changes at once including reconnect", async () => {
    configValues.set("logLevel", "debug");
    configValues.set("gatewayUrl", "ws://new-gateway/ws/copilot-proxy");

    onDidChangeConfigurationCallback?.();

    expect(loggedMessages.some((m) => m.includes("Configuration changed"))).toBe(true);
    expect(loggedMessages.some((m) => m.includes("Reconnecting due to configuration change"))).toBe(
      true,
    );
  });

  it("does not trigger reconnect for reconnect delay changes alone", async () => {
    configValues.set("reconnectInitialDelayMs", 2000);

    onDidChangeConfigurationCallback?.();

    expect(
      loggedMessages.some((m) => m.includes("Configuration changed: reconnectInitialDelayMs")),
    ).toBe(true);
    expect(loggedMessages.some((m) => m.includes("Reconnecting due to configuration change"))).toBe(
      false,
    );
  });
});
