/**
 * Authenticated fetch wrapper for the LLM Gateway admin API.
 *
 * - Reads the auth token from in-memory browser state
 * - Sets Authorization: Bearer <token> on every request
 * - Attaches x-user-id: llm-gateway on every /api/ai-chat/* request
 *   (interim identity — see openspec change web-ai-chat-frontend-production)
 * - Throws on non-2xx responses with a structured error
 */

import {
  clearGatewayAuthToken,
  getGatewayAuthToken,
  setGatewayAuthToken,
} from "../utils/authToken";

/**
 * Interim user identity. There is no real identity source yet, so every chat
 * session belongs to the shared `llm-gateway` user. Replaced by a real identity
 * provider in a later change.
 */
const WEB_AI_CHAT_USER_ID = "llm-gateway";

const DEFAULT_CHAT_TIMEOUT_MS = 120_000;

const AI_CHAT_PATH_PREFIX = "/api/ai-chat/";

// ---- Production Web AI Chat types ----

export type AiChatErrorCode =
  | "RATE_LIMITED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | (string & {});

export interface AiChatUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
}

export interface AiChatSendMessageResponse {
  sessionId: string;
  messageId: string;
  assistantMessage: {
    role: "assistant";
    content: string;
  };
  usage: AiChatUsage;
  model: string | null;
  requestId: string;
}

export interface AiChatSessionSummary {
  sessionId: string;
  title: string | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface AiChatSessionListResponse {
  data: AiChatSessionSummary[];
  nextCursor: string | null;
}

/**
 * An image attachment carried inline in a chat message as a base64 data URL.
 * Mirrors the backend `attachments` array shape; bounded to one image per
 * message and a ~700 KB base64 cap (see `chat.vue` validation).
 */
export interface AiChatAttachment {
  id: string;
  type: string;
  dataUrl: string;
  /** Original filename, if known — display only. */
  name?: string;
  /** Raw byte size of the underlying file — display only. */
  size?: number;
}

export interface AiChatHistoryMessage {
  messageId: string;
  role: "user" | "assistant";
  content: string;
  attachments: AiChatAttachment[];
  status: "streaming" | "done" | "failed";
  model: string | null;
  requestId: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } | null;
  createdAt: number;
}

/**
 * A chat-routable model entry for the picker. Sourced from the existing
 * `GET /v1/models` endpoint (reused — no chat-scoped list endpoint).
 */
export interface AiChatChatModel {
  id: string;
  displayName: string;
  inputModalities: string[];
}

export interface AiChatMessageListResponse {
  data: AiChatHistoryMessage[];
  nextCursor: string | null;
}

// ---- Production SSE lifecycle ----

export interface AiChatStreamStartedEvent {
  sessionId: string;
  messageId: string;
  model: string | null;
  requestId: string;
}

export interface AiChatStreamDeltaEvent {
  messageId: string;
  delta: string;
}

export interface AiChatStreamHeartbeatEvent {
  messageId: string;
  timestamp: number;
}

export interface AiChatStreamCompletedEvent {
  sessionId: string;
  messageId: string;
  usage: AiChatUsage | null;
  requestId: string;
  retryCount: number;
}

export interface AiChatStreamErrorEvent {
  code: string;
  message: string;
  retryable: boolean;
  requestId: string;
  retryCount: number;
  errorClass: string;
  retryAfterSeconds?: number;
}

export interface AiChatStreamCallbacks {
  onStarted?: (event: AiChatStreamStartedEvent) => void;
  onDelta?: (event: AiChatStreamDeltaEvent) => void;
  onHeartbeat?: (event: AiChatStreamHeartbeatEvent) => void;
  onCompleted?: (event: AiChatStreamCompletedEvent) => void;
  onError?: (event: AiChatStreamErrorEvent) => void;
}

export interface StreamAiChatMessageOptions {
  prompt: string;
  sessionId?: string;
  clientMessageId: string;
  model?: string;
  attachments?: AiChatAttachment[];
  timeoutMs?: number;
  signal?: AbortSignal;
  callbacks: AiChatStreamCallbacks;
}

export class GatewayApiError extends Error {
  public readonly statusCode: number;
  public readonly code?: string;
  public readonly requestId?: string;
  public readonly retryable?: boolean;

