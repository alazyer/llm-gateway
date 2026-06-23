import type {
  ChatCompletionChoice,
  ChatCompletionUsage,
  ChatToolCallDelta,
} from "../contracts.js";
import {
  buildResponseFunctionCall,
  buildResponseOutputMessage,
  normalizeSamplingOptions,
  translateChatCompletionUsage,
  type ResponseTranslationOptions,
  type ResponsesError,
  type ResponsesFunctionCallOutput,
  type ResponsesOutputItem,
  type ResponsesStyleResponse,
  type ResponsesUsage,
} from "./response.js";
import { isRecord, expectString, expectNumber, formatSseEvent, extractDataFrame } from "../shared.js";

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

interface ResponseFailedEvent {
  type: "response.failed";
  response_id: string | null;
  error: ResponsesError;
  response?: ResponsesStyleResponse;
}

interface ResponseCreatedEvent {
  type: "response.created";
  response: ResponsesStyleResponse;
}

interface ResponseOutputItemAddedEvent {
  type: "response.output_item.added";
  response_id: string;
  output_index: number;
  item: ResponsesOutputItem;
}

interface ResponseContentPartAddedEvent {
  type: "response.content_part.added";
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: 0;
  part: {
    type: "output_text";
    text: string;
  };
}

interface ResponseOutputTextDeltaEvent {
  type: "response.output_text.delta";
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: 0;
  delta: string;
}

interface ResponseFunctionCallArgumentsDeltaEvent {
  type: "response.function_call_arguments.delta";
  response_id: string;
  item_id: string;
  output_index: number;
  call_id: string;
  delta: string;
}

interface ResponseFunctionCallArgumentsDoneEvent {
  type: "response.function_call_arguments.done";
  response_id: string;
  item_id: string;
  output_index: number;
  call_id: string;
  arguments: string;
}

interface ResponseOutputTextDoneEvent {
  type: "response.output_text.done";
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: 0;
  text: string;
}

interface ResponseContentPartDoneEvent {
  type: "response.content_part.done";
  response_id: string;
  item_id: string;
  output_index: number;
  content_index: 0;
  part: {
    type: "output_text";
    text: string;
  };
}

interface ResponseOutputItemDoneEvent {
  type: "response.output_item.done";
  response_id: string;
  output_index: number;
  item: ResponsesOutputItem;
}

interface ResponseCompletedEvent {
  type: "response.completed";
  response: ResponsesStyleResponse;
}

interface ToolCallState {
  outputIndex: number;
  callId: string;
  name: string;
  arguments: string;
  itemAdded: boolean;
}


function normalizeChunkContent(
  choices: ChatCompletionChoice[],
  responseContext: string,
): { content: string; toolCallDeltas: ChatToolCallDelta[]; isTerminal: boolean } {
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error(`${responseContext}.choices must be a non-empty array.`);
  }

  let content = "";
  const toolCallDeltas: ChatToolCallDelta[] = [];
  let isTerminal = true;

  for (const [index, choice] of choices.entries()) {
    if (!isRecord(choice)) {
      throw new Error(`${responseContext}.choices[${index}] must be an object.`);
    }

    if (choice.delta !== undefined) {
      if (!isRecord(choice.delta)) {
        throw new Error(
          `${responseContext}.choices[${index}].delta must be an object.`,
        );
      }

      if (choice.delta.content !== undefined) {
        content += expectString(
          choice.delta.content,
          `${responseContext}.choices[${index}].delta.content`,
        );
      }

      if (Array.isArray(choice.delta.tool_calls)) {
        toolCallDeltas.push(...(choice.delta.tool_calls as ChatToolCallDelta[]));
      }
    }

    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      expectString(
        choice.finish_reason,
        `${responseContext}.choices[${index}].finish_reason`,
      );
      continue;
    }

    isTerminal = false;
  }

  return { content, toolCallDeltas, isTerminal };
}

export class ChatCompletionStreamTranslator {
  private readonly decoder = new TextDecoder();
  private readonly options: ResponseTranslationOptions;
  private buffer = "";
  private responseId?: string;
  private createdAt?: number;
  private model?: string;
  private outputText = "";
  private usage?: ResponsesUsage;
  private started = false;
  private createdEmitted = false;
  private terminal = false;

  // Output item tracking
  private nextOutputIndex = 0;
  private textOutputIndex: number | null = null;
  private textContentPartAdded = false;
  private toolStates = new Map<number, ToolCallState>();
  private completedToolIndices: number[] = [];
  private hasToolCalls = false;

  constructor(options: ResponseTranslationOptions = {}) {
    this.options = normalizeSamplingOptions(options);
  }

