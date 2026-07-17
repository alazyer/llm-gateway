import { describe, expect, it, vi } from "vitest";

import {
  ChatCompletionsClient,
  UpstreamHttpError,
  type PerRequestOptions,
} from "../src/upstream/chat-completions-client.js";
import type { ChatCompletionRequest, ChatCompletionResponse } from "../src/contracts.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultRequest: ChatCompletionRequest = {
  model: "glm-5.1",
  messages: [{ role: "user", content: "hello" }],
};

const successResponseBody = {
  id: "chatcmpl-1",
  object: "chat.completion",
  created: 1_718_000_000,
  model: "glm-5.1",
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: "Hi there!" },
    },
  ],
};

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jsonError(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createSseStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.close();
    },
  });
}

/** Creates a client with mock fetch and the given constructor options. */
function createClient(
  fetchFn: ReturnType<typeof vi.fn>,
  opts?: { timeoutMs?: number; maxRetries?: number },
) {
  return new ChatCompletionsClient({
    baseUrl: "https://provider.example/v1",
    apiKey: "test-key",
    fetchFn: fetchFn as unknown as typeof fetch,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    timeoutMs: opts?.timeoutMs,
    maxRetries: opts?.maxRetries,
  });
}

// ---------------------------------------------------------------------------
// Tests: createCompletion per-request overrides
// ---------------------------------------------------------------------------

