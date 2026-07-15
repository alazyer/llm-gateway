import type { ChatCompletionRequest, ChatCompletionResponse, ModelChainConfig, ChainModelEntry } from "./contracts.js";
import type { ChatCompletionsTransport } from "./upstream/chat-completions-client.js";
import { UpstreamHttpError } from "./upstream/chat-completions-client.js";
import { toErrorMessage } from "./shared.js";

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export interface ChainAttempt {
  model: string;
  attemptIndex: number;
  outcome: "success" | "retryable-error" | "non-retryable-error" | "timeout" | "budget-exceeded";
  statusCode?: number | undefined;
  statusText?: string | undefined;
}

export class ChainExhaustedError extends Error {
  public readonly chainName: string;
  public readonly modelsTried: number;
  public readonly attempts: ChainAttempt[];

  public constructor(chainName: string, modelsTried: number, attempts: ChainAttempt[]) {
    super(
      `Chain "${chainName}" exhausted all ${modelsTried} model(s). Every model failed with a retryable error.`,
    );
    this.name = "ChainExhaustedError";
    this.chainName = chainName;
    this.modelsTried = modelsTried;
    this.attempts = attempts;
  }
}

export class ChainBudgetExceededError extends Error {
  public readonly chainName: string;

  public constructor(chainName: string) {
    super(`Chain "${chainName}" exceeded its timeout budget.`);
    this.name = "ChainBudgetExceededError";
    this.chainName = chainName;
  }
}

// ---------------------------------------------------------------------------
// Descriptor type
// ---------------------------------------------------------------------------