  push(chunk: string | Uint8Array): string[] {
    if (this.terminal) {
      return [];
    }

    this.buffer +=
      typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    this.buffer = this.buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    const events: string[] = [];

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

      events.push(...this.translateFrame(frame));

      if (this.terminal) {
        this.buffer = "";
        break;
      }
    }

    return events;
  }

  flush(): string[] {
    if (this.terminal) {
      return [];
    }

    if (this.buffer.trim().length > 0) {
      return [
        this.fail(
          "upstream stream ended with an incomplete SSE frame.",
          "invalid_upstream_chunk",
        ),
      ];
    }

    if (!this.started) {
      return [];
    }

    return [
      this.fail(
        "upstream stream ended before emitting a terminal chunk or [DONE].",
        "invalid_upstream_chunk",
      ),
    ];
  }

  private translateFrame(frame: string): string[] {
    const data = extractDataFrame(frame);
    if (data === null) {
      return [
        this.fail(
          "upstream SSE frame is missing a data field.",
          "invalid_upstream_chunk",
        ),
      ];
    }

    if (data === "[DONE]") {
      return this.complete();
    }

    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return [
        this.fail(
          "upstream SSE data must be valid JSON.",
          "invalid_upstream_chunk",
        ),
      ];
    }

    if (!isRecord(payload)) {
      return [
        this.fail(
          "upstream SSE data must decode to an object.",
          "invalid_upstream_chunk",
        ),
      ];
    }

    try {
      if (payload.error !== undefined) {
        return [this.handleUpstreamError(payload.error)];
      }

      return this.handleChunk(payload as ChatCompletionStreamChunk);
    } catch (error) {
      if (error instanceof Error) {
        return [this.fail(error.message, "invalid_upstream_chunk")];
      }

      throw error;
    }
  }

  private handleChunk(chunk: ChatCompletionStreamChunk): string[] {
    const id = expectString(chunk.id, "chunk.id");
    const createdAt = expectNumber(chunk.created, "chunk.created");
    const model = expectString(chunk.model, "chunk.model");

    if (!this.started) {
      this.responseId = id;
      this.createdAt = createdAt;
      this.model = model;
      this.started = true;
    } else {
      this.assertStableIdentity(id, createdAt, model);
    }

    const events: string[] = [];
    if (!this.createdEmitted) {
      this.createdEmitted = true;
      events.push(this.emitCreated());
    }

    const { content, toolCallDeltas, isTerminal } = normalizeChunkContent(
      chunk.choices ?? [],
      "chunk",
    );

    // Handle text content
    if (content.length > 0) {
      events.push(...this.ensureTextOutputLifecycle());
      this.outputText += content;
      const deltaEvent: ResponseOutputTextDeltaEvent = {
        type: "response.output_text.delta",
        response_id: this.responseId!,
        item_id: this.getOutputItemId(this.textOutputIndex!),
        output_index: this.textOutputIndex!,
        content_index: 0,
        delta: content,
      };
      events.push(formatSseEvent("response.output_text.delta", deltaEvent));
    }

    // Handle tool call deltas
    for (const toolDelta of toolCallDeltas) {
      events.push(...this.handleToolCallDelta(toolDelta));
    }

    if (chunk.usage !== undefined) {
      this.usage = translateChatCompletionUsage(chunk.usage, "chunk.usage");
    }

    if (isTerminal) {
      events.push(...this.complete());
    }

    return events;
  }

  private ensureTextOutputLifecycle(): string[] {
    const events: string[] = [];

    if (this.textOutputIndex === null) {
      this.textOutputIndex = this.nextOutputIndex++;
      const itemEvent: ResponseOutputItemAddedEvent = {
        type: "response.output_item.added",
        response_id: this.responseId!,
        output_index: this.textOutputIndex,
        item: buildResponseOutputMessage(
          this.responseId!,
          this.outputText,
          this.textOutputIndex,
          "in_progress",
        ),
      };
      events.push(formatSseEvent("response.output_item.added", itemEvent));
    }

    if (!this.textContentPartAdded) {
      this.textContentPartAdded = true;
      const partEvent: ResponseContentPartAddedEvent = {
        type: "response.content_part.added",
        response_id: this.responseId!,
        item_id: this.getOutputItemId(this.textOutputIndex!),
        output_index: this.textOutputIndex!,
        content_index: 0,
        part: {
          type: "output_text",
          text: this.outputText,
        },
      };
      events.push(formatSseEvent("response.content_part.added", partEvent));
    }

    return events;
  }

  private handleToolCallDelta(toolDelta: ChatToolCallDelta): string[] {
    const events: string[] = [];
    const toolIndex = expectNumber(toolDelta.index, "chunk.choices[0].delta.tool_calls[].index");

    let state = this.toolStates.get(toolIndex);
    if (!state) {
      const outputIndex = this.nextOutputIndex++;
      const callId =
        typeof toolDelta.id === "string" && toolDelta.id.length > 0
          ? toolDelta.id
          : `${this.responseId!}:tool:${toolIndex}`;
      const name =
        typeof toolDelta.function?.name === "string" && toolDelta.function.name.length > 0
          ? toolDelta.function.name
          : "tool";

      state = {
        outputIndex,
        callId,
        name,
        arguments: "",
        itemAdded: false,
      };
      this.toolStates.set(toolIndex, state);
      this.hasToolCalls = true;
    }

    // Update call_id if provided later
    if (typeof toolDelta.id === "string" && toolDelta.id.length > 0) {
      state.callId = toolDelta.id;
    }

    // Update name if provided later
    if (typeof toolDelta.function?.name === "string" && toolDelta.function.name.length > 0) {
      state.name = toolDelta.function.name;
    }

    // Emit output_item.added for the function_call
    if (!state.itemAdded) {
      state.itemAdded = true;
      const itemEvent: ResponseOutputItemAddedEvent = {
        type: "response.output_item.added",
        response_id: this.responseId!,
        output_index: state.outputIndex,
        item: buildResponseFunctionCall(
          this.responseId!,
          {
            id: state.callId,
            type: "function",
            function: { name: state.name, arguments: "" },
          },
          state.outputIndex,
          "in_progress",
        ),
      };
      events.push(formatSseEvent("response.output_item.added", itemEvent));
    }

    // Emit argument deltas
    if (typeof toolDelta.function?.arguments === "string") {
      const partialArgs = toolDelta.function.arguments;
      state.arguments += partialArgs;

      const argsDeltaEvent: ResponseFunctionCallArgumentsDeltaEvent = {
        type: "response.function_call_arguments.delta",
        response_id: this.responseId!,
        item_id: this.getOutputItemId(state.outputIndex),
        output_index: state.outputIndex,
        call_id: state.callId,
        delta: partialArgs,
      };
      events.push(
        formatSseEvent("response.function_call_arguments.delta", argsDeltaEvent),
      );
    }

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

  private emitCreated(): string {
    const event: ResponseCreatedEvent = {
      type: "response.created",
      response: this.buildResponse("in_progress"),
    };

    return formatSseEvent("response.created", event);
  }

  private complete(): string[] {
    if (this.terminal) {
      return [];
    }

    if (!this.started) {
      return [
        this.fail(
          "received [DONE] before any upstream response chunk.",
          "invalid_upstream_chunk",
        ),
      ];
    }

    this.terminal = true;
    const events: string[] = [];

    // Close text output if active
    if (this.textOutputIndex !== null) {
      const textItemId = this.getOutputItemId(this.textOutputIndex);
      const doneEvent: ResponseOutputTextDoneEvent = {
        type: "response.output_text.done",
        response_id: this.responseId!,
        item_id: textItemId,
        output_index: this.textOutputIndex,
        content_index: 0,
        text: this.outputText,
      };
      const partDoneEvent: ResponseContentPartDoneEvent = {
        type: "response.content_part.done",
        response_id: this.responseId!,
        item_id: textItemId,
        output_index: this.textOutputIndex,
        content_index: 0,
        part: {
          type: "output_text",
          text: this.outputText,
        },
      };
      const itemDoneEvent: ResponseOutputItemDoneEvent = {
        type: "response.output_item.done",
        response_id: this.responseId!,
        output_index: this.textOutputIndex,
        item: buildResponseOutputMessage(
          this.responseId!,
          this.outputText,
          this.textOutputIndex,
          "completed",
        ),
      };
      events.push(
        formatSseEvent("response.output_text.done", doneEvent),
        formatSseEvent("response.content_part.done", partDoneEvent),
        formatSseEvent("response.output_item.done", itemDoneEvent),
      );
    }

    // Close all tool call outputs
    for (const state of this.toolStates.values()) {
      const argsDoneEvent: ResponseFunctionCallArgumentsDoneEvent = {
        type: "response.function_call_arguments.done",
        response_id: this.responseId!,
        item_id: this.getOutputItemId(state.outputIndex),
        output_index: state.outputIndex,
        call_id: state.callId,
        arguments: state.arguments,
      };
      const itemDoneEvent: ResponseOutputItemDoneEvent = {
        type: "response.output_item.done",
        response_id: this.responseId!,
        output_index: state.outputIndex,
        item: buildResponseFunctionCall(
          this.responseId!,
          {
            id: state.callId,
            type: "function",
            function: { name: state.name, arguments: state.arguments },
          },
          state.outputIndex,
          "completed",
        ),
      };
      events.push(
        formatSseEvent("response.function_call_arguments.done", argsDoneEvent),
        formatSseEvent("response.output_item.done", itemDoneEvent),
      );
      this.completedToolIndices.push(state.outputIndex);
    }

    const completedEvent: ResponseCompletedEvent = {
      type: "response.completed",
      response: this.buildResponse("completed"),
    };
    events.push(formatSseEvent("response.completed", completedEvent));

    return events;
  }

  private handleUpstreamError(error: unknown): string {
    if (!isRecord(error)) {
      return this.fail("upstream error payload must be an object.", "upstream_error");
    }

    const message =
      error.message === undefined
        ? "upstream stream returned an error without a message."
        : expectString(error.message, "error.message");
    const type =
      error.type === undefined ? "upstream_error" : expectString(error.type, "error.type");

    return this.fail(message, type);
  }

  private fail(message: string, type: string): string {
    this.terminal = true;

    const event: ResponseFailedEvent = {
      type: "response.failed",
      response_id: this.responseId ?? null,
      error: { type, message },
    };

    if (this.started) {
      event.response = this.buildResponse("failed", { type, message });
    }

    return formatSseEvent("response.failed", event);
  }

  private buildResponse(
    status: ResponsesStyleResponse["status"],
    error?: ResponsesError,
  ): ResponsesStyleResponse {
    const output: ResponsesOutputItem[] = [];

    if (this.textOutputIndex !== null) {
      output.push(
        buildResponseOutputMessage(
          this.responseId!,
          this.outputText,
          this.textOutputIndex,
          status === "completed" ? "completed" : "in_progress",
        ),
      );
    }

    for (const state of this.toolStates.values()) {
      output.push(
        buildResponseFunctionCall(
          this.responseId!,
          {
            id: state.callId,
            type: "function",
            function: { name: state.name, arguments: state.arguments },
          },
          state.outputIndex,
          status === "completed" ? "completed" : "in_progress",
        ),
      );
    }

    const response: ResponsesStyleResponse = {
      id: this.responseId!,
      object: "response",
      created_at: this.createdAt!,
      model: this.options.model ?? this.model!,
      status,
      output,
      output_text: this.outputText,
      parallel_tool_calls: this.hasToolCalls,
      tool_choice: this.hasToolCalls ? "auto" : "none",
    };

    if (this.options.temperature !== undefined) {
      response.temperature = this.options.temperature;
    }

    if (this.options.top_p !== undefined) {
      response.top_p = this.options.top_p;
    }

    if (this.usage !== undefined) {
      response.usage = this.usage;
    }

    if (error !== undefined) {
      response.error = error;
    }

    return response;
  }

  private getOutputItemId(outputIndex: number): string {
    return `${this.responseId!}:output:${outputIndex}`;
  }
}

