/**
 * Authenticated fetch wrapper for the LLM Gateway admin API.
 *
 * - Reads the auth token from in-memory browser state
 * - Sets Authorization: Bearer <token> on every request
 * - Throws on non-2xx responses with a structured error
 */

import {
  clearGatewayAuthToken,
  getGatewayAuthToken,
  setGatewayAuthToken,
} from "../utils/authToken";

const DEFAULT_CHAT_VALIDATION_TIMEOUT_MS = 120_000;

export interface ValidationModelRecord {
  id: string;
  displayName: string;
  source?: string;
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
}

export interface ChatValidationResponse {
  id: string;
  model: string;
  choices: Array<{
    message?: {
      role: "assistant";
      content: string | null;
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface StreamValidationChatOptions {
  model: string;
  prompt: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onRequestId?: (requestId: string) => void;
}

export class GatewayApiError extends Error {
  public readonly statusCode: number;
  public readonly code?: string;
  public readonly requestId?: string;

  public constructor(
    message: string,
    statusCode: number,
    options?: { code?: string; requestId?: string },
  ) {
    super(message);
    this.name = "GatewayApiError";
    this.statusCode = statusCode;
    this.code = options?.code;
    this.requestId = options?.requestId;
  }
}

function extractRequestId(value: unknown): string | undefined {
  if (value && typeof value === "object" && "id" in value && typeof value.id === "string") {
    return value.id;
  }
  return undefined;
}

function parseErrorBody(body: unknown, statusCode: number): { message: string; code?: string } {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;

    if (
      record.error &&
      typeof record.error === "object" &&
      "message" in (record.error as Record<string, unknown>) &&
      typeof (record.error as Record<string, unknown>).message === "string"
    ) {
      const errorRecord = record.error as Record<string, unknown>;
      return {
        message: String(errorRecord.message),
        code: typeof errorRecord.code === "string" ? errorRecord.code : undefined,
      };
    }

    if (typeof record.error === "string") {
      return { message: record.error };
    }
  }

  return { message: `Request failed: ${statusCode}` };
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

  function getAuthHeaders(): Record<string, string> {
    const token = getToken();
    if (!token) {
      return {};
    }
    return {
      Authorization: `Bearer ${token}`,
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
      requestId,
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

  async function listValidationModels(): Promise<ValidationModelRecord[]> {
    const response = await request<{
      object: "list";
      data: Array<{
        id: string;
        display_name?: string;
        source?: string;
        capabilities?: {
          supports_streaming?: boolean;
          supports_tool_calls?: boolean;
        };
      }>;
    }>("/v1/models");

    return response.data.map((model) => ({
      id: model.id,
      displayName: model.display_name || model.id,
      source: model.source,
      supportsStreaming: model.capabilities?.supports_streaming !== false,
      supportsToolCalls: model.capabilities?.supports_tool_calls !== false,
    }));
  }

  async function validateChatPrompt(
    options: {
      model: string;
      prompt: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<ChatValidationResponse> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_CHAT_VALIDATION_TIMEOUT_MS;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("validation_timeout"), timeoutMs);
    const signal = options.signal;

    const abortForwarder = () => {
      controller.abort(signal?.reason ?? "cancelled_by_user");
    };
    signal?.addEventListener("abort", abortForwarder, { once: true });

    try {
      const response = await fetch(new URL("/v1/chat/completions", baseUrl), {
        method: "POST",
        headers: {
          ...getAuthHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: options.model,
          stream: false,
          messages: [
            {
              role: "user",
              content: options.prompt,
            },
          ],
        }),
        signal: controller.signal,
      });

      if (response.status === 401) {
        handleUnauthorized();
        throw new GatewayApiError("Authentication required", 401, {
          code: "authentication_required",
        });
      }

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw mapResponseError(response.status, body);
      }

      return await response.json() as ChatValidationResponse;
    } catch (error) {
      if (controller.signal.aborted) {
        if (controller.signal.reason === "validation_timeout") {
          throw new GatewayApiError(
            `Validation timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
            408,
            { code: "validation_timeout" },
          );
        }

        throw new GatewayApiError("Validation cancelled.", 499, {
          code: "cancelled_by_user",
        });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortForwarder);
    }
  }

  async function streamValidationChat(options: StreamValidationChatOptions): Promise<void> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_CHAT_VALIDATION_TIMEOUT_MS;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("validation_timeout"), timeoutMs);

    const abortForwarder = () => {
      controller.abort(options.signal?.reason ?? "cancelled_by_user");
    };
    options.signal?.addEventListener("abort", abortForwarder, { once: true });

    let requestId: string | undefined;

    try {
      const response = await fetch(new URL("/v1/chat/completions", baseUrl), {
        method: "POST",
        headers: {
          ...getAuthHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: options.model,
          stream: true,
          messages: [
            {
              role: "user",
              content: options.prompt,
            },
          ],
        }),
        signal: controller.signal,
      });

      if (response.status === 401) {
        handleUnauthorized();
        throw new GatewayApiError("Authentication required", 401, {
          code: "authentication_required",
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
          { code: "stream_body_missing" },
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";

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

          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");

          if (!data) {
            continue;
          }

          if (data === "[DONE]") {
            return;
          }

          let parsed: unknown;
          try {
            parsed = JSON.parse(data) as unknown;
          } catch {
            continue;
          }

          const frameRequestId = extractRequestId(parsed);
          if (frameRequestId && frameRequestId !== requestId) {
            requestId = frameRequestId;
            options.onRequestId?.(frameRequestId);
          }

          if (parsed && typeof parsed === "object" && "error" in parsed) {
            const record = parsed as Record<string, unknown>;
            throw mapResponseError(response.status, parsed, extractRequestId(record));
          }

          if (
            parsed &&
            typeof parsed === "object" &&
            "choices" in parsed &&
            Array.isArray((parsed as Record<string, unknown>).choices)
          ) {
            const choices = (parsed as { choices: Array<{ delta?: { content?: string } }> }).choices;
            const content = choices[0]?.delta?.content;
            if (typeof content === "string" && content.length > 0) {
              options.onTextDelta?.(content);
            }
          }
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        if (controller.signal.reason === "validation_timeout") {
          throw new GatewayApiError(
            `Validation timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
            408,
            { code: "validation_timeout", requestId },
          );
        }
        throw new GatewayApiError("Validation cancelled.", 499, {
          code: "cancelled_by_user",
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
    listValidationModels,
    validateChatPrompt,
    streamValidationChat,
  };
}
