import { Readable } from "node:stream";

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type {
  CopilotProxyRequestMessage,
  CopilotProxyRequestParams,
  CopilotProxyTool,
  CopilotProxyToolCallDelta,
  CopilotProxyUsage,
} from "@llm-gateway/shared";

import type {
  AnthropicMessagesRequest,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCompletionUsage,
  ChatMessage,
  ChatTool,
  ChatToolCall,
  ResponseInput,
  ResponseInputItem,
  ResponseMessageItem,
  ResponseRequest,
} from "../contracts.js";
import type { AppConfig, GatewayModelConfig } from "../config.js";
import type {
  CopilotProxyConnectionRegistry,
  CopilotProxyStreamMessage,
  RegisteredCopilotProxyModel,
} from "../copilot-proxy/registry.js";
import {
  buildChatCompletionRequestFromAnthropic,
  estimateAnthropicInputTokens,
} from "../translation/anthropic/request.js";
import { translateChatCompletionResponseToAnthropic } from "../translation/anthropic/response.js";
import {
  createAnthropicMessageResponseStream,
  createAnthropicMessageStreamTranslator,
} from "../translation/anthropic/stream.js";
import { buildChatCompletionRequest } from "../translation/request.js";
import { translateChatCompletionResponse } from "../translation/response.js";
import { createChatCompletionStreamTranslator } from "../translation/stream.js";
import {
  ChatCompletionsClient,
  type ChatCompletionsTransport,
  UpstreamHttpError,
} from "../upstream/chat-completions-client.js";
import { formatSseEvent, isRecord, toErrorMessage } from "../shared.js";

const metadataValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const requestBodySchema = z
  .object({
    model: z.string().optional(),
    input: z.unknown().optional(),
    instructions: z.string().optional(),
    stream: z.boolean().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    metadata: z.record(z.string(), metadataValueSchema).optional(),
    user: z.string().optional(),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
  })
  .passthrough();

const RESPONSES_ALLOWED_TOP_LEVEL_FIELDS = new Set([
  "model",
  "input",
  "instructions",
  "stream",
  "temperature",
  "top_p",
  "max_output_tokens",
  "metadata",
  "user",
  "tools",
  "tool_choice",
]);

interface ModelRecord {
  id: string;
  display_name: string;
  object: "model";
  created: number;
  owned_by: string;
  permission: [];
  root: string;
  parent: null;
  capabilities: {
    input_modalities: ["text"];
    output_modalities: ["text"];
    supports_responses_api: boolean;
    supports_streaming: boolean;
    supports_system_messages: true;
    supports_model_messages: true;
    supports_personality: true;
    supports_tool_calls: boolean;
    supports_parallel_tool_calls: boolean;
  };
  personality: "default";
  model_messages: [
    {
      role: "system";
      content: string;
    },
  ];
  base_instructions: string;
  source?: "copilot-proxy";
}

interface AnthropicModelRecord {
  id: string;
  type: "model";
  display_name: string;
  created_at: string;
  source?: "copilot-proxy";
}

interface ResponsesRoutesOptions {
  config: AppConfig;
  client?: ChatCompletionsTransport;
  fetchFn?: typeof fetch;
  copilotProxyRegistry?: CopilotProxyConnectionRegistry;
}

interface TranslationOptions {
  temperature?: number;
  top_p?: number;
  model?: string;
}

type ParsedResponseRequest = Omit<ResponseRequest, "model"> & { model?: string };
type ParsedAnthropicMessagesRequest = Omit<AnthropicMessagesRequest, "model"> & {
  model?: string;
};
type ParsedChatCompletionsRequest = Omit<ChatCompletionRequest, "model"> & {
  model?: string;
};

class RouteError extends Error {
  public readonly statusCode: number;
  public readonly details?: Record<string, unknown>;

  public constructor(
    statusCode: number,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RouteError";
    this.statusCode = statusCode;
    if (details) {
      this.details = details;
    }
  }
}

interface CopilotToolCallState {
    id: string;
    name: string;
    arguments: string;
}

function isCopilotModelName(model: string | undefined): model is `copilot-${string}` {
    return typeof model === "string" && model.startsWith("copilot-");
}