  public constructor(
    message: string,
    statusCode: number,
    options?: { code?: string; requestId?: string; retryable?: boolean },
  ) {
    super(message);
    this.name = "GatewayApiError";
    this.statusCode = statusCode;
    this.code = options?.code;
    this.requestId = options?.requestId;
    this.retryable = options?.retryable;
  }
}

function extractRequestId(value: unknown): string | undefined {
  if (value && typeof value === "object" && "id" in value && typeof value.id === "string") {
    return value.id;
  }
  return undefined;
}

function parseErrorBody(body: unknown, statusCode: number): { message: string; code?: string; retryable?: boolean; requestId?: string } {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;

    const errorRecord = (
      record.error && typeof record.error === "object"
        ? record.error as Record<string, unknown>
        : null
    );

    if (errorRecord) {
      const message = typeof errorRecord.message === "string"
        ? errorRecord.message
        : `Request failed: ${statusCode}`;
      const code = typeof errorRecord.code === "string" ? errorRecord.code : undefined;
      const retryable = typeof errorRecord.retryable === "boolean" ? errorRecord.retryable : undefined;
      const requestId = typeof errorRecord.requestId === "string" ? errorRecord.requestId : undefined;
      return { message, code, retryable, requestId };
    }

    if (typeof record.error === "string") {
      return { message: record.error };
    }
  }

  return { message: `Request failed: ${statusCode}` };
}

/**
 * Pure SSE frame parser for the production Web AI Chat lifecycle.
 *
 * Parses the typed event stream (`started`, `delta`, `heartbeat`,
 * `completed`, `error`) and dispatches to callbacks. Extracted from the
 * composable so it can be unit-tested with a mocked `Response` body.
 *
 * Invariants honored:
 * - `heartbeat` events are ignored for content accumulation.
 * - `delta` content is forwarded in arrival order.
 * - On a terminal `error` event, the partial content already streamed via
 *   `onDelta` is preserved by the caller; the error payload is surfaced with
 *   `code`, `retryable`, and `requestId`.
 * - The stream ends after `completed` or `error`.
 */
export async function consumeAiChatStream(
  body: ReadableStream<Uint8Array>,
  callbacks: AiChatStreamCallbacks,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  function dispatchFrame(frame: string): boolean {
    // Returns true when a terminal event (completed/error) was handled.
    const lines = frame.split(/\r?\n/);
    let event = "message";
    const dataLines: string[] = [];

    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    const data = dataLines.join("\n");
    if (!data) {
      return false;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      return false;
    }

    if (!parsed || typeof parsed !== "object") {
      return false;
    }

    const payload = parsed as Record<string, unknown>;

    switch (event) {
      case "started":
        callbacks.onStarted?.({
          sessionId: typeof payload.sessionId === "string" ? payload.sessionId : "",
          messageId: typeof payload.messageId === "string" ? payload.messageId : "",
          model: typeof payload.model === "string" ? payload.model : null,
          requestId: typeof payload.requestId === "string" ? payload.requestId : "",
        });
        return false;
      case "delta": {
        const delta = typeof payload.delta === "string" ? payload.delta : "";
        const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
        if (delta.length > 0) {
          callbacks.onDelta?.({ messageId, delta });
        }
        return false;
      }
      case "heartbeat":
        callbacks.onHeartbeat?.({
          messageId: typeof payload.messageId === "string" ? payload.messageId : "",
          timestamp: typeof payload.timestamp === "number" ? payload.timestamp : 0,
        });
        return false;
      case "completed":
        callbacks.onCompleted?.({
          sessionId: typeof payload.sessionId === "string" ? payload.sessionId : "",
          messageId: typeof payload.messageId === "string" ? payload.messageId : "",
          usage: parseUsage(payload.usage),
          requestId: typeof payload.requestId === "string" ? payload.requestId : "",
          retryCount: typeof payload.retryCount === "number" ? payload.retryCount : 0,
        });
        return true;
      case "error":
        callbacks.onError?.({
          code: typeof payload.code === "string" ? payload.code : "UPSTREAM_UNAVAILABLE",
          message: typeof payload.message === "string" ? payload.message : "An error occurred while processing the request.",
          retryable: typeof payload.retryable === "boolean" ? payload.retryable : false,
          requestId: typeof payload.requestId === "string" ? payload.requestId : "",
          retryCount: typeof payload.retryCount === "number" ? payload.retryCount : 0,
          errorClass: typeof payload.errorClass === "string" ? payload.errorClass : "",
          ...(typeof payload.retryAfterSeconds === "number"
            ? { retryAfterSeconds: payload.retryAfterSeconds }
            : {}),
        });
        return true;
      default:
        return false;
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return;
    }

    buffered += decoder.decode(value, { stream: true });

    let separator = buffered.indexOf("\n\n");
    while (separator !== -1) {
      const frame = buffered.slice(0, separator);
      buffered = buffered.slice(separator + 2);
      separator = buffered.indexOf("\n\n");

      if (frame.trim().length === 0) {
        continue;
      }

      const terminal = dispatchFrame(frame);
      if (terminal) {
        return;
      }
    }
  }
}

