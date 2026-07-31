## ADDED Requirements

### Requirement: Gateway SHALL expose an authenticated Copilot proxy WebSocket endpoint
The gateway SHALL expose a WebSocket endpoint at `/ws/copilot-proxy` for VS Code extension connections and SHALL authenticate each connection before accepting proxy traffic.

#### Scenario: Valid proxy token accepted
- **WHEN** a VS Code extension connects to `/ws/copilot-proxy` with a valid unexpired proxy token
- **THEN** the gateway SHALL accept the WebSocket connection and allow registration messages

#### Scenario: Missing proxy token rejected
- **WHEN** a client connects to `/ws/copilot-proxy` without a proxy token
- **THEN** the gateway SHALL reject the connection with an unauthorized response

#### Scenario: Expired proxy token rejected
- **WHEN** a client connects to `/ws/copilot-proxy` with an expired proxy token
- **THEN** the gateway SHALL reject the connection with an unauthorized response

### Requirement: WebSocket protocol messages SHALL use typed JSON frames with correlation IDs
All Copilot proxy WebSocket messages SHALL be JSON frames with a `type` field. Messages associated with an inference request SHALL include the gateway-generated request correlation ID.

#### Scenario: Gateway dispatches request frame
- **WHEN** the gateway dispatches an inference request to an extension
- **THEN** it SHALL send a `request` frame containing `id`, `model`, `messages`, `params`, and any supported `tools`

#### Scenario: Extension streams correlated delta frame
- **WHEN** the extension emits partial output for an inference request
- **THEN** it SHALL send a `stream_delta` frame with the same `id` as the gateway request

#### Scenario: Gateway ignores unknown frame type
- **WHEN** the gateway receives a WebSocket frame with an unknown `type`
- **THEN** it SHALL reject or log the protocol error for that connection without crashing the gateway process

### Requirement: Extension SHALL register models and status after WebSocket connect
After a WebSocket connection is accepted, the extension SHALL send a registration frame containing available Copilot models, extension metadata, and Copilot status.

#### Scenario: Registration accepted
- **WHEN** an extension sends a valid `register` frame with one or more models
- **THEN** the gateway SHALL associate those models with the extension connection

#### Scenario: Empty registration marks unavailable
- **WHEN** an extension sends a valid `register` frame with no models and `copilot_status` indicating disconnected or unavailable
- **THEN** the gateway SHALL keep the connection health state but SHALL NOT route Copilot inference requests to it

#### Scenario: Invalid registration rejected
- **WHEN** an extension sends a `register` frame with invalid model metadata
- **THEN** the gateway SHALL reject the registration and SHALL NOT add those models to the registry

### Requirement: Protocol SHALL support ordered streaming completion, error, and usage frames
The extension SHALL stream Copilot output to the gateway with ordered `stream_delta` frames followed by exactly one terminal `stream_done` or `stream_error` frame for each accepted request.

#### Scenario: Successful stream completes
- **WHEN** Copilot produces a successful streamed response
- **THEN** the extension SHALL send zero or more `stream_delta` frames followed by one `stream_done` frame for the correlated request

#### Scenario: Stream fails after partial output
- **WHEN** Copilot streaming fails after one or more deltas were sent
- **THEN** the extension SHALL send a `stream_error` frame with `partial: true` for the correlated request

#### Scenario: Request fails before output
- **WHEN** Copilot request execution fails before any output is sent
- **THEN** the extension SHALL send a `stream_error` frame with `partial: false` for the correlated request

### Requirement: Gateway and extension SHALL maintain heartbeat liveness
The gateway SHALL periodically verify extension liveness with ping/pong messages and SHALL mark connections unhealthy when heartbeat deadlines are missed.

#### Scenario: Extension responds to ping
- **WHEN** the gateway sends a `ping` frame
- **THEN** the extension SHALL respond with a `pong` frame before the configured heartbeat timeout

#### Scenario: Extension misses heartbeat
- **WHEN** an extension fails to respond to heartbeat within the configured timeout
- **THEN** the gateway SHALL mark the connection disconnected, remove its registered models, and fail in-flight requests with endpoint-native stream errors

### Requirement: Protocol SHALL support request cancellation
The gateway SHALL send `cancel` frames to the extension for in-flight requests that are no longer needed.

#### Scenario: Cancel frame includes correlation ID
- **WHEN** the gateway cancels an in-flight Copilot request
- **THEN** it SHALL send a `cancel` frame containing the original request `id`

#### Scenario: Extension receives cancel frame
- **WHEN** the extension receives a `cancel` frame for an active request
- **THEN** it SHALL cancel the corresponding `vscode.lm` request if the API supports cancellation
- **AND** it SHALL stop sending non-terminal deltas for that request
