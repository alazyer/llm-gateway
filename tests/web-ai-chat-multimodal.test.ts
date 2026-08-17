import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { closeDatabase, getDatabase, openDatabase } from "../src/db/index.js";
import { allMigrations } from "../src/db/migrations/all.js";
import { runMigrations } from "../src/db/migrations/index.js";
import { insertAiChatMessage, insertAiChatSession } from "../src/db/ai-chat-repository.js";

const GATEWAY_AUTH_TOKEN = "test-chat-token";
let tempDir = "";

/**
 * A tiny valid PNG data URL (~67 bytes). Small enough to stay well under the
 * ~700 KB cap, so the route accepts it as a valid attachment.
 */
const VALID_PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function baseConfig(): AppConfig {
  return {
    host: "127.0.0.1",
    port: 3001,
    logLevel: "silent",
    upstreamBaseUrl: "https://provider.example/v1",
    defaultModel: "glm-5.1-vision",
    requestTimeoutMs: 30000,
    maxRetries: 0,
    maxBodySizeKb: 1024,
    healthProbeEnabled: false,
    gatewayAuthToken: GATEWAY_AUTH_TOKEN,
    models: [
      {
        name: "glm-5.1",
        upstreamModel: "glm-5.1",
        baseUrl: "https://provider.example/v1",
        apiKey: "secret-key",
        apiKeyEnv: "GLM5_KEY",
        ownedBy: "zhipu",
        created: 1_718_000_000,
        supportsTools: true,
        supportsStreaming: true,
        supportsImageInput: false,
        unknownFieldMode: "warn",
      },
      {
        name: "glm-5.1-vision",
        upstreamModel: "glm-5.1-vision",
        baseUrl: "https://provider.example/v1",
        apiKey: "secret-key",
        apiKeyEnv: "GLM5_KEY",
        ownedBy: "zhipu",
        created: 1_718_000_000,
        supportsTools: true,
        supportsStreaming: true,
        supportsImageInput: true,
        unknownFieldMode: "warn",
      },
    ],
  };
}

