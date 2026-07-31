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
}

export interface ChatCompletionsTransport {
  createCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  createCompletionStream(request: ChatCompletionRequest): Promise<ReadableStream<Uint8Array>>;
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

  public constructor(options: ChatCompletionsClientOptions) {
    const baseUrl = ensureTrailingSlash(options.baseUrl);
    this.client = new OpenAI({
      baseURL: baseUrl,
      apiKey: options.apiKey,
      fetch: options.fetchFn,
    });
    this.logger = options.logger;
  }

  public async createCompletion(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    try {
      const response = await this.client.chat.completions.create(
        request as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      );

      return response as unknown as ChatCompletionResponse;
    } catch (error) {
      throw this.toUpstreamError(error, request, false);
    }
  }

  public async createCompletionStream(
    request: ChatCompletionRequest,
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

    try {
      const stream = await this.client.chat.completions.create(
        streamingRequest as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
      );

      return createSseReadableStream(stream as AsyncIterable<unknown>);
    } catch (error) {
      throw this.toUpstreamError(error, request, true);
    }
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

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
