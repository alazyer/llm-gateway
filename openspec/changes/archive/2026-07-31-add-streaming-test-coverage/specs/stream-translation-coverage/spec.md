# stream-translation-coverage Specification

## Purpose
Comprehensive test coverage for SSE stream translators, response translation, request translation, and copilot-proxy stream adapters.

## Requirements

### Requirement: ChatCompletionStreamTranslator SHALL have comprehensive edge-case test coverage

The `ChatCompletionStreamTranslator` class in `src/translation/stream.ts` SHALL have test cases covering error paths, boundary conditions, tool calls, and identity stability checks.

#### Scenario: Incomplete SSE frame at stream end
- **WHEN** `push()` receives a partial SSE frame (no trailing `\n\n`) followed by `flush()`
- **THEN** the translator SHALL emit a `response.failed` event with `code: "invalid_upstream_chunk"`

#### Scenario: Upstream error payload mid-stream
- **WHEN** a valid SSE chunk contains an `error` field
- **THEN** the translator SHALL emit a `response.failed` event with the upstream error message

#### Scenario: Multiple tool calls interleaved with text
- **WHEN** a stream contains chunks with `delta.content` followed by `delta.tool_calls` followed by more `delta.content`
- **THEN** the translator SHALL emit the correct sequence of `output_text.delta`, `function_call_arguments.delta`, and `output_text.delta` events in order

#### Scenario: Identity field changes mid-stream
- **WHEN** a chunk has a different `id` value than the first chunk
- **THEN** the translator SHALL emit a `response.failed` event indicating inconsistent `chunk.id`

#### Scenario: Empty choices array
- **WHEN** a chunk has `choices: []`
- **THEN** the translator SHALL emit a `response.failed` event indicating `choices` must be non-empty

#### Scenario: Missing delta on non-terminal chunk
- **WHEN** a chunk has `choices[0].finish_reason === null` but no `delta` field
- **THEN** the translator SHALL emit a `response.failed` event indicating `delta` must be an object

#### Scenario: [DONE] before any chunks
- **WHEN** the first frame received is `data: [DONE]`
- **THEN** the translator SHALL emit a `response.failed` event indicating no upstream response chunk was received

#### Scenario: Malformed JSON in SSE data
- **WHEN** a SSE frame contains invalid JSON in the `data` field
- **THEN** the translator SHALL emit a `response.failed` event indicating invalid JSON

#### Scenario: SSE frame missing data field
- **WHEN** a SSE frame has an `event` line but no `data` line
- **THEN** the translator SHALL emit a `response.failed` event indicating missing data field

### Requirement: AnthropicMessageStreamTranslator SHALL have comprehensive edge-case test coverage

The `AnthropicMessageStreamTranslator` class in `src/translation/anthropic/stream.ts` SHALL have test cases covering tool-use streaming, stop reasons, and error events.

#### Scenario: Tool-use block streaming
- **WHEN** a stream contains `content_block_start` with `type: "tool_use"` followed by `content_block_delta` with `input_json_delta`
- **THEN** the translator SHALL emit `content_block_start`, `content_block_delta`, and `content_block_stop` events with correct tool-use block structure

#### Scenario: Uncommon stop_reason values
- **WHEN** a `message_delta` event has `stop_reason: "pause_turn"` or `stop_reason: "refusal"`
- **THEN** the translator SHALL map these to the corresponding `stop_reason` values in the output

#### Scenario: Error event mid-stream
- **WHEN** a stream emits an `error` event type
- **THEN** the translator SHALL propagate the error information

#### Scenario: Stream ends without terminal event
- **WHEN** the upstream stream ends without a `message_delta` with `stop_reason`
- **THEN** the translator SHALL handle this gracefully (emitting an error or partial response)

### Requirement: Non-streaming response translation SHALL have edge-case test coverage

Both `translateChatCompletionResponse` and `translateChatCompletionResponseToAnthropic` SHALL have test cases for edge-case inputs.

#### Scenario: Response with null content
- **WHEN** a chat completion response has `message.content: null`
- **THEN** `translateChatCompletionResponse` SHALL produce an empty output_text or function_call-only output
- **AND** `translateChatCompletionResponseToAnthropic` SHALL produce a response with no text block

#### Scenario: Response with empty string content
- **WHEN** a chat completion response has `message.content: ""`
- **THEN** `translateChatCompletionResponse` SHALL produce `output_text: ""`

#### Scenario: Response without usage field
- **WHEN** a chat completion response has no `usage` field
- **THEN** the translated response SHALL omit the `usage` field

#### Scenario: Uncommon finish_reason values
- **WHEN** a response has `finish_reason: "length"` or `finish_reason: "content_filter"`
- **THEN** `translateChatCompletionResponseToAnthropic` SHALL map these to the corresponding `stop_reason` values

### Requirement: Request translation SHALL have edge-case test coverage

Both `normalizeResponseInputToMessages` and `buildChatCompletionRequestFromAnthropic` SHALL have test cases for edge-case inputs.

#### Scenario: function_call_output items
- **WHEN** `normalizeResponseInputToMessages` receives an item with `type: "function_call_output"`
- **THEN** it SHALL produce a `{ role: "tool", tool_call_id, content }` message

#### Scenario: System prompts as text block arrays
- **WHEN** `buildChatCompletionRequestFromAnthropic` receives `system: [{ type: "text", text: "..." }]`
- **THEN** it SHALL prepend a `{ role: "system", content: "..." }` message

#### Scenario: tool_choice variants
- **WHEN** `buildChatCompletionRequestFromAnthropic` receives `tool_choice: "any"` or `tool_choice: { type: "tool", name: "fn" }`
- **THEN** it SHALL map these to the corresponding Chat Completions `tool_choice` values

#### Scenario: stop_sequences mapping
- **WHEN** `buildChatCompletionRequestFromAnthropic` receives `stop_sequences: ["END", "---"]`
- **THEN** it SHALL map these to `stop: ["END", "---"]` in the output

### Requirement: Copilot-proxy stream adapters SHALL have unit test coverage

The copilot-proxy stream adapter functions (`streamCopilotOpenAiChatCompletion`, `streamCopilotAnthropicMessage`, `streamCopilotResponses`) SHALL have unit tests using mock `AsyncIterable` sources.

#### Scenario: streamCopilotOpenAiChatCompletion produces correct SSE chunks
- **WHEN** a mock async iterable yields text content events, tool call events, and a stream_done event
- **THEN** the adapter SHALL yield correctly formatted `data: {...}\n\n` SSE chunks with the expected Chat Completions chunk structure

#### Scenario: streamCopilotAnthropicMessage produces correct SSE events
- **WHEN** a mock async iterable yields copilot-proxy events
- **THEN** the adapter SHALL yield Anthropic message stream events with correct event types and data

#### Scenario: streamCopilotResponses produces correct SSE events
- **WHEN** a mock async iterable yields copilot-proxy events
- **THEN** the adapter SHALL yield Responses API stream events with correct event types and data

#### Scenario: Stream error handled correctly
- **WHEN** a mock async iterable yields a `stream_error` event
- **THEN** the adapter SHALL propagate the error information in the appropriate output format