function resolveCopilotModel(
    registry: CopilotProxyConnectionRegistry | undefined,
    requestedModel: string | undefined,
): RegisteredCopilotProxyModel | undefined {
    if (!isCopilotModelName(requestedModel)) {
      return undefined;
}

    const model = registry?.findModel(requestedModel);
    if (model) {
      return model;
    }

    throw new RouteError(
      503,
      "Copilot models unavailable — VS Code extension not connected.",
    );
  }

  function mapCopilotUsage(usage: CopilotProxyUsage | undefined): ChatCompletionUsage | undefined {
    if (!usage) {
      return undefined;
    }

    return {
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      total_tokens: usage.total_tokens ?? usage.input_tokens + usage.output_tokens,
    };
  }

  function mapChatMessageToCopilot(message: ChatMessage): CopilotProxyRequestMessage["messages"][number] {
    const mapped: CopilotProxyRequestMessage["messages"][number] = {
      role: message.role,
      content: message.content ?? "",
    };

    if (message.tool_call_id) {
      mapped.tool_call_id = message.tool_call_id;
    }

    if (message.tool_calls) {
      mapped.tool_calls = message.tool_calls;
    }

    return mapped;
  }

  function mapChatToolToCopilot(tool: ChatTool): CopilotProxyTool {
    const mapped: CopilotProxyTool = {
      type: "function",
      function: {
        name: tool.function.name,
      },
    };

    if (tool.function.description) {
      mapped.function.description = tool.function.description;
    }

    if (tool.function.parameters) {
      mapped.function.parameters = tool.function.parameters;
    }

    return mapped;
  }

  function buildCopilotParams(request: ChatCompletionRequest): CopilotProxyRequestParams | undefined {
    const params: CopilotProxyRequestParams = {};

    if (request.stream !== undefined) {
      params.stream = request.stream;
    }
    if (request.temperature !== undefined) {
      params.temperature = request.temperature;
    }
    if (request.top_p !== undefined) {
      params.top_p = request.top_p;
    }
    if (request.max_completion_tokens !== undefined) {
      params.max_tokens = request.max_completion_tokens;
    }
    if (request.stop !== undefined) {
      params.stop = request.stop;
    }
    if (request.user !== undefined) {
      params.user = request.user;
    }
    if (request.metadata !== undefined) {
      params.metadata = request.metadata;
    }
    if (request.tool_choice !== undefined) {
      params.tool_choice = request.tool_choice;
    }

    return Object.keys(params).length > 0 ? params : undefined;
  }

  function buildCopilotRequest(
    id: string,
    model: RegisteredCopilotProxyModel,
    request: ChatCompletionRequest,
  ): CopilotProxyRequestMessage {
    const message: CopilotProxyRequestMessage = {
      type: "request",
      id,
      model: model.id,
      messages: request.messages.map(mapChatMessageToCopilot),
    };

    const params = buildCopilotParams(request);
    if (params) {
      message.params = params;
    }

    if (request.tools) {
      message.tools = request.tools.map(mapChatToolToCopilot);
    }

    return message;
  }

  function applyToolCallDelta(
    toolCalls: Map<number, CopilotToolCallState>,
    delta: CopilotProxyToolCallDelta,
  ): void {
    const existing = toolCalls.get(delta.index) ?? {
      id: delta.id ?? `call_${delta.index}`,
      name: "",
      arguments: "",
    };

    if (delta.id) {
      existing.id = delta.id;
    }
    if (delta.function?.name) {
      existing.name = delta.function.name;
    }
    if (delta.function?.arguments) {
      existing.arguments += delta.function.arguments;
    }

    toolCalls.set(delta.index, existing);
  }

  function buildToolCalls(toolCalls: Map<number, CopilotToolCallState>): ChatToolCall[] {
    return [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, toolCall]) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments,
        },
      }));
  }

  function routeErrorFromCopilotStreamError(message: Extract<CopilotProxyStreamMessage, { type: "stream_error" }>): RouteError {
    return new RouteError(
      message.error.status ?? 502,
      message.error.message,
      {
        code: message.error.code,
        partial: message.partial,
      },
    );
  }

  async function collectCopilotChatCompletion(
    id: string,
    model: RegisteredCopilotProxyModel,
    events: AsyncIterable<CopilotProxyStreamMessage>,
  ): Promise<ChatCompletionResponse> {
    let content = "";
    let usage: ChatCompletionUsage | undefined;
    const toolCalls = new Map<number, CopilotToolCallState>();

    for await (const event of events) {
      if (event.type === "stream_error") {
        throw routeErrorFromCopilotStreamError(event);
      }

      if (event.type === "stream_done") {
        usage = mapCopilotUsage(event.usage) ?? usage;
        break;
      }

      if (event.content_type === "text") {
        content += event.content;
        continue;
      }

      if (event.content_type === "tool_call") {
        applyToolCallDelta(toolCalls, event.content);
        continue;
      }

      if (event.content_type === "usage") {
        usage = mapCopilotUsage(event.content);
      }
    }

    const finalToolCalls = buildToolCalls(toolCalls);
    const message: NonNullable<ChatCompletionResponse["choices"][number]["message"]> = {
      role: "assistant",
      content: content.length > 0 ? content : null,
    };

    if (finalToolCalls.length > 0) {
      message.tool_calls = finalToolCalls;
    }

    const response: ChatCompletionResponse = {
      id,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: model.id,
      choices: [
        {
          index: 0,
          finish_reason: finalToolCalls.length > 0 ? "tool_calls" : "stop",
          message,
        },
      ],
    };

    if (usage) {
      response.usage = usage;
    }

    return response;
  }

  function formatOpenAiSseData(data: unknown): string {
    return `data: ${JSON.stringify(data)}\n\n`;
  }

  function createOpenAiCopilotChunk(
    id: string,
    model: string,
    delta: NonNullable<ChatCompletionResponse["choices"][number]["delta"]>,
    finishReason: string | null,
    usage?: ChatCompletionUsage,
  ): string {
    const chunk: ChatCompletionResponse = {
      id,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          finish_reason: finishReason,
          delta,
        },
      ],
    };

    if (usage) {
      chunk.usage = usage;
    }

    return formatOpenAiSseData(chunk);
  }

  async function* streamCopilotOpenAiChatCompletion(
    id: string,
    model: RegisteredCopilotProxyModel,
    handle: { events: AsyncIterable<CopilotProxyStreamMessage>; cancel(): void },
    abortSignal?: AbortSignal,
  ): AsyncGenerator<string> {
    let completed = false;

    try {
      yield createOpenAiCopilotChunk(id, model.id, { role: "assistant" }, null);

      for await (const event of handle.events) {
        if (abortSignal?.aborted) {
          return;
        }

        if (event.type === "stream_error") {
          completed = true;
          yield formatOpenAiSseData({
            error: {
              message: event.error.message,
              type: "api_error",
              code: event.error.code,
            },
          });
          return;
        }

        if (event.type === "stream_done") {
          completed = true;
          const usage = mapCopilotUsage(event.usage);
          yield createOpenAiCopilotChunk(id, model.id, {}, "stop", usage);
          yield "data: [DONE]\n\n";
          return;
        }

        if (event.content_type === "text") {
          yield createOpenAiCopilotChunk(id, model.id, { content: event.content }, null);
          continue;
        }

        if (event.content_type === "tool_call") {
          yield createOpenAiCopilotChunk(
            id,
            model.id,
            { tool_calls: [event.content] },
            null,
          );
        }
      }
    } finally {
      if (!completed) {
        handle.cancel();
      }
    }
  }

  async function* streamCopilotAnthropicMessage(
    id: string,
    model: RegisteredCopilotProxyModel,
    handle: { events: AsyncIterable<CopilotProxyStreamMessage>; cancel(): void },
    abortSignal?: AbortSignal,
  ): AsyncGenerator<string> {
    let completed = false;

    try {
      const response = await collectCopilotChatCompletion(id, model, handle.events);
      completed = true;
      if (abortSignal?.aborted) {
        return;
      }

      const anthropicResponse = translateChatCompletionResponseToAnthropic(response, {
        model: model.id,
      });
      for (const frame of createAnthropicMessageResponseStream(anthropicResponse)) {
        yield frame;
      }
    } catch (error) {
      completed = true;
      const message = error instanceof Error ? error.message : String(error);
      yield formatSseEvent("error", {
        type: "error",
        error: {
          type: "api_error",
          message,
        },
      });
    } finally {
      if (!completed) {
        handle.cancel();
      }
    }
  }

  async function* streamCopilotResponses(
    id: string,
    model: RegisteredCopilotProxyModel,
    handle: { events: AsyncIterable<CopilotProxyStreamMessage>; cancel(): void },
    options: TranslationOptions,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<string> {
    const translator = createChatCompletionStreamTranslator(options);

    for await (const chunk of streamCopilotOpenAiChatCompletion(
      id,
      model,
      handle,
      abortSignal,
    )) {
      for (const frame of translator.push(chunk)) {
        yield frame;
      }
    }

    for (const frame of translator.flush()) {
      yield frame;
    }
  }

  function createModelRecord(model: GatewayModelConfig): ModelRecord {
  const baseInstructions =
    "You are a helpful AI assistant. Follow developer and user instructions, keep responses accurate, and prefer concise plain-text output unless the caller asks for a specific format.";

  return {
    id: model.name,
    display_name: model.name,
    object: "model",
    created: model.created,
    owned_by: model.ownedBy,
    permission: [],
    root: model.name,
    parent: null,
    capabilities: {
      input_modalities: ["text"],
      output_modalities: ["text"],
      supports_responses_api: true,
      supports_streaming: model.supportsStreaming,
      supports_system_messages: true,
      supports_model_messages: true,
      supports_personality: true,
      supports_tool_calls: model.supportsTools,
      supports_parallel_tool_calls: model.supportsTools,
    },
    personality: "default",
    model_messages: [
      {
        role: "system",
        content: baseInstructions,
      },
    ],
    base_instructions: baseInstructions,
  };
}

function createCopilotModelRecord(model: RegisteredCopilotProxyModel): ModelRecord {
  const baseInstructions =
    "You are a helpful AI assistant. Follow developer and user instructions, keep responses accurate, and prefer concise plain-text output unless the caller asks for a specific format.";

  return {
    id: model.id,
    display_name: model.name,
    object: "model",
    created: model.created,
    owned_by: "github-copilot",
    permission: [],
    root: model.id,
    parent: null,
    capabilities: {
      input_modalities: ["text"],
      output_modalities: ["text"],
      supports_responses_api: true,
      supports_streaming: model.capabilities.supports_streaming,
      supports_system_messages: true,
      supports_model_messages: true,
      supports_personality: true,
      supports_tool_calls: model.capabilities.supports_tools,
      supports_parallel_tool_calls: model.capabilities.supports_tools,
    },
    personality: "default",
    model_messages: [
      {
        role: "system",
        content: baseInstructions,
      },
    ],
    base_instructions: baseInstructions,
    source: "copilot-proxy",
  };
}

function createModelsList(
  config: AppConfig,
  copilotProxyRegistry?: CopilotProxyConnectionRegistry,
): { object: "list"; data: ModelRecord[] } {
  return {
    object: "list",
    data: [
      ...config.models.map((model) => createModelRecord(model)),
      ...(copilotProxyRegistry?.listModels().map((model) => createCopilotModelRecord(model)) ??
        []),
    ],
  };
}

function createAnthropicModelRecord(model: GatewayModelConfig): AnthropicModelRecord {
  return {
    id: model.name,
    type: "model",
    display_name: model.name,
    created_at: new Date(model.created * 1_000).toISOString(),
  };
}

function createCopilotAnthropicModelRecord(
  model: RegisteredCopilotProxyModel,
): AnthropicModelRecord {
  return {
    id: model.id,
    type: "model",
    display_name: model.name,
    created_at: new Date(model.created * 1_000).toISOString(),
    source: "copilot-proxy",
  };
}

function createAnthropicModelsList(
  config: AppConfig,
  copilotProxyRegistry?: CopilotProxyConnectionRegistry,
): { object: "list"; data: AnthropicModelRecord[] } {
  return {
    object: "list",
    data: [
      ...config.models.map((model) => createAnthropicModelRecord(model)),
      ...(copilotProxyRegistry
        ?.listModels()
        .map((model) => createCopilotAnthropicModelRecord(model)) ?? []),
    ],
  };
}

function resolveModel(
  config: AppConfig,
  requestedModel?: string,
): GatewayModelConfig {
  const normalizedModel = normalizeOptionalString(requestedModel);

  if (normalizedModel) {
    const configured = config.models.find((model) => model.name === normalizedModel);
    if (configured) {
      return configured;
    }

    throw new RouteError(400, `Model metadata for \`${normalizedModel}\` is not configured.`);
  }

  if (config.defaultModel) {
    const configuredDefault = config.models.find(
      (model) => model.name === config.defaultModel,
    );
    if (configuredDefault) {
      return configuredDefault;
    }
  }

  if (config.models.length === 1) {
    return config.models[0]!;
  }

  throw new RouteError(
    400,
    "Request body must include a model or the gateway must define a single/default model.",
  );
}

function parseResponseRequest(body: unknown): ParsedResponseRequest {
  const parsed = requestBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new RouteError(400, formatZodError(parsed.error));
  }

  const normalized: ParsedResponseRequest = {};

  const model = normalizeOptionalString(parsed.data.model);
  if (model) {
    normalized.model = model;
  }

  const instructions = normalizeOptionalString(parsed.data.instructions);
  if (instructions) {
    normalized.instructions = instructions;
  }

  if (parsed.data.input !== undefined) {
    if (!isResponseInput(parsed.data.input)) {
      throw new RouteError(
        400,
        "Request body input must be a string, a message object, or an array of message objects.",
      );
    }
    normalized.input = parsed.data.input;
  }

  if (!hasUsableInput(normalized.input, normalized.instructions)) {
    throw new RouteError(
      400,
      "Request body must include usable input or non-empty instructions.",
    );
  }

  if (parsed.data.stream !== undefined) {
    normalized.stream = parsed.data.stream;
  }
  if (parsed.data.temperature !== undefined) {
    normalized.temperature = parsed.data.temperature;
  }
  if (parsed.data.top_p !== undefined) {
    normalized.top_p = parsed.data.top_p;
  }
  if (parsed.data.max_output_tokens !== undefined) {
    normalized.max_output_tokens = parsed.data.max_output_tokens;
  }
  if (parsed.data.metadata !== undefined) {
    normalized.metadata = parsed.data.metadata;
  }

  const user = normalizeOptionalString(parsed.data.user);
  if (user) {
    normalized.user = user;
  }

  if (parsed.data.tools !== undefined) {
    // Only pass through function-type tools; other tool types (e.g.
    // computer_preview, text_editor) are Responses API-specific and not
    // understood by the upstream Chat Completions API.
    const functionTools = parsed.data.tools.filter(isResponsesTool);
    if (functionTools.length > 0) {
      normalized.tools = functionTools;
    }
  }

  if (parsed.data.tool_choice !== undefined) {
    // Only pass through tool_choice values the Chat Completions API understands
    const tc = parsed.data.tool_choice;
    if (
      tc === "auto" ||
      tc === "none" ||
      tc === "required" ||
      (isRecord(tc) && tc.type === "function" && typeof tc.name === "string")
    ) {
      normalized.tool_choice = tc as import("../contracts.js").ResponsesToolChoice;
    }
  }

  return normalized;
}