export function createChatCompletionStreamTranslator(
  options: ResponseTranslationOptions = {},
): ChatCompletionStreamTranslator {
  return new ChatCompletionStreamTranslator(options);
}

interface TranslateChatCompletionStreamOptions extends ResponseTranslationOptions {
  responseRequest?: {
    model?: unknown;
    temperature?: unknown;
    top_p?: unknown;
  };
}

function resolveTranslatorOptions(
  options: TranslateChatCompletionStreamOptions = {},
): ResponseTranslationOptions {
  const resolved: ResponseTranslationOptions = {};

  const temperature =
    options.temperature ?? (isRecord(options.responseRequest) ? options.responseRequest.temperature : undefined);
  if (temperature !== undefined) {
    resolved.temperature = expectNumber(temperature, "temperature");
  }

  const topP = options.top_p ?? (isRecord(options.responseRequest) ? options.responseRequest.top_p : undefined);
  if (topP !== undefined) {
    resolved.top_p = expectNumber(topP, "top_p");
  }

  const model =
    options.model ??
    (isRecord(options.responseRequest) ? options.responseRequest.model : undefined);
  if (model !== undefined) {
    resolved.model = expectString(model, "model");
  }

  return resolved;
}

export async function* translateChatCompletionStream(
  upstreamStream: ReadableStream<Uint8Array>,
  options: TranslateChatCompletionStreamOptions = {},
): AsyncGenerator<string> {
  const translator = createChatCompletionStreamTranslator(resolveTranslatorOptions(options));
  const reader = upstreamStream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (value !== undefined) {
        yield* translator.push(value);
      }
    }

    yield* translator.flush();
  } finally {
    reader.releaseLock();
  }
}