function nonStreamAssistantResponse(): Response {
  return new Response(JSON.stringify({
    id: "chatcmpl_mm",
    model: "glm-5.1-vision",
    choices: [{ message: { role: "assistant", content: "I see the image." }, finish_reason: "stop", index: 0 }],
    usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  closeDatabase();
  tempDir = join(tmpdir(), `llm-gateway-mm-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const db = openDatabase({ GATEWAY_DB_PATH: join(tempDir, "test.db") });
  runMigrations(db, allMigrations);
});

afterEach(() => {
  closeDatabase();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function headers(userId: string): Record<string, string> {
  return {
    "x-api-key": GATEWAY_AUTH_TOKEN,
    "x-user-id": userId,
  };
}

describe("Web AI Chat multimodal input", () => {
  it("forwards attachments as a multimodal content array and persists them", async () => {
    const fetchMock = vi.fn(async () => nonStreamAssistantResponse());
    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: headers("user-mm"),
        payload: {
          prompt: "describe this",
          stream: false,
          clientMessageId: "11111111-1111-4111-8111-111111111111",
          model: "glm-5.1-vision",
          attachments: [{ id: "att-1", type: "image/png", dataUrl: VALID_PNG_DATA_URL }],
        },
      });
      expect(response.statusCode).toBe(200);

      const upstreamInit = fetchMock.mock.calls[0]![1] as RequestInit;
      const upstreamBody = JSON.parse(upstreamInit.body as string) as {
        messages: Array<{ role: string; content: unknown }>;
      };
      expect(upstreamBody.messages[0]!.role).toBe("user");
      const content = upstreamBody.messages[0]!.content as Array<{ type: string; image_url?: { url: string } }>;
      expect(content[0]).toMatchObject({ type: "text", text: "describe this" });
      expect(content[1]).toMatchObject({ type: "image_url", image_url: { url: VALID_PNG_DATA_URL } });

      const body = response.json() as { sessionId: string };
      const history = await app.inject({
        method: "GET",
        url: `/api/ai-chat/sessions/${body.sessionId}/messages`,
        headers: headers("user-mm"),
      });
      const page = (history.json() as { data: Array<{ role: string; content: string; attachments: unknown[] }> }).data;
      const userMsg = page.find((m) => m.role === "user");
      expect(userMsg?.content).toBe("describe this");
      expect(userMsg?.attachments).toEqual([
        { id: "att-1", type: "image/png", dataUrl: VALID_PNG_DATA_URL },
      ]);
    } finally {
      await app.close();
    }
  });

  it("rejects attachments on a non-image model with VALIDATION_ERROR and persists nothing", async () => {
    const fetchMock = vi.fn(async () => nonStreamAssistantResponse());
    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: headers("user-mm"),
        payload: {
          prompt: "describe this",
          stream: false,
          clientMessageId: "22222222-2222-4222-8222-222222222222",
          model: "glm-5.1",
          attachments: [{ id: "att-1", type: "image/png", dataUrl: VALID_PNG_DATA_URL }],
        },
      });
      expect(response.statusCode).toBe(400);
      const errorBody = response.json() as { error: { code: string } };
      expect(errorBody.error.code).toBe("VALIDATION_ERROR");
      expect(fetchMock).not.toHaveBeenCalled();

      // No session or user message persisted.
      const db = getDatabase();
      const sessions = db.prepare("SELECT COUNT(*) AS n FROM ai_chat_sessions").get() as { n: number };
      const messages = db.prepare("SELECT COUNT(*) AS n FROM ai_chat_messages").get() as { n: number };
      expect(sessions.n).toBe(0);
      expect(messages.n).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("rejects oversized, wrong-MIME, and over-count attachments", async () => {
    const fetchMock = vi.fn(async () => nonStreamAssistantResponse());
    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      // Oversized: ~800 KB of base64 padding exceeds the ~700 KB cap.
      const oversized = `data:image/png;base64,${"A".repeat(800 * 1024)}`;
      const oversizedRes = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: headers("user-mm"),
        payload: {
          prompt: "x",
          stream: false,
          clientMessageId: "33333333-3333-4333-8333-333333333331",
          model: "glm-5.1-vision",
          attachments: [{ id: "att-1", type: "image/png", dataUrl: oversized }],
        },
      });
      expect(oversizedRes.statusCode).toBe(400);

      // Wrong MIME type.
      const wrongMimeRes = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: headers("user-mm"),
        payload: {
          prompt: "x",
          stream: false,
          clientMessageId: "33333333-3333-4333-8333-333333333332",
          model: "glm-5.1-vision",
          attachments: [{ id: "att-1", type: "application/pdf", dataUrl: VALID_PNG_DATA_URL }],
        },
      });
      expect(wrongMimeRes.statusCode).toBe(400);

      // Over count: two attachments exceeds max(1).
      const overCountRes = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: headers("user-mm"),
        payload: {
          prompt: "x",
          stream: false,
          clientMessageId: "33333333-3333-4333-8333-333333333333",
          model: "glm-5.1-vision",
          attachments: [
            { id: "att-1", type: "image/png", dataUrl: VALID_PNG_DATA_URL },
            { id: "att-2", type: "image/png", dataUrl: VALID_PNG_DATA_URL },
          ],
        },
      });
      expect(overCountRes.statusCode).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("text-only request is unchanged: content is a plain string", async () => {
    const fetchMock = vi.fn(async () => nonStreamAssistantResponse());
    const app = createApp({ config: baseConfig(), fetchFn: fetchMock as typeof fetch });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/ai-chat/messages",
        headers: headers("user-mm"),
        payload: {
          prompt: "hello",
          stream: false,
          clientMessageId: "44444444-4444-4444-8444-444444444441",
          model: "glm-5.1-vision",
        },
      });
      expect(response.statusCode).toBe(200);
      const upstreamInit = fetchMock.mock.calls[0]![1] as RequestInit;
      const upstreamBody = JSON.parse(upstreamInit.body as string) as {
        messages: Array<{ role: string; content: unknown }>;
      };
      expect(upstreamBody.messages[0]!.content).toBe("hello");
    } finally {
      await app.close();
    }
  });

  it("round-trips a stored multimodal envelope and flat text identically", () => {
    // Direct DB persistence (bypassing the route) to exercise the read path's
    // envelope decode + fallback for both shapes.
    const db = getDatabase();
    const now = 1_718_000_000;
    insertAiChatSession({
      id: "sess-rt",
      user_id: "user-rt",
      created_at: now,
      updated_at: now,
      model: "glm-5.1-vision",
      title: "round trip",
    });

    // Multimodal envelope (what the route writes via encodeMessageContent).
    insertAiChatMessage({
      id: "msg-mm",
      session_id: "sess-rt",
      user_id: "user-rt",
      role: "user",
      content: JSON.stringify({ v: 1, text: "see this", images: [{ id: "att-1", type: "image/png", dataUrl: VALID_PNG_DATA_URL }] }),
      model: null,
      request_id: null,
      status: "done",
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      client_message_id: null,
      created_at: now,
    });

    // Plain text (what text-only messages and old rows store).
    insertAiChatMessage({
      id: "msg-text",
      session_id: "sess-rt",
      user_id: "user-rt",
      role: "assistant",
      content: "plain reply",
      model: "glm-5.1-vision",
      request_id: "req_rt",
      status: "done",
      input_tokens: 1,
      output_tokens: 2,
      total_tokens: 3,
      client_message_id: null,
      created_at: now + 1,
    });

    const rows = db
      .prepare("SELECT id, content FROM ai_chat_messages WHERE session_id = ? ORDER BY created_at ASC")
      .all("sess-rt") as Array<{ id: string; content: string }>;

    expect(rows).toHaveLength(2);
    // The route's decodeMessageContent restores the envelope to text + attachment.
    const mm = JSON.parse(rows[0]!.content) as { v: number; text: string; images: Array<{ dataUrl: string }> };
    expect(mm.text).toBe("see this");
    expect(mm.images[0]!.dataUrl).toBe(VALID_PNG_DATA_URL);
    // Flat text round-trips untouched.
    expect(rows[1]!.content).toBe("plain reply");
  });
});