function parseUsage(value: unknown): AiChatUsage | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const inputTokens = typeof record.inputTokens === "number" ? record.inputTokens : null;
  const outputTokens = typeof record.outputTokens === "number" ? record.outputTokens : null;
  const totalTokens = typeof record.totalTokens === "number" ? record.totalTokens : null;
  if (inputTokens === null && outputTokens === null && totalTokens === null) {
    return null;
  }
  return { inputTokens, outputTokens, totalTokens };
}

/**
 * Resolve which model the picker should show, given the available models, the
 * session's stored model (null for a new session), and the currently-selected
 * model id. Mirrors the backend's per-request resolution on the client side so
 * the picker reflects what will be sent:
 * - New session: keep the current selection if valid; else default to the
 *   first available model.
 * - Existing session: restore the stored model if it's still available; else
 *   keep the current selection (the backend will reject an unavailable model).
 */
export function resolveSelectedModel(
  availableModels: AiChatChatModel[],
  sessionModel: string | null,
  currentSelection: string,
): string {
  if (availableModels.length === 0) {
    return currentSelection;
  }
  const exists = (id: string) => availableModels.some((m) => m.id === id);

  if (sessionModel && exists(sessionModel)) {
    return sessionModel;
  }
  if (currentSelection && exists(currentSelection)) {
    return currentSelection;
  }
  return availableModels[0]!.id;
}

/**
 * Merge a newly-loaded page of history into the existing message timeline,
 * deterministically and without skipping or duplicating messages.
 *
 * Messages arrive oldest-first; `nextCursor` (when present) points at the last
 * item of the current page and the next fetch yields chronologically-later
 * messages, so additional pages append to the bottom. Items already present
 * (by key) are dropped to guarantee no duplication across reloads.
 *
 * When `replace` is true (initial load / session open), the page becomes the
 * new timeline as-is. `keyOf` extracts the stable identity of an item (e.g.
 * `messageId` or `sessionId`).
 */
export function composeMessagePages<T>(
  existing: T[],
  page: T[],
  replace: boolean,
  keyOf: (item: T) => string,
): T[] {
  if (replace) {
    return dedupeByKey(page, keyOf);
  }
  const seen = new Set(existing.map(keyOf));
  const appended = page.filter((item) => !seen.has(keyOf(item)));
  return [...existing, ...appended];
}

/**
 * Merge a newly-loaded page of sessions into the existing list, newest-first,
 * without duplication. `replace` swaps the list (refresh); otherwise the page
 * appends (older sessions loaded via cursor). `keyOf` extracts the stable
 * identity of an item (e.g. `sessionId`).
 */
export function composeSessionPages<T>(
  existing: T[],
  page: T[],
  replace: boolean,
  keyOf: (item: T) => string,
): T[] {
  if (replace) {
    return dedupeByKey(page, keyOf);
  }
  const seen = new Set(existing.map(keyOf));
  const appended = page.filter((item) => !seen.has(keyOf(item)));
  return [...existing, ...appended];
}

function dedupeByKey<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const id = keyOf(item);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(item);
  }
  return result;
}

