import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Buffer } from "node:buffer";

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig, GatewayModelConfig } from "../config.js";
import {
  ChatCompletionsClient,
  UpstreamHttpError,
  type ChatCompletionsTransport,
} from "../upstream/chat-completions-client.js";
import type { ChatCompletionRequest } from "../contracts.js";
import { insertAiChatAuditEvent } from "../db/ai-chat-audit-repository.js";

import {
  getAiChatSessionById,
  insertAiChatSession,
  insertAiChatMessage,
  listAiChatMessagesBySession,
  listAiChatSessionsByUser,
  renameAiChatSession,
  touchAiChatSession,
  updateAiChatSessionModel,
  type AiChatMessageCursor,
  type AiChatSessionCursor,
} from "../db/ai-chat-repository.js";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const MAX_TRANSIENT_RETRIES = 2;
const STREAM_HEARTBEAT_INTERVAL_CHARS = 1;
const LEGACY_QUICK_VALIDATION_MESSAGES_PATH = "/api/ai-chat/quick-validation/messages";
const AUTO_TITLE_MAX_LENGTH = 60;
const SESSION_TITLE_MIN_LENGTH = 1;
const SESSION_TITLE_MAX_LENGTH = 120;

const LOCALIZED_MESSAGES = {
  RATE_LIMITED: "Rate limit exceeded. Please wait and retry shortly.",
  UPSTREAM_TIMEOUT: "The model took too long to respond. Please try again.",
  UPSTREAM_UNAVAILABLE: "The model is currently unavailable. Please retry.",
  VALIDATION_ERROR: "The request could not be processed. Please check your input.",
  UNAUTHORIZED: "Authentication is required to use Web AI Chat.",
  FORBIDDEN: "You do not have access to this chat session.",
} as const;

const userRateWindows = new Map<string, number[]>();

const sendMessageBodySchema = z.object({
  sessionId: z.string().uuid().optional(),
  prompt: z.string().trim().min(1),
  stream: z.boolean().default(true),
  clientMessageId: z.string().uuid(),
  model: z.string().trim().min(1).optional(),
  context: z.object({
    locale: z.string().optional(),
    timezone: z.string().optional(),
  }).optional(),
});

const paginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const renameSessionBodySchema = z.object({
  title: z.string().trim().min(SESSION_TITLE_MIN_LENGTH).max(SESSION_TITLE_MAX_LENGTH),
});

class AiChatRouteError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly retryCount: number;
  public readonly errorClass: string;

  public constructor(
    statusCode: number,
    code: string,
    message: string,
    options: boolean | {
      retryable?: boolean;
      retryCount?: number;
      errorClass?: string;
    } = false,
  ) {
    super(message);
    this.name = "AiChatRouteError";
    this.statusCode = statusCode;
    this.code = code;
    if (typeof options === "boolean") {
      this.retryable = options;
      this.retryCount = 0;
      this.errorClass = code;
      return;
    }
    this.retryable = options.retryable ?? false;
    this.retryCount = options.retryCount ?? 0;
    this.errorClass = options.errorClass ?? code;
  }
}

interface UpstreamCallResult {
  statusCode: number;
  body: string;
  headers: Record<string, unknown>;
  retryCount: number;
  errorClass: string | null;
}

interface AiChatAuditPayload {
  actor: string;
  action: "send" | "rename";
  requestId: string;
  sessionId: string;
  outcome: string;
  retryCount: number;
  errorClass: string | null;
  latencyMs?: number;
  streamInterrupted?: boolean;
}

