import type {
  AnthropicMessageResponse,
  AnthropicTextBlock,
  AnthropicStopReason,
  AnthropicToolUseBlock,
  ChatCompletionChoice,
  ChatCompletionUsage,
} from "../../contracts.js";
import { mapChatFinishReasonToAnthropic } from "./response.js";

interface AnthropicStreamTranslationOptions {
  model?: string;
}

interface ChatCompletionStreamChunk {
  id?: string;
  created?: number;
  model?: string;
  choices?: ChatCompletionChoice[];
  usage?: ChatCompletionUsage;
  error?: {
    message?: unknown;
    type?: unknown;
  };
}

interface ToolCallState {
  blockIndex: number;
  id: string;
  name: string;
  inputText: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectString(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new Error(`${context} must be a string.`);
  }

  return value;
}

function expectNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`${context} must be a number.`);
  }

  return value;
}

function formatSseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function extractDataFrame(frame: string): string | null {
  const dataLines: string[] = [];

  for (const line of frame.split("\n")) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  return dataLines.length > 0 ? dataLines.join("\n") : null;
}

function getFirstChoice(choices: ChatCompletionChoice[], context: string): ChatCompletionChoice {
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error(`${context}.choices must be a non-empty array.`);
  }

  const [choice] = choices;
  if (!choice || !isRecord(choice)) {
    throw new Error(`${context}.choices[0] must be an object.`);
  }

  return choice;
}

function buildEmptyMessage(
  id: string,
  model: string,
): AnthropicMessageResponse {
  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
    },
  };
}

function createAnthropicMessageStartEvent(
  message: AnthropicMessageResponse,
): string {
  return formatSseEvent("message_start", {
    type: "message_start",
    message: {
      ...message,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: message.usage.input_tokens,
        output_tokens: 0,
      },
    },
  });
}

function createAnthropicTextBlockEvents(
  block: AnthropicTextBlock,
  index: number,
): string[] {
  const events = [
    formatSseEvent("content_block_start", {
      type: "content_block_start",
      index,
      content_block: {
        type: "text",
        text: "",
      },
    }),
  ];

  if (block.text.length > 0) {
    events.push(
      formatSseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: {
          type: "text_delta",
          text: block.text,
        },
      }),
    );
  }

  events.push(
    formatSseEvent("content_block_stop", {
      type: "content_block_stop",
      index,
    }),
  );

  return events;
}

function createAnthropicToolUseBlockEvents(
  block: AnthropicToolUseBlock,
  index: number,
): string[] {
  const events = [
    formatSseEvent("content_block_start", {
      type: "content_block_start",
      index,
      content_block: {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: {},
      },
    }),
  ];

  const partialJson = JSON.stringify(block.input);
  if (partialJson !== "{}") {
    events.push(
      formatSseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: partialJson,
        },
      }),
    );
  }

  events.push(
    formatSseEvent("content_block_stop", {
      type: "content_block_stop",
      index,
    }),
  );

  return events;
}

export function createAnthropicMessageResponseStream(
  message: AnthropicMessageResponse,
): string[] {
  const events = [createAnthropicMessageStartEvent(message)];

  message.content.forEach((block, index) => {
    if (block.type === "text") {
      events.push(...createAnthropicTextBlockEvents(block, index));
      return;
    }

    events.push(...createAnthropicToolUseBlockEvents(block, index));
  });

  events.push(
    formatSseEvent("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: message.stop_reason,
        stop_sequence: message.stop_sequence,
      },
      usage: {
        output_tokens: message.usage.output_tokens,
      },
    }),
  );
  events.push(formatSseEvent("message_stop", { type: "message_stop" }));

  return events;
}

export class AnthropicMessageStreamTranslator {
  private readonly decoder = new TextDecoder();
  private readonly options: AnthropicStreamTranslationOptions;
  private buffer = "";
  private started = false;
  private terminal = false;
  private messageStartEmitted = false;
  private responseId?: string;
  private createdAt?: number;
  private model?: string;
  private finishReason: AnthropicStopReason | null = null;
  private activeTextBlockIndex: number | null = null;
  private textValue = "";
  private toolStates = new Map<number, ToolCallState>();
  private blockCount = 0;
  private usage?: ChatCompletionUsage;

  public constructor(options: AnthropicStreamTranslationOptions = {}) {
    this.options = options;
  }

  public push(chunk: string | Uint8Array): string[] {
    if (this.terminal) {
      return [];
    }

    this.buffer +=
      typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    this.buffer = this.buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    const frames: string[] = [];

    while (true) {
      const delimiterIndex = this.buffer.indexOf("\n\n");
      if (delimiterIndex === -1) {
        break;
      }

      const frame = this.buffer.slice(0, delimiterIndex);
      this.buffer = this.buffer.slice(delimiterIndex + 2);

      if (frame.trim().length === 0) {
        continue;
      }

      frames.push(...this.translateFrame(frame));
      if (this.terminal) {
        this.buffer = "";
        break;
      }
    }

    return frames;
  }

  public flush(): string[] {
    if (this.terminal) {
      return [];
    }

    if (this.buffer.trim().length > 0) {
      return [this.fail("upstream stream ended with an incomplete SSE frame.")];
    }

    if (!this.started) {
      return [];
    }

    return [this.fail("upstream stream ended before the Anthropic message completed.")];
  }

  private translateFrame(frame: string): string[] {
    const data = extractDataFrame(frame);
    if (data === null) {
      return [this.fail("upstream SSE frame is missing a data field.")];
    }

    if (data === "[DONE]") {
      return this.complete();
    }

    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return [this.fail("upstream SSE data must be valid JSON.")];
    }