function parseAnthropicMessagesRequest(body: unknown): ParsedAnthropicMessagesRequest {
  if (!isRecord(body)) {
    throw new RouteError(400, "Request body must be an object.");
  }

  const normalized: ParsedAnthropicMessagesRequest = {
    ...(body as Omit<AnthropicMessagesRequest, "model">),
  };

  if (body.model !== undefined && typeof body.model !== "string") {
    throw new RouteError(400, "Request body model must be a string.");
  }

  const model = normalizeOptionalString(
    typeof body.model === "string" ? body.model : undefined,
  );
  if (model) {
    normalized.model = model;
  }

  return normalized;
}

function parseChatCompletionsRequest(body: unknown): ParsedChatCompletionsRequest {
  if (!isRecord(body)) {
    throw new RouteError(400, "Request body must be an object.");
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new RouteError(400, "Request body messages must be a non-empty array.");
  }

  if (body.model !== undefined && typeof body.model !== "string") {
    throw new RouteError(400, "Request body model must be a string.");
  }

  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw new RouteError(400, "Request body stream must be a boolean.");
  }

  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw new RouteError(400, "Request body tools must be an array when provided.");
  }

  const normalized: ParsedChatCompletionsRequest = {
    ...(body as Omit<ChatCompletionRequest, "model">),
    messages: body.messages as ChatCompletionRequest["messages"],
  };

  const model = normalizeOptionalString(
    typeof body.model === "string" ? body.model : undefined,
  );
  if (model) {
    normalized.model = model;
  }

  return normalized;
}

