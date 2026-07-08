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

class ToolResultPart {
  public constructor(
    public readonly callId: string,
    public readonly content: Array<TextPart>,
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

// LanguageModelChatTool is an interface (not a constructor class), so
// we just create matching plain objects in tests.

const LanguageModelChatToolMode = {
  Auto: 1,
  Required: 2,
} as const;

const selectChatModels = vi.fn();
const sendRequest = vi.fn();

vi.mock("vscode", () => ({
  lm: {
    selectChatModels,
  },
  LanguageModelTextPart: TextPart,
  LanguageModelToolCallPart: ToolCallPart,
  LanguageModelToolResultPart: ToolResultPart,
  CancellationTokenSource,
  LanguageModelChatToolMode: {
    Auto: 1,
    Required: 2,
  },
  LanguageModelChatMessage: {
    User: (content: string | Array<unknown>) => ({ role: "user", content }),
    Assistant: (content: string | Array<unknown>) => ({ role: "assistant", content }),
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
        capabilities: { toolCalling: true },
        sendRequest,
      },
    ]);
  });

  it("discovers Copilot models and maps them to gateway IDs with tool calling", async () => {
    const { CopilotBridge } = await import("./copilot-bridge.js");
    const bridge = new CopilotBridge();

    await expect(bridge.discoverModels()).resolves.toEqual([
      {
        id: "copilot-gpt-4o",
        name: "GPT-4o",
        native_id: "gpt-4o",
        source: "copilot-",
        capabilities: {
          supports_streaming: true,
          supports_tools: true,
          supports_usage: false,
          supports_progress: false,
          max_tokens: 100000,
        },
      },
    ]);
  });

  it("uses a custom model prefix for gateway IDs and source", async () => {
    const { CopilotBridge } = await import("./copilot-bridge.js");
    const bridge = new CopilotBridge("alazyer-");

    await expect(bridge.discoverModels()).resolves.toEqual([
      {
        id: "alazyer-gpt-4o",
        name: "GPT-4o",
        native_id: "gpt-4o",
        source: "alazyer-",
        capabilities: {
          supports_streaming: true,
          supports_tools: true,
          supports_usage: false,
          supports_progress: false,
          max_tokens: 100000,
        },
      },
    ]);
  });

  it("maps toolCalling=false to supports_tools=false", async () => {
    selectChatModels.mockResolvedValue([
      {
        id: "gpt-4o-mini",
        name: "GPT-4o Mini",
        vendor: "copilot",
        family: "gpt-4o-mini",
        version: "1",
        maxInputTokens: 50000,
        capabilities: { toolCalling: false },
        sendRequest,
      },
    ]);
    const { CopilotBridge } = await import("./copilot-bridge.js");
    const bridge = new CopilotBridge();
    const models = await bridge.discoverModels();

    expect(models[0]?.capabilities.supports_tools).toBe(false);
  });

  it("maps toolCalling as number to supports_tools=true (runtime capabilities)", async () => {
    selectChatModels.mockResolvedValue([
      {
        id: "gpt-4o",
        name: "GPT-4o",
        vendor: "copilot",
        family: "gpt-4o",
        version: "1",
        maxInputTokens: 100000,
        capabilities: { toolCalling: 5 },
        sendRequest,
      },
    ]);
    const { CopilotBridge } = await import("./copilot-bridge.js");
    const bridge = new CopilotBridge();
    const models = await bridge.discoverModels();

    expect(models[0]?.capabilities.supports_tools).toBe(true);
  });

  it("defaults to supports_tools=true when capabilities.toolCalling is absent", async () => {
    selectChatModels.mockResolvedValue([
      {
        id: "gpt-4o",
        name: "GPT-4o",
        vendor: "copilot",
        family: "gpt-4o",
        version: "1",
        maxInputTokens: 100000,
        capabilities: {},
        sendRequest,
      },
    ]);
    const { CopilotBridge } = await import("./copilot-bridge.js");
    const bridge = new CopilotBridge();
    const models = await bridge.discoverModels();

    // Default is true because Copilot models support tool calling via stable API
    expect(models[0]?.capabilities.supports_tools).toBe(true);
  });

