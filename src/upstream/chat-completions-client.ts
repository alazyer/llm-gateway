import type { ChatCompletionRequest, ChatCompletionResponse } from "../contracts.js";
import OpenAI, { APIError } from "openai";

interface LoggerLike {
  debug(context: unknown, message?: string): void;
  info(context: unknown, message?: string): void;
  warn(context: unknown, message?: string): void;
  error(context: unknown, message?: string): void;
}

export interface ChatCompletionsClientOptions {
  baseUrl: string;
  apiKey: string;
  fetchFn?: typeof fetch;
  logger?: LoggerLike;
  /**
   * Instance-level default for the maximum number of retries on a transient
   * upstream failure (network error or 5xx). Overridden per-call by
   * `PerRequestOptions.maxRetries`. Defaults to the OpenAI SDK's own default
   * (2) when unset here and on the call.
   */
  maxRetries?: number;
  /**
   * Instance-level default request timeout in milliseconds. Overridden
   * per-call by `PerRequestOptions.timeoutMs`.
   */
  timeoutMs?: number;
}

/**
 * Per-call overrides applied to a single `createCompletion` /
 * `createCompletionStream` invocation. A field that is `undefined` falls back
 * to the client's instance-level default; if that is also unset, the OpenAI
 * SDK's built-in default applies.
 */
export interface PerRequestOptions {
  timeoutMs?: number;
  maxRetries?: number;
}

export interface ChatCompletionsTransport {
  createCompletion(request: ChatCompletionRequest, requestId?: string, options?: PerRequestOptions): Promise<ChatCompletionResponse>;
  createCompletionStream(request: ChatCompletionRequest, requestId?: string, options?: PerRequestOptions): Promise<ReadableStream<Uint8Array>>;
}

export class UpstreamHttpError extends Error {
  public readonly statusCode: number;
  public readonly statusText: string;
  public readonly body: string;

  public constructor(statusCode: number, statusText: string, body: string) {
    super(`Upstream /chat/completions request failed with ${statusCode} ${statusText}.`);
    this.name = "UpstreamHttpError";
    this.statusCode = statusCode;
    this.statusText = statusText;
    this.body = body;
  }
}

export class ChatCompletionsClient implements ChatCompletionsTransport {
  private readonly client: OpenAI;
  private readonly logger: LoggerLike | undefined;
  private readonly instanceMaxRetries: number | undefined;
  private readonly instanceTimeoutMs: number | undefined;

  public constructor(options: ChatCompletionsClientOptions) {
    const baseUrl = ensureTrailingSlash(options.baseUrl);
    this.client = new OpenAI({
      baseURL: baseUrl,
      apiKey: options.apiKey,
      fetch: options.fetchFn,
    });
    this.logger = options.logger;
    this.instanceMaxRetries = options.maxRetries;
    this.instanceTimeoutMs = options.timeoutMs;
  }

  public async createCompletion(
    request: ChatCompletionRequest,
    _requestId?: string,
    options?: PerRequestOptions,
  ): Promise<ChatCompletionResponse> {
    const requestOptions = this.resolveRequestOptions(options);
    try {
      const response = await this.client.chat.completions.create(
        request as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
        requestOptions,
      );

      return response as unknown as ChatCompletionResponse;
    } catch (error) {
      throw this.toUpstreamError(error, request, false);
    }
  }

  public async createCompletionStream(
    request: ChatCompletionRequest,
    _requestId?: string,
    options?: PerRequestOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    const streamingRequest: ChatCompletionRequest = {
      ...request,
      stream: true,
    };

    this.logger?.info(
      {
        model: request.model,
        stream: true,
      },
      "Calling upstream /chat/completions via OpenAI SDK.",
    );

    const requestOptions = this.resolveRequestOptions(options);
    try {
      const stream = await this.client.chat.completions.create(
        streamingRequest as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
        requestOptions,
      );

      return createSseReadableStream(stream as AsyncIterable<unknown>);
    } catch (error) {
      throw this.toUpstreamError(error, request, true);
    }
  }

  /**
   * Build the SDK per-call `RequestOptions`, resolving each field as:
   * per-request override → instance default → SDK default (omitted).
   */
  private resolveRequestOptions(options?: PerRequestOptions): { maxRetries?: number; timeout?: number } {
    const resolved: { maxRetries?: number; timeout?: number } = {};
    const maxRetries = options?.maxRetries ?? this.instanceMaxRetries;
    if (maxRetries !== undefined) {
      resolved.maxRetries = maxRetries;
    }
    const timeoutMs = options?.timeoutMs ?? this.instanceTimeoutMs;
    if (timeoutMs !== undefined) {
      resolved.timeout = timeoutMs;
    }
    return resolved;
  }

  private toUpstreamError(
    error: unknown,
    request: ChatCompletionRequest,
    stream: boolean,
  ): Error {
    if (error instanceof APIError) {
      // The SDK sets `error.name` unreliably (often "Error"), so use
      // `constructor.name` to preserve the concrete type — e.g.
      // APIConnectionTimeoutError / APIConnectionError — which callers use to
      // distinguish connection failures (timeout vs. unreachable) from real
      // upstream HTTP responses.
      const errorTypeName = error.constructor.name;
      this.logger?.warn(
        {
          model: request.model,
          stream,
          statusCode: error.status,
          statusText: errorTypeName,
        },
        "Upstream /chat/completions returned a non-success response.",
      );

      return new UpstreamHttpError(
        error.status ?? 502,
        errorTypeName,
        JSON.stringify(error.error ?? { message: error.message }),
      );
    }

    this.logger?.error(
      {
        model: request.model,
        stream,
        error: toErrorMessage(error),
      },
      "Failed to reach upstream /chat/completions.",
    );

    return new Error(
      `Failed to reach upstream /chat/completions endpoint: ${toErrorMessage(error)}`,
    );
  }
}

function createSseReadableStream(
  stream: AsyncIterable<unknown>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        // The OpenAI SDK throws mid-iteration when a chunk carries an `error`
        // object (e.g. a provider disconnect). Rather than kill the stream —
        // which would discard the partial content already enqueued — emit the
        // error as a terminal SSE data frame in the shape the route's
        // `parseUpstreamStreamPayload` already detects ({ error: { code,
        // message } }), then close cleanly. This preserves partial deltas.
        const errorFrame = toStreamErrorFrame(error);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorFrame)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });
}

function toStreamErrorFrame(error: unknown): { error: { code: string; message: string } } {
  if (error instanceof APIError) {
    const message = (error.error as { message?: string } | undefined)?.message ?? error.message;
    return { error: { code: "UPSTREAM_UNAVAILABLE", message } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { error: { code: "UPSTREAM_UNAVAILABLE", message } };
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