function buildTranslationOptions(
  request: ParsedResponseRequest,
  publicModel: string,
): TranslationOptions {
  const options: TranslationOptions = {
    model: publicModel,
  };

  if (request.temperature !== undefined) {
    options.temperature = request.temperature;
  }

  if (request.top_p !== undefined) {
    options.top_p = request.top_p;
  }

  return options;
}

async function* translateStream(
  upstreamStream: ReadableStream<Uint8Array>,
  options: TranslationOptions,
  abortSignal?: AbortSignal,
): AsyncGenerator<string> {
  const translator = createChatCompletionStreamTranslator(options);

  for await (const chunk of readableStreamToAsyncIterable(upstreamStream, abortSignal)) {
    for (const frame of translator.push(chunk)) {
      yield frame;
    }

  }

  for (const frame of translator.flush()) {
    yield frame;
  }
}

async function* translateAnthropicStream(
  upstreamStream: ReadableStream<Uint8Array>,
  publicModel: string,
  abortSignal?: AbortSignal,
): AsyncGenerator<string> {
  const translator = createAnthropicMessageStreamTranslator({
    model: publicModel,
  });

  for await (const chunk of readableStreamToAsyncIterable(upstreamStream, abortSignal)) {
    for (const frame of translator.push(chunk)) {
      yield frame;
    }
  }

  for (const frame of translator.flush()) {
    yield frame;
  }
}

function createDisconnectAbortSignal(request: FastifyRequest): AbortSignal {
  const abortController = new AbortController();
  const onClose = () => {
    abortController.abort();
  };
  request.raw.on("close", onClose);
  return abortController.signal;
}