export interface ChainDescriptor {
  type: "chain";
  chain: ModelChainConfig;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

/**
 * Classifies an error as retryable or non-retryable for chain fallback purposes.
 *
 * Retryable:
 * - UpstreamHttpError with status 429, 502, 503, 504
 * - Timeout / network errors (non-UpstreamHttpError, non-RouteError failures
 *   that originate from the transport layer)
 *
 * Non-retryable:
 * - UpstreamHttpError with any other HTTP status code
 * - RouteError with any status code
 * - Any other error type
 */
export function isRetryableForChain(error: unknown): boolean {
  if (error instanceof UpstreamHttpError) {
    return (
      error.statusCode === 429 ||
      error.statusCode === 502 ||
      error.statusCode === 503 ||
      error.statusCode === 504
    );
  }

  // RouteError is always non-retryable regardless of status code
  if (isRouteError(error)) {
    return false;
  }

  // Other errors (network, timeout, generic) are considered retryable
  // because they likely represent transient connectivity issues rather
  // than definitive rejections from the upstream provider.
  return true;
}

// ---------------------------------------------------------------------------
// Settings resolution
// ---------------------------------------------------------------------------

/**
 * Resolves effective timeout and retry settings using 3-level precedence:
 * model-in-chain override → chain-level default → gateway-level default
 */
export function resolveEffectiveSettings(
  entry: ChainModelEntry,
  chain: ModelChainConfig,
  gatewayTimeout: number,
  gatewayRetries: number,
): { timeoutMs: number; maxRetries: number } {
  return {
    timeoutMs: entry.timeoutMs ?? chain.timeoutMs ?? gatewayTimeout,
    maxRetries: entry.maxRetries ?? chain.maxRetries ?? gatewayRetries,
  };
}

// ---------------------------------------------------------------------------
// Non-streaming chain execution
// ---------------------------------------------------------------------------

interface LoggerLike {
  debug(context: unknown, message?: string): void;
  info(context: unknown, message?: string): void;
  warn(context: unknown, message?: string): void;
  error(context: unknown, message?: string): void;
}

export interface ExecuteChainParams {
  descriptor: ChainDescriptor;
  upstreamRequest: ChatCompletionRequest;
  transportFactory: (model: ChainModelEntry, settings: { timeoutMs: number; maxRetries: number }) => ChatCompletionsTransport;
  gatewayTimeoutMs: number;
  gatewayMaxRetries: number;
  logger: LoggerLike;
}

export async function executeChain(params: ExecuteChainParams): Promise<ChatCompletionResponse> {
  const { descriptor, upstreamRequest, transportFactory, gatewayTimeoutMs, gatewayMaxRetries, logger } = params;
  const chain = descriptor.chain;
  const chainTimeoutMs = chain.chainTimeoutMs;
  const chainStart = Date.now();
  const attempts: ChainAttempt[] = [];

  for (let i = 0; i < chain.models.length; i++) {
    const entry = chain.models[i]!;
    const attemptIndex = i + 1; // 1-based

    // Check budget before attempting this model
    if (chainTimeoutMs !== undefined) {
      const elapsed = Date.now() - chainStart;
      if (elapsed >= chainTimeoutMs) {
        const attempt: ChainAttempt = {
          model: entry.name,
          attemptIndex,
          outcome: "budget-exceeded",
        };
        attempts.push(attempt);
        logger.info(
          { chain: chain.name, model: entry.name, attemptIndex, outcome: "budget-exceeded", elapsedMs: elapsed },
          "Chain budget exceeded before model attempt.",
        );
        throw new ChainBudgetExceededError(chain.name);
      }
    }

    const settings = resolveEffectiveSettings(entry, chain, gatewayTimeoutMs, gatewayMaxRetries);
    const client = transportFactory(entry, settings);

    try {
      // Build the request with the model's upstream name
      const requestForModel: ChatCompletionRequest = {
        ...upstreamRequest,
        model: entry.modelConfig.upstreamModel,
      };

      const response = await client.createCompletion(requestForModel);

      // Check budget after completion
      if (chainTimeoutMs !== undefined) {
        const elapsed = Date.now() - chainStart;
        if (elapsed >= chainTimeoutMs) {
          const attempt: ChainAttempt = {
            model: entry.name,
            attemptIndex,
            outcome: "budget-exceeded",
          };
          attempts.push(attempt);
          logger.info(
            { chain: chain.name, model: entry.name, attemptIndex, outcome: "budget-exceeded", elapsedMs: elapsed },
            "Chain budget exceeded after model completion (response discarded).",
          );
          throw new ChainBudgetExceededError(chain.name);
        }
      }

      const attempt: ChainAttempt = {
        model: entry.name,
        attemptIndex,
        outcome: "success",
      };
      attempts.push(attempt);
      logger.info(
        { chain: chain.name, model: entry.name, attemptIndex, outcome: "success" },
        "Chain model attempt succeeded.",
      );

      return response;
    } catch (error) {
      const retryable = isRetryableForChain(error);

      let statusCode: number | undefined;
      let statusText: string | undefined;

      if (error instanceof UpstreamHttpError) {
        statusCode = error.statusCode;
        statusText = error.statusText;
      }

      const outcome = retryable ? "retryable-error" : "non-retryable-error";
      const attempt: ChainAttempt = {
        model: entry.name,
        attemptIndex,
        outcome,
        statusCode,
        statusText,
      };
      attempts.push(attempt);

      logger.info(
        {
          chain: chain.name,
          model: entry.name,
          attemptIndex,
          outcome,
          statusCode,
          statusText,
          errorMessage: toErrorMessage(error),
        },
        `Chain model attempt failed with ${outcome}.`,
      );

      if (!retryable) {
        // Non-retryable error: throw immediately, preserving original error
        throw error;
      }

      // Retryable error: advance to next model (loop continues)
    }
  }

  // All models exhausted with retryable errors
  throw new ChainExhaustedError(chain.name, chain.models.length, attempts);
}

// ---------------------------------------------------------------------------
// Streaming chain execution
// ---------------------------------------------------------------------------

export interface ExecuteChainStreamParams {
  descriptor: ChainDescriptor;
  upstreamRequest: ChatCompletionRequest;
  transportFactory: (model: ChainModelEntry, settings: { timeoutMs: number; maxRetries: number }) => ChatCompletionsTransport;
  gatewayTimeoutMs: number;
  gatewayMaxRetries: number;
  logger: LoggerLike;
}

/**
 * Executes a chain for a streaming request. Returns an async generator
 * yielding SSE event strings.
 *
 * - If a model fails before producing the first SSE chunk (retryable),
 *   advance to the next model.
 * - Once the first SSE chunk from any model is received, commit to that
 *   model and stream all subsequent chunks.
 * - If the stream breaks mid-way, emit an SSE error event with chain name,
 *   model name, and error details; do NOT attempt fallback.
 */
export async function* executeChainStream(
  params: ExecuteChainStreamParams,
): AsyncGenerator<string> {
  const { descriptor, upstreamRequest, transportFactory, gatewayTimeoutMs, gatewayMaxRetries, logger } = params;
  const chain = descriptor.chain;
  const chainTimeoutMs = chain.chainTimeoutMs;
  const chainStart = Date.now();

  for (let i = 0; i < chain.models.length; i++) {
    const entry = chain.models[i]!;
    const attemptIndex = i + 1; // 1-based

    // Check budget before attempting this model
    if (chainTimeoutMs !== undefined) {
      const elapsed = Date.now() - chainStart;
      if (elapsed >= chainTimeoutMs) {
        logger.info(
          { chain: chain.name, model: entry.name, attemptIndex, outcome: "budget-exceeded", elapsedMs: elapsed },
          "Chain budget exceeded before streaming model attempt.",
        );
        throw new ChainBudgetExceededError(chain.name);
      }
    }

    const settings = resolveEffectiveSettings(entry, chain, gatewayTimeoutMs, gatewayMaxRetries);
    const client = transportFactory(entry, settings);

    // Build the request with the model's upstream name and stream: true
    const requestForModel: ChatCompletionRequest = {
      ...upstreamRequest,
      model: entry.modelConfig.upstreamModel,
      stream: true,
    };

    let upstreamStream: ReadableStream<Uint8Array>;
    try {
      upstreamStream = await client.createCompletionStream(requestForModel);
    } catch (error) {
      const retryable = isRetryableForChain(error);

      let statusCode: number | undefined;
      let statusText: string | undefined;

      if (error instanceof UpstreamHttpError) {
        statusCode = error.statusCode;
        statusText = error.statusText;
      }

      const outcome = retryable ? "retryable-error" : "non-retryable-error";
      logger.info(
        {
          chain: chain.name,
          model: entry.name,
          attemptIndex,
          outcome,
          statusCode,
          statusText,
          errorMessage: toErrorMessage(error),
        },
        `Chain streaming model attempt failed before first chunk with ${outcome}.`,
      );

      if (!retryable) {
        throw error;
      }

      // Retryable: advance to next model
      continue;
    }

    // We got a stream — commit to this model and yield chunks.
    // If the stream breaks mid-way, emit an SSE error event and stop.
    logger.info(
      { chain: chain.name, model: entry.name, attemptIndex, outcome: "success" },
      "Chain streaming model attempt connected (first chunk pending).",
    );

    let firstChunkReceived = false;
    const reader = upstreamStream.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          if (!firstChunkReceived) {
            // Stream ended without producing any data — treat as retryable
            logger.info(
              { chain: chain.name, model: entry.name, attemptIndex, outcome: "retryable-error" },
              "Chain streaming model produced empty stream, advancing to next model.",
            );
            break; // break out of read loop, will continue to next model
          }
          return; // stream completed normally
        }

        firstChunkReceived = true;
        const text = decoder.decode(value, { stream: true });
        yield text;
      }
    } catch (error) {
      if (!firstChunkReceived) {
        // Error before first chunk — retryable or non-retryable
        const retryable = isRetryableForChain(error);

        let statusCode: number | undefined;
        let statusText: string | undefined;
        if (error instanceof UpstreamHttpError) {
          statusCode = error.statusCode;
          statusText = error.statusText;
        }

        const outcome = retryable ? "retryable-error" : "non-retryable-error";
        logger.info(
          {
            chain: chain.name,
            model: entry.name,
            attemptIndex,
            outcome,
            statusCode,
            statusText,
            errorMessage: toErrorMessage(error),
          },
          `Chain streaming model failed before first chunk with ${outcome}.`,
        );

        if (!retryable) {
          throw error;
        }

        // Retryable before first chunk: advance to next model
        continue;
      }

      // Error after first chunk — we are committed to this model.
      // Emit SSE error event and stop. Do NOT attempt fallback.
      const errorMessage = toErrorMessage(error);
      logger.error(
        {
          chain: chain.name,
          model: entry.name,
          attemptIndex,
          errorMessage,
        },
        "Chain streaming model failed after first chunk — emitting SSE error event.",
      );

      yield formatSseErrorEvent(chain.name, entry.name, errorMessage);
      return;
    } finally {
      reader.releaseLock();
    }
  }

  // All models exhausted with retryable errors
  throw new ChainExhaustedError(chain.name, chain.models.length, []);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detects a RouteError by checking for the `name` property and `statusCode`.
 * RouteError is defined locally in responses.ts and not exported, so we
 * detect it structurally.
 */
function isRouteError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { name?: unknown }).name === "RouteError" &&
    typeof (error as { statusCode?: unknown }).statusCode === "number"
  );
}

/**
 * Formats an SSE error event for mid-stream failures in chain execution.
 */
function formatSseErrorEvent(chainName: string, modelName: string, errorMessage: string): string {
  const payload = {
    type: "error",
    error: {
      type: "chain_stream_error",
      message: errorMessage,
      chain: chainName,
      model: modelName,
    },
  };
  return `event: error\ndata: ${JSON.stringify(payload)}\n\n`;
}
