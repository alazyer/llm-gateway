import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type {
  ChatCompletionResponse,
  AnthropicMessagesRequest,
  ChatCompletionRequest,
  ChatCompletionUsage,
  ChatToolCallDelta,
  ModelChainConfig,
  ResponseInput,
  ResponseInputItem,
  ResponseMessageItem,
  ResponseRequest,
} from "../contracts.js";
import type { AppConfig, GatewayModelConfig } from "../config.js";
import type {
  CopilotProxyConnectionRegistry,
  CopilotProxyRequestHandle,
  RegisteredCopilotProxyModel,
  CopilotProxyStreamMessage,
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
    supports_responses_api: true;
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
  status?: string;
  status_reason?: string | null;
  source?: string;
  active_models?: number;
  total_models?: number;
}

interface AnthropicModelRecord {
  id: string;
  type: "model";
  display_name: string;
  created_at: string;
  status?: string;
  status_reason?: string | null;
  source?: string;
  active_models?: number;
  total_models?: number;
}

interface ResponsesRoutesOptions {
  config: AppConfig;
  client?: ChatCompletionsTransport;
  fetchFn?: typeof fetch;
  copilotProxyRegistry?: CopilotProxyConnectionRegistry;
  allowedPrefixes?: readonly string[];
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

function createModelRecord(model: GatewayModelConfig): ModelRecord {
  const baseInstructions =
    "You are a helpful AI assistant. Follow developer and user instructions, keep responses accurate, and prefer concise plain-text output unless the caller asks for a specific format.";

  const record: ModelRecord = {
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

  record.status = model.status ?? "active";
  record.status_reason = model.statusReason ?? null;
  record.source = "static";

  return record;
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
    status: "active",
    status_reason: "Registered by VS Code Copilot proxy extension.",
    source: "copilot-proxy",
  };
}

function createChainModelRecord(chain: ModelChainConfig): ModelRecord {
  const baseInstructions =
    "You are a helpful AI assistant. Follow developer and user instructions, keep responses accurate, and prefer concise plain-text output unless the caller asks for a specific format.";

  return {
    id: `chain-${chain.name}`,
    display_name: `chain-${chain.name}`,
    object: "model",
    created: chain.statusChangedAt ?? Math.floor(Date.now() / 1000),
    owned_by: "llm-gateway",
    permission: [],
    root: `chain-${chain.name}`,
    parent: null,
    capabilities: {
      input_modalities: ["text"],
      output_modalities: ["text"],
      supports_responses_api: true,
      supports_streaming: chain.models.some((entry) => entry.modelConfig.supportsStreaming),
      supports_system_messages: true,
      supports_model_messages: true,
      supports_personality: true,
      supports_tool_calls: chain.models.some((entry) => entry.modelConfig.supportsTools),
      supports_parallel_tool_calls: chain.models.some((entry) => entry.modelConfig.supportsTools),
    },
    personality: "default",
    model_messages: [
      {
        role: "system",
        content: baseInstructions,
      },
    ],
    base_instructions: baseInstructions,
    status: chain.status,
    status_reason: chain.statusReason,
    source: "chain",
    active_models: chain.activeModels,
    total_models: chain.totalModels,
  };
}

function getAllModelRecords(options: ResponsesRoutesOptions): ModelRecord[] {
  const staticModels = options.config.models.map((model) => createModelRecord(model));
  const chainModels = (options.config.modelChains ?? []).map((chain) => createChainModelRecord(chain));
  const copilotModels = options.copilotProxyRegistry?.listModels().map((model) => createCopilotModelRecord(model)) ?? [];

  return [...staticModels, ...chainModels, ...copilotModels];
}

function filterModelRecords<T extends { status?: string }>(records: T[], status?: string): T[] {
  if (!status) {
    return records;
  }

  return records.filter((record) => (record.status ?? "active") === status);
}

function createModelsList(
  options: ResponsesRoutesOptions,
  status?: string,
): { object: "list"; data: ModelRecord[] } {
  return {
    object: "list",
    data: filterModelRecords(getAllModelRecords(options), status),
  };
}

function createAnthropicModelRecord(model: GatewayModelConfig): AnthropicModelRecord {
  const record: AnthropicModelRecord = {
    id: model.name,
    type: "model",
    display_name: model.name,
    created_at: new Date(model.created * 1_000).toISOString(),
  };

  record.status = model.status ?? "active";
  record.status_reason = model.statusReason ?? null;
  record.source = "static";

  return record;
}

function createAnthropicCopilotModelRecord(model: RegisteredCopilotProxyModel): AnthropicModelRecord {
  return {
    id: model.id,
    type: "model",
    display_name: model.name,
    created_at: new Date(model.created * 1_000).toISOString(),
    status: "active",
    status_reason: "Registered by VS Code Copilot proxy extension.",
    source: "copilot-proxy",
  };
}

function createAnthropicChainModelRecord(chain: ModelChainConfig): AnthropicModelRecord {
  return {
    id: `chain-${chain.name}`,
    type: "model",
    display_name: `chain-${chain.name}`,
    created_at: new Date((chain.statusChangedAt ?? Math.floor(Date.now() / 1000)) * 1_000).toISOString(),
    status: chain.status,
    status_reason: chain.statusReason,
    source: "chain",
    active_models: chain.activeModels,
    total_models: chain.totalModels,
  };
}

function createAnthropicModelsList(
  options: ResponsesRoutesOptions,
  status?: string,
): { object: "list"; data: AnthropicModelRecord[] } {
  const staticModels = options.config.models.map((model) => createAnthropicModelRecord(model));
  const chainModels = (options.config.modelChains ?? []).map((chain) => createAnthropicChainModelRecord(chain));
  const copilotModels = options.copilotProxyRegistry?.listModels().map((model) => createAnthropicCopilotModelRecord(model)) ?? [];

  return {
    object: "list",
    data: filterModelRecords([...staticModels, ...chainModels, ...copilotModels], status),
  };
}

function getAllowedCopilotPrefixes(options: ResponsesRoutesOptions): readonly string[] {
  return options.allowedPrefixes ?? options.config.copilotProxy?.allowedPrefixes ?? ["copilot-"];
}

function isAllowedCopilotProxyModel(
  modelName: string,
  options: ResponsesRoutesOptions,
): boolean {
  return getAllowedCopilotPrefixes(options).some((prefix) => modelName.startsWith(prefix));
}

function getEffectiveRequestedModel(
  config: AppConfig,
  requestedModel?: string,
): string | undefined {
  const normalizedModel = normalizeOptionalString(requestedModel);
  if (normalizedModel) {
    return normalizedModel;
  }

  if (config.defaultModel) {
    return config.defaultModel;
  }

  if (config.models.length === 1) {
    return config.models[0]!.name;
  }

  return undefined;
}

function getCopilotProxyModelOrThrow(
  options: ResponsesRoutesOptions,
  requestedModel?: string,
): RegisteredCopilotProxyModel | undefined {
  const effectiveModel = getEffectiveRequestedModel(options.config, requestedModel);
  if (!effectiveModel || !isAllowedCopilotProxyModel(effectiveModel, options)) {
    return undefined;
  }

  const model = options.copilotProxyRegistry?.findModel(effectiveModel);
  if (!model) {
    throw new RouteError(
      503,
      "Copilot models unavailable — VS Code extension not connected.",
    );
  }

  return model;
}

function normalizeCopilotMaxTokens(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  return Math.max(16, value);
}

function buildCopilotProxyRequest(
  model: RegisteredCopilotProxyModel,
  request: ChatCompletionRequest,
): import("@llm-gateway/shared").CopilotProxyRequestMessage {
  const proxyRequest: import("@llm-gateway/shared").CopilotProxyRequestMessage = {
    type: "request",
    id: randomUUID(),
    model: model.id,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content ?? "",
      ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
      ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
    })),
  };

  const params: import("@llm-gateway/shared").CopilotProxyRequestParams = {};
  if (request.stream !== undefined) {
    params.stream = request.stream;
  }
  if (request.temperature !== undefined) {
    params.temperature = request.temperature;
  }
  if (request.top_p !== undefined) {
    params.top_p = request.top_p;
  }
  const maxTokens = normalizeCopilotMaxTokens(request.max_completion_tokens);
  if (maxTokens !== undefined) {
    params.max_tokens = maxTokens;
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

  if (Object.keys(params).length > 0) {
    proxyRequest.params = params;
  }

  if (request.tools !== undefined && request.tools.length > 0) {
    proxyRequest.tools = request.tools;
  }

  return proxyRequest;
}

