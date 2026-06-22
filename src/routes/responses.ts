import { Readable } from "node:stream";

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type {
  AnthropicMessagesRequest,
  ChatCompletionRequest,
  ResponseInput,
  ResponseInputItem,
  ResponseMessageItem,
  ResponseRequest,
} from "../contracts.js";
import type { AppConfig, GatewayModelConfig } from "../config.js";
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
}

interface AnthropicModelRecord {
  id: string;
  type: "model";
  display_name: string;
  created_at: string;
}

interface ResponsesRoutesOptions {
  config: AppConfig;
  client?: ChatCompletionsTransport;
  fetchFn?: typeof fetch;
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

function createModelsList(config: AppConfig): { object: "list"; data: ModelRecord[] } {
  return {
    object: "list",
    data: config.models.map((model) => createModelRecord(model)),
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

function createAnthropicModelsList(
  config: AppConfig,
): { object: "list"; data: AnthropicModelRecord[] } {
  return {
    object: "list",
    data: config.models.map((model) => createAnthropicModelRecord(model)),
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

  const modelsListHandler = async () => createModelsList(options.config);
  const anthropicModelsListHandler = async () =>
    createAnthropicModelsList(options.config);
  const modelDetailHandler = async (
    request: FastifyRequest<{ Params: { model: string } }>,
    reply: FastifyReply,
  ) => {
    log.debug({ model: request.params.model }, "Serving model metadata detail.");
    const configured = options.config.models.find(
      (model) => model.name === request.params.model,
    );

    if (!configured) {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
