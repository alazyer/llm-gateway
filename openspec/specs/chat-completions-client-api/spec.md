## Purpose
Define gateway client-facing behavior for OpenAI Chat Completions endpoint support at `POST /v1/chat/completions`.

## Requirements

### Requirement: Gateway SHALL accept `POST /v1/chat/completions` requests
The gateway SHALL expose `POST /v1/chat/completions` and process OpenAI Chat Completions request payloads in both non-stream and stream modes.

#### Scenario: Non-stream chat completions request succeeds
- **WHEN** a client sends a valid non-stream `POST /v1/chat/completions` request
- **THEN** the gateway SHALL dispatch the request through the configured upstream Chat Completions transport and return an OpenAI Chat Completions JSON response

#### Scenario: Stream chat completions request succeeds
- **WHEN** a client sends a valid `POST /v1/chat/completions` request with `stream=true`
- **THEN** the gateway SHALL return OpenAI-compatible Chat Completions SSE stream output

### Requirement: Gateway SHALL apply configured model routing and capability gates for chat completions requests
The gateway SHALL apply model alias resolution, upstream model mapping, base URL and API key resolution, and pre-dispatch capability checks when handling `POST /v1/chat/completions` requests.

#### Scenario: Missing model configuration is rejected
- **WHEN** a request targets a model alias not present in gateway configuration
- **THEN** the gateway SHALL return a client error and SHALL NOT call upstream transport

#### Scenario: Unsupported streaming is rejected before upstream dispatch
- **WHEN** a request sets `stream=true` for a model with streaming disabled
- **THEN** the gateway SHALL reject the request with client error before calling upstream transport

### Requirement: Gateway SHALL return endpoint-native OpenAI-style error responses for `/v1/chat/completions`
The gateway SHALL normalize request validation failures and upstream transport failures into stable OpenAI-compatible error envelopes for `POST /v1/chat/completions` clients.

#### Scenario: Invalid request body returns validation error
- **WHEN** the request body for `POST /v1/chat/completions` fails schema validation
- **THEN** the gateway SHALL return HTTP 400 with an OpenAI-style error envelope describing invalid input

#### Scenario: Upstream transport failure returns normalized OpenAI-style error
- **WHEN** upstream transport fails while serving `POST /v1/chat/completions`
- **THEN** the gateway SHALL return an OpenAI-style error response with appropriate HTTP status without exposing raw upstream error bodies
