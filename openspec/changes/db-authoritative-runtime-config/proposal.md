## Why

The gateway still requires `GATEWAY_CONFIG_PATH` and YAML parsing during startup, which conflicts with the new DB-authoritative runtime direction and makes startup behavior tighter than needed. We need startup to be DB-first and permissive, with inference-time validation for model/chain availability and credentials.

## What Changes

- Make `GATEWAY_CONFIG_PATH` optional and ignored at runtime.
- Startup becomes independent from `models` / `model_chains` presence.
- Ensure `gateway_config` singleton exists on startup (auto-create defaults when missing).
- Keep listing/discovery endpoints operational with empty results when no models/chains exist.
- Return `404` for missing requested model or chain during inference resolution.
- Return `500` for existing but misconfigured inference targets (for example, missing runtime secret for `api_key_env`).
- Treat broken/misconfigured chains as hard failure for the request (no partial fallback).
- Keep `/healthz` returning `200` while exposing configuration state details.
- **BREAKING**: YAML file bootstrap is removed from runtime behavior; operators must provision models/chains via admin APIs (or explicit DB tooling) instead of startup seeding.

## Capabilities

### New Capabilities
- `runtime-db-bootstrap`: Startup initialization that guarantees `gateway_config(id=1)` with defaults and supports DB-only operation without YAML.

### Modified Capabilities
- `migration`: Remove YAML-seeding startup path requirements and make `GATEWAY_CONFIG_PATH` optional/ignored at runtime.
- `persistence`: Update startup loading contract to DB-only configuration state with permissive boot when model/chain catalogs are empty.
- `model-chain-resolution`: Change inference resolution error semantics to `404` for missing targets and `500` for existing but misconfigured targets.
- `enhanced-health`: Change no-model behavior from degraded/503 to `200` health with explicit configuration-state details.

## Impact

- Affected code: `src/config.ts`, `src/server.ts`, `src/runtime-config.ts`, model/chain resolution paths, inference route handlers, and health endpoint logic.
- Affected APIs: `/healthz`, model discovery/list endpoints, and inference endpoints (`/v1/chat/completions`, `/v1/responses`, `/v1/messages`).
- Operational impact: runtime no longer depends on YAML path; initial model/chain setup must happen through admin/API or direct DB provisioning flows.
