# incoming-auth Specification

## Purpose
TBD - created by archiving change gateway-security-health. Update Purpose after archive.
## Requirements
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

### Requirement: Gateway SHALL issue scoped proxy tokens for VS Code extension connections
The gateway SHALL provide an authenticated proxy-token issuance endpoint for VS Code extensions and SHALL scope issued tokens to Copilot proxy WebSocket access.

#### Scenario: Authenticated token request succeeds
- **WHEN** gateway auth is enabled and a client with valid gateway credentials requests a Copilot proxy token
- **THEN** the gateway SHALL issue a proxy token with an expiry timestamp

#### Scenario: Unauthenticated token request rejected
- **WHEN** gateway auth is enabled and a client without valid gateway credentials requests a Copilot proxy token
- **THEN** the gateway SHALL reject the request with HTTP 401

#### Scenario: Proxy token has limited lifetime
- **WHEN** the gateway issues a proxy token
- **THEN** the token SHALL expire no later than the configured proxy-token lifetime

### Requirement: Gateway SHALL validate proxy tokens separately from incoming request auth
The gateway SHALL validate proxy tokens for `/ws/copilot-proxy` connections without changing the existing `x-api-key` and `Authorization: Bearer` validation behavior for HTTP data endpoints.

#### Scenario: Proxy token accepted for WebSocket only
- **WHEN** an extension presents a valid proxy token to `/ws/copilot-proxy`
- **THEN** the gateway SHALL authorize the WebSocket connection
- **AND** the same token SHALL NOT automatically grant access to HTTP data endpoints unless it is also the configured gateway auth token

#### Scenario: Gateway auth remains unchanged
- **WHEN** a CLI client calls `POST /v1/chat/completions` or `POST /v1/messages`
- **THEN** the gateway SHALL continue applying existing gateway auth semantics for `x-api-key` and `Authorization: Bearer`

#### Scenario: Copilot credentials never accepted by gateway
- **WHEN** a client attempts to authenticate to the gateway using Copilot or VS Code credentials
- **THEN** the gateway SHALL NOT treat those credentials as valid proxy or request credentials