async function* readableStreamToAsyncIterable(
  stream: ReadableStream<Uint8Array>,
  abortSignal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();

  try {
    while (true) {
      if (abortSignal?.aborted) {
        return;
      }

      const { done, value } = await reader.read();
      if (done) {
        return;
      }

      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function sendError(
  reply: FastifyReply,
  error: unknown,
  log: FastifyReply["log"],
  requestId?: string,
): Promise<unknown> {
  // Ensure the content-type is reset to application/json so Fastify can
  // serialize the error object. If a streaming path already set
  // text/event-stream on the reply, sending a plain object would trigger
  // FST_ERR_REP_INVALID_PAYLOAD_TYPE.
  reply.type("application/json; charset=utf-8");

  if (error instanceof UpstreamHttpError) {
    log.warn(
      {
        requestId,
        statusCode: error.statusCode,
        statusText: error.statusText,
      },
      "Upstream API request failed.",
    );
    return reply.code(error.statusCode).send({
      error: "Upstream request failed.",
      upstream: {
        statusCode: error.statusCode,
        statusText: error.statusText,
      },
    });
  }

  if (error instanceof RouteError) {
    const method = error.statusCode >= 500 ? log.error.bind(log) : log.warn.bind(log);
    method(
      {
        requestId,
        statusCode: error.statusCode,
        details: error.details,
      },
      error.message,
    );
    return reply.code(error.statusCode).send({
      error: error.message,
      ...(error.details ?? {}),
    });
  }

  log.error(
    {
      requestId,
      error: toErrorMessage(error),
    },
    "Unhandled gateway error.",
  );
  return reply.code(500).send({
    error: toErrorMessage(error),
  });
}

function sendAnthropicError(
  reply: FastifyReply,
  error: unknown,
  log: FastifyReply["log"],
  requestId?: string,
): FastifyReply {
  // Ensure the content-type is reset to application/json so Fastify can
  // serialize the error object. If a streaming path already set
  // text/event-stream on the reply, sending a plain object would trigger
  // FST_ERR_REP_INVALID_PAYLOAD_TYPE.
  reply.type("application/json; charset=utf-8");

  if (error instanceof UpstreamHttpError) {
    log.warn(
      {
        requestId,
        statusCode: error.statusCode,
        statusText: error.statusText,
      },
      "Upstream API request failed.",
    );
    return reply.code(error.statusCode).send({
      type: "error",
      error: {
        type: "api_error",
        message: "Upstream request failed.",
      },
    });
  }

  if (error instanceof RouteError) {
    const method = error.statusCode >= 500 ? log.error.bind(log) : log.warn.bind(log);
    method(
      {
        requestId,
        statusCode: error.statusCode,
        details: error.details,
      },
      error.message,
    );
    return reply.code(error.statusCode).send({
      type: "error",
      error: {
        type: error.statusCode >= 500 ? "api_error" : "invalid_request_error",
        message: error.message,
      },
    });
  }

  const message = toErrorMessage(error);
  log.error(
    {
      requestId,
      error: message,
    },
    "Unhandled gateway error.",
  );
  return reply.code(500).send({
    type: "error",
    error: {
      type: "api_error",
      message,
    },
  });
}

function sendOpenAiError(
  reply: FastifyReply,
  error: unknown,
  log: FastifyReply["log"],
  requestId?: string,
): FastifyReply {
  reply.type("application/json; charset=utf-8");

  if (error instanceof UpstreamHttpError) {
    log.warn(
      {
        requestId,
        statusCode: error.statusCode,
        statusText: error.statusText,
      },
      "Upstream API request failed.",
    );

    return reply.code(error.statusCode).send({
      error: {
        message: "Upstream request failed.",
        type: "api_error",
      },
    });
  }

  if (error instanceof RouteError) {
    const method = error.statusCode >= 500 ? log.error.bind(log) : log.warn.bind(log);
    method(
      {
        requestId,
        statusCode: error.statusCode,
        details: error.details,
      },
      error.message,
    );

    return reply.code(error.statusCode).send({
      error: {
        message: error.message,
        type: error.statusCode >= 500 ? "api_error" : "invalid_request_error",
      },
    });
  }

  const message = toErrorMessage(error);
  log.error(
    {
      requestId,
      error: message,
    },
    "Unhandled gateway error.",
  );

  return reply.code(500).send({
    error: {
      message,
      type: "api_error",
    },
  });
}

function listUnknownResponsesTopLevelFields(body: unknown): string[] {
  if (!isRecord(body)) {
    return [];
  }

  return Object.keys(body)
    .filter((field) => !RESPONSES_ALLOWED_TOP_LEVEL_FIELDS.has(field))
    .sort();
}

function responseRequestUsesTools(request: ParsedResponseRequest): boolean {
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    return true;
  }

  if (request.tool_choice === undefined) {
    return false;
  }

  return request.tool_choice !== "none";
}

function anthropicRequestUsesTools(request: ParsedAnthropicMessagesRequest): boolean {
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    return true;
  }

  if (request.tool_choice === undefined) {
    return false;
  }

  if (typeof request.tool_choice === "string") {
    return request.tool_choice !== "none";
  }

  return true;
}

function chatCompletionsRequestUsesTools(
  request: ParsedChatCompletionsRequest,
): boolean {
  if (Array.isArray(request.tools) && request.tools.length > 0) {
    return true;
  }

  if (request.tool_choice === undefined) {
    return false;
  }

  if (typeof request.tool_choice === "string") {
    return request.tool_choice !== "none";
  }

  return true;
}

export const responsesRoutes: FastifyPluginAsync<ResponsesRoutesOptions> = async (
  app,
  options,
) => {
  const log = app.log.child({ component: "responses-routes" });
  const clientCache = new Map<string, ChatCompletionsTransport>();
  const unknownFieldCounters = new Map<string, { warn: number; enforce: number; requestCount: number; windowRequests: number }>();

  const incrementUnknownFieldCounter = (
    publicModel: string,
    mode: "warn" | "enforce",
    windowRequests: number,
  ): number => {
    const existing = unknownFieldCounters.get(publicModel) ?? { warn: 0, enforce: 0, requestCount: 0, windowRequests };
    existing.requestCount += 1;

    if (existing.requestCount >= existing.windowRequests) {
      existing.warn = 0;
      existing.enforce = 0;
      existing.requestCount = 0;
    }

    existing[mode] += 1;
    unknownFieldCounters.set(publicModel, existing);
    return existing[mode];
  };

  const getClient = (model: GatewayModelConfig): ChatCompletionsTransport => {
    if (options.client) {
      return options.client;
    }

    const cacheKey = `${model.baseUrl}::${model.apiKey}`;
    const cached = clientCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const clientOptions: {
      baseUrl: string;
      apiKey: string;
      fetchFn?: typeof fetch;
      logger?: {
        debug(context: unknown, message?: string): void;
        info(context: unknown, message?: string): void;
        warn(context: unknown, message?: string): void;
        error(context: unknown, message?: string): void;
      };
      timeoutMs?: number;
      maxRetries?: number;
    } = {
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
      logger: app.log.child({
        component: "upstream-client",
        upstreamBaseUrl: model.baseUrl,
      }),
      timeoutMs: options.config.requestTimeoutMs,
      maxRetries: options.config.maxRetries,
    };
    if (options.fetchFn) {
      clientOptions.fetchFn = options.fetchFn;
    }

    const client = new ChatCompletionsClient(clientOptions);
    clientCache.set(cacheKey, client);
    return client;
  };

  const modelsListHandler = async () =>
    createModelsList(options.config, options.copilotProxyRegistry);
  const anthropicModelsListHandler = async () =>
    createAnthropicModelsList(options.config, options.copilotProxyRegistry);
  const modelDetailHandler = async (
    request: FastifyRequest<{ Params: { model: string } }>,
    reply: FastifyReply,
  ) => {
    log.debug({ model: request.params.model }, "Serving model metadata detail.");
    const configured = options.config.models.find(
      (model) => model.name === request.params.model,
    );

    if (!configured) {
      const copilotModel = options.copilotProxyRegistry?.findModel(request.params.model);
      if (copilotModel) {
        return hasAnthropicVersionHeader(request)
          ? createCopilotAnthropicModelRecord(copilotModel)
          : createCopilotModelRecord(copilotModel);
      }

      return reply.code(404).send({
        error: `Model \`${request.params.model}\` is not configured.`,
      });
    }

    if (hasAnthropicVersionHeader(request)) {
      return createAnthropicModelRecord(configured);
    }

    return createModelRecord(configured);
  };

  const responsesHandler = async (
    request: FastifyRequest<{ Body: unknown }>,
    reply: FastifyReply,
  ) => {
    try {
      const parsedRequest = parseResponseRequest(request.body);
      log.info(
        {
          requestId: request.id,
          path: request.url,
          stream: parsedRequest.stream ?? false,
          requestedModel: parsedRequest.model ?? null,
        },
        "Handling /responses request.",
      );
      const unknownTopLevelFields = listUnknownResponsesTopLevelFields(request.body);
      const copilotModel = resolveCopilotModel(
        options.copilotProxyRegistry,
        parsedRequest.model,
      );
      if (copilotModel) {
        if (unknownTopLevelFields.length > 0) {
          log.warn(
            {
              requestId: request.id,
              publicModel: copilotModel.id,
              unknownFieldMode: "warn",
              unknownFields: unknownTopLevelFields,
              unknownFieldCount: unknownTopLevelFields.length,
            },
            "Detected unknown top-level /responses request fields.",
          );
        }

        if (parsedRequest.stream && !copilotModel.capabilities.supports_streaming) {
          throw new RouteError(
            400,
            `Model \`${copilotModel.id}\` does not support streaming.`,
          );
        }

        if (responseRequestUsesTools(parsedRequest) && !copilotModel.capabilities.supports_tools) {
          throw new RouteError(
            400,
            `Model \`${copilotModel.id}\` does not support tools.`,
          );
        }

        const copilotChatRequest = buildChatCompletionRequest({
          ...parsedRequest,
          model: copilotModel.id,
        });
        const handle = options.copilotProxyRegistry?.dispatchRequest(
          buildCopilotRequest(String(request.id), copilotModel, copilotChatRequest),
        );
        if (!handle) {
          throw new RouteError(
            503,
            "Copilot models unavailable — VS Code extension not connected.",
          );
        }

        const translationOptions = buildTranslationOptions(parsedRequest, copilotModel.id);

        if (parsedRequest.stream) {
          log.info(
            {
              requestId: request.id,
              publicModel: copilotModel.id,
            },
            "Proxying streaming response request through Copilot extension.",
          );
          const disconnectSignal = createDisconnectAbortSignal(request);

          reply
            .code(200)
            .type("text/event-stream; charset=utf-8")
            .header("cache-control", "no-cache, no-transform")
            .header("connection", "keep-alive")
            .header("x-accel-buffering", "no");

          return reply.send(
            Readable.from(
              streamCopilotResponses(
                String(request.id),
                copilotModel,
                handle,
                translationOptions,
                disconnectSignal,
              ),
            ),
          );
        }

        log.info(
          {
            requestId: request.id,
            publicModel: copilotModel.id,
          },
          "Proxying non-stream response request through Copilot extension.",
        );
        const response = await collectCopilotChatCompletion(
          String(request.id),
          copilotModel,
          handle.events,
        );
        return reply.code(200).send(
          translateChatCompletionResponse(response, translationOptions),
        );
      }

      const selectedModel = resolveModel(options.config, parsedRequest.model);
      const supportsStreaming = selectedModel.supportsStreaming;
      const supportsTools = selectedModel.supportsTools;
      const unknownFieldMode = selectedModel.unknownFieldMode;

      if (unknownTopLevelFields.length > 0) {
        const unknownFieldModeCount = incrementUnknownFieldCounter(
          selectedModel.name,
          unknownFieldMode,
          selectedModel.unknownFieldWindowRequests,
        );

        log.warn(
          {
            requestId: request.id,
            publicModel: selectedModel.name,
            unknownFieldMode,
            unknownFields: unknownTopLevelFields,
            unknownFieldCount: unknownTopLevelFields.length,
            unknownFieldModeCount,
          },
          "Detected unknown top-level /responses request fields.",
        );

        if (unknownFieldMode === "enforce") {
          throw new RouteError(400, "Unknown /responses fields.", {
            unknown_fields: unknownTopLevelFields,
          });
        }
      }

      if (parsedRequest.stream && !supportsStreaming) {
        throw new RouteError(
          400,
          `Model \`${selectedModel.name}\` does not support streaming.`,
        );
      }

      if (responseRequestUsesTools(parsedRequest) && !supportsTools) {
        throw new RouteError(
          400,
          `Model \`${selectedModel.name}\` does not support tools.`,
        );
      }

      log.debug(
        {
          requestId: request.id,
          publicModel: selectedModel.name,
          upstreamModel: selectedModel.upstreamModel,
          upstreamBaseUrl: selectedModel.baseUrl,
        },
        "Selected upstream target for request.",
      );
      const upstreamRequest = buildChatCompletionRequest({
        ...parsedRequest,
        model: selectedModel.upstreamModel,
      });
      const translationOptions = buildTranslationOptions(
        parsedRequest,
        selectedModel.name,
      );
      const client = getClient(selectedModel);

      if (parsedRequest.stream) {
        log.info(
          {
            requestId: request.id,
            publicModel: selectedModel.name,
          },
          "Proxying streaming response request upstream.",
        );
        const upstreamStream = await client.createCompletionStream(upstreamRequest, request.id);
        const disconnectSignal = createDisconnectAbortSignal(request);

        reply
          .code(200)
          .type("text/event-stream; charset=utf-8")
          .header("cache-control", "no-cache, no-transform")
          .header("connection", "keep-alive")
          .header("x-accel-buffering", "no");

        return reply.send(
          Readable.from(translateStream(upstreamStream, translationOptions, disconnectSignal)),
        );
      }

      log.info(
        {
          requestId: request.id,
          publicModel: selectedModel.name,
        },
        "Proxying non-stream response request upstream.",
      );
      const upstreamResponse = await client.createCompletion(upstreamRequest, request.id);
      return reply.code(200).send(
        translateChatCompletionResponse(upstreamResponse, translationOptions),
      );
    } catch (error) {
      return sendError(reply, error, log, request.id);
    }
  };

  const anthropicMessagesHandler = async (
    request: FastifyRequest<{ Body: unknown }>,
    reply: FastifyReply,
  ) => {
    try {
      const parsedRequest = parseAnthropicMessagesRequest(request.body);
      log.info(
        {
          requestId: request.id,
          path: request.url,
          stream: parsedRequest.stream ?? false,
          requestedModel: parsedRequest.model ?? null,
        },
        "Handling /v1/messages request.",
      );
      const copilotModel = resolveCopilotModel(
        options.copilotProxyRegistry,
        parsedRequest.model,
      );
      if (copilotModel) {
        if (parsedRequest.stream && !copilotModel.capabilities.supports_streaming) {
          throw new RouteError(
            400,
            `Model \`${copilotModel.id}\` does not support streaming.`,
          );
        }

        if (
          anthropicRequestUsesTools(parsedRequest) &&
          !copilotModel.capabilities.supports_tools
        ) {
          throw new RouteError(
            400,
            `Model \`${copilotModel.id}\` does not support tools.`,
          );
        }

        let copilotChatRequest: ChatCompletionRequest;
        try {
          copilotChatRequest = buildChatCompletionRequestFromAnthropic({
            ...parsedRequest,
            model: copilotModel.id,
          });
        } catch (error) {
          throw new RouteError(
            400,
            error instanceof Error ? error.message : String(error),
          );
        }

        const handle = options.copilotProxyRegistry?.dispatchRequest(
          buildCopilotRequest(String(request.id), copilotModel, copilotChatRequest),
        );
        if (!handle) {
          throw new RouteError(
            503,
            "Copilot models unavailable — VS Code extension not connected.",
          );
        }

        if (parsedRequest.stream) {
          const disconnectSignal = createDisconnectAbortSignal(request);
          reply
            .code(200)
            .type("text/event-stream; charset=utf-8")
            .header("cache-control", "no-cache, no-transform")
            .header("connection", "keep-alive")
            .header("x-accel-buffering", "no");

          return reply.send(
            Readable.from(
              streamCopilotAnthropicMessage(
                String(request.id),
                copilotModel,
                handle,
                disconnectSignal,
              ),
            ),
          );
        }

        const response = await collectCopilotChatCompletion(
          String(request.id),
          copilotModel,
          handle.events,
        );
        return reply.code(200).send(
          translateChatCompletionResponseToAnthropic(response, {
            model: copilotModel.id,
          }),
        );
      }

      const selectedModel = resolveModel(options.config, parsedRequest.model);
      const supportsStreaming = selectedModel.supportsStreaming;
      const supportsTools = selectedModel.supportsTools;

      if (parsedRequest.stream && !supportsStreaming) {
        throw new RouteError(
          400,
          `Model \`${selectedModel.name}\` does not support streaming.`,
        );
      }

      if (anthropicRequestUsesTools(parsedRequest) && !supportsTools) {
        throw new RouteError(
          400,
          `Model \`${selectedModel.name}\` does not support tools.`,
        );
      }

      log.debug(
        {
          requestId: request.id,
          publicModel: selectedModel.name,
          upstreamModel: selectedModel.upstreamModel,
          upstreamBaseUrl: selectedModel.baseUrl,
        },
        "Selected upstream target for Anthropic request.",
      );

      let upstreamRequest: ChatCompletionRequest;
      try {
        upstreamRequest = buildChatCompletionRequestFromAnthropic({
          ...parsedRequest,
          model: selectedModel.upstreamModel,
        });
      } catch (error) {
        throw new RouteError(
          400,
          error instanceof Error ? error.message : String(error),
        );
      }

      const client = getClient(selectedModel);

      if (parsedRequest.stream) {
        log.info(
          {
            requestId: request.id,
            publicModel: selectedModel.name,
          },
          "Proxying streaming Anthropic request upstream.",
        );

        try {
          const upstreamStream = await client.createCompletionStream(upstreamRequest, request.id);
          const disconnectSignal = createDisconnectAbortSignal(request);

          reply
            .code(200)
            .type("text/event-stream; charset=utf-8")
            .header("cache-control", "no-cache, no-transform")
            .header("connection", "keep-alive")
            .header("x-accel-buffering", "no");

          return reply.send(
            Readable.from(
              translateAnthropicStream(upstreamStream, selectedModel.name, disconnectSignal),
            ),
          );
        } catch (error) {
          if (!(error instanceof UpstreamHttpError) || error.statusCode !== 406) {
            throw error;
          }

          log.info(
            {
              requestId: request.id,
              publicModel: selectedModel.name,
              upstreamStatusCode: error.statusCode,
            },
            "Upstream rejected streaming Accept header; falling back to non-stream completion for Anthropic request.",
          );

          const { stream: _stream, ...nonStreamingUpstreamRequest } = upstreamRequest;
          const upstreamResponse = await client.createCompletion(nonStreamingUpstreamRequest, request.id);
          const anthropicResponse = translateChatCompletionResponseToAnthropic(
            upstreamResponse,
            {
              model: selectedModel.name,
            },
          );

          reply
            .code(200)
            .type("text/event-stream; charset=utf-8")
            .header("cache-control", "no-cache, no-transform")
            .header("connection", "keep-alive")
            .header("x-accel-buffering", "no");

          return reply.send(
            Readable.from(createAnthropicMessageResponseStream(anthropicResponse)),
          );
        }
      }

      log.info(
        {
          requestId: request.id,
          publicModel: selectedModel.name,
        },
        "Proxying non-stream Anthropic request upstream.",
      );
      const upstreamResponse = await client.createCompletion(upstreamRequest, request.id);
      return reply.code(200).send(
        translateChatCompletionResponseToAnthropic(upstreamResponse, {
          model: selectedModel.name,
        }),
      );
    } catch (error) {
      return sendAnthropicError(reply, error, log, request.id);
    }
  };

  const chatCompletionsHandler = async (
    request: FastifyRequest<{ Body: unknown }>,
    reply: FastifyReply,
  ) => {
    try {
      const parsedRequest = parseChatCompletionsRequest(request.body);
      log.info(
        {
          requestId: request.id,
          path: request.url,
          stream: parsedRequest.stream ?? false,
          requestedModel: parsedRequest.model ?? null,
        },
        "Handling /v1/chat/completions request.",
      );

      const copilotModel = resolveCopilotModel(
        options.copilotProxyRegistry,
        parsedRequest.model,
      );
      if (copilotModel) {
        if (parsedRequest.stream && !copilotModel.capabilities.supports_streaming) {
          throw new RouteError(
            400,
            `Model \`${copilotModel.id}\` does not support streaming.`,
          );
        }

        if (
          chatCompletionsRequestUsesTools(parsedRequest) &&
          !copilotModel.capabilities.supports_tools
        ) {
          throw new RouteError(
            400,
            `Model \`${copilotModel.id}\` does not support tools.`,
          );
        }

        const copilotChatRequest: ChatCompletionRequest = {
          ...parsedRequest,
          model: copilotModel.id,
        };
        const handle = options.copilotProxyRegistry?.dispatchRequest(
          buildCopilotRequest(String(request.id), copilotModel, copilotChatRequest),
        );
        if (!handle) {
          throw new RouteError(
            503,
            "Copilot models unavailable — VS Code extension not connected.",
          );
        }

        if (parsedRequest.stream) {
          const disconnectSignal = createDisconnectAbortSignal(request);
          reply
            .code(200)
            .type("text/event-stream; charset=utf-8")
            .header("cache-control", "no-cache, no-transform")
            .header("connection", "keep-alive")
            .header("x-accel-buffering", "no");

          return reply.send(
            Readable.from(
              streamCopilotOpenAiChatCompletion(
                String(request.id),
                copilotModel,
                handle,
                disconnectSignal,
              ),
            ),
          );
        }

        const response = await collectCopilotChatCompletion(
          String(request.id),
          copilotModel,
          handle.events,
        );
        return reply.code(200).send(response);
      }

      const selectedModel = resolveModel(options.config, parsedRequest.model);

      if (parsedRequest.stream && !selectedModel.supportsStreaming) {
        throw new RouteError(
          400,
          `Model \`${selectedModel.name}\` does not support streaming.`,
        );
      }

      if (chatCompletionsRequestUsesTools(parsedRequest) && !selectedModel.supportsTools) {
        throw new RouteError(400, `Model \`${selectedModel.name}\` does not support tools.`);
      }

      log.debug(
        {
          requestId: request.id,
          publicModel: selectedModel.name,
          upstreamModel: selectedModel.upstreamModel,
          upstreamBaseUrl: selectedModel.baseUrl,
        },
        "Selected upstream target for chat completions request.",
      );

      const upstreamRequest: ChatCompletionRequest = {
        ...parsedRequest,
        model: selectedModel.upstreamModel,
      };
      const client = getClient(selectedModel);

      if (parsedRequest.stream) {
        log.info(
          {
            requestId: request.id,
            publicModel: selectedModel.name,
          },
          "Proxying streaming chat completions request upstream.",
        );
        const upstreamStream = await client.createCompletionStream(upstreamRequest, request.id);
        const disconnectSignal = createDisconnectAbortSignal(request);

        reply
          .code(200)
          .type("text/event-stream; charset=utf-8")
          .header("cache-control", "no-cache, no-transform")
          .header("connection", "keep-alive")
          .header("x-accel-buffering", "no");

        return reply.send(Readable.from(readableStreamToAsyncIterable(upstreamStream, disconnectSignal)));
      }

      log.info(
        {
          requestId: request.id,
          publicModel: selectedModel.name,
        },
        "Proxying non-stream chat completions request upstream.",
      );
      const upstreamResponse = await client.createCompletion(upstreamRequest, request.id);
      return reply.code(200).send(upstreamResponse);
    } catch (error) {
      return sendOpenAiError(reply, error, log, request.id);
    }
  };

  const anthropicCountTokensHandler = async (
    request: FastifyRequest<{ Body: unknown }>,
    reply: FastifyReply,
  ) => {
    try {
      const parsedRequest = parseAnthropicMessagesRequest(request.body);
      const selectedModel = resolveModel(options.config, parsedRequest.model);
      const normalizedRequest: AnthropicMessagesRequest = {
        ...parsedRequest,
        model: selectedModel.name,
      };

      return reply.code(200).send({
        input_tokens: estimateAnthropicInputTokens(normalizedRequest),
      });
    } catch (error) {
      return sendAnthropicError(reply, error, log, request.id);
    }
  };

  app.get("/models", async () => {
    log.debug(
      { configuredModels: options.config.models.map((model) => model.name) },
      "Serving models list.",
    );
    return modelsListHandler();
  });
  app.get("/v1/models", async (request) => {
    log.debug(
      {
        configuredModels: options.config.models.map((model) => model.name),
        anthropic: hasAnthropicVersionHeader(request),
      },
      "Serving models list.",
    );
    return hasAnthropicVersionHeader(request)
      ? anthropicModelsListHandler()
      : modelsListHandler();
  });
  app.get("/models/:model", modelDetailHandler);
  app.get("/v1/models/:model", modelDetailHandler);
  app.post("/responses", responsesHandler);
  app.post("/v1/responses", responsesHandler);
  app.post("/v1/chat/completions", chatCompletionsHandler);
  app.post("/v1/messages", anthropicMessagesHandler);
  app.post("/v1/messages/count_tokens", anthropicCountTokensHandler);
};

function hasUsableInput(
  input: ParsedResponseRequest["input"] | undefined,
  instructions: string | undefined,
): boolean {
  if (instructions && instructions.trim().length > 0) {
    return true;
  }

  if (input === undefined) {
    return false;
  }

  if (typeof input === "string") {
    return input.trim().length > 0;
  }

  if (Array.isArray(input)) {
    return input.some(hasUsableInputItemContent);
  }

  return hasUsableInputItemContent(input);
}

function hasUsableInputItemContent(item: ResponseInputItem): boolean {
  if (item.type === "function_call" || item.type === "function_call_output") {
    return true;
  }

  return hasUsableMessageContent(item);
}

function hasUsableMessageContent(message: ResponseMessageItem): boolean {
  if (typeof message.content === "string") {
    return message.content.trim().length > 0;
  }

  return message.content.some((part) => part.text.trim().length > 0);
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function hasAnthropicVersionHeader(
  request: Pick<FastifyRequest, "headers">,
): boolean {
  const header = request.headers["anthropic-version"];
  return typeof header === "string" && header.trim().length > 0;
}

function formatZodError(error: z.ZodError): string {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "body";
    return `${path}: ${issue.message}`;
  });

  return `Invalid /responses request body: ${issues.join("; ")}`;
}