export function useGatewayApi() {
  const config = useRuntimeConfig();
  const baseUrl = config.public.gatewayBaseUrl as string;

  function getToken(): string | null {
    return getGatewayAuthToken();
  }

  function setToken(token: string): void {
    setGatewayAuthToken(token);
  }

  function clearToken(): void {
    clearGatewayAuthToken();
  }

  /**
   * Whether a gateway auth credential is available for chat. Chat submission
   * SHALL be blocked when this returns false (see spec: "Missing gateway auth
   * credential blocks chat").
   */
  function hasGatewayCredential(): boolean {
    return getGatewayAuthToken() !== null;
  }

  function getAuthHeaders(): Record<string, string> {
    const token = getToken();
    if (!token) {
      return {};
    }
    return {
      Authorization: `Bearer ${token}`,
    };
  }

  /**
   * Headers for /api/ai-chat/* requests: gateway auth credential plus the
   * interim `x-user-id: llm-gateway` identity header.
   */
  function getAiChatHeaders(): Record<string, string> {
    return {
      ...getAuthHeaders(),
      "x-user-id": WEB_AI_CHAT_USER_ID,
    };
  }

  function handleUnauthorized(): void {
    clearToken();
    if (import.meta.client) {
      navigateTo("/auth");
    }
  }

  function mapResponseError(
    statusCode: number,
    body: unknown,
    requestId?: string,
  ): GatewayApiError {
    const parsed = parseErrorBody(body, statusCode);
    return new GatewayApiError(parsed.message, statusCode, {
      code: parsed.code,
      requestId: parsed.requestId ?? requestId,
      retryable: parsed.retryable,
    });
  }

  async function request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      params?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      ...getAuthHeaders(),
    };

    const url = new URL(path, baseUrl);
    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) {
        url.searchParams.set(key, value);
      }
    }

    const fetchOptions: RequestInit = {
      method: options.method || "GET",
      headers,
    };

    if (options.body !== undefined) {
      (fetchOptions.headers as Record<string, string>)["Content-Type"] = "application/json";
      fetchOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(url.toString(), fetchOptions);

    if (response.status === 401) {
      handleUnauthorized();
      throw new GatewayApiError("Authentication required", 401, {
        code: "authentication_required",
      });
    }

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      throw mapResponseError(response.status, errorBody);
    }

    // Handle 200 with empty body (e.g. DELETE)
    const text = await response.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  }

  // ---- Production Web AI Chat ----

  /**
   * Send a message via the production non-stream endpoint
   * `POST /api/ai-chat/messages` with `stream=false`.
   */
  async function sendMessage(options: {
    prompt: string;
    sessionId?: string;
    clientMessageId: string;
    model?: string;
    attachments?: AiChatAttachment[];
    signal?: AbortSignal;
  }): Promise<AiChatSendMessageResponse> {
    const controller = new AbortController();
    const timeoutMs = DEFAULT_CHAT_TIMEOUT_MS;
    const timeout = setTimeout(() => controller.abort("chat_timeout"), timeoutMs);
    const signal = options.signal;

    const abortForwarder = () => {
      controller.abort(signal?.reason ?? "cancelled_by_user");
    };
    signal?.addEventListener("abort", abortForwarder, { once: true });

    try {
      const response = await fetch(new URL("/api/ai-chat/messages", baseUrl), {
        method: "POST",
        headers: {
          ...getAiChatHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: options.prompt,
          stream: false,
          clientMessageId: options.clientMessageId,
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
          ...(options.model ? { model: options.model } : {}),
          ...(options.attachments && options.attachments.length > 0
            ? { attachments: options.attachments.map(({ id, type, dataUrl }) => ({ id, type, dataUrl })) }
            : {}),
        }),
        signal: controller.signal,
      });

      if (response.status === 401) {
        handleUnauthorized();
        throw new GatewayApiError("Authentication required", 401, {
          code: "UNAUTHORIZED",
        });
      }

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw mapResponseError(response.status, body);
      }

      return await response.json() as AiChatSendMessageResponse;
    } catch (error) {
      if (controller.signal.aborted) {
        if (controller.signal.reason === "chat_timeout") {
          throw new GatewayApiError(
            `Chat request timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
            408,
            { code: "UPSTREAM_TIMEOUT", retryable: true },
          );
        }
        throw new GatewayApiError("Chat request cancelled.", 499, {
          code: "cancelled_by_user",
          retryable: false,
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortForwarder);
    }
  }

  /**
   * List sessions via `GET /api/ai-chat/sessions?cursor=&limit=`. Sessions are
   * returned newest-first; `nextCursor` fetches the next older page.
   */
  async function listSessions(options?: {
    cursor?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<AiChatSessionListResponse> {
    const params: Record<string, string> = {};
    if (options?.cursor) params.cursor = options.cursor;
    if (options?.limit !== undefined) params.limit = String(options.limit);

    const url = new URL("/api/ai-chat/sessions", baseUrl);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: getAiChatHeaders(),
      signal: options?.signal,
    });

    if (response.status === 401) {
      handleUnauthorized();
      throw new GatewayApiError("Authentication required", 401, {
        code: "UNAUTHORIZED",
      });
    }

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw mapResponseError(response.status, body);
    }

    return await response.json() as AiChatSessionListResponse;
  }

  /**
   * List messages for a session via
   * `GET /api/ai-chat/sessions/:sessionId/messages?cursor=&limit=`.
   * Messages are returned oldest-first; `nextCursor` fetches the next newer
   * page (chronological append).
   */
  async function listSessionMessages(options: {
    sessionId: string;
    cursor?: string;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<AiChatMessageListResponse> {
    const params: Record<string, string> = {};
    if (options.cursor) params.cursor = options.cursor;
    if (options.limit !== undefined) params.limit = String(options.limit);

    const url = new URL(
      `/api/ai-chat/sessions/${encodeURIComponent(options.sessionId)}/messages`,
      baseUrl,
    );
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: getAiChatHeaders(),
      signal: options?.signal,
    });

    if (response.status === 401) {
      handleUnauthorized();
      throw new GatewayApiError("Authentication required", 401, {
        code: "UNAUTHORIZED",
      });
    }

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw mapResponseError(response.status, body);
    }

    return await response.json() as AiChatMessageListResponse;
  }

  /**
   * Stream a message via the production SSE lifecycle endpoint
   * `POST /api/ai-chat/messages` with `stream=true`. Parses the typed event
   * stream (`started`/`delta`/`heartbeat`/`completed`/`error`) and dispatches
   * to the provided callbacks. Heartbeat events are ignored for content; on
   * a terminal `error`, already-delivered `delta` content is preserved by the
   * caller and the typed error payload is surfaced via `onError`.
   */
  async function streamAiChatMessage(options: StreamAiChatMessageOptions): Promise<void> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_CHAT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("chat_timeout"), timeoutMs);

    const abortForwarder = () => {
      controller.abort(options.signal?.reason ?? "cancelled_by_user");
    };
    options.signal?.addEventListener("abort", abortForwarder, { once: true });

    let requestId: string | undefined;

    const callbacks: AiChatStreamCallbacks = {
      onStarted: (event) => {
        if (event.requestId) {
          requestId = event.requestId;
        }
        options.callbacks.onStarted?.(event);
      },
      onDelta: options.callbacks.onDelta,
      onHeartbeat: options.callbacks.onHeartbeat,
      onCompleted: (event) => {
        if (event.requestId) {
          requestId = event.requestId;
        }
        options.callbacks.onCompleted?.(event);
      },
      onError: (event) => {
        if (event.requestId) {
          requestId = event.requestId;
        }
        options.callbacks.onError?.(event);
      },
    };

    try {
      const response = await fetch(new URL("/api/ai-chat/messages", baseUrl), {
        method: "POST",
        headers: {
          ...getAiChatHeaders(),
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          prompt: options.prompt,
          stream: true,
          clientMessageId: options.clientMessageId,
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
          ...(options.model ? { model: options.model } : {}),
          ...(options.attachments && options.attachments.length > 0
            ? { attachments: options.attachments.map(({ id, type, dataUrl }) => ({ id, type, dataUrl })) }
            : {}),
        }),
        signal: controller.signal,
      });

      if (response.status === 401) {
        handleUnauthorized();
        throw new GatewayApiError("Authentication required", 401, {
          code: "UNAUTHORIZED",
        });
      }

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw mapResponseError(response.status, body);
      }

      if (!response.body) {
        throw new GatewayApiError(
          "Gateway returned an empty streaming response.",
          502,
          { code: "stream_body_missing", requestId },
        );
      }

      await consumeAiChatStream(response.body, callbacks);
    } catch (error) {
      if (controller.signal.aborted) {
        if (controller.signal.reason === "chat_timeout") {
          throw new GatewayApiError(
            `Chat stream timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
            408,
            { code: "UPSTREAM_TIMEOUT", retryable: true, requestId },
          );
        }
        throw new GatewayApiError("Chat stream cancelled.", 499, {
          code: "cancelled_by_user",
          retryable: false,
          requestId,
        });
      }

      if (error instanceof GatewayApiError) {
        throw error;
      }

      throw new GatewayApiError(
        error instanceof Error ? error.message : "Streaming request failed.",
        502,
        { code: "stream_request_failed", requestId },
      );
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortForwarder);
    }
  }

  /**
   * List chat-routable models via the existing `GET /v1/models` endpoint.
   * Reused for the model picker (no chat-scoped list endpoint). Returns active
   * models with a display name.
   */
  async function listChatModels(): Promise<AiChatChatModel[]> {
    const response = await request<{
      object: "list";
      data: Array<{
        id: string;
        display_name?: string;
        capabilities?: {
          supports_streaming?: boolean;
          supports_tool_calls?: boolean;
          input_modalities?: string[];
        };
      }>;
    }>("/v1/models");

    return response.data.map((model) => ({
      id: model.id,
      displayName: model.display_name || model.id,
      inputModalities: Array.isArray(model.capabilities?.input_modalities)
        ? model.capabilities!.input_modalities!
        : ["text"],
    }));
  }

  /**
   * Rename a session via `PATCH /api/ai-chat/sessions/:sessionId`. Returns the
   * updated title and timestamp.
   */
  async function renameSession(options: {
    sessionId: string;
    title: string;
    signal?: AbortSignal;
  }): Promise<{ sessionId: string; title: string; updatedAt: number }> {
    const controller = new AbortController();
    const signal = options.signal;
    const abortForwarder = () => {
      controller.abort(signal?.reason ?? "cancelled_by_user");
    };
    signal?.addEventListener("abort", abortForwarder, { once: true });

    try {
      const response = await fetch(
        new URL(`/api/ai-chat/sessions/${encodeURIComponent(options.sessionId)}`, baseUrl),
        {
          method: "PATCH",
          headers: {
            ...getAiChatHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ title: options.title }),
          signal: controller.signal,
        },
      );

      if (response.status === 401) {
        handleUnauthorized();
        throw new GatewayApiError("Authentication required", 401, {
          code: "UNAUTHORIZED",
        });
      }

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw mapResponseError(response.status, body);
      }

      return await response.json() as { sessionId: string; title: string; updatedAt: number };
    } finally {
      signal?.removeEventListener("abort", abortForwarder);
    }
  }

  // ---- Status ----
  function getStatus() {
    return request<{
      status: string;
      models: { total: number; active: number; inactive: number };
      chains: { total: number; active: number; degraded: number; inactive: number };
      default_model: string | null;
      uptime_seconds: number;
    }>("/admin/status");
  }

  // ---- Models ----
  function listModels(filters?: { status?: string; source?: string }) {
    const params: Record<string, string> = {};
    if (filters?.status) params.status = filters.status;
    if (filters?.source) params.source = filters.source;
    return request<{
      models: Array<{
        name: string;
        upstream_model: string;
        base_url: string;
        owned_by: string;
        status: string;
        status_reason: string | null;
        status_changed_at: number | null;
        supports_tools: boolean;
        supports_streaming: boolean;
        input_modalities: string[];
        output_modalities: string[];
      }>;
    }>("/admin/models", { params });
  }

  function getModel(name: string) {
    return request<{
      model: {
        name: string;
        upstream_model: string;
        base_url: string;
        api_key_env: string;
        owned_by: string;
        created: number;
        status: string;
        status_reason: string | null;
        status_changed_at: number | null;
        supports_tools: boolean;
        supports_streaming: boolean;
        input_modalities: string[];
        output_modalities: string[];
        unknown_field_mode: string;
        unknown_field_window_requests: number;
        source: string | null;
        source_prefix: string | null;
        connection_id: string | null;
        capabilities_json: string | null;
        updated_at: number;
      };
    }>(`/admin/models/${encodeURIComponent(name)}`);
  }

  function createModel(body: {
    name: string;
    upstream_model: string;
    base_url: string;
    api_key_env: string;
    owned_by?: string;
    supports_tools?: boolean;
    supports_streaming?: boolean;
    input_modalities?: string[];
    output_modalities?: string[];
    unknown_field_mode?: string;
    unknown_field_window_requests?: number;
    source?: string;
  }) {
    return request<{ model: Record<string, unknown> }>("/admin/models", {
      method: "POST",
      body,
    });
  }

  function updateModel(
    name: string,
    body: {
      upstream_model?: string;
      base_url?: string;
      api_key_env?: string;
      owned_by?: string;
      supports_tools?: boolean;
      supports_streaming?: boolean;
      input_modalities?: string[];
      output_modalities?: string[];
      unknown_field_mode?: string;
      unknown_field_window_requests?: number;
      status?: string;
      status_reason?: string;
    },
  ) {
    return request<{ model: Record<string, unknown> }>(
      `/admin/models/${encodeURIComponent(name)}`,
      { method: "PUT", body },
    );
  }

  function deleteModel(name: string) {
    return request<{
      message: string;
      affected_chains: string[];
    }>(`/admin/models/${encodeURIComponent(name)}`, { method: "DELETE" });
  }

  function activateModel(name: string) {
    return request<{
      model: Record<string, unknown>;
      message: string;
    }>(`/admin/models/${encodeURIComponent(name)}/activate`, {
      method: "POST",
    });
  }

  function deactivateModel(name: string) {
    return request<{
      model: Record<string, unknown>;
      message: string;
    }>(`/admin/models/${encodeURIComponent(name)}/deactivate`, {
      method: "POST",
    });
  }

  // ---- Chains ----
  function listChains(filters?: { status?: string; source?: string }) {
    const params: Record<string, string> = {};
    if (filters?.status) params.status = filters.status;
    if (filters?.source) params.source = filters.source;
    return request<{
      chains: Array<{
        name: string;
        status: string;
        status_reason: string | null;
        status_changed_at: number | null;
        active_models: number;
        total_models: number;
        timeout_ms: number;
        max_retries: number;
        chain_timeout_ms: number | null;
      }>;
    }>("/admin/chains", { params });
  }

  function getChain(name: string) {
    return request<{
      chain: {
        name: string;
        status: string;
        status_reason: string | null;
        status_changed_at: number | null;
        active_models: number;
        total_models: number;
        timeout_ms: number;
        max_retries: number;
        chain_timeout_ms: number | null;
        models: Array<{
          position: number;
          model_name: string;
          timeout_ms: number | null;
          max_retries: number | null;
          status: string;
        }>;
        updated_at: number;
      };
    }>(`/admin/chains/${encodeURIComponent(name)}`);
  }

  function createChain(body: {
    name: string;
    timeout_ms?: number;
    max_retries?: number;
    chain_timeout_ms?: number | null;
    models: Array<{
      model_name: string;
      timeout_ms?: number | null;
      max_retries?: number | null;
    }>;
  }) {
    return request<{ chain: Record<string, unknown> }>("/admin/chains", {
      method: "POST",
      body,
    });
  }

  function updateChain(
    name: string,
    body: {
      timeout_ms?: number;
      max_retries?: number;
      chain_timeout_ms?: number | null;
      models?: Array<{
        model_name: string;
        timeout_ms?: number | null;
        max_retries?: number | null;
      }>;
    },
  ) {
    return request<{ chain: Record<string, unknown> }>(
      `/admin/chains/${encodeURIComponent(name)}`,
      { method: "PUT", body },
    );
  }

  function deleteChain(name: string) {
    return request<{ message: string }>(
      `/admin/chains/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
  }

  // ---- Gateway Config ----
  function getDatabase() {
    return request<{
      type: string;
      gateway_config: {
        id: number;
        default_model: string | null;
        request_timeout_ms: number;
        max_retries: number;
        max_body_size_kb: number;
        health_probe_enabled: boolean;
        cors_origin: string | null;
        copilot_proxy_enabled: boolean;
        copilot_proxy_require_token_auth: boolean | number;
        copilot_proxy_token_ttl_seconds: number;
        copilot_proxy_heartbeat_interval_ms: number;
        copilot_proxy_heartbeat_timeout_ms: number;
        copilot_proxy_max_inflight_per_connection: number;
        copilot_proxy_allowed_prefixes: string | string[];
      };
      model_count: number;
      chain_count: number;
    }>("/admin/database");
  }

  function patchGatewayConfig(body: Record<string, unknown>) {
    return request<{
      type: string;
      gateway_config: Record<string, unknown>;
      model_count: number;
      chain_count: number;
    }>("/admin/database", { method: "PATCH", body });
  }

  return {
    getToken,
    setToken,
    clearToken,
    hasGatewayCredential,
    getStatus,
    listModels,
    getModel,
    createModel,
    updateModel,
    deleteModel,
    activateModel,
    deactivateModel,
    listChains,
    getChain,
    createChain,
    updateChain,
    deleteChain,
    getDatabase,
    patchGatewayConfig,
    // Production Web AI Chat
    sendMessage,
    listSessions,
    listSessionMessages,
    streamAiChatMessage,
    listChatModels,
    renameSession,
  };
}