interface UpstreamStreamResult {
  requestId: string;
  deltas: string[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  error?: AiChatRouteError;
}

interface AiChatRoutesOptions {
  config: AppConfig;
  client?: ChatCompletionsTransport;
  fetchFn?: typeof fetch;
}

function extractUserId(request: FastifyRequest): string | null {
  const raw = request.headers["x-user-id"];
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  if (Array.isArray(raw) && typeof raw[0] === "string" && raw[0].trim().length > 0) {
    return raw[0].trim();
  }
  return null;
}

function nowMillis(): number {
  return Date.now();
}

function createRequestId(): string {
  return `req_${randomUUID()}`;
}

function encodeCursor(value: AiChatSessionCursor | AiChatMessageCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeSessionCursor(raw?: string): AiChatSessionCursor | undefined {
  if (!raw) {
    return undefined;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new AiChatRouteError(400, "VALIDATION_ERROR", "Invalid session cursor.");
  }
  if (typeof parsed.updatedAt !== "number" || typeof parsed.id !== "string") {
    throw new AiChatRouteError(400, "VALIDATION_ERROR", "Invalid session cursor.");
  }
  return { updatedAt: parsed.updatedAt, id: parsed.id };
}

function decodeMessageCursor(raw?: string): AiChatMessageCursor | undefined {
  if (!raw) {
    return undefined;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new AiChatRouteError(400, "VALIDATION_ERROR", "Invalid message cursor.");
  }
  if (typeof parsed.createdAt !== "number" || typeof parsed.id !== "string") {
    throw new AiChatRouteError(400, "VALIDATION_ERROR", "Invalid message cursor.");
  }
  return { createdAt: parsed.createdAt, id: parsed.id };
}

function enforceRateLimit(userId: string): { limited: boolean; retryAfterSeconds?: number } {
  const now = nowMillis();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const existing = userRateWindows.get(userId) ?? [];
  const active = existing.filter((value) => value >= windowStart);

  if (active.length >= RATE_LIMIT_MAX_REQUESTS) {
    const oldest = active[0]!;
    const retryAfterMs = Math.max(0, RATE_LIMIT_WINDOW_MS - (now - oldest));
    userRateWindows.set(userId, active);
    return {
      limited: true,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    };
  }

  active.push(now);
  userRateWindows.set(userId, active);
  return { limited: false };
}

function isTransientUpstreamStatus(statusCode: number): boolean {
  return statusCode === 408
    || statusCode === 429
    || statusCode === 500
    || statusCode === 502
    || statusCode === 503
    || statusCode === 504;
}

function localizedMessage(code: string): string {
  return LOCALIZED_MESSAGES[code as keyof typeof LOCALIZED_MESSAGES] ?? "An error occurred while processing the request.";
}

function parseUpstreamError(statusCode: number, payload: string): AiChatRouteError {
  let code = "UPSTREAM_UNAVAILABLE";
  let message = localizedMessage("UPSTREAM_UNAVAILABLE");
  let retryable = isTransientUpstreamStatus(statusCode);

  if (statusCode === 401) {
    return new AiChatRouteError(401, "UNAUTHORIZED", localizedMessage("UNAUTHORIZED"));
  }
  if (statusCode === 403) {
    return new AiChatRouteError(403, "FORBIDDEN", localizedMessage("FORBIDDEN"));
  }
  if (statusCode === 429) {
    return new AiChatRouteError(429, "RATE_LIMITED", localizedMessage("RATE_LIMITED"), true);
  }
  if (statusCode === 400 || statusCode === 422) {
    code = "VALIDATION_ERROR";
    message = localizedMessage("VALIDATION_ERROR");
    retryable = false;
  } else if (statusCode === 408) {
    code = "UPSTREAM_TIMEOUT";
    message = localizedMessage("UPSTREAM_TIMEOUT");
  }

  if (payload.length > 0) {
    try {
      const body = JSON.parse(payload) as Record<string, unknown>;
      const errorObj = body.error as Record<string, unknown> | undefined;
      if (errorObj && typeof errorObj.message === "string") {
        message = errorObj.message;
      } else if (typeof body.error === "string") {
        message = body.error;
      }
    } catch {
      // Keep generic message when upstream body is not valid JSON.
    }
  }

  return new AiChatRouteError(statusCode, code, message, { retryable, errorClass: code });
}

function classifyNetworkFailure(error: unknown): { statusCode: number; code: string; message: string } {
  if (error instanceof Error && error.name === "AbortError") {
    return {
      statusCode: 408,
      code: "UPSTREAM_TIMEOUT",
      message: localizedMessage("UPSTREAM_TIMEOUT"),
    };
  }
  return {
    statusCode: 503,
    code: "UPSTREAM_UNAVAILABLE",
    message: localizedMessage("UPSTREAM_UNAVAILABLE"),
  };
}

function parseStreamUsage(payload: Record<string, unknown>): UpstreamStreamResult["usage"] | undefined {
  const usage = payload.usage as Record<string, unknown> | undefined;
  if (!usage) {
    return undefined;
  }

  const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
  const completion = typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined;
  const total = typeof usage.total_tokens === "number" ? usage.total_tokens : undefined;
  if (prompt === undefined || completion === undefined || total === undefined) {
    return undefined;
  }

  return {
    inputTokens: prompt,
    outputTokens: completion,
    totalTokens: total,
  };
}

function parseUpstreamStreamPayload(payload: string): UpstreamStreamResult {
  const deltas: string[] = [];
  let usage: UpstreamStreamResult["usage"];
  let requestId = createRequestId();

  const frames = payload.split("\n\n");
  for (const frame of frames) {
    if (frame.trim().length === 0) {
      continue;
    }
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");

    if (!data || data === "[DONE]") {
      continue;
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (typeof parsed.id === "string" && parsed.id.length > 0) {
      requestId = parsed.id;
    }

    if (parsed.error && typeof parsed.error === "object") {
      const err = parsed.error as Record<string, unknown>;
      const message = typeof err.message === "string" ? err.message : "Streaming upstream request failed.";
      const code = typeof err.code === "string" ? err.code : "UPSTREAM_UNAVAILABLE";
      return {
        requestId,
        deltas,
        ...(usage ? { usage } : {}),
        error: new AiChatRouteError(502, code, message, true),
      };
    }

    const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
    const first = choices[0] as Record<string, unknown> | undefined;
    const delta = first?.delta as Record<string, unknown> | undefined;
    if (delta && typeof delta.content === "string" && delta.content.length > 0) {
      deltas.push(delta.content);
    }

    usage = parseStreamUsage(parsed) ?? usage;
  }

  return {
    requestId,
    deltas,
    ...(usage ? { usage } : {}),
  };
}

/**
 * Resolve the routable model for a message request, per the precedence:
 * - For an existing session: the session's stored `model` wins (and is updated
 *   if the client sends a differing `model`).
 * - For a new session: the client-supplied `model`, else `config.defaultModel`,
 *   else the first active model.
 *
 * The resolved model must be an active configured model, else `VALIDATION_ERROR`.
 * The `clientModel`/`sessionModel` may be `null` (new session, no client model;
 * or a pre-existing session with NULL stored model).
 */
function resolveModel(
  config: AppConfig,
  sessionModel: string | null,
  clientModel: string | undefined,
): { model: GatewayModelConfig; stampedModel: string } {
  if (config.models.length === 0) {
    throw new AiChatRouteError(503, "UPSTREAM_UNAVAILABLE", "No chat model is configured.");
  }

  // A model is routable unless it is explicitly inactive. (The production
  // loader defaults to "active"; unnormalized configs/tests may omit the field,
  // so we exclude only explicit "inactive" rather than require "active".)
  const activeModels = config.models.filter((model) => model.status !== "inactive");
  if (activeModels.length === 0) {
    throw new AiChatRouteError(503, "UPSTREAM_UNAVAILABLE", "No chat model is configured.");
  }

  // Existing session: the stored model is authoritative, BUT if the client sends
  // a differing model, switch to it (mid-session switch). New session: prefer
  // the client-supplied model, then the default.
  const desired = (sessionModel !== null && clientModel !== undefined && clientModel !== sessionModel)
    ? clientModel
    : (sessionModel ?? clientModel ?? config.defaultModel ?? null);

  const findActive = (name: string | null): GatewayModelConfig | undefined =>
    name ? activeModels.find((model) => model.name === name) : undefined;

  if (desired) {
    const matched = findActive(desired);
    if (!matched) {
      throw new AiChatRouteError(
        400,
        "VALIDATION_ERROR",
        `Model \`${desired}\` is not available.`,
      );
    }
    return { model: matched, stampedModel: matched.name };
  }

  // No explicit model: default, else first active.
  const fallback = config.defaultModel
    ? findActive(config.defaultModel) ?? activeModels[0]!
    : activeModels[0]!;
  return { model: fallback, stampedModel: fallback.name };
}

/**
 * Derive a human-readable session title from the first user prompt: the first
 * `AUTO_TITLE_MAX_LENGTH` characters, trimmed; truncated with a trailing `…`
 * when the prompt exceeds the limit. Newlines collapse to spaces so the title
 * renders on one line.
 */
function deriveSessionTitle(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, " ").trim();
  if (collapsed.length <= AUTO_TITLE_MAX_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, AUTO_TITLE_MAX_LENGTH)}…`;
}

async function callChatCompletionsWithRetry(
  request: FastifyRequest,
  payload: Record<string, unknown>,
  model: GatewayModelConfig,
  client: ChatCompletionsTransport,
): Promise<UpstreamCallResult> {
  let lastStatusCode = 502;
  let lastBody = "";
  let lastHeaders: Record<string, unknown> = {};
  let retryCount = 0;

  const upstreamRequest = {
    model: model.upstreamModel,
    messages: payload.messages as ChatCompletionRequest["messages"],
    ...(payload.stream !== undefined ? { stream: payload.stream as boolean } : {}),
  } as ChatCompletionRequest;
  const isStream = payload.stream === true;

  for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt += 1) {
    try {
      if (isStream) {
        const stream = await client.createCompletionStream(upstreamRequest);
        const body = await drainSseStream(stream);
        lastStatusCode = 200;
        lastBody = body;
        lastHeaders = {};
        return {
          statusCode: 200,
          body,
          headers: lastHeaders,
          retryCount,
          errorClass: null,
        };
      }

      const response = await client.createCompletion(upstreamRequest);
      const body = JSON.stringify(response);
      lastStatusCode = 200;
      lastBody = body;
      lastHeaders = {};
      return {
        statusCode: 200,
        body,
        headers: lastHeaders,
        retryCount,
        errorClass: null,
      };
    } catch (error) {
      // ChatCompletionsClient surfaces non-2xx upstream responses as
      // UpstreamHttpError (carrying statusCode/body) and network/TLS failures
      // as a plain Error. The OpenAI SDK wraps connection failures
      // (timeouts, DNS, TLS) as APIConnectionError/APIConnectionTimeoutError,
      // which the client then surfaces as UpstreamHttpError with a synthetic
      // 502 status and the SDK error name in `statusText` — detect those and
      // route them through classifyNetworkFailure so timeouts map to 408 and
      // other network failures to 503, preserving the route's error taxonomy.
      const isConnectionFailure = error instanceof UpstreamHttpError
        && (error.statusText === "APIConnectionError"
          || error.statusText === "APIConnectionTimeoutError");
      if (error instanceof UpstreamHttpError && !isConnectionFailure) {
        lastStatusCode = error.statusCode;
        lastBody = error.body;
        lastHeaders = {};
        const upstreamError = parseUpstreamError(error.statusCode, error.body);
        if (!isTransientUpstreamStatus(error.statusCode) || attempt === MAX_TRANSIENT_RETRIES) {
          return {
            statusCode: error.statusCode,
            body: error.body,
            headers: lastHeaders,
            retryCount,
            errorClass: upstreamError.errorClass,
          };
        }
        retryCount += 1;
        request.log.info(
          {
            event: "ai_chat_retry",
            attempt: attempt + 1,
            maxRetries: MAX_TRANSIENT_RETRIES,
            statusCode: error.statusCode,
            retryCount,
            errorClass: upstreamError.errorClass,
          },
          "Retrying transient upstream failure for Web AI Chat.",
        );
        continue;
      }

      const cause = isConnectionFailure
        ? new Error(error.body || error.statusText)
        : error;
      if (isConnectionFailure && error.statusText === "APIConnectionTimeoutError") {
        Object.defineProperty(cause, "name", { value: "AbortError" });
      }
      const classifiedError = classifyNetworkFailure(cause);
      if (attempt === MAX_TRANSIENT_RETRIES) {
        throw new AiChatRouteError(
          classifiedError.statusCode,
          classifiedError.code,
          classifiedError.message,
          {
            retryable: true,
            retryCount,
            errorClass: classifiedError.code,
          },
        );
      }
      retryCount += 1;
      request.log.info(
        {
          event: "ai_chat_retry",
          attempt: attempt + 1,
          maxRetries: MAX_TRANSIENT_RETRIES,
          error: error instanceof Error ? error.message : "unknown",
          retryCount,
          errorClass: classifiedError.code,
        },
        "Retrying transient upstream network failure for Web AI Chat.",
      );
    }
  }

  return {
    statusCode: lastStatusCode,
    body: lastBody,
    headers: lastHeaders,
    retryCount,
    errorClass: "UPSTREAM_UNAVAILABLE",
  };
}

/**
 * Drain a `ReadableStream<Uint8Array>` of SSE frames (as emitted by
 * `ChatCompletionsClient.createCompletionStream`) into a single string, so the
 * route can feed it to the existing buffered `parseUpstreamStreamPayload`.
 */
async function drainSseStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let body = "";
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    body += decoder.decode(value, { stream: true });
  }
  body += decoder.decode();
  return body;
}

function sseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function ensureOwnedSession(sessionId: string, userId: string): void {
  const session = getAiChatSessionById(sessionId);
  if (!session) {
    throw new AiChatRouteError(404, "VALIDATION_ERROR", `Session \`${sessionId}\` not found.`);
  }
  if (session.user_id !== userId) {
    throw new AiChatRouteError(403, "FORBIDDEN", localizedMessage("FORBIDDEN"));
  }
}

