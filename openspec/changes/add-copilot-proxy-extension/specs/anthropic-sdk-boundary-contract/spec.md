## ADDED Requirements

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
