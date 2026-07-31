/**
 * Authenticated fetch wrapper for the LLM Gateway admin API.
 *
 * - Reads the auth token from localStorage
 * - Sets Authorization: Bearer header on every request
 * - Throws on non-2xx responses with a structured error
 */
export function useGatewayApi() {
  const config = useRuntimeConfig();
  const baseUrl = config.public.gatewayBaseUrl as string;

  function getToken(): string | null {
    if (import.meta.client) {
      return localStorage.getItem("gateway_auth_token");
    }
    return null;
  }

  function setToken(token: string): void {
    if (import.meta.client) {
      localStorage.setItem("gateway_auth_token", token);
    }
  }

  function clearToken(): void {
    if (import.meta.client) {
      localStorage.removeItem("gateway_auth_token");
    }
  }

  async function request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      params?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const token = getToken();
    const headers: Record<string, string> = {};

    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const url = new URL(path, baseUrl);
    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) {
        url.searchParams.set(key, value);
      }
    }

    const fetchOptions: RequestInit = {
      method: options.method || "GET",
      headers: {
        ...headers,
      },
    };

    if (options.body !== undefined) {
      (fetchOptions.headers as Record<string, string>)["Content-Type"] = "application/json";
      fetchOptions.body = JSON.stringify(options.body);
    }

    const response = await fetch(url.toString(), fetchOptions);

    if (response.status === 401) {
      clearToken();
      if (import.meta.client) {
        navigateTo("/auth");
      }
      throw new Error("Authentication required");
    }

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({}));
      const message =
        errorBody?.error?.message || `Request failed: ${response.status}`;
      throw new Error(message);
    }

    // Handle 200 with empty body (e.g. DELETE)
    const text = await response.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
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
  };
}