describe("ChatCompletionsClient per-request overrides", () => {
  describe("createCompletion", () => {
    it("uses per-request timeoutMs when provided (abort fires early)", async () => {
      // Instance timeout is 60s; per-request is 100ms.
      // Simulate a fetch that blocks until the signal aborts.
      const slowFetch = vi.fn(async (_url: string, init?: RequestInit) => {
        // Wait for the abort signal to fire
        await new Promise<void>((resolve) => {
          if (init?.signal?.aborted) {
            resolve();
            return;
          }
          init?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        // After abort, the SDK throws a DOMException AbortError which our
        // code catches and converts to UpstreamHttpError(504).
        throw new DOMException("The operation was aborted.", "AbortError");
      });

      const client = createClient(slowFetch, { timeoutMs: 60000 });
      await expect(
        client.createCompletion(defaultRequest, "req-1", { timeoutMs: 100 }),
      ).rejects.toThrow(UpstreamHttpError);

      expect(slowFetch).toHaveBeenCalled();
    });

    it("uses per-request maxRetries when provided (retries transient errors)", async () => {
      let callCount = 0;
      const retryFetch = vi.fn(async () => {
        callCount++;
        if (callCount <= 2) {
          return jsonError(503, { error: { message: "unavailable" } });
        }
        return jsonOk(successResponseBody);
      });

      // Instance maxRetries=0 (no retries), but per-request allows 2 retries
      const client = createClient(retryFetch, { maxRetries: 0 });
      const result = await client.createCompletion(defaultRequest, "req-2", {
        maxRetries: 2,
      });

      // The result comes from the SDK parsing the JSON — check model field
      expect(result.model).toBe("glm-5.1");
      // 1 initial + 2 retries = 3 total calls
      expect(retryFetch).toHaveBeenCalledTimes(3);
    });

    it("does not retry when per-request maxRetries is 0 (even if instance has retries)", async () => {
      const retryFetch = vi.fn(async () => {
        return jsonError(503, { error: { message: "unavailable" } });
      });

      // Instance has maxRetries=3, but per-request overrides to 0
      const client = createClient(retryFetch, { maxRetries: 3 });
      await expect(
        client.createCompletion(defaultRequest, "req-3", { maxRetries: 0 }),
      ).rejects.toThrow();

      // Should only call once (no retries)
      expect(retryFetch).toHaveBeenCalledTimes(1);
    });

    it("resolves both timeoutMs and maxRetries overrides simultaneously", async () => {
      let callCount = 0;
      const retryFetch = vi.fn(async () => {
        callCount++;
        if (callCount <= 1) {
          return jsonError(429, { error: { message: "rate limited" } });
        }
        return jsonOk(successResponseBody);
      });

      const client = createClient(retryFetch, { timeoutMs: 60000, maxRetries: 0 });
      const result = await client.createCompletion(defaultRequest, "req-4", {
        timeoutMs: 5000,
        maxRetries: 1,
      });

      expect(result.model).toBe("glm-5.1");
      expect(retryFetch).toHaveBeenCalledTimes(2);
    });

    it("backward-compatible: works without per-request options", async () => {
      const mockFetch = vi.fn(async () => jsonOk(successResponseBody));
      const client = createClient(mockFetch, { timeoutMs: 30000, maxRetries: 1 });

      const result = await client.createCompletion(defaultRequest, "req-5");
      expect(result.model).toBe("glm-5.1");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("per-request maxRetries=undefined falls back to instance value", async () => {
      let callCount = 0;
      const retryFetch = vi.fn(async () => {
        callCount++;
        if (callCount <= 1) {
          return jsonError(503, { error: { message: "unavailable" } });
        }
        return jsonOk(successResponseBody);
      });

      // Instance maxRetries=1, per-request only sets timeoutMs
      const client = createClient(retryFetch, { maxRetries: 1, timeoutMs: 30000 });
      const result = await client.createCompletion(defaultRequest, "req-6", {
        timeoutMs: 5000,
      });

      // Should retry once (from instance maxRetries=1)
      expect(result.model).toBe("glm-5.1");
      expect(retryFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe("createCompletionStream", () => {
    it("uses per-request maxRetries when provided (retries transient errors)", async () => {
      let callCount = 0;
      const retryFetch = vi.fn(async () => {
        callCount++;
        if (callCount <= 2) {
          return jsonError(503, { error: { message: "unavailable" } });
        }
        // Return a valid SSE stream
        return new Response(
          createSseStream(["data: {}\n\n", "data: [DONE]\n\n"]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      });

      const client = createClient(retryFetch, { maxRetries: 0 });
      const stream = await client.createCompletionStream(
        defaultRequest,
        "req-s-1",
        { maxRetries: 2 },
      );

      expect(stream).toBeInstanceOf(ReadableStream);
      // 1 initial + 2 retries = 3 total calls
      expect(retryFetch).toHaveBeenCalledTimes(3);
    });

    it("does not retry streaming when per-request maxRetries is 0", async () => {
      const retryFetch = vi.fn(async () => {
        return jsonError(503, { error: { message: "unavailable" } });
      });

      const client = createClient(retryFetch, { maxRetries: 3 });
      await expect(
        client.createCompletionStream(defaultRequest, "req-s-2", {
          maxRetries: 0,
        }),
      ).rejects.toThrow();

      expect(retryFetch).toHaveBeenCalledTimes(1);
    });

    it("backward-compatible: works without per-request options", async () => {
      const mockFetch = vi.fn(async () => {
        return new Response(
          createSseStream(["data: {}\n\n", "data: [DONE]\n\n"]),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      });
      const client = createClient(mockFetch, { timeoutMs: 30000, maxRetries: 0 });

      const stream = await client.createCompletionStream(defaultRequest, "req-s-3");
      expect(stream).toBeInstanceOf(ReadableStream);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("uses per-request timeoutMs when provided (abort fires early)", async () => {
      const slowFetch = vi.fn(async (_url: string, init?: RequestInit) => {
        await new Promise<void>((resolve) => {
          if (init?.signal?.aborted) {
            resolve();
            return;
          }
          init?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new DOMException("The operation was aborted.", "AbortError");
      });

      const client = createClient(slowFetch, { timeoutMs: 60000 });
      await expect(
        client.createCompletionStream(defaultRequest, "req-s-4", {
          timeoutMs: 100,
        }),
      ).rejects.toThrow(UpstreamHttpError);

      expect(slowFetch).toHaveBeenCalled();
    });
  });
});
