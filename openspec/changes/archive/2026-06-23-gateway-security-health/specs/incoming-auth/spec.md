## Purpose
Define incoming request authentication for the gateway, validating `x-api-key` / `Authorization` headers against a configured gateway token.

## ADDED Requirements

### Requirement: Gateway SHALL support configurable incoming request authentication
The gateway SHALL validate incoming requests against a configured gateway auth token when authentication is enabled. Authentication SHALL be optional and disabled by default for backward compatibility.

#### Scenario: Auth enabled — valid token accepted
- **WHEN** `gateway_auth_token_env` is configured with a non-empty env var value and a request includes a matching `x-api-key` header or `Authorization: Bearer <token>` header
- **THEN** the gateway SHALL process the request normally

#### Scenario: Auth enabled — invalid token rejected
- **WHEN** `gateway_auth_token_env` is configured and a request includes a non-matching or empty auth header
- **THEN** the gateway SHALL return HTTP 401 Unauthorized with an appropriate error body

#### Scenario: Auth enabled — missing token rejected
- **WHEN** `gateway_auth_token_env` is configured and a request includes no auth header
- **THEN** the gateway SHALL return HTTP 401 Unauthorized

#### Scenario: Auth disabled — no validation
- **WHEN** `gateway_auth_token_env` is not configured
- **THEN** the gateway SHALL skip auth validation and process all requests (current behavior)

### Requirement: Auth validation SHALL apply to all data endpoints but not health/metadata discovery
The gateway SHALL require authentication on `POST /responses`, `POST /v1/responses`, `POST /v1/chat/completions`, `POST /v1/messages`, and `POST /v1/messages/count_tokens`. `GET /healthz`, `GET /models`, `GET /v1/models`, and `GET /models/:model` SHALL NOT require authentication.

#### Scenario: Data endpoint requires auth
- **WHEN** auth is enabled and a POST endpoint is called without valid auth
- **THEN** the gateway SHALL return 401 before processing the request body

#### Scenario: Health/metadata endpoint accessible without auth
- **WHEN** auth is enabled and `GET /healthz` or `GET /v1/models` is called without auth
- **THEN** the gateway SHALL process the request normally

### Requirement: Anthropic-compatible clients SHALL use x-api-key header
Claude Code sends `x-api-key` for Anthropic auth. The gateway SHALL accept `x-api-key` as a valid auth header alongside `Authorization: Bearer`.

#### Scenario: x-api-key header accepted
- **WHEN** auth is enabled and a request includes `x-api-key: <token>` matching the configured value
- **THEN** the gateway SHALL process the request normally

#### Scenario: Authorization Bearer header accepted
- **WHEN** auth is enabled and a request includes `Authorization: Bearer <token>` matching the configured value
- **THEN** the gateway SHALL process the request normally
