# copilot-proxy-routing Specification

## Purpose
Define routing behavior for extension-prefixed Copilot-backed models through the Copilot proxy connection registry.

## Requirements

### Requirement: Gateway SHALL route extension-prefixed models through the Copilot proxy
The gateway SHALL route client requests targeting model identifiers with an operator-allowed prefix through the Copilot proxy connection registry instead of the configured direct upstream Chat Completions transport.

#### Scenario: Chat completions request uses Copilot proxy route
- **WHEN** a client sends `POST /v1/chat/completions` with a model registered with an allowed prefix (e.g., `alazyer-copilot-auto`)
- **THEN** the gateway SHALL dispatch the request to a healthy VS Code extension connection capable of serving that model
- **AND** the gateway SHALL NOT call the direct upstream Chat Completions transport for that request

#### Scenario: Responses request uses Copilot proxy route
- **WHEN** a client sends `POST /responses` or `POST /v1/responses` with a model registered with an allowed prefix
- **THEN** the gateway SHALL translate the request through the existing Responses-to-Chat-Completions path and dispatch it to a healthy VS Code extension connection capable of serving that model
- **AND** the gateway SHALL preserve the Responses-compatible JSON response or SSE event contract for the client

#### Scenario: Anthropic messages request uses Copilot proxy route
- **WHEN** a client sends `POST /v1/messages` with a model registered with an allowed prefix
- **THEN** the gateway SHALL dispatch the translated request to a healthy VS Code extension connection capable of serving that model
- **AND** the gateway SHALL preserve the Anthropic-compatible response or stream contract for the client

#### Scenario: Non-prefixed request uses existing upstream route
- **WHEN** a client sends a request for a model that does not match any allowed prefix
- **THEN** the gateway SHALL route the request through the existing configured upstream provider path

### Requirement: Gateway SHALL reject unavailable extension-prefixed model requests with endpoint-native service-unavailable errors
The gateway SHALL return service-unavailable responses for extension-prefixed model requests when no connected extension can serve the requested model.

#### Scenario: No extension connected
- **WHEN** a client requests an extension-prefixed model and no VS Code extension is connected
- **THEN** the gateway SHALL return HTTP 503 with an endpoint-native error indicating that models with that prefix are unavailable because no VS Code extension is connected

#### Scenario: Extension connected but model unavailable
- **WHEN** a client requests an extension-prefixed model that is not present in any connected extension registration
- **THEN** the gateway SHALL return HTTP 503 with an endpoint-native error indicating that the requested model is unavailable

#### Scenario: Extension loses capability before dispatch
- **WHEN** an extension-prefixed model was previously registered but the serving extension reports it unavailable before request dispatch
- **THEN** the gateway SHALL NOT dispatch the request to that extension
- **AND** the gateway SHALL return HTTP 503 if no other extension can serve the model

### Requirement: Gateway SHALL select a healthy least-loaded extension for proxied requests
When multiple connected VS Code extensions can serve a model, the gateway SHALL select a healthy connection with the fewest in-flight requests.

#### Scenario: Multiple healthy extensions support model
- **WHEN** two or more healthy extension connections register the same extension-prefixed model
- **THEN** the gateway SHALL route the next request to a least-loaded capable connection

#### Scenario: Unhealthy extension ignored
- **WHEN** an extension connection has missed heartbeat deadlines or is closing
- **THEN** the gateway SHALL exclude that connection from request routing

### Requirement: Gateway SHALL support cancellation of in-flight proxied requests
The gateway SHALL forward client disconnects and explicit request cancellation to the serving VS Code extension using the WebSocket protocol correlation ID.

#### Scenario: HTTP client disconnects during proxied stream
- **WHEN** the original HTTP/SSE client disconnects while a proxied request is in flight
- **THEN** the gateway SHALL send a `cancel` message for the correlated request to the serving extension
- **AND** the gateway SHALL release gateway-side stream resources for that request

#### Scenario: Extension completes after cancellation
- **WHEN** an extension sends stream frames for a request after the gateway has cancelled and released it
- **THEN** the gateway SHALL ignore those frames without affecting other in-flight requests
