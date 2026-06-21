## Purpose
Define OpenAI SDK-backed upstream transport behavior for Chat Completions dispatch and endpoint-native error normalization.

## Requirements

### Requirement: Gateway SHALL use OpenAI SDK for upstream chat completions transport
The gateway SHALL dispatch upstream `/v1/chat/completions` requests through an OpenAI SDK-backed transport adapter for both streaming and non-streaming calls.

#### Scenario: Non-stream upstream dispatch uses SDK adapter
- **WHEN** a valid internal Chat Completions request is dispatched in non-stream mode
- **THEN** the gateway SHALL invoke the OpenAI SDK transport adapter instead of raw HTTP client logic

#### Scenario: Stream upstream dispatch uses SDK adapter
- **WHEN** a valid internal Chat Completions request is dispatched with `stream=true`
- **THEN** the gateway SHALL invoke the OpenAI SDK streaming transport path and expose translated endpoint-native stream output

### Requirement: Gateway SHALL preserve model routing and auth controls during SDK dispatch
The gateway SHALL continue to apply configured model selection, upstream model mapping, base URL, and API key resolution when creating OpenAI SDK requests.

#### Scenario: Model alias maps to configured upstream model
- **WHEN** a request targets a configured public model alias
- **THEN** the SDK request SHALL use that model's configured `upstream_model`, `base_url`, and credentials

#### Scenario: Missing model configuration fails before SDK call
- **WHEN** a request references a model not present in gateway configuration
- **THEN** the gateway SHALL reject the request and SHALL NOT attempt an OpenAI SDK upstream call

### Requirement: Gateway SHALL normalize upstream transport errors to endpoint contracts
The gateway SHALL map OpenAI SDK transport and upstream HTTP failures into stable endpoint-native error responses.

#### Scenario: Upstream transport error on `/responses`
- **WHEN** SDK transport fails while serving `/responses`
- **THEN** the gateway SHALL return a `/responses`-compatible error envelope with appropriate HTTP status

#### Scenario: Upstream transport error on `/v1/messages`
- **WHEN** SDK transport fails while serving `/v1/messages`
- **THEN** the gateway SHALL return an Anthropic-compatible error envelope with appropriate HTTP status