  it("defaults to supports_tools=true when model has no capabilities property", async () => {
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
    const { CopilotBridge } = await import("./copilot-bridge.js");
    const bridge = new CopilotBridge();
    const models = await bridge.discoverModels();

    // Default is true because Copilot models support tool calling via stable API
    expect(models[0]?.capabilities.supports_tools).toBe(true);
  });

  it("streams text output and completion frames", async () => {
    async function* stream() {
      yield new TextPart("hello");
      yield new TextPart(" world");
    }
    sendRequest.mockResolvedValue({ stream: stream() });

    const { CopilotBridge } = await import("./copilot-bridge.js");
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    };
    const bridge = new CopilotBridge("copilot-", logger as never);
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

  it("passes request tools to Copilot as LanguageModelChatTool objects", async () => {
    async function* stream() {
      yield new TextPart("result");
    }
    sendRequest.mockResolvedValue({ stream: stream() });

    const { CopilotBridge } = await import("./copilot-bridge.js");
    const bridge = new CopilotBridge();
    const sent: CopilotProxyExtensionMessage[] = [];

    await bridge.executeRequest(
      {
        type: "request",
        id: "req-tools-1",
        model: "copilot-gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              description: "Look up docs",
              parameters: { type: "object", properties: { q: { type: "string" } } },
            },
          },
        ],
      },
      (message) => sent.push(message),
    );