function toErrorPayload(error: AiChatRouteError, requestId: string): Record<string, unknown> {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    requestId,
    retryCount: error.retryCount,
    errorClass: error.errorClass,
  };
}

function writeAuditEvent(request: FastifyRequest, audit: AiChatAuditPayload): void {
  const timestamp = nowMillis();
  insertAiChatAuditEvent({
    id: randomUUID(),
    actor: audit.actor,
    action: audit.action,
    request_id: audit.requestId,
    session_id: audit.sessionId,
    outcome: audit.outcome,
    timestamp,
    retry_count: audit.retryCount,
    error_class: audit.errorClass,
    prompt_redacted: 1,
    response_redacted: 1,
  });

  request.log.info(
    {
      event: "ai_chat_audit",
      actor: audit.actor,
      action: audit.action,
      requestId: audit.requestId,
      sessionId: audit.sessionId,
      outcome: audit.outcome,
      timestamp,
      retryCount: audit.retryCount,
      errorClass: audit.errorClass,
      latencyMs: audit.latencyMs ?? null,
      streamInterrupted: audit.streamInterrupted ?? false,
      promptRedacted: true,
      responseRedacted: true,
    },
    "Web AI Chat audit event.",
  );
}

function sendRouteError(reply: FastifyReply, error: AiChatRouteError, requestId: string): FastifyReply {
  return reply.code(error.statusCode).send({
    error: toErrorPayload(error, requestId),
  });
}

