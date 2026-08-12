import { describe, expect, it, vi } from "vitest";

import {
  consumeAiChatStream,
  type AiChatStreamCallbacks,
} from "../packages/web/composables/useGatewayApi";

function encodeStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function makeCallbacks(): AiChatStreamCallbacks & {
  events: string[];
  deltas: string[];
} {
  const events: string[] = [];
  const deltas: string[] = [];
  return {
    events,
    deltas,
    onStarted: (e) => { events.push(`started:${e.sessionId}`); },
    onDelta: (e) => { events.push(`delta:${e.delta}`); deltas.push(e.delta); },
    onHeartbeat: (e) => { events.push(`heartbeat:${e.messageId}`); },
    onCompleted: (e) => { events.push(`completed:${e.messageId}`); },
    onError: (e) => { events.push(`error:${e.code}:${e.retryable}:${e.requestId}`); },
  };
}

describe("consumeAiChatStream", () => {
  it("renders started -> delta* -> completed in order", async () => {
    const body = encodeStream([
      sse("started", { sessionId: "s1", messageId: "m1", model: null, requestId: "r1" }),
      sse("delta", { messageId: "m1", delta: "Hello" }),
      sse("delta", { messageId: "m1", delta: " world" }),
      sse("completed", { sessionId: "s1", messageId: "m1", usage: null, requestId: "r1", retryCount: 0 }),
    ]);
    const cb = makeCallbacks();

    await consumeAiChatStream(body, cb);

    expect(cb.events).toEqual([
      "started:s1",
      "delta:Hello",
      "delta: world",
      "completed:m1",
    ]);
    expect(cb.deltas.join("")).toBe("Hello world");
  });

  it("ignores heartbeat events for content accumulation", async () => {
    const body = encodeStream([
      sse("started", { sessionId: "s1", messageId: "m1", model: null, requestId: "r1" }),
      sse("delta", { messageId: "m1", delta: "Partial" }),
      sse("heartbeat", { messageId: "m1", timestamp: 1 }),
      sse("delta", { messageId: "m1", delta: " content" }),
      sse("heartbeat", { messageId: "m1", timestamp: 2 }),
      sse("completed", { sessionId: "s1", messageId: "m1", usage: null, requestId: "r1", retryCount: 0 }),
    ]);
    const cb = makeCallbacks();

    await consumeAiChatStream(body, cb);

    // Heartbeat callbacks fire (connection stays open), but deltas are not
    // corrupted by them.
    expect(cb.events).toEqual([
      "started:s1",
      "delta:Partial",
      "heartbeat:m1",
      "delta: content",
      "heartbeat:m1",
      "completed:m1",
    ]);
    expect(cb.deltas.join("")).toBe("Partial content");
  });

  it("preserves partial delta content and surfaces typed error on terminal error", async () => {
    const body = encodeStream([
      sse("started", { sessionId: "s1", messageId: "m1", model: null, requestId: "r1" }),
      sse("delta", { messageId: "m1", delta: "Partial" }),
      sse("delta", { messageId: "m1", delta: " answer" }),
      sse("error", {
        code: "UPSTREAM_UNAVAILABLE",
        message: "Provider disconnected",
        retryable: true,
        requestId: "r1",
        retryCount: 0,
        errorClass: "UPSTREAM_UNAVAILABLE",
      }),
    ]);
    const cb = makeCallbacks();
    const onError = vi.fn();
    cb.onError = onError;

    await consumeAiChatStream(body, cb);

    // Partial content was already delivered via onDelta before the error.
    expect(cb.deltas.join("")).toBe("Partial answer");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      code: "UPSTREAM_UNAVAILABLE",
      retryable: true,
      requestId: "r1",
    }));
    // Terminal error ends the stream (no completed event).
    expect(cb.events).not.toContain("completed:m1");
  });

  it("keeps the stream connection open across heartbeat-only segments", async () => {
    // Two heartbeats with no deltas between them must not terminate the stream
    // and must not alter content.
    const body = encodeStream([
      sse("started", { sessionId: "s1", messageId: "m1", model: null, requestId: "r1" }),
      sse("heartbeat", { messageId: "m1", timestamp: 1 }),
      sse("heartbeat", { messageId: "m1", timestamp: 2 }),
      sse("delta", { messageId: "m1", delta: "after heartbeats" }),
      sse("completed", { sessionId: "s1", messageId: "m1", usage: null, requestId: "r1", retryCount: 0 }),
    ]);
    const cb = makeCallbacks();

    await consumeAiChatStream(body, cb);

    expect(cb.deltas.join("")).toBe("after heartbeats");
    expect(cb.events.filter((e) => e.startsWith("completed"))).toHaveLength(1);
  });

  it("handles split frames across read chunks", async () => {
    // Frame split across two chunks — the parser must reassemble.
    const encoder = new TextEncoder();
    const frame = sse("delta", { messageId: "m1", delta: "joined" });
    const midPoint = frame.indexOf("data:");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frame.slice(0, midPoint)));
        controller.enqueue(encoder.encode(frame.slice(midPoint)));
        controller.enqueue(encoder.encode("\n\n"));
        controller.close();
      },
    });

    const deltas: string[] = [];
    await consumeAiChatStream(body, { onDelta: (e) => deltas.push(e.delta) });

    expect(deltas.join("")).toBe("joined");
  });
});
