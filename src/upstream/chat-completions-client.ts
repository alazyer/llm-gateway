import type { ChatCompletionRequest, ChatCompletionResponse } from "../contracts.js";

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

export class ChatCompletionsClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: typeof fetch;
  private readonly logger: LoggerLike | undefined;

  public constructor(options: ChatCompletionsClientOptions) {
    this.baseUrl = ensureTrailingSlash(options.baseUrl);
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? fetch;
    this.logger = options.logger;
  }

  public async createCompletion(
    request: ChatCompletionRequest,
  ): Promise<ChatCompletionResponse> {
    const response = await this.postChatCompletion(request, "application/json");
    const rawBody = await response.text();

    try {
      return JSON.parse(rawBody) as ChatCompletionResponse;
    } catch (error) {
      throw new Error(
        `Upstream /chat/completions returned invalid JSON: ${toErrorMessage(error)}`,
      );
    }
  }

  public async createCompletionStream(
    request: ChatCompletionRequest,
  ): Promise<Response> {
    const response = await this.postChatCompletion(request, "text/event-stream");

    if (!response.body) {
      throw new Error("Upstream /chat/completions response did not include a readable stream.");
    }

    return response;
  }

  private async postChatCompletion(
    request: ChatCompletionRequest,
    accept: string,
  ): Promise<Response> {
    const url = new URL("chat/completions", this.baseUrl);
    const logContext = {
      upstreamUrl: url.toString(),
      model: request.model,
      stream: accept === "text/event-stream",
    };

    this.logger?.info(logContext, "Calling upstream /chat/completions.");

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: "POST",
        headers: {
          accept,
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      });
    } catch (error) {
      this.logger?.error(
        {
          ...logContext,
          error: toErrorMessage(error),
        },
        "Failed to reach upstream /chat/completions.",
      );
      throw new Error(
        `Failed to reach upstream /chat/completions endpoint at ${url.toString()}: ${toErrorMessage(
          error,
        )}`,
      );
    }

    if (!response.ok) {
      const body = await response.text();
      this.logger?.warn(
        {
          ...logContext,
          statusCode: response.status,
          statusText: response.statusText,
        },
        "Upstream /chat/completions returned a non-success response.",
      );
      throw new UpstreamHttpError(
        response.status,
        response.statusText,
        body,
      );
    }

    this.logger?.debug(
      {
        ...logContext,
        statusCode: response.status,
        statusText: response.statusText,
      },
      "Upstream /chat/completions request succeeded.",
    );

    return response;
  }
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