function ensureModelRuntimeReady(
  model: GatewayModelConfig,
): asserts model is GatewayModelConfig & { apiKey: string } {
  if (!model.baseUrl || !model.apiKey) {
    throw new AiChatRouteError(500, "UPSTREAM_UNAVAILABLE", `Model \`${model.name}\` is missing runtime configuration.`);
  }
}

export const aiChatRoutes: FastifyPluginAsync<AiChatRoutesOptions> = async (app, options) => {
  const clientCache = new Map<string, ChatCompletionsTransport>();

  const getClient = (model: GatewayModelConfig): ChatCompletionsTransport => {
    ensureModelRuntimeReady(model);
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
      maxRetries: number;
      logger?: { debug: (...args: unknown[]) => void; info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void; error: (...args: unknown[]) => void };
    } = {
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
      maxRetries: 0,
      logger: app.log.child({ component: "upstream-client", upstreamBaseUrl: model.baseUrl }),
    };
    if (options.fetchFn) {
      clientOptions.fetchFn = options.fetchFn;
    }
    const client = new ChatCompletionsClient(clientOptions);
    clientCache.set(cacheKey, client);
    return client;
  };

  app.post("/api/ai-chat/messages", async (request, reply) => {
    const requestId = createRequestId();
    const userId = extractUserId(request);
    if (!userId) {
      const error = new AiChatRouteError(401, "UNAUTHORIZED", localizedMessage("UNAUTHORIZED"));
      writeAuditEvent(request, {
        actor: "anonymous",
        action: "send",
        requestId,
        sessionId: "unknown",
        outcome: "denied",
        retryCount: 0,
        errorClass: error.errorClass,
      });
      return sendRouteError(reply, error, requestId);
    }

    const bodyResult = sendMessageBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      const error = new AiChatRouteError(400, "VALIDATION_ERROR", bodyResult.error.message);
      writeAuditEvent(request, {
        actor: userId,
        action: "send",
        requestId,
        sessionId: "unknown",
        outcome: "failed",
        retryCount: 0,
        errorClass: error.errorClass,
      });
      return sendRouteError(reply, error, requestId);
    }

    const { limited, retryAfterSeconds } = enforceRateLimit(userId);
    if (limited) {
      writeAuditEvent(request, {
        actor: userId,
        action: "send",
        requestId,
        sessionId: bodyResult.data.sessionId ?? "unknown",
        outcome: "rate_limited",
        retryCount: 0,
        errorClass: "RATE_LIMITED",
      });
      return reply.code(429).send({
        error: {
          code: "RATE_LIMITED",
          message: localizedMessage("RATE_LIMITED"),
          retryable: true,
          requestId,
          retryCount: 0,
          errorClass: "RATE_LIMITED",
          retryAfterSeconds,
        },
      });
    }

    const parsed = bodyResult.data;
    const sessionId = parsed.sessionId ?? randomUUID();
    const timestamp = nowMillis();
    const existingSession = getAiChatSessionById(sessionId);
    if (existingSession && existingSession.user_id !== userId) {
      const error = new AiChatRouteError(403, "FORBIDDEN", localizedMessage("FORBIDDEN"));
      writeAuditEvent(request, {
        actor: userId,
        action: "send",
        requestId,
        sessionId,
        outcome: "denied",
        retryCount: 0,
        errorClass: error.errorClass,
      });
      return sendRouteError(reply, error, requestId);
    }

    let routedModel: ReturnType<typeof resolveModel>;
    try {
      routedModel = resolveModel(options.config, existingSession?.model ?? null, parsed.model);
    } catch (error) {
      if (error instanceof AiChatRouteError) {
        writeAuditEvent(request, {
          actor: userId,
          action: "send",
          requestId,
          sessionId,
          outcome: "failed",
          retryCount: error.retryCount,
          errorClass: error.errorClass,
        });
        return sendRouteError(reply, error, requestId);
      }
      throw error;
    }

    if (!existingSession) {
      insertAiChatSession({
        id: sessionId,
        user_id: userId,
        created_at: timestamp,
        updated_at: timestamp,
        model: routedModel.stampedModel,
        title: deriveSessionTitle(parsed.prompt),
      });
    } else {
      touchAiChatSession(sessionId, timestamp);
      if (existingSession.model !== routedModel.stampedModel) {
        updateAiChatSessionModel(sessionId, routedModel.stampedModel);
      }
    }

    const userMessageId = randomUUID();
    insertAiChatMessage({
      id: userMessageId,
      session_id: sessionId,
      user_id: userId,
      role: "user",
      content: parsed.prompt,
      model: null,
      request_id: null,
      status: "done",
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      client_message_id: parsed.clientMessageId,
      created_at: timestamp,
    });

    request.log.info(
      { event: "ai_chat_send", requestId, sessionId, userId, stream: parsed.stream },
      "Web AI Chat request accepted.",
    );

    ensureModelRuntimeReady(routedModel.model);

    if (!parsed.stream) {
      const requestStartedAt = nowMillis();
      let upstream;
      try {
        upstream = await callChatCompletionsWithRetry(request, {
          stream: false,
          messages: [{ role: "user", content: parsed.prompt }],
        }, routedModel.model, getClient(routedModel.model));
      } catch (error) {
        if (error instanceof AiChatRouteError) {
          writeAuditEvent(request, {
            actor: userId,
            action: "send",
            requestId,
            sessionId,
            outcome: "failed",
            retryCount: error.retryCount,
            errorClass: error.errorClass,
            latencyMs: nowMillis() - requestStartedAt,
            streamInterrupted: false,
          });
          return sendRouteError(reply, error, requestId);
        }
        throw error;
      }
      if (upstream.statusCode >= 400) {
        const upstreamError = parseUpstreamError(upstream.statusCode, upstream.body);
        const terminalError = new AiChatRouteError(
          upstreamError.statusCode,
          upstreamError.code,
          upstreamError.message,
          {
            retryable: upstreamError.retryable,
            retryCount: upstream.retryCount,
            errorClass: upstream.errorClass ?? upstreamError.errorClass,
          },
        );
        insertAiChatMessage({
          id: randomUUID(),
          session_id: sessionId,
          user_id: userId,
          role: "assistant",
          content: "",
          model: routedModel.stampedModel,
          request_id: requestId,
          status: "failed",
          input_tokens: null,
          output_tokens: null,
          total_tokens: null,
          client_message_id: null,
          created_at: nowMillis(),
        });
        touchAiChatSession(sessionId, nowMillis());
        request.log.warn(
          {
            event: "ai_chat_fail",
            requestId,
            sessionId,
            code: terminalError.code,
            retryCount: terminalError.retryCount,
            errorClass: terminalError.errorClass,
            latencyMs: nowMillis() - requestStartedAt,
            streamInterrupted: false,
          },
          "Web AI Chat non-stream request failed.",
        );
        writeAuditEvent(request, {
          actor: userId,
          action: "send",
          requestId,
          sessionId,
          outcome: "failed",
          retryCount: terminalError.retryCount,
          errorClass: terminalError.errorClass,
          latencyMs: nowMillis() - requestStartedAt,
          streamInterrupted: false,
        });
        return sendRouteError(reply, terminalError, requestId);
      }

      const upstreamBody = JSON.parse(upstream.body) as Record<string, unknown>;
      const choices = Array.isArray(upstreamBody.choices) ? upstreamBody.choices : [];
      const firstChoice = choices[0] as Record<string, unknown> | undefined;
      const messageObj = (firstChoice?.message as Record<string, unknown> | undefined) ?? {};
      const assistantContent = typeof messageObj.content === "string"
        ? messageObj.content
        : "";
      const usageObj = (upstreamBody.usage as Record<string, unknown> | undefined) ?? {};
      const inputTokens = typeof usageObj.prompt_tokens === "number" ? usageObj.prompt_tokens : null;
      const outputTokens = typeof usageObj.completion_tokens === "number" ? usageObj.completion_tokens : null;
      const totalTokens = typeof usageObj.total_tokens === "number" ? usageObj.total_tokens : null;
      const assistantRequestId = typeof upstreamBody.id === "string" ? upstreamBody.id : requestId;
      const assistantMessageId = randomUUID();

      insertAiChatMessage({
        id: assistantMessageId,
        session_id: sessionId,
        user_id: userId,
        role: "assistant",
        content: assistantContent,
        model: routedModel.stampedModel,
        request_id: assistantRequestId,
        status: "done",
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: totalTokens,
        client_message_id: null,
        created_at: nowMillis(),
      });
      touchAiChatSession(sessionId, nowMillis());

      request.log.info(
        {
          event: "ai_chat_complete",
          requestId: assistantRequestId,
          sessionId,
          userId,
          retryCount: upstream.retryCount,
          latencyMs: nowMillis() - requestStartedAt,
          streamInterrupted: false,
        },
        "Web AI Chat non-stream request completed.",
      );
      writeAuditEvent(request, {
        actor: userId,
        action: "send",
        requestId: assistantRequestId,
        sessionId,
        outcome: "completed",
        retryCount: upstream.retryCount,
        errorClass: null,
        latencyMs: nowMillis() - requestStartedAt,
        streamInterrupted: false,
      });

      return reply.code(200).send({
        sessionId,
        messageId: assistantMessageId,
        assistantMessage: {
          role: "assistant",
          content: assistantContent,
        },
        usage: {
          inputTokens,
          outputTokens,
          totalTokens,
        },
        model: routedModel.stampedModel,
        requestId: assistantRequestId,
      });
    }

    const requestStartedAt = nowMillis();
    let upstream;
    try {
      upstream = await callChatCompletionsWithRetry(request, {
        stream: true,
        messages: [{ role: "user", content: parsed.prompt }],
      }, routedModel.model, getClient(routedModel.model));
    } catch (error) {
      if (error instanceof AiChatRouteError) {
        upstream = {
          statusCode: error.statusCode,
          body: JSON.stringify({
            error: {
              message: error.message,
              code: error.code,
            },
          }),
          headers: {},
          retryCount: error.retryCount,
          errorClass: error.errorClass,
        };
      } else {
        throw error;
      }
    }

    let streamResult: UpstreamStreamResult;
    if (upstream.statusCode >= 400) {
      const parsedFailureStream = parseUpstreamStreamPayload(upstream.body);
      streamResult = {
        requestId: parsedFailureStream.requestId || requestId,
        deltas: parsedFailureStream.deltas,
        ...(parsedFailureStream.usage ? { usage: parsedFailureStream.usage } : {}),
        error: parsedFailureStream.error ?? new AiChatRouteError(
          upstream.statusCode,
          parseUpstreamError(upstream.statusCode, upstream.body).code,
          parseUpstreamError(upstream.statusCode, upstream.body).message,
          {
            retryable: parseUpstreamError(upstream.statusCode, upstream.body).retryable,
            retryCount: upstream.retryCount,
            errorClass: upstream.errorClass ?? parseUpstreamError(upstream.statusCode, upstream.body).errorClass,
          },
        ),
      };
    } else {
      streamResult = parseUpstreamStreamPayload(upstream.body);
    }

    const assistantMessageId = randomUUID();
    const terminalRequestId = streamResult.requestId || requestId;
    let assistantContent = "";
    for (const delta of streamResult.deltas) {
      assistantContent += delta;
    }

    if (streamResult.error) {
      insertAiChatMessage({
        id: assistantMessageId,
        session_id: sessionId,
        user_id: userId,
        role: "assistant",
        content: assistantContent,
        model: routedModel.stampedModel,
        request_id: terminalRequestId,
        status: "failed",
        input_tokens: streamResult.usage?.inputTokens ?? null,
        output_tokens: streamResult.usage?.outputTokens ?? null,
        total_tokens: streamResult.usage?.totalTokens ?? null,
        client_message_id: null,
        created_at: nowMillis(),
      });
      touchAiChatSession(sessionId, nowMillis());

      request.log.warn(
        {
          event: "ai_chat_fail",
          requestId: terminalRequestId,
          sessionId,
          code: streamResult.error.code,
          retryCount: streamResult.error.retryCount,
          errorClass: streamResult.error.errorClass,
          latencyMs: nowMillis() - requestStartedAt,
          streamInterrupted: streamResult.deltas.length > 0,
        },
        "Web AI Chat stream request failed.",
      );
      writeAuditEvent(request, {
        actor: userId,
        action: "send",
        requestId: terminalRequestId,
        sessionId,
        outcome: "failed",
        retryCount: streamResult.error.retryCount,
        errorClass: streamResult.error.errorClass,
        latencyMs: nowMillis() - requestStartedAt,
        streamInterrupted: streamResult.deltas.length > 0,
      });

      reply
        .code(200)
        .type("text/event-stream; charset=utf-8")
        .header("cache-control", "no-cache, no-transform")
        .header("connection", "keep-alive");

      const frames: string[] = [];
      frames.push(sseEvent("started", {
        sessionId,
        messageId: assistantMessageId,
        model: routedModel.stampedModel,
        requestId: terminalRequestId,
      }));
      let charsSinceHeartbeat = 0;
      for (const delta of streamResult.deltas) {
        frames.push(sseEvent("heartbeat", { messageId: assistantMessageId, timestamp: nowMillis() }));
        frames.push(sseEvent("delta", { messageId: assistantMessageId, delta }));
        charsSinceHeartbeat += delta.length;
        if (charsSinceHeartbeat >= STREAM_HEARTBEAT_INTERVAL_CHARS) {
          charsSinceHeartbeat = 0;
        }
      }
      frames.push(sseEvent("error", toErrorPayload(streamResult.error, terminalRequestId)));
      return reply.send(Readable.from(frames));
    }

    insertAiChatMessage({
      id: assistantMessageId,
      session_id: sessionId,
      user_id: userId,
      role: "assistant",
      content: assistantContent,
      model: routedModel.stampedModel,
      request_id: terminalRequestId,
      status: "done",
      input_tokens: streamResult.usage?.inputTokens ?? null,
      output_tokens: streamResult.usage?.outputTokens ?? null,
      total_tokens: streamResult.usage?.totalTokens ?? null,
      client_message_id: null,
      created_at: nowMillis(),
    });
    touchAiChatSession(sessionId, nowMillis());

    request.log.info(
      {
        event: "ai_chat_complete",
        requestId: terminalRequestId,
        sessionId,
        userId,
        streamed: true,
        retryCount: upstream.retryCount,
        latencyMs: nowMillis() - requestStartedAt,
        streamInterrupted: false,
      },
      "Web AI Chat stream request completed.",
    );
    writeAuditEvent(request, {
      actor: userId,
      action: "send",
      requestId: terminalRequestId,
      sessionId,
      outcome: "completed",
      retryCount: upstream.retryCount,
      errorClass: null,
      latencyMs: nowMillis() - requestStartedAt,
      streamInterrupted: false,
    });

    reply
      .code(200)
      .type("text/event-stream; charset=utf-8")
      .header("cache-control", "no-cache, no-transform")
      .header("connection", "keep-alive");

    const frames: string[] = [];
    frames.push(sseEvent("started", {
      sessionId,
      messageId: assistantMessageId,
      model: routedModel.stampedModel,
      requestId: terminalRequestId,
    }));
    for (const delta of streamResult.deltas) {
      frames.push(sseEvent("heartbeat", { messageId: assistantMessageId, timestamp: nowMillis() }));
      frames.push(sseEvent("delta", { messageId: assistantMessageId, delta }));
    }
    frames.push(sseEvent("completed", {
      sessionId,
      messageId: assistantMessageId,
      usage: streamResult.usage ?? null,
      requestId: terminalRequestId,
      retryCount: upstream.retryCount,
    }));
    return reply.send(Readable.from(frames));
  });

  app.post(LEGACY_QUICK_VALIDATION_MESSAGES_PATH, async (_request, reply) => {
    return reply.redirect("/api/ai-chat/messages", 308);
  });

  app.get("/api/ai-chat/sessions", async (request, reply) => {
    const requestId = createRequestId();
    const userId = extractUserId(request);
    if (!userId) {
      return sendRouteError(reply, new AiChatRouteError(401, "UNAUTHORIZED", localizedMessage("UNAUTHORIZED")), requestId);
    }

    const queryResult = paginationQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return sendRouteError(reply, new AiChatRouteError(400, "VALIDATION_ERROR", queryResult.error.message), requestId);
    }

    const limit = queryResult.data.limit;
    let cursor: AiChatSessionCursor | undefined;
    try {
      cursor = decodeSessionCursor(queryResult.data.cursor);
    } catch (error) {
      if (error instanceof AiChatRouteError) {
        return sendRouteError(reply, error, requestId);
      }
      throw error;
    }
    const rows = listAiChatSessionsByUser(userId, limit + 1, cursor);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore
      ? encodeCursor({
        updatedAt: page[page.length - 1]!.updated_at,
        id: page[page.length - 1]!.id,
      })
      : null;

    return reply.code(200).send({
      data: page.map((row) => ({
        sessionId: row.id,
        title: row.title,
        model: row.model,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      nextCursor,
    });
  });

  app.patch("/api/ai-chat/sessions/:sessionId", async (request, reply) => {
    const requestId = createRequestId();
    const userId = extractUserId(request);
    if (!userId) {
      return sendRouteError(reply, new AiChatRouteError(401, "UNAUTHORIZED", localizedMessage("UNAUTHORIZED")), requestId);
    }

    const params = request.params as { sessionId?: string };
    if (!params.sessionId) {
      return sendRouteError(reply, new AiChatRouteError(400, "VALIDATION_ERROR", "Missing sessionId path parameter."), requestId);
    }

    try {
      ensureOwnedSession(params.sessionId, userId);
    } catch (error) {
      if (error instanceof AiChatRouteError) {
        writeAuditEvent(request, {
          actor: userId,
          action: "rename",
          requestId,
          sessionId: params.sessionId,
          outcome: "denied",
          retryCount: 0,
          errorClass: error.errorClass,
        });
        return sendRouteError(reply, error, requestId);
      }
      throw error;
    }

    const bodyResult = renameSessionBodySchema.safeParse(request.body);
    if (!bodyResult.success) {
      const error = new AiChatRouteError(400, "VALIDATION_ERROR", bodyResult.error.message);
      writeAuditEvent(request, {
        actor: userId,
        action: "rename",
        requestId,
        sessionId: params.sessionId,
        outcome: "failed",
        retryCount: 0,
        errorClass: error.errorClass,
      });
      return sendRouteError(reply, error, requestId);
    }

    const updatedAt = nowMillis();
    renameAiChatSession(params.sessionId, bodyResult.data.title, updatedAt);
    writeAuditEvent(request, {
      actor: userId,
      action: "rename",
      requestId,
      sessionId: params.sessionId,
      outcome: "completed",
      retryCount: 0,
      errorClass: null,
    });

    return reply.code(200).send({
      sessionId: params.sessionId,
      title: bodyResult.data.title,
      updatedAt,
    });
  });

  app.get("/api/ai-chat/sessions/:sessionId/messages", async (request, reply) => {
    const requestId = createRequestId();
    const userId = extractUserId(request);
    if (!userId) {
      return sendRouteError(reply, new AiChatRouteError(401, "UNAUTHORIZED", localizedMessage("UNAUTHORIZED")), requestId);
    }

    const params = request.params as { sessionId?: string };
    if (!params.sessionId) {
      return sendRouteError(reply, new AiChatRouteError(400, "VALIDATION_ERROR", "Missing sessionId path parameter."), requestId);
    }
    try {
      ensureOwnedSession(params.sessionId, userId);
    } catch (error) {
      if (error instanceof AiChatRouteError) {
        return sendRouteError(reply, error, requestId);
      }
      throw error;
    }

    const queryResult = paginationQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return sendRouteError(reply, new AiChatRouteError(400, "VALIDATION_ERROR", queryResult.error.message), requestId);
    }

    const limit = queryResult.data.limit;
    let cursor: AiChatMessageCursor | undefined;
    try {
      cursor = decodeMessageCursor(queryResult.data.cursor);
    } catch (error) {
      if (error instanceof AiChatRouteError) {
        return sendRouteError(reply, error, requestId);
      }
      throw error;
    }
    const rows = listAiChatMessagesBySession(params.sessionId, userId, limit + 1, cursor);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore
      ? encodeCursor({
        createdAt: page[page.length - 1]!.created_at,
        id: page[page.length - 1]!.id,
      })
      : null;

    return reply.code(200).send({
      data: page.map((row) => ({
        messageId: row.id,
        role: row.role,
        content: row.content,
        status: row.status,
        model: row.model,
        requestId: row.request_id,
        usage: row.input_tokens === null || row.output_tokens === null || row.total_tokens === null
          ? null
          : {
            inputTokens: row.input_tokens,
            outputTokens: row.output_tokens,
            totalTokens: row.total_tokens,
          },
        createdAt: row.created_at,
      })),
      nextCursor,
    });
  });
};
