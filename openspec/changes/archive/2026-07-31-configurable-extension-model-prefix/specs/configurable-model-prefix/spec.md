## ADDED Requirements

### Requirement: Gateway SHALL validate extension model prefixes against an operator-configured allowlist
The gateway SHALL read a `copilot_proxy_allowed_prefixes` list from the YAML configuration. When an extension sends a `register` or `status_update` frame, the gateway SHALL validate that every model ID starts with one of the allowed prefixes. Models that do not match any allowed prefix SHALL be rejected.

#### Scenario: Model with allowed prefix accepted
- **WHEN** the gateway configuration includes `copilot_proxy_allowed_prefixes: ["copilot-", "alazyer-"]` and an extension registers model `alazyer-copilot-auto`
- **THEN** the gateway SHALL accept the model registration and associate `alazyer-copilot-auto` with that extension connection

#### Scenario: Model with disallowed prefix rejected
- **WHEN** the gateway configuration includes `copilot_proxy_allowed_prefixes: ["copilot-", "alazyer-"]` and an extension registers model `other-team-gpt-4o`
- **THEN** the gateway SHALL reject the registration for that model and SHALL close the WebSocket connection with code `1008`

#### Scenario: Empty allowed prefixes list rejects all registrations
- **WHEN** the gateway configuration includes `copilot_proxy_allowed_prefixes: []` and an extension registers any model
- **THEN** the gateway SHALL reject the registration and close the WebSocket connection with code `1008`

#### Scenario: Default allowed prefixes includes copilot-
- **WHEN** the gateway configuration does not specify `copilot_proxy_allowed_prefixes`
- **THEN** the gateway SHALL treat the allowed prefixes list as `["copilot-"]`, preserving backward compatibility

### Requirement: Gateway SHALL use the matching prefix as the model source identifier
When a model is registered with an allowed prefix, the gateway SHALL store that prefix as the model's `source` field. The `source` field SHALL appear in model discovery endpoint responses so clients can identify which namespace a model belongs to.

#### Scenario: Source reflects registered prefix
- **WHEN** an extension registers model `alazyer-copilot-auto` and the allowed prefix that matched is `alazyer-`
- **THEN** the gateway SHALL store and expose `source: "alazyer-"` in the model record

#### Scenario: Copilot prefix preserves existing source
- **WHEN** an extension registers model `copilot-gpt-4o` and the allowed prefix that matched is `copilot-`
- **THEN** the gateway SHALL store and expose `source: "copilot-"` in the model record

### Requirement: Gateway SHALL expose active prefix information via management API
The gateway SHALL provide a `/api/channels` endpoint that lists active extension channels, their allowed prefixes, connected extension count, and registered models.

#### Scenario: List active channels
- **WHEN** a client calls `GET /api/channels` with valid gateway auth
- **THEN** the gateway SHALL return a JSON array where each entry includes the channel prefix, the number of connected extensions, and the model IDs registered under that prefix

#### Scenario: Unauthenticated request rejected
- **WHEN** a client calls `GET /api/channels` without valid gateway auth and gateway auth is enabled
- **THEN** the gateway SHALL return HTTP 401

#### Scenario: Channels endpoint when Copilot proxy disabled
- **WHEN** a client calls `GET /api/channels` and `copilot_proxy` is not enabled in the gateway configuration
- **THEN** the gateway SHALL return HTTP 403 with an error indicating that the Copilot proxy is disabled

#### Scenario: Channels endpoint when gateway auth not configured
- **WHEN** a client calls `GET /api/channels` and gateway authentication is not configured (`gateway_auth_token` is absent)
- **THEN** the gateway SHALL return HTTP 403 with an error indicating that gateway auth must be enabled, consistent with the `/api/proxy-token` endpoint behavior