function dispatchCopilotProxyRequest(
  options: ResponsesRoutesOptions,
  model: RegisteredCopilotProxyModel,
  request: ChatCompletionRequest,
): CopilotProxyRequestHandle {
  const handle = options.copilotProxyRegistry?.dispatchRequest(
    buildCopilotProxyRequest(model, request),
  );

  if (!handle) {
    throw new RouteError(
      503,
      "Copilot models unavailable — VS Code extension not connected.",
    );
  }

  return handle;
}

function translateCopilotUsage(
  usage: import("@llm-gateway/shared").CopilotProxyUsage | undefined,
): ChatCompletionUsage | undefined {
  if (!usage) {
    return undefined;
  }

  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    total_tokens: usage.total_tokens ?? usage.input_tokens + usage.output_tokens,
  };
}

function getCopilotErrorStatus(message: CopilotProxyStreamMessage): number {
  return message.type === "stream_error" && message.error.status
    ? message.error.status
    : 502;
}

async function collectCopilotCompletion(
  handle: CopilotProxyRequestHandle,
  modelId: string,
): Promise<ChatCompletionResponse> {
  let content = "";
  let usage: ChatCompletionUsage | undefined;
  const toolCallStates = new Map<number, ChatToolCallDelta>();

  for await (const message of handle.events) {
    if (message.type === "stream_delta") {
      if (message.content_type === "text") {
        content += message.content;
      } else if (message.content_type === "tool_call") {
        const existing = toolCallStates.get(message.content.index) ?? {
          index: message.content.index,
        };
        if (message.content.id !== undefined) {
          existing.id = message.content.id;
        }
        if (message.content.type !== undefined) {
          existing.type = message.content.type;
        }
        if (message.content.function !== undefined) {
          existing.function = {
            name: `${existing.function?.name ?? ""}${message.content.function.name ?? ""}`,
            arguments: `${existing.function?.arguments ?? ""}${message.content.function.arguments ?? ""}`,
          };
        }
        toolCallStates.set(message.content.index, existing);
      } else if (message.content_type === "usage") {
        usage = translateCopilotUsage(message.content);
      }
      continue;
    }

    if (message.type === "stream_done") {
      usage = translateCopilotUsage(message.usage) ?? usage;
      const toolCalls = [...toolCallStates.values()]
        .sort((left, right) => left.index - right.index)
        .map((toolCall, index) => ({
          id: toolCall.id ?? `call_${index}`,
          type: "function" as const,
          function: {
            name: toolCall.function?.name ?? "tool",
            arguments: toolCall.function?.arguments ?? "{}",
          },
        }));

      return {
        id: `chatcmpl_${randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [
          {
            index: 0,
            finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
            message: {
              role: "assistant",
              content: content.length > 0 ? content : null,
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
            },
          },
        ],
        ...(usage ? { usage } : {}),
      };
    }

    throw new RouteError(getCopilotErrorStatus(message), message.error.message);
  }

  throw new RouteError(502, "Copilot proxy extension closed the request without a response.");
}

function createCopilotChatCompletionChunk(
  modelId: string,
  message: CopilotProxyStreamMessage,
  streamId: string,
  created: number,
): ChatCompletionResponse {
  const base = {
    id: streamId,
    object: "chat.completion.chunk",
    created,
    model: modelId,
  };

  if (message.type === "stream_done") {
    const usage = translateCopilotUsage(message.usage);
    return {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      ...(usage ? { usage } : {}),
    };
  }

  if (message.type === "stream_error") {
    throw new RouteError(getCopilotErrorStatus(message), message.error.message);
  }

  if (message.content_type === "text") {
    return {
      ...base,
      choices: [
        {
          index: 0,
          delta: { content: message.content },
          finish_reason: null,
        },
      ],
    };
  }

  if (message.content_type === "tool_call") {
    return {
      ...base,
      choices: [
        {
          index: 0,
          delta: { tool_calls: [message.content] },
          finish_reason: null,
        },
      ],
    };
  }

  return {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: null }],
  };
}

async function* createCopilotChatCompletionStream(
  handle: CopilotProxyRequestHandle,
  modelId: string,
): AsyncGenerator<string> {
  const streamId = `chatcmpl_${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  for await (const message of handle.events) {
    if (message.type === "stream_delta" && (message.content_type === "usage" || message.content_type === "progress")) {
      continue;
    }

    const chunk = createCopilotChatCompletionChunk(modelId, message, streamId, created);
    yield `data: ${JSON.stringify(chunk)}\n\n`;

    if (message.type === "stream_done") {
      yield "data: [DONE]\n\n";
      return;
    }
  }

  throw new RouteError(502, "Copilot proxy extension closed the request without a response.");
}

async function* translateCopilotResponseStream(
  handle: CopilotProxyRequestHandle,
  publicModel: string,
  options: TranslationOptions,
): AsyncGenerator<string> {
  const translator = createChatCompletionStreamTranslator(options);
  for await (const frame of createCopilotChatCompletionStream(handle, publicModel)) {
    for (const event of translator.push(frame)) {
      yield event;
    }
  }

  for (const event of translator.flush()) {
    yield event;
  }
}

async function* translateCopilotAnthropicStream(
  handle: CopilotProxyRequestHandle,
  publicModel: string,
): AsyncGenerator<string> {
  const translator = createAnthropicMessageStreamTranslator({ model: publicModel });
  for await (const frame of createCopilotChatCompletionStream(handle, publicModel)) {
    for (const event of translator.push(frame)) {
      yield event;
    }
  }

  for (const event of translator.flush()) {
    yield event;
  }
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
): AsyncGenerator<string> {
  const translator = createChatCompletionStreamTranslator(options);

  for await (const chunk of readableStreamToAsyncIterable(upstreamStream)) {
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
): AsyncGenerator<string> {
  const translator = createAnthropicMessageStreamTranslator({
    model: publicModel,
  });

  for await (const chunk of readableStreamToAsyncIterable(upstreamStream)) {
    for (const frame of translator.push(chunk)) {
      yield frame;
    }
  }

  for (const frame of translator.flush()) {
    yield frame;
  }
}

async function* readableStreamToAsyncIterable(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();

  try {
    while (true) {
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
  const unknownFieldCounters = new Map<string, { warn: number; enforce: number }>();

  const incrementUnknownFieldCounter = (
    publicModel: string,
    mode: "warn" | "enforce",
  ): number => {
    const existing = unknownFieldCounters.get(publicModel) ?? { warn: 0, enforce: 0 };
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
    } = {
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
      logger: app.log.child({
        component: "upstream-client",
        upstreamBaseUrl: model.baseUrl,
      }),
    };
    if (options.fetchFn) {
      clientOptions.fetchFn = options.fetchFn;
    }

    const client = new ChatCompletionsClient(clientOptions);
    clientCache.set(cacheKey, client);
    return client;
  };

  const modelsListHandler = async (status?: string) => createModelsList(options, status);
  const anthropicModelsListHandler = async (status?: string) =>
    createAnthropicModelsList(options, status);
  const modelDetailHandler = async (
    request: FastifyRequest<{ Params: { model: string } }>,
    reply: FastifyReply,
  ) => {
    log.debug({ model: request.params.model }, "Serving model metadata detail.");
    const configured = getAllModelRecords(options).find(
      (model) => model.id === request.params.model,
    );

    if (!configured) {
      return reply.code(404).send({
        error: `Model \`${request.params.model}\` is not configured.`,
      });
    }

    if (hasAnthropicVersionHeader(request)) {
      return createAnthropicModelsList(options).data.find(
        (model) => model.id === request.params.model,
      );
    }

    return configured;
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
      const copilotModel = getCopilotProxyModelOrThrow(options, parsedRequest.model);
      if (copilotModel) {
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

        const upstreamRequest = buildChatCompletionRequest({
          ...parsedRequest,
          model: copilotModel.native_id,
        });
        const handle = dispatchCopilotProxyRequest(options, copilotModel, upstreamRequest);
        const translationOptions = buildTranslationOptions(parsedRequest, copilotModel.id);

        if (parsedRequest.stream) {
          reply
            .code(200)
            .type("text/event-stream; charset=utf-8")
            .header("cache-control", "no-cache, no-transform")
            .header("connection", "keep-alive")
            .header("x-accel-buffering", "no");

          return reply.send(
            Readable.from(translateCopilotResponseStream(handle, copilotModel.id, translationOptions)),
          );
        }

        const copilotResponse = await collectCopilotCompletion(handle, copilotModel.id);
        return reply.code(200).send(
          translateChatCompletionResponse(copilotResponse, translationOptions),
        );
      }

      const selectedModel = resolveModel(options.config, parsedRequest.model);
      const supportsStreaming = selectedModel.supportsStreaming;
      const supportsTools = selectedModel.supportsTools;
      const unknownFieldMode = selectedModel.unknownFieldMode;
      const unknownTopLevelFields = listUnknownResponsesTopLevelFields(request.body);

      if (unknownTopLevelFields.length > 0) {
        const unknownFieldModeCount = incrementUnknownFieldCounter(
          selectedModel.name,
          unknownFieldMode,
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
        const upstreamStream = await client.createCompletionStream(upstreamRequest);

        reply
          .code(200)
          .type("text/event-stream; charset=utf-8")
          .header("cache-control", "no-cache, no-transform")
          .header("connection", "keep-alive")
          .header("x-accel-buffering", "no");

        return reply.send(
          Readable.from(translateStream(upstreamStream, translationOptions)),
        );
      }

      log.info(
        {
          requestId: request.id,
          publicModel: selectedModel.name,
        },
        "Proxying non-stream response request upstream.",
      );
      const upstreamResponse = await client.createCompletion(upstreamRequest);
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
      const copilotModel = getCopilotProxyModelOrThrow(options, parsedRequest.model);
      if (copilotModel) {
        if (parsedRequest.stream && !copilotModel.capabilities.supports_streaming) {
          throw new RouteError(
            400,
            `Model \`${copilotModel.id}\` does not support streaming.`,
          );
        }

        if (anthropicRequestUsesTools(parsedRequest) && !copilotModel.capabilities.supports_tools) {
          throw new RouteError(
            400,
            `Model \`${copilotModel.id}\` does not support tools.`,
          );
        }

        let upstreamRequest: ChatCompletionRequest;
        try {
          upstreamRequest = buildChatCompletionRequestFromAnthropic({
            ...parsedRequest,
            model: copilotModel.native_id,
          });
        } catch (error) {
          throw new RouteError(
            400,
            error instanceof Error ? error.message : String(error),
          );
        }

        const handle = dispatchCopilotProxyRequest(options, copilotModel, upstreamRequest);
        if (parsedRequest.stream) {
          reply
            .code(200)
            .type("text/event-stream; charset=utf-8")
            .header("cache-control", "no-cache, no-transform")
            .header("connection", "keep-alive")
            .header("x-accel-buffering", "no");

          return reply.send(
            Readable.from(translateCopilotAnthropicStream(handle, copilotModel.id)),
          );
        }

        const copilotResponse = await collectCopilotCompletion(handle, copilotModel.id);
        return reply.code(200).send(
          translateChatCompletionResponseToAnthropic(copilotResponse, {
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
          const upstreamStream = await client.createCompletionStream(upstreamRequest);

          reply
            .code(200)
            .type("text/event-stream; charset=utf-8")
            .header("cache-control", "no-cache, no-transform")
            .header("connection", "keep-alive")
            .header("x-accel-buffering", "no");

          return reply.send(
            Readable.from(
              translateAnthropicStream(upstreamStream, selectedModel.name),
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
          const upstreamResponse = await client.createCompletion(nonStreamingUpstreamRequest);
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
      const upstreamResponse = await client.createCompletion(upstreamRequest);
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

      const copilotModel = getCopilotProxyModelOrThrow(options, parsedRequest.model);
      if (copilotModel) {
        if (parsedRequest.stream && !copilotModel.capabilities.supports_streaming) {
          throw new RouteError(
            400,
            `Model \`${copilotModel.id}\` does not support streaming.`,
          );
        }

        if (chatCompletionsRequestUsesTools(parsedRequest) && !copilotModel.capabilities.supports_tools) {
          throw new RouteError(400, `Model \`${copilotModel.id}\` does not support tools.`);
        }

        const upstreamRequest: ChatCompletionRequest = {
          ...parsedRequest,
          model: copilotModel.native_id,
        };
        const handle = dispatchCopilotProxyRequest(options, copilotModel, upstreamRequest);

        if (parsedRequest.stream) {
          reply
            .code(200)
            .type("text/event-stream; charset=utf-8")
            .header("cache-control", "no-cache, no-transform")
            .header("connection", "keep-alive")
            .header("x-accel-buffering", "no");

          return reply.send(
            Readable.from(createCopilotChatCompletionStream(handle, copilotModel.id)),
          );
        }

        const copilotResponse = await collectCopilotCompletion(handle, copilotModel.id);
        return reply.code(200).send(copilotResponse);
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
        const upstreamStream = await client.createCompletionStream(upstreamRequest);

        reply
          .code(200)
          .type("text/event-stream; charset=utf-8")
          .header("cache-control", "no-cache, no-transform")
          .header("connection", "keep-alive")
          .header("x-accel-buffering", "no");

        return reply.send(Readable.from(readableStreamToAsyncIterable(upstreamStream)));
      }

      log.info(
        {
          requestId: request.id,
          publicModel: selectedModel.name,
        },
        "Proxying non-stream chat completions request upstream.",
      );
      const upstreamResponse = await client.createCompletion(upstreamRequest);
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

  app.get("/models", async (request) => {
    const status = getStatusFilter(request);
    log.debug(
      { configuredModels: options.config.models.map((model) => model.name) },
      "Serving models list.",
    );
    return modelsListHandler(status);
  });
  app.get("/v1/models", async (request) => {
    const status = getStatusFilter(request);
    log.debug(
      {
        configuredModels: options.config.models.map((model) => model.name),
        anthropic: hasAnthropicVersionHeader(request),
      },
      "Serving models list.",
    );
    return hasAnthropicVersionHeader(request)
      ? anthropicModelsListHandler(status)
      : modelsListHandler(status);
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

function getStatusFilter(request: FastifyRequest): string | undefined {
  const query = request.query;
  if (!isRecord(query) || typeof query.status !== "string") {
    return undefined;
  }

  return normalizeOptionalString(query.status);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