    expect(sendRequest).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "Hello" }),
      ]),
      expect.objectContaining({
        justification: expect.any(String),
        tools: expect.arrayContaining([
          expect.objectContaining({
            name: "lookup",
            description: "Look up docs",
            inputSchema: { type: "object", properties: { q: { type: "string" } } },
          }),
        ]),
      }),
      expect.any(Object),
    );

    // Should not send a stream_error with tools_unsupported
    const errors = sent.filter(
      (m) => m.type === "stream_error" && "error" in m && m.error.code === "tools_unsupported",
    );
    expect(errors).toHaveLength(0);
  });

  it("maps tool_choice=auto to LanguageModelChatToolMode.Auto", async () => {
    async function* stream() {
      yield new TextPart("ok");
    }
    sendRequest.mockResolvedValue({ stream: stream() });

    const { CopilotBridge } = await import("./copilot-bridge.js");
    const bridge = new CopilotBridge();

    await bridge.executeRequest(
      {
        type: "request",
        id: "req-tc-auto",
        model: "copilot-gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        tools: [{ type: "function", function: { name: "lookup" } }],
        params: { tool_choice: "auto" },
      },
      vi.fn(),
    );

    expect(sendRequest).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        toolMode: LanguageModelChatToolMode.Auto,
      }),
      expect.any(Object),
    );
  });

  it("maps tool_choice=required to LanguageModelChatToolMode.Required", async () => {
    async function* stream() {
      yield new TextPart("ok");
    }
    sendRequest.mockResolvedValue({ stream: stream() });

    const { CopilotBridge } = await import("./copilot-bridge.js");
    const bridge = new CopilotBridge();

    await bridge.executeRequest(
      {
        type: "request",
        id: "req-tc-required",
        model: "copilot-gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        tools: [{ type: "function", function: { name: "lookup" } }],
        params: { tool_choice: "required" },
      },
      vi.fn(),
    );

    expect(sendRequest).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        toolMode: LanguageModelChatToolMode.Required,
      }),
      expect.any(Object),
    );
  });

  it("maps tool_choice=none to undefined toolMode", async () => {
    async function* stream() {
      yield new TextPart("ok");
    }
    sendRequest.mockResolvedValue({ stream: stream() });

    const { CopilotBridge } = await import("./copilot-bridge.js");
    const bridge = new CopilotBridge();

    await bridge.executeRequest(
      {
        type: "request",
        id: "req-tc-none",
        model: "copilot-gpt-4o",
        messages: [{ role: "user", content: "Hello" }],
        tools: [{ type: "function", function: { name: "lookup" } }],
        params: { tool_choice: "none" },
      },
      vi.fn(),
    );

    expect(sendRequest).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        tools: expect.any(Array),
      }),
      expect.any(Object),
    );

    // toolMode should NOT be set in the request options
    const callArgs = sendRequest.mock.calls[0] as [unknown, unknown, unknown];
    const options = callArgs[1] as Record<string, unknown>;
    expect(options.toolMode).toBeUndefined();
  });

  it("maps tool-role messages to User messages with LanguageModelToolResultPart", async () => {
    async function* stream() {
      yield new TextPart("result");
    }
    sendRequest.mockResolvedValue({ stream: stream() });

    const { CopilotBridge } = await import("./copilot-bridge.js");
    const bridge = new CopilotBridge();

    await bridge.executeRequest(
      {
        type: "request",
        id: "req-tool-msg",
        model: "copilot-gpt-4o",
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: '{"q":"docs"}' } }] },
          { role: "tool", content: "Documentation found", tool_call_id: "call-1" },
        ],
        tools: [{ type: "function", function: { name: "lookup" } }],
      },
      vi.fn(),
    );

    const callArgs = sendRequest.mock.calls[0] as [Array<unknown>, unknown, unknown];
    const messages = callArgs[0] as Array<Record<string, unknown>>;

    // Tool-role message should be a User message containing ToolResultPart
    const toolMessage = messages.find(
      (m) => m.role === "user" && Array.isArray(m.content) && m.content.some((p: Record<string, unknown>) => p.callId === "call-1"),
    );
    expect(toolMessage).toBeDefined();
  });

  it("maps assistant messages with tool_calls to Assistant messages with ToolCallPart", async () => {
    async function* stream() {
      yield new TextPart("result");
    }
    sendRequest.mockResolvedValue({ stream: stream() });

    const { CopilotBridge } = await import("./copilot-bridge.js");
    const bridge = new CopilotBridge();

    await bridge.executeRequest(
      {
        type: "request",
        id: "req-assistant-tools",
        model: "copilot-gpt-4o",
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: '{"q":"docs"}' } }] },
          { role: "tool", content: "Documentation found", tool_call_id: "call-1" },
        ],
        tools: [{ type: "function", function: { name: "lookup" } }],
      },
      vi.fn(),
    );

    const callArgs = sendRequest.mock.calls[0] as [Array<unknown>, unknown, unknown];
    const messages = callArgs[0] as Array<Record<string, unknown>>;

    // Assistant message with tool_calls should be an Assistant message with array content
    const assistantMessage = messages.find((m) => m.role === "assistant" && Array.isArray(m.content));
    expect(assistantMessage).toBeDefined();

    // The array should contain a ToolCallPart-like object
    const content = assistantMessage!.content as Array<Record<string, unknown>>;
    const toolCallPart = content.find((p) => p.name === "lookup" && p.callId === "call-1");
    expect(toolCallPart).toBeDefined();
  });

  it("maps system-role messages to User messages (stable API workaround)", async () => {
    async function* stream() {
      yield new TextPart("ok");
    }
    sendRequest.mockResolvedValue({ stream: stream() });

    const { CopilotBridge } = await import("./copilot-bridge.js");
    const bridge = new CopilotBridge();

    await bridge.executeRequest(
      {
        type: "request",
        id: "req-system-msg",
        model: "copilot-gpt-4o",
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: "Hello" },
        ],
      },
      vi.fn(),
    );

    const callArgs = sendRequest.mock.calls[0] as [Array<unknown>, unknown, unknown];
    const messages = callArgs[0] as Array<Record<string, unknown>>;

    // System-role message should be mapped to a User message with the same content
    const systemMessage = messages.find(
      (m) => m.role === "user" && m.content === "You are a helpful assistant.",
    );
    expect(systemMessage).toBeDefined();
  });

  it("maps developer-role messages to User messages (stable API workaround)", async () => {
    async function* stream() {
      yield new TextPart("ok");
    }
    sendRequest.mockResolvedValue({ stream: stream() });

    const { CopilotBridge } = await import("./copilot-bridge.js");
    const bridge = new CopilotBridge();

    await bridge.executeRequest(
      {
        type: "request",
        id: "req-developer-msg",
        model: "copilot-gpt-4o",
        messages: [
          { role: "developer", content: "Always respond concisely." },
          { role: "user", content: "Hello" },
        ],
      },
      vi.fn(),
    );

    const callArgs = sendRequest.mock.calls[0] as [Array<unknown>, unknown, unknown];
    const messages = callArgs[0] as Array<Record<string, unknown>>;

    // Developer-role message should be mapped to a User message with the same content
    const developerMessage = messages.find(
      (m) => m.role === "user" && m.content === "Always respond concisely.",
    );
    expect(developerMessage).toBeDefined();
  });

  it("handles full multi-turn tool conversation flow", async () => {
    async function* stream() {
      yield new TextPart("The documentation says...");
    }
    sendRequest.mockResolvedValue({ stream: stream() });

    const { CopilotBridge } = await import("./copilot-bridge.js");
    const bridge = new CopilotBridge();

    await bridge.executeRequest(
      {
        type: "request",
        id: "req-multi-turn",
        model: "copilot-gpt-4o",
        messages: [
          { role: "user", content: "Look up docs about X" },
          { role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: '{"q":"X"}' } }] },
          { role: "tool", content: "Documentation for X found", tool_call_id: "call-1" },
        ],
        tools: [{ type: "function", function: { name: "lookup" } }],
      },
      vi.fn(),
    );

    const callArgs = sendRequest.mock.calls[0] as [Array<unknown>, unknown, unknown];
    const messages = callArgs[0] as Array<Record<string, unknown>>;

    // Turn 1: User message
    expect(messages[0]).toEqual({ role: "user", content: "Look up docs about X" });

    // Turn 2: Assistant message with ToolCallPart
    const assistantMsg = messages[1]!;
    expect(assistantMsg.role).toBe("assistant");
    expect(Array.isArray(assistantMsg.content)).toBe(true);
    const assistantParts = assistantMsg.content as Array<Record<string, unknown>>;
    const toolCallPart = assistantParts.find((p) => p.callId === "call-1" && p.name === "lookup");
    expect(toolCallPart).toBeDefined();
    expect(toolCallPart!.input).toEqual({ q: "X" });

    // Turn 3: Tool result as User message with ToolResultPart
    const toolResultMsg = messages[2]!;
    expect(toolResultMsg.role).toBe("user");
    expect(Array.isArray(toolResultMsg.content)).toBe(true);
    const toolResultParts = toolResultMsg.content as Array<Record<string, unknown>>;
    const resultPart = toolResultParts.find((p) => p.callId === "call-1");
    expect(resultPart).toBeDefined();
    // The ToolResultPart's content should contain the tool result text
    const resultContent = resultPart!.content as Array<Record<string, unknown>>;
    expect(resultContent[0]?.value).toBe("Documentation for X found");
  });

  it("warns when tool-role message has missing tool_call_id", async () => {
    async function* stream() {
      yield new TextPart("ok");
    }
    sendRequest.mockResolvedValue({ stream: stream() });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { CopilotBridge } = await import("./copilot-bridge.js");
    const bridge = new CopilotBridge();

    await bridge.executeRequest(
      {
        type: "request",
        id: "req-no-tool-call-id",
        model: "copilot-gpt-4o",
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
          { role: "tool", content: "Result" } as Record<string, unknown> & { role: "tool"; content: string },
        ],
        tools: [{ type: "function", function: { name: "lookup" } }],
      },
      vi.fn(),
    );

    // Should have warned about missing tool_call_id
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("missing tool_call_id"),
    );

    // Should still map the message (graceful degradation)
    const callArgs = sendRequest.mock.calls[0] as [Array<unknown>, unknown, unknown];
    const messages = callArgs[0] as Array<Record<string, unknown>>;
    const toolResultMsg = messages.find(
      (m) => m.role === "user" && Array.isArray(m.content),
    );
    expect(toolResultMsg).toBeDefined();

    warnSpy.mockRestore();
  });

  it("returns stream errors when Copilot request execution fails", async () => {
    sendRequest.mockRejectedValue(new Error("Copilot failed"));

    const { CopilotBridge } = await import("./copilot-bridge.js");
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    };
    const bridge = new CopilotBridge("copilot-", logger as never);
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
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    };
    const bridge = new CopilotBridge("copilot-", logger as never);
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
