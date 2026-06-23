## Why

The README reveals the gateway's primary use case: **enabling Claude Code to work with non-Claude upstream providers** via `/v1/messages`. However, the gateway currently ignores incoming authentication headers (`x-api-key`, `Authorization`, `ANTHROPIC_AUTH_TOKEN`), meaning any unauthenticated client can use it — exposing upstream API keys to unauthorized access. The health check is superficial (`{ok: true}` without verifying upstream connectivity), making it useless for operational monitoring. And there are no CORS headers, preventing browser-based tooling from calling the gateway.

## What Changes

- Add configurable incoming request authentication: validate `x-api-key` / `Authorization` / `anthropic-version` + `x-api-key` headers against a gateway auth token before processing any request. Claude Code sends `ANTHROPIC_AUTH_TOKEN` or `x-api-key`; the gateway should verify these are non-empty (or match a configured value) before allowing requests.
- Enhance `/healthz` to optionally verify upstream connectivity: check that at least one configured upstream is reachable, or at minimum verify that model configuration is valid and loaded.
- Add CORS headers for browser-based tooling: configurable `cors_origin` in gateway YAML to enable Anthropic SDK playgrounds and admin dashboards.

## Capabilities

### New Capabilities
- `incoming-auth`: Configurable gateway authentication for incoming requests, validating `x-api-key` / `Authorization` headers against a configured gateway token before processing.
- `enhanced-health`: Health check that validates gateway state (config loaded, models available) and optionally probes upstream connectivity.
- `cors-support`: Configurable CORS headers for browser-based clients.

### Modified Capabilities
- `chat-completions-client-api`: Requests SHALL require valid auth token when auth is enabled; unauthenticated requests rejected with 401/403.

## Impact

- **Code**: `src/routes/responses.ts` (auth middleware), `src/app.ts` (health enhancement, CORS), `src/config.ts` (new auth/CORS config fields)
- **APIs**: Auth-protected endpoints return 401/403 when auth is enabled; `/healthz` returns richer data; CORS headers on responses
- **Dependencies**: No new dependencies
- **Config**: New gateway YAML fields: `gateway_auth_token_env`, `cors_origin`; new env var for gateway auth token
- **Tests**: New auth tests, health check tests, CORS tests
