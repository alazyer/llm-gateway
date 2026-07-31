## Purpose
Define Anthropic SDK-compatible request/response boundary expectations for `/v1/messages`, including validation and streaming lifecycle guarantees.
## Requirements
### Requirement: `/v1/messages` boundary SHALL use Anthropic SDK-compatible validation and construction
The gateway SHALL validate and normalize `/v1/messages` requests and construct `/v1/messages` responses/events using Anthropic SDK-compatible contract shapes.

#### Scenario: Valid Anthropic request accepted
- **WHEN** a `/v1/messages` request conforms to Anthropic-compatible schema
- **THEN** the gateway SHALL accept it and normalize it for translation to internal Chat Completions format

#### Scenario: Invalid Anthropic request rejected
- **WHEN** a `/v1/messages` request violates Anthropic-compatible schema
- **THEN** the gateway SHALL return an Anthropic-compatible invalid request error

### Requirement: Anthropic streaming minimum event contract SHALL be guaranteed
For `/v1/messages` streaming responses, the gateway SHALL emit at least the following ordered events:
`message_start → content_block_start → content_block_delta* → content_block_stop → message_delta → message_stop`.

#### Scenario: Text completion stream emits required lifecycle events
- **WHEN** upstream emits a valid text stream for `/v1/messages`
- **THEN** the gateway SHALL emit required Anthropic lifecycle events in the mandated order

#### Scenario: Tool-use stream emits required lifecycle events
- **WHEN** upstream emits tool call deltas for `/v1/messages`
- **THEN** the gateway SHALL emit content block events and terminal message events in the mandated order

### Requirement: `/v1/messages` strict unknown-field policy SHALL remain unchanged in this change
This change SHALL NOT introduce unknown top-level field strictness rollout behavior for `/v1/messages`.

#### Scenario: Unknown `/v1/messages` strict-mode config absent
- **WHEN** gateway configuration is updated for this change
- **THEN** no `/v1/messages`-specific `warn|enforce` unknown-field policy SHALL be required

### Requirement: Gateway SHALL serve `copilot-*` Anthropic messages requests through Copilot proxy when available
The gateway SHALL preserve the `/v1/messages` Anthropic-compatible request and response contract while serving registered `copilot-*` models through the Copilot proxy path.

#### Scenario: Non-stream Copilot messages request succeeds
- **WHEN** a client sends a valid non-stream `POST /v1/messages` request for a registered `copilot-*` model
- **THEN** the gateway SHALL return an Anthropic-compatible message response produced from Copilot proxy stream frames

#### Scenario: Streaming Copilot messages request succeeds
- **WHEN** a client sends a valid `POST /v1/messages` request with `stream=true` for a registered `copilot-*` model
- **THEN** the gateway SHALL return Anthropic-compatible SSE output translated from Copilot proxy stream frames

#### Scenario: Copilot messages model unavailable
- **WHEN** a client sends `POST /v1/messages` for a `copilot-*` model with no capable extension connected
- **THEN** the gateway SHALL return HTTP 503 with an Anthropic-compatible error envelope

### Requirement: Gateway SHALL map Copilot proxy stream frames to Anthropic message output
For `/v1/messages` requests served by the Copilot proxy, the gateway SHALL translate text, tool-call, usage, done, and error frames into Anthropic-compatible message response and streaming event shapes.

#### Scenario: Text delta maps to Anthropic content block delta
- **WHEN** the gateway receives a Copilot proxy `stream_delta` frame with `content_type: "text"` for a streaming messages request
- **THEN** it SHALL emit an Anthropic `content_block_delta` event in the required message stream lifecycle

#### Scenario: Tool-call delta maps to Anthropic tool use
- **WHEN** the gateway receives a Copilot proxy `stream_delta` frame with `content_type: "tool_call"` for a messages request
- **THEN** it SHALL emit Anthropic-compatible tool use content in the response or stream

#### Scenario: Stream error maps to Anthropic error
- **WHEN** the gateway receives a Copilot proxy `stream_error` frame before completing a messages request
- **THEN** it SHALL emit or return an Anthropic-compatible error with an appropriate HTTP status or stream error event

