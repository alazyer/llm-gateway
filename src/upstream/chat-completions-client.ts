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
  timeoutMs?: number;
  maxRetries?: number;
}

export interface PerRequestOptions {
  timeoutMs?: number;
  maxRetries?: number;
}

export interface ChatCompletionsTransport {
  createCompletion(request: ChatCompletionRequest, requestId?: string, perRequest?: PerRequestOptions): Promise<ChatCompletionResponse>;
  createCompletionStream(request: ChatCompletionRequest, requestId?: string, perRequest?: PerRequestOptions): Promise<ReadableStream<Uint8Array>>;
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
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  public constructor(options: ChatCompletionsClientOptions) {
    const baseUrl = ensureTrailingSlash(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.maxRetries = options.maxRetries ?? 0;
    this.client = new OpenAI({
      baseURL: baseUrl,
      apiKey: options.apiKey,
      fetch: options.fetchFn,
      timeout: this.timeoutMs,
      maxRetries: 0, // We handle retries ourselves
    });
    this.logger = options.logger;
  }

  public async createCompletion(
    request: ChatCompletionRequest,
    requestId?: string,
    perRequest?: PerRequestOptions,
  ): Promise<ChatCompletionResponse> {
    const effectiveTimeoutMs = perRequest?.timeoutMs ?? this.timeoutMs;
    const effectiveMaxRetries = perRequest?.maxRetries ?? this.maxRetries;
    const startTime = Date.now();
    let lastError: unknown;

    for (let attempt = 0; attempt <= effectiveMaxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          this.logger?.info(
            {
              requestId,
              model: request.model,
              attempt,
              backoffMs,
            },
            "Retrying upstream /chat/completions request.",
          );
          await sleep(backoffMs);
        }

        const abortController = new AbortController();
        const timeoutId = setTimeout(() => abortController.abort(), effectiveTimeoutMs);

        try {
          const response = await this.client.chat.completions.create(
            request as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
            {
              signal: abortController.signal,
              headers: requestId ? { "X-Request-ID": requestId } : undefined,
            },
          );

          const elapsed = Date.now() - startTime;
          this.logger?.info(
            {
              requestId,
              model: request.model,
              elapsedMs: elapsed,
            },
            "Upstream /chat/completions non-stream request completed.",
          );

          return response as unknown as ChatCompletionResponse;
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (error) {
        lastError = error;

        if (this.isRetryableError(error) && attempt < effectiveMaxRetries) {
          continue;
        }

        break;
      }
    }

    if (lastError instanceof DOMException && lastError.name === "AbortError") {
      throw new UpstreamHttpError(504, "Gateway Timeout", "Upstream request timed out.");
    }

    throw this.toUpstreamError(lastError, request, false);
  }

  public async createCompletionStream(
    request: ChatCompletionRequest,
    requestId?: string,
    perRequest?: PerRequestOptions,
  ): Promise<ReadableStream<Uint8Array>> {
    const effectiveTimeoutMs = perRequest?.timeoutMs ?? this.timeoutMs;
    const effectiveMaxRetries = perRequest?.maxRetries ?? this.maxRetries;
    const streamingRequest: ChatCompletionRequest = {
      ...request,
      stream: true,
    };

    this.logger?.info(
      {
        requestId,
        model: request.model,
        stream: true,
      },
      "Calling upstream /chat/completions via OpenAI SDK.",
    );

    let lastError: unknown;

    for (let attempt = 0; attempt <= effectiveMaxRetries; attempt++) {
      try {
        if (attempt > 0) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          this.logger?.info(
            {
              requestId,
              model: request.model,
              stream: true,
              attempt,
              backoffMs,
            },
            "Retrying upstream /chat/completions stream request.",
          );
          await sleep(backoffMs);
        }

        const abortController = new AbortController();
        const timeoutId = setTimeout(() => abortController.abort(), effectiveTimeoutMs);
        const streamStartTime = Date.now();

        try {
          const stream = await this.client.chat.completions.create(
            streamingRequest as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
            {
              signal: abortController.signal,
              headers: requestId ? { "X-Request-ID": requestId } : undefined,
            },
          );

          const ttfb = Date.now() - streamStartTime;
          this.logger?.info(
            {
              requestId,
              model: request.model,
              stream: true,
              ttfbMs: ttfb,
            },
            "Upstream /chat/completions stream first byte received.",
          );

          clearTimeout(timeoutId);
          return createSseReadableStream(stream as AsyncIterable<unknown>);
        } catch (error) {
          clearTimeout(timeoutId);
          throw error;
        }
      } catch (error) {
        lastError = error;

        if (this.isRetryableError(error) && attempt < effectiveMaxRetries) {
          continue;
        }

        break;
      }
    }

    if (lastError instanceof DOMException && lastError.name === "AbortError") {
      throw new UpstreamHttpError(504, "Gateway Timeout", "Upstream stream request timed out.");
    }

    throw this.toUpstreamError(lastError, request, true);
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof APIError) {
      return error.status === 429 || error.status === 502 || error.status === 503;
    }

    return false;
  }

  private toUpstreamError(
    error: unknown,
    request: ChatCompletionRequest,
    stream: boolean,
  ): Error {
    if (error instanceof APIError) {
      this.logger?.warn(
        {
          model: request.model,
          stream,
          statusCode: error.status,
          statusText: error.name,
        },
        "Upstream /chat/completions returned a non-success response.",
      );

      return new UpstreamHttpError(
        error.status ?? 502,
        error.name,
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
        controller.error(error);
      }
    },
  });
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