function isResponseInput(value: unknown): value is ResponseInput {
  return (
    typeof value === "string" ||
    isResponseInputItem(value) ||
    (Array.isArray(value) && value.every(isResponseInputItem))
  );
}

function isResponseInputItem(value: unknown): value is ResponseInputItem {
  if (!isRecord(value)) {
    return false;
  }

  if (value.type === "function_call") {
    return (
      typeof value.call_id === "string" &&
      typeof value.name === "string" &&
      typeof value.arguments === "string"
    );
  }

  if (value.type === "function_call_output") {
    return (
      typeof value.call_id === "string" &&
      typeof value.output === "string"
    );
  }

  return isResponseMessageItem(value);
}

function isResponseMessageItem(value: unknown): value is ResponseMessageItem {
  if (!isRecord(value)) {
    return false;
  }

  if (value.type !== "message") {
    return false;
  }

  if (!isResponseRole(value.role)) {
    return false;
  }

  if (typeof value.content === "string") {
    return true;
  }

  return Array.isArray(value.content) && value.content.every(isTextContent);
}

function isResponsesTool(value: unknown): value is import("../contracts.js").ResponsesTool {
  return (
    isRecord(value) &&
    value.type === "function" &&
    typeof value.name === "string" &&
    (value.description === undefined || typeof value.description === "string") &&
    (value.parameters === undefined || isRecord(value.parameters))
  );
}

function isTextContent(
  value: unknown,
): value is ResponseMessageItem["content"] extends infer Content
  ? Content extends Array<infer Item>
    ? Item
    : never
  : never {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    typeof value.text === "string"
  );
}

function isResponseRole(value: unknown): value is ResponseMessageItem["role"] {
  return (
    value === "user" ||
    value === "assistant" ||
    value === "system" ||
    value === "developer"
  );
}
