## Why

The gateway's streaming and translation code has significant test gaps that leave critical paths unverified:

1. **SSE stream translator edge cases** — The `ChatCompletionStreamTranslator` is tested for happy-path text and tool calls, but several error and boundary conditions lack coverage:
   - Incomplete SSE frames at stream end (the `flush()` path)
   - Upstream error payloads embedded in otherwise valid streams
   - Multiple tool calls interleaved with text content in a single stream
   - Identity-stability checks (mismatched `id`, `created`, or `model` mid-stream)
   - Empty `choices` arrays or missing `delta` objects

2. **Anthropic stream translator edge cases** — The `AnthropicMessageStreamTranslator` has similar gaps:
   - Tool-use block streaming with interleaved text and tool content
   - `stop_reason` mapping for less common values (`pause_turn`, `refusal`)
   - Error events mid-stream
   - Incomplete streams ending without a terminal event

3. **Non-streaming translation edge cases** — Both `translateChatCompletionResponse` and `translateChatCompletionResponseToAnthropic` lack coverage for:
   - Responses with `null` content (tool-call-only responses)
   - Responses with empty string content
   - Multiple choices
   - Missing `usage` field
   - `finish_reason` values beyond `stop` and `tool_calls`

4. **Request translation edge cases** — `normalizeResponseInputToMessages` and `buildChatCompletionRequestFromAnthropic` lack coverage for:
   - `function_call_output` items
   - System prompts as `AnthropicTextBlock[]` arrays
   - `tool_choice` variants: `"any"`, `"required"`, named function
   - `stop_sequences` mapping

5. **Copilot-proxy stream integration** — The copilot-proxy streaming paths (`streamCopilotOpenAiChatCompletion`, `streamCopilotAnthropicMessage`, `streamCopilotResponses`) have no unit tests — they are only exercised through expensive integration tests.

These gaps mean regressions in stream translation and edge-case handling can go undetected, especially as the codebase evolves.

## What Changes

- Add comprehensive unit tests for `ChatCompletionStreamTranslator` covering error paths, boundary conditions, tool calls, and identity checks.
- Add comprehensive unit tests for `AnthropicMessageStreamTranslator` covering tool-use streaming, stop reasons, and error events.
- Add edge-case tests for `translateChatCompletionResponse` and `translateChatCompletionResponseToAnthropic`.
- Add edge-case tests for `normalizeResponseInputToMessages` and `buildChatCompletionRequestFromAnthropic`.
- Add unit tests for copilot-proxy stream adapter functions using mock `AsyncIterable` sources.

## Capabilities

### New Capabilities

- `stream-translation-coverage`: Comprehensive test coverage for SSE stream translators, response translation, request translation, and copilot-proxy stream adapters.

### Modified Capabilities

None — this change adds tests only. No production code changes.

## Impact

- **Code**: Test files only (`tests/` directory). No production code changes.
- **APIs**: No API changes.
- **Dependencies**: No new dependencies.
- **Config**: No config changes.
- **Tests**: ~150 new test cases across existing and new test files.