    if (!isRecord(payload)) {
      return [this.fail("upstream SSE data must decode to an object.")];
    }

    if (payload.error !== undefined) {
      const error = isRecord(payload.error) ? payload.error : {};
      return [
        formatSseEvent("error", {
          type: "error",
          error: {
            type:
              typeof error.type === "string" ? error.type : "api_error",
            message:
              typeof error.message === "string"
                ? error.message
                : "Upstream stream returned an error.",
          },
        }),
      ];
    }

    try {
      return this.handleChunk(payload as ChatCompletionStreamChunk);
    } catch (error) {
      return [
        this.fail(error instanceof Error ? error.message : String(error)),
      ];
    }
  }

  private handleChunk(chunk: ChatCompletionStreamChunk): string[] {
    const id = expectString(chunk.id, "chunk.id");
    const createdAt = expectNumber(chunk.created, "chunk.created");
    const upstreamModel = expectString(chunk.model, "chunk.model");
    const model = this.options.model ?? upstreamModel;

    if (!this.started) {
      this.started = true;
      this.responseId = id;
      this.createdAt = createdAt;
      this.model = model;
    } else {
      this.assertStableIdentity(id, createdAt, model);
    }

    const events: string[] = [];
    if (!this.messageStartEmitted) {
      this.messageStartEmitted = true;
      events.push(
        formatSseEvent("message_start", {
          type: "message_start",
          message: buildEmptyMessage(this.responseId!, this.model!),
        }),
      );
    }

    const choice = getFirstChoice(chunk.choices ?? [], "chunk");
    const delta = choice.delta;

    if (delta?.content !== undefined) {
      if (this.activeTextBlockIndex === null) {
        this.activeTextBlockIndex = this.blockCount++;
        events.push(
          formatSseEvent("content_block_start", {
            type: "content_block_start",
            index: this.activeTextBlockIndex,
            content_block: {
              type: "text",
              text: "",
            },
          }),
        );
      }

      const text = expectString(delta.content, "chunk.choices[0].delta.content");
      this.textValue += text;
      events.push(
        formatSseEvent("content_block_delta", {
          type: "content_block_delta",
          index: this.activeTextBlockIndex,
          delta: {
            type: "text_delta",
            text,
          },
        }),
      );
    }

    for (const toolDelta of delta?.tool_calls ?? []) {
      const toolIndex = expectNumber(toolDelta.index, "chunk.choices[0].delta.tool_calls[].index");
      let state = this.toolStates.get(toolIndex);
      if (!state) {
        state = {
          blockIndex: this.blockCount++,
          id: toolDelta.id ?? `${this.responseId!}:tool:${toolIndex}`,
          name: toolDelta.function?.name ?? "tool",
          inputText: "",
        };
        this.toolStates.set(toolIndex, state);
        events.push(
          formatSseEvent("content_block_start", {
            type: "content_block_start",
            index: state.blockIndex,
            content_block: {
              type: "tool_use",
              id: state.id,
              name: state.name,
              input: {},
            },
          }),
        );
      }

      if (toolDelta.id) {
        state.id = toolDelta.id;
      }

      if (toolDelta.function?.name) {
        state.name = toolDelta.function.name;
      }

      if (toolDelta.function?.arguments) {
        const partialJson = expectString(
          toolDelta.function.arguments,
          "chunk.choices[0].delta.tool_calls[].function.arguments",
        );
        state.inputText += partialJson;
        events.push(
          formatSseEvent("content_block_delta", {
            type: "content_block_delta",
            index: state.blockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: partialJson,
            },
          }),
        );
      }
    }

    if (chunk.usage !== undefined) {
      this.usage = chunk.usage;
    }

    if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
      this.finishReason = mapChatFinishReasonToAnthropic(choice.finish_reason);
      events.push(...this.complete());
    }

    return events;
  }

  private complete(): string[] {
    if (this.terminal) {
      return [];
    }

    if (!this.started) {
      return [this.fail("received [DONE] before any upstream response chunk.")];
    }

    this.terminal = true;

    const events: string[] = [];

    const blockStops: number[] = [];
    if (this.activeTextBlockIndex !== null) {
      blockStops.push(this.activeTextBlockIndex);
      this.activeTextBlockIndex = null;
    }

    for (const toolState of this.toolStates.values()) {
      blockStops.push(toolState.blockIndex);
    }
    blockStops.sort((left, right) => left - right);

    for (const blockIndex of blockStops) {
      events.push(
        formatSseEvent("content_block_stop", {
          type: "content_block_stop",
          index: blockIndex,
        }),
      );
    }
    this.toolStates.clear();

    events.push(
      formatSseEvent("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: this.finishReason,
          stop_sequence: null,
        },
        usage: {
          output_tokens: this.usage?.completion_tokens ?? 0,
        },
      }),
    );
    events.push(formatSseEvent("message_stop", { type: "message_stop" }));

    return events;
  }

  private assertStableIdentity(id: string, createdAt: number, model: string): void {
    if (this.responseId !== id) {
      throw new Error("chunk.id must stay consistent across the stream.");
    }

    if (this.createdAt !== createdAt) {
      throw new Error("chunk.created must stay consistent across the stream.");
    }

    if (this.model !== model) {
      throw new Error("chunk.model must stay consistent across the stream.");
    }
  }

  private fail(message: string): string {
    this.terminal = true;
    return formatSseEvent("error", {
      type: "error",
      error: {
        type: "api_error",
        message,
      },
    });
  }
}

export function createAnthropicMessageStreamTranslator(
  options: AnthropicStreamTranslationOptions = {},
): AnthropicMessageStreamTranslator {
  return new AnthropicMessageStreamTranslator(options);
}
