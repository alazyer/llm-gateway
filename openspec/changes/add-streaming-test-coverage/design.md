## Context

The llm-gateway translates between three API surfaces and an upstream Chat Completions transport. The translation layer (`src/translation/`) handles both streaming and non-streaming paths. Existing tests cover the main happy paths but miss numerous edge cases that have caused bugs in similar gateway projects.

## Goals / Non-Goals

**Goals:**
- Achieve >90% branch coverage on `ChatCompletionStreamTranslator` and `AnthropicMessageStreamTranslator`
- Cover all error paths in stream translation (malformed chunks, missing fields, upstream errors)
- Cover all edge cases in non-streaming response translation (null content, empty content, multiple choices)
- Cover all request translation edge cases (function_call_output, tool_choice variants, stop_sequences)
- Add unit-level tests for copilot-proxy stream adapters without requiring a running server

**Non-Goals:**
- Achieving 100% line coverage — some defensive code paths (e.g., `isRecord` checks on clearly-typed inputs) are not worth testing
- Adding integration/E2E tests — those are a separate concern
- Changing any production code to improve testability — the existing module boundaries are sufficient
- Testing the Fastify framework itself or the OpenAI SDK

## Decisions

### 1. Test file organization

**Decision**: Add tests to the existing test files where they fit, and create one new file for copilot-proxy stream adapter tests.

| Tests added to | Content |
|---|---|
| `tests/response-translation.test.ts` | Stream translator edge cases, non-streaming response edge cases |
| `tests/anthropic-translation.test.ts` | Anthropic stream translator edge cases, Anthropic response edge cases |
| `tests/request-translation.test.ts` | Request translation edge cases |
| `tests/anthropic-request-translation.test.ts` | Anthropic request translation edge cases |
| `tests/copilot-proxy-stream-adapters.test.ts` (new) | Unit tests for copilot-proxy stream adapter functions |

**Rationale**: Keeping related tests together reduces file count and makes it easy to find tests for a module. The copilot-proxy adapters don't have an existing test file, so a new one is warranted.

**Alternative considered**: One test file per source module. Rejected — would create too many small files and duplicate the `parseSseEvent` helper across all of them.

### 2. SSE frame construction helper

**Decision**: Create a shared `makeSseChunk` helper in each test file that constructs well-formed SSE frames from a JS object, rather than manually stringifying JSON.

**Rationale**: Most existing tests already have a `parseSseEvent` helper. The inverse (`makeSseChunk`) makes test data readable and ensures correctly-formatted SSE frames. It's a small utility, not worth extracting to a shared test helper module.

### 3. Mock AsyncIterable for copilot-proxy tests

**Decision**: Use async generator functions as mock `AsyncIterable<CopilotProxyStreamMessage>` sources for copilot-proxy stream adapter tests.

**Rationale**: Async generators are the simplest way to produce an `AsyncIterable` in tests. They support `for await...of` natively and can simulate delays, errors, and early termination. No mocking library needed.

**Alternative considered**: Use a mocking library like `vitest`'s `vi.fn()` to create mock iterables. Rejected — async generators are more readable and don't require understanding mock framework internals.

### 4. Test copilot-proxy adapters via their public async generator interface

**Decision**: Test `streamCopilotOpenAiChatCompletion`, `streamCopilotAnthropicMessage`, and `streamCopilotResponses` by consuming their `AsyncGenerator<string>` output directly, rather than through an HTTP client.

**Rationale**: These functions are already async generators that yield SSE strings. Testing them at the generator level is fast, isolated, and doesn't require starting a Fastify server. The existing server tests already cover the HTTP integration.

### 5. No production code changes

**Decision**: Do not modify any production code to expose internals or improve testability.

**Rationale**: All target functions and classes are already exported. The stream translators are stateful classes with a public `push()`/`flush()` API. The copilot-proxy adapters are async generators. No internal access needed.

## Risks / Trade-offs

- **Test-only change**: No risk to production code. The only risk is test bugs (false positives or false negatives), which are caught by code review.
- **Copilot-proxy adapter tests may be brittle**: The adapters depend on `CopilotProxyStreamMessage` type shapes. If the protocol changes, these tests will need updating. This is acceptable — the tests serve as documentation of the expected protocol behavior.
- **Coverage target is approximate**: ">90% branch coverage" is a guideline, not a hard gate. Some branches may be intentionally uncovered (e.g., defensive `isRecord` checks on typed inputs).
