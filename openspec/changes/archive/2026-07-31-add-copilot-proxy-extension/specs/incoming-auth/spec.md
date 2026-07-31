## ADDED Requirements

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
