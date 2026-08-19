/**
 * Database row types corresponding to the persisted tables.
 * These mirror the schema defined in the initial migration.
 */

/** Row from the `schema_migrations` table. */
export interface SchemaMigrationRow {
  version: number;
}

/** Row from the `models` table. */
export interface ModelRow {
  name: string;
  upstream_model: string;
  base_url: string;
  api_key_env: string;
  owned_by: string;
  created: number;
  supports_tools: number;
  supports_streaming: number;
  input_modalities: string;
  output_modalities: string;
  unknown_field_mode: string;
  unknown_field_window_requests: number;
  source: string | null;
  source_prefix: string | null;
  connection_id: string | null;
  status: string;
  status_reason: string | null;
  status_changed_at: number | null;
  capabilities_json: string | null;
  updated_at: number;
}

/** Row from the `model_chains` table. */
export interface ModelChainRow {
  name: string;
  timeout_ms: number;
  max_retries: number;
  chain_timeout_ms: number | null;
  status: string;
  status_reason: string | null;
  status_changed_at: number | null;
  updated_at: number;
}

/** Row from the `chain_models` junction table. */
export interface ChainModelRow {
  chain_name: string;
  position: number;
  model_name: string;
  timeout_ms: number | null;
  max_retries: number | null;
}

/** Row from the `gateway_config` singleton table. */
export interface GatewayConfigRow {
  id: number;
  default_model: string | null;
  request_timeout_ms: number;
  max_retries: number;
  max_body_size_kb: number;
  gateway_auth_token_env: string | null;
  health_probe_enabled: number;
  cors_origin: string | null;
  copilot_proxy_enabled: number;
  copilot_proxy_require_token_auth: number;
  copilot_proxy_token_ttl_seconds: number;
  copilot_proxy_heartbeat_interval_ms: number;
  copilot_proxy_heartbeat_timeout_ms: number;
  copilot_proxy_max_inflight_per_connection: number;
  copilot_proxy_allowed_prefixes: string;
}
