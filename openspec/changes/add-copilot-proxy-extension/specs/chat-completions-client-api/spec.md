## ADDED Requirements

### Requirement: Gateway SHALL serve `copilot-*` chat completions requests through Copilot proxy when available
The gateway SHALL preserve the `POST /v1/chat/completions` request and response contract while serving registered `copilot-*` models through the Copilot proxy path.

#### Scenario: Non-stream Copilot chat completion succeeds
- **WHEN** a client sends a valid non-stream `POST /v1/chat/completions` request for a registered `copilot-*` model
- **THEN** the gateway SHALL return an OpenAI-compatible Chat Completions JSON response produced from Copilot proxy stream frames

#### Scenario: Streaming Copilot chat completion succeeds
- **WHEN** a client sends a valid `POST /v1/chat/completions` request with `stream=true` for a registered `copilot-*` model
- **THEN** the gateway SHALL return OpenAI-compatible Chat Completions SSE output translated from Copilot proxy stream frames

#### Scenario: Copilot model unavailable
- **WHEN** a client sends `POST /v1/chat/completions` for a `copilot-*` model with no capable extension connected
- **THEN** the gateway SHALL return HTTP 503 with an OpenAI-style error envelope

### Requirement: Gateway SHALL map Copilot proxy stream frames to OpenAI Chat Completions output
For `/v1/chat/completions` requests served by the Copilot proxy, the gateway SHALL translate text, tool-call, usage, done, and error frames into OpenAI-compatible Chat Completions response shapes.

#### Scenario: Text delta maps to OpenAI SSE content delta
- **WHEN** the gateway receives a Copilot proxy `stream_delta` frame with `content_type: "text"` for a streaming chat completions request
- **THEN** it SHALL emit an OpenAI SSE chunk with `choices[0].delta.content`

#### Scenario: Tool-call delta maps to OpenAI tool calls
- **WHEN** the gateway receives a Copilot proxy `stream_delta` frame with `content_type: "tool_call"` for a chat completions request
- **THEN** it SHALL emit OpenAI-compatible tool call data in the response or stream

#### Scenario: Stream error maps to OpenAI error
- **WHEN** the gateway receives a Copilot proxy `stream_error` frame before completing a chat completions request
- **THEN** it SHALL emit or return an OpenAI-compatible error with an appropriate HTTP status or stream error event
