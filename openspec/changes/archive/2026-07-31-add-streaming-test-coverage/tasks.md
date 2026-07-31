## 1. ChatCompletionStreamTranslator edge cases

- [ ] 1.1 Test: incomplete SSE frame at stream end triggers `response.failed` via `flush()`
- [ ] 1.2 Test: upstream error payload in SSE chunk triggers `response.failed`
- [ ] 1.3 Test: multiple tool calls interleaved with text content produce correct event sequence
- [ ] 1.4 Test: identity field (`id`, `created`, `model`) change mid-stream triggers `response.failed`
- [ ] 1.5 Test: empty `choices` array triggers `response.failed`
- [ ] 1.6 Test: missing `delta` on non-terminal chunk triggers `response.failed`
- [ ] 1.7 Test: `data: [DONE]` before any chunks triggers `response.failed`
- [ ] 1.8 Test: malformed JSON in SSE data field triggers `response.failed`
- [ ] 1.9 Test: SSE frame missing data field triggers `response.failed`
- [ ] 1.10 Test: streaming tool calls with argument deltas produce correct `function_call_arguments.delta` events

## 2. AnthropicMessageStreamTranslator edge cases

- [ ] 2.1 Test: tool-use block streaming produces correct `content_block_start`/`delta`/`stop` events
- [ ] 2.2 Test: `stop_reason: "pause_turn"` maps correctly
- [ ] 2.3 Test: `stop_reason: "refusal"` maps correctly
- [ ] 2.4 Test: error event mid-stream propagates error information
- [ ] 2.5 Test: stream ends without terminal event handled gracefully

## 3. Non-streaming response translation edge cases

- [ ] 3.1 Test: `translateChatCompletionResponse` with `message.content: null` produces empty or function_call-only output
- [ ] 3.2 Test: `translateChatCompletionResponse` with `message.content: ""` produces empty `output_text`
- [ ] 3.3 Test: `translateChatCompletionResponse` without `usage` omits `usage` in output
- [ ] 3.4 Test: `translateChatCompletionResponseToAnthropic` with null content produces no text block
- [ ] 3.5 Test: `translateChatCompletionResponseToAnthropic` maps `finish_reason: "length"` to `stop_reason: "max_tokens"`
- [ ] 3.6 Test: `translateChatCompletionResponseToAnthropic` maps `finish_reason: "content_filter"` to appropriate `stop_reason`

## 4. Request translation edge cases

- [ ] 4.1 Test: `normalizeResponseInputToMessages` with `function_call_output` item produces tool message
- [ ] 4.2 Test: `buildChatCompletionRequestFromAnthropic` with system text block array prepends system message
- [ ] 4.3 Test: `buildChatCompletionRequestFromAnthropic` with `tool_choice: "any"` maps to `tool_choice: "required"`
- [ ] 4.4 Test: `buildChatCompletionRequestFromAnthropic` with `tool_choice: { type: "tool", name: "fn" }` maps correctly
- [ ] 4.5 Test: `buildChatCompletionRequestFromAnthropic` with `stop_sequences` maps to `stop`

## 5. Copilot-proxy stream adapter tests

- [ ] 5.1 Create `tests/copilot-proxy-stream-adapters.test.ts`
- [ ] 5.2 Test: `streamCopilotOpenAiChatCompletion` with text + tool call + stream_done events
- [ ] 5.3 Test: `streamCopilotAnthropicMessage` with text + tool call + stream_done events
- [ ] 5.4 Test: `streamCopilotResponses` with text + tool call + stream_done events
- [ ] 5.5 Test: `stream_error` event produces error in output format for each adapter
- [ ] 5.6 Test: adapter cancels handle when generator is abandoned early (abort signal)

## 6. Verify

- [ ] 6.1 Run `npm test` and confirm all new and existing tests pass
- [ ] 6.2 Verify no production code changes in the diff
