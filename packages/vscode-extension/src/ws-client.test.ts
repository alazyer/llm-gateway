import type { CopilotProxyRegisterMessage } from "@llm-gateway/shared";
import { describe, expect, it, vi } from "vitest";

import type { ExtensionConfig } from "./config.js";
import { CopilotProxyWebSocketClient, type WebSocketFactory } from "./ws-client.js";

class FakeSocket {
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onclose: ((event: { code: number; reason: string }) => void) | null = null;
  public onerror: (() => void) | null = null;
  public readonly sent: string[] = [];

  public constructor(public readonly url: string) {}

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(code = 1000, reason = ""): void {
    this.onclose?.({ code, reason });
  }
}

const config: ExtensionConfig = {
  gatewayUrl: "ws://localhost:3000/ws/copilot-proxy",
  proxyToken: "cpx_secret",
  reconnectInitialDelayMs: 10,
  reconnectMaxDelayMs: 30,
};

function createClient() {
  const sockets: FakeSocket[] = [];
  const factory: WebSocketFactory = (url) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);
    return socket;
  };
  const logger = {
    debug: vi.fn(),

    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  };
  const statusBar = {
    setStatus: vi.fn(),
    dispose: vi.fn(),
  };
  const registration: CopilotProxyRegisterMessage = {
    type: "register",
    extension_version: "0.1.0",
    copilot_status: "disconnected",
    models: [],
  };
  const client = new CopilotProxyWebSocketClient({
    config,
    logger: logger as never,
    statusBar: statusBar as never,
    registrationProvider: () => registration,
    webSocketFactory: factory,
  });

  return { client, sockets, logger, statusBar };
}

describe("CopilotProxyWebSocketClient", () => {
  it("connects with proxy token and registers after open", async () => {
    const { client, sockets, logger, statusBar } = createClient();

    client.connect();
    expect(sockets[0]?.url).toBe(
      "ws://localhost:3000/ws/copilot-proxy?token=cpx_secret",
    );
    sockets[0]?.onopen?.();
    await Promise.resolve();

    expect(statusBar.setStatus).toHaveBeenCalledWith("connected");
    expect(logger.info).toHaveBeenCalledWith(
      "Opening gateway WebSocket connection to ws://localhost:3000/ws/copilot-proxy.",
    );
    expect(logger.info).toHaveBeenCalledWith("Connected to LLM Gateway Copilot proxy.");
    expect(logger.info).toHaveBeenCalledWith(
      "Sent proxy registration: status=disconnected, models=0.",
    );
    expect(sockets[0]?.sent.map((entry) => JSON.parse(entry) as unknown)).toContainEqual({
      type: "register",
      extension_version: "0.1.0",
      copilot_status: "disconnected",
      models: [],
    });
  });

  it("responds to ping with pong", () => {
    const { client, sockets } = createClient();

    client.connect();
    sockets[0]?.onmessage?.({ data: JSON.stringify({ type: "ping" }) });

    expect(sockets[0]?.sent).toContain(JSON.stringify({ type: "pong" }));
  });

  it("dispatches request and cancel frames to handlers", () => {
    const sockets: FakeSocket[] = [];
    const requestHandler = vi.fn();
    const cancelHandler = vi.fn();
    const logger = {
      debug: vi.fn(),

      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    };
    const client = new CopilotProxyWebSocketClient({
      config,
      logger: logger as never,
      statusBar: { setStatus: vi.fn(), dispose: vi.fn() } as never,
      registrationProvider: () => ({
        type: "register",
        extension_version: "0.1.0",
        copilot_status: "connected",
        models: [],
      }),
      requestHandler,
      cancelHandler,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    client.connect();
    sockets[0]?.onmessage?.({
      data: JSON.stringify({
        type: "request",
        id: "req-1",
        model: "copilot-gpt-4o",
        messages: [],
      }),
    });
    sockets[0]?.onmessage?.({ data: JSON.stringify({ type: "cancel", id: "req-1" }) });

    expect(requestHandler).toHaveBeenCalledWith(
      expect.objectContaining({ type: "request", id: "req-1" }),
      expect.any(Function),
    );
    expect(cancelHandler).toHaveBeenCalledWith("req-1");
    expect(logger.info).toHaveBeenCalledWith(
      "Received gateway request req-1: model=copilot-gpt-4o, messages=0.",
    );
    expect(logger.info).toHaveBeenCalledWith("Received gateway cancellation for request req-1.");
  });

  it("does not reconnect after proxy token rejection", () => {
    vi.useFakeTimers();
    const { client, sockets, statusBar } = createClient();

    client.connect();
    sockets[0]?.onclose?.({ code: 1008, reason: "expired" });
    vi.runAllTimers();

    expect(statusBar.setStatus).toHaveBeenCalledWith("gateway-error");
    expect(sockets).toHaveLength(1);
    vi.useRealTimers();
  });

  it("reconnects with bounded backoff after normal close", () => {
    vi.useFakeTimers();
    const { client, sockets, logger, statusBar } = createClient();

    client.connect();
    sockets[0]?.onclose?.({ code: 1001, reason: "gone" });
    expect(statusBar.setStatus).toHaveBeenCalledWith("retrying");
    expect(logger.warn).toHaveBeenCalledWith(
      "Gateway WebSocket closed: code=1001, reason=gone; reconnecting in 10ms.",
    );
    vi.advanceTimersByTime(10);

    expect(sockets).toHaveLength(2);
    vi.useRealTimers();
  });

  it("sends periodic status updates while connected", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const client = new CopilotProxyWebSocketClient({
      config,
      logger: {
        debug: vi.fn(),

        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        show: vi.fn(),
        dispose: vi.fn(),
      } as never,
      statusBar: { setStatus: vi.fn(), dispose: vi.fn() } as never,
      registrationProvider: () => ({
        type: "register",
        extension_version: "0.1.0",
        copilot_status: "connected",
        models: [],
      }),
      statusProvider: () => ({
        type: "status_update",
        copilot_status: "connected",
        available_models: [],
      }),
      statusPollIntervalMs: 25,
      webSocketFactory: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    client.connect();
    sockets[0]?.onopen?.();
    await Promise.resolve();
    vi.advanceTimersByTime(25);
    await Promise.resolve();

    expect(sockets[0]?.sent.map((entry) => JSON.parse(entry) as unknown)).toContainEqual({
      type: "status_update",
      copilot_status: "connected",
      available_models: [],
    });
    vi.useRealTimers();
  });

  it("sends disconnect on deactivate", () => {
    const { client, sockets, statusBar } = createClient();

    client.connect();
    client.disconnect();

    expect(sockets[0]?.sent).toContain(
      JSON.stringify({ type: "disconnect", reason: "Extension deactivated." }),
    );
    expect(statusBar.setStatus).toHaveBeenCalledWith("disconnected");
  });
});
