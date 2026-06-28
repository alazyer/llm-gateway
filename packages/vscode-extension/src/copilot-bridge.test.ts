import type { CopilotProxyExtensionMessage } from "@llm-gateway/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

class TextPart {
  public constructor(public readonly value: string) {}
}

class ToolCallPart {
  public constructor(
    public readonly callId: string,
    public readonly name: string,
    public readonly input: object,
  ) {}
}

class CancellationTokenSource {
  public static readonly instances: CancellationTokenSource[] = [];
  public readonly token = {};
  public cancel = vi.fn();
  public dispose = vi.fn();

  public constructor() {
    CancellationTokenSource.instances.push(this);
  }
}

const selectChatModels = vi.fn();
const sendRequest = vi.fn();

vi.mock("vscode", () => ({
  lm: {
    selectChatModels,
  },
  LanguageModelTextPart: TextPart,
  LanguageModelToolCallPart: ToolCallPart,
  CancellationTokenSource,
  LanguageModelChatMessage: {
    User: (content: string) => ({ role: "user", content }),
    Assistant: (content: string) => ({ role: "assistant", content }),
  },
}));

describe("CopilotBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    CancellationTokenSource.instances.length = 0;
    selectChatModels.mockResolvedValue([
      {
        id: "gpt-4o",
        name: "GPT-4o",
        vendor: "copilot",
        family: "gpt-4o",
        version: "1",
        maxInputTokens: 100000,
        sendRequest,
      },
    ]);
  });

  it("discovers Copilot models and maps them to gateway IDs", async () => {
    const { CopilotBridge } = await import("./copilot-bridge.js");
    const bridge = new CopilotBridge();

    await expect(bridge.discoverModels()).resolves.toEqual([
      {
        id: "copilot-gpt-4o",
        name: "GPT-4o",
        native_id: "gpt-4o",
        source: "copilot-proxy",
        capabilities: {
          supports_streaming: true,
          supports_tools: false,
          supports_usage: false,
          supports_progress: false,
          max_tokens: 100000,
        },
      },
    ]);
  });

  it("streams text output and completion frames", async () => {
    async function* stream() {
      yield new TextPart("hello");
      yield new TextPart(" world");
    }
    sendRequest.mockResolvedValue({ stream: stream() });

    const { CopilotBridge } = await import("./copilot-bridge.js");
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    };
    const bridge = new CopilotBridge(logger as never);
    const sent: CopilotProxyExtensionMessage[] = [];

    await bridge.executeRequest(
      {
        type: "request",
        id: "req-1",
        model: "copilot-gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      },
      (message) => sent.push(message),
    );

    expect(sent).toEqual([
      { type: "stream_delta", id: "req-1", content_type: "text", content: "hello" },
      { type: "stream_delta", id: "req-1", content_type: "text", content: " world" },
      { type: "stream_done", id: "req-1" },
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      "Starting Copilot request req-1: model=copilot-gpt-4o, messages=1, tools=0.",
    );
    expect(logger.info).toHaveBeenCalledWith(
      "Completed Copilot request req-1: streamed 2 part(s).",
    );
  });

  it("reports unavailable Copilot models", async () => {
    selectChatModels.mockResolvedValue([]);
    const { CopilotBridge } = await import("./copilot-bridge.js");
    const bridge = new CopilotBridge();
    const sent: CopilotProxyExtensionMessage[] = [];

    await bridge.executeRequest(
      {
        type: "request",
        id: "req-1",
        model: "copilot-gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      },
      (message) => sent.push(message),
    );

    expect(sent).toEqual([
      expect.objectContaining({
        type: "stream_error",
        id: "req-1",
        partial: false,
      }),
    ]);
  });

  it("streams tool-call output when Copilot emits tool-call parts", async () => {
    async function* stream() {
      yield new ToolCallPart("call-1", "lookup", { q: "docs" });
    }
    sendRequest.mockResolvedValue({ stream: stream() });

    const { CopilotBridge } = await import("./copilot-bridge.js");
    const bridge = new CopilotBridge();
    const sent: CopilotProxyExtensionMessage[] = [];

    await bridge.executeRequest(
      {
        type: "request",
        id: "req-1",
        model: "copilot-gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      },
      (message) => sent.push(message),
    );

    expect(sent).toEqual([
      {
        type: "stream_delta",
        id: "req-1",
        content_type: "tool_call",
        content: {
          index: 0,
          id: "call-1",
          type: "function",
          function: {
            name: "lookup",
            arguments: JSON.stringify({ q: "docs" }),
          },
        },
      },
      { type: "stream_done", id: "req-1" },
    ]);
  });

  it("rejects tool requests when tool support is not advertised", async () => {
    const { CopilotBridge } = await import("./copilot-bridge.js");
    const bridge = new CopilotBridge();
    const sent: CopilotProxyExtensionMessage[] = [];

    await bridge.executeRequest(
      {
        type: "request",
        id: "req-1",
        model: "copilot-gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        tools: [{ type: "function", function: { name: "lookup" } }],
      },
      (message) => sent.push(message),
    );

    expect(sent[0]).toMatchObject({
      type: "stream_error",
      error: { code: "tools_unsupported" },
    });
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it("returns stream errors when Copilot request execution fails", async () => {
    sendRequest.mockRejectedValue(new Error("Copilot failed"));

    const { CopilotBridge } = await import("./copilot-bridge.js");
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    };
    const bridge = new CopilotBridge(logger as never);
    const sent: CopilotProxyExtensionMessage[] = [];

    await bridge.executeRequest(
      {
        type: "request",
        id: "req-1",
        model: "copilot-gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      },
      (message) => sent.push(message),
    );

    expect(sent).toEqual([
      expect.objectContaining({
        type: "stream_error",
        id: "req-1",
        partial: false,
        error: expect.objectContaining({
          code: "copilot_request_failed",
          message: "Copilot failed",
        }),
      }),
    ]);
    expect(logger.error).toHaveBeenCalledWith("Copilot request req-1 failed: Copilot failed");
  });

  it("cancels active requests", async () => {
    let release!: () => void;
    sendRequest.mockResolvedValue({
      stream: (async function* stream() {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      })(),
    });

    const { CopilotBridge } = await import("./copilot-bridge.js");
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    };
    const bridge = new CopilotBridge(logger as never);
    const executePromise = bridge.executeRequest(
      {
        type: "request",
        id: "req-1",
        model: "copilot-gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
      },
      vi.fn(),
    );

    await vi.waitFor(() => expect(sendRequest).toHaveBeenCalled());
    bridge.cancel("req-1");
    expect(CancellationTokenSource.instances[0]?.cancel).toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith("Cancelling Copilot request req-1.");
    release();
    await executePromise;
  });
});
