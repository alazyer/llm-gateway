import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useGatewayApi } from "../composables/useGatewayApi";

const VALID_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

describe("streamAiChatMessage attachment serialization", () => {
  beforeEach(() => {
    // `useGatewayApi()` reads the gateway base URL from the Nuxt runtime
    // config; stub it before constructing the client.
    (globalThis as Record<string, unknown>).useRuntimeConfig = () => ({
      public: { gatewayBaseUrl: "http://localhost:3000", webAiChatEnabled: true },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockSseStream(): Response {
    // Minimal completed SSE lifecycle: started + completed (no deltas).
    const body = [
      'event: started\ndata: {"sessionId":"s1","messageId":"m1","model":"glm-5.1-vision","requestId":"req_1"}\n\n',
      'event: completed\ndata: {"sessionId":"s1","messageId":"m1","usage":null,"requestId":"req_1","retryCount":0}\n\n',
    ].join("");
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  it("includes attachments in the request body when present", async () => {
    const fetchMock = vi.fn(async () => mockSseStream());
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const api = useGatewayApi();
    await api.streamAiChatMessage({
      prompt: "describe this",
      clientMessageId: "11111111-1111-4111-8111-111111111111",
      model: "glm-5.1-vision",
      attachments: [{ id: "att-1", type: "image/png", dataUrl: VALID_PNG }],
      callbacks: {},
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = JSON.parse(init.body as string) as { attachments?: unknown };
    expect(body.attachments).toEqual([
      { id: "att-1", type: "image/png", dataUrl: VALID_PNG },
    ]);
  });

  it("omits the attachments field when none are supplied", async () => {
    const fetchMock = vi.fn(async () => mockSseStream());
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const api = useGatewayApi();
    await api.streamAiChatMessage({
      prompt: "hello",
      clientMessageId: "22222222-2222-4222-8222-222222222222",
      model: "glm-5.1-vision",
      callbacks: {},
    });

    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = JSON.parse(init.body as string) as { attachments?: unknown };
    expect(body.attachments).toBeUndefined();
  });

  it("omits the attachments field when the array is empty", async () => {
    const fetchMock = vi.fn(async () => mockSseStream());
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const api = useGatewayApi();
    await api.streamAiChatMessage({
      prompt: "hello",
      clientMessageId: "33333333-3333-4333-8333-333333333333",
      model: "glm-5.1-vision",
      attachments: [],
      callbacks: {},
    });

    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = JSON.parse(init.body as string) as { attachments?: unknown };
    expect(body.attachments).toBeUndefined();
  });
});
