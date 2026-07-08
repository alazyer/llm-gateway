## Why

`src/routes/responses.ts` contains three nearly identical error sender functions — `sendError`, `sendAnthropicError`, and `sendOpenAiError` — that share the same structure but differ only in their output error format. This creates several problems:

1. **Duplicated logic** — All three functions follow the same pattern: reset content-type to JSON, check for `UpstreamHttpError`, check for `RouteError`, then fall through to a generic 500. The only difference is the error body shape (gateway-style, Anthropic-style, or OpenAI-style).

2. **Inconsistent behavior risk** — If a bug is fixed in one error sender (e.g., adding a new error category), the other two must be manually updated. Missing an update creates inconsistent behavior across API surfaces.

3. **Maintenance burden** — The three functions total ~85 lines of near-duplicate code. Any change to error handling (e.g., adding request ID to error responses, or a new error category) must be applied three times.

4. **Shared validation predicates** — Functions like `responseRequestUsesTools`, `anthropicRequestUsesTools`, and `chatCompletionsRequestUsesTools` all implement the same "does this request use tools?" logic with only minor type differences. These should be consolidated.

## What Changes

- Unify the three error sender functions into a single parameterized `sendRouteError` function that takes an `errorFormat: "gateway" | "anthropic" | "openai"` parameter.
- Consolidate the three `*RequestUsesTools` predicates into a single `requestUsesTools` function that works with any parsed request type.
- Move `RouteError` and the unified `sendRouteError` to `src/routes/error-senders.ts` (this aligns with the `split-monolithic-responses` change; if that change is implemented first, this change modifies the already-extracted module).

## Capabilities

### New Capabilities

- `unified-error-handling`: A single parameterized error sender and a single tools-detection predicate, replacing three duplicated copies of each.

### Modified Capabilities

- `responses-chatcompletions-translation-bridge`: Error formatting behavior is identical; implementation uses unified function.
- `anthropic-chatcompletions-translation-bridge`: Same as above.
- `openai-chat-completions-transport`: Same as above.
- `incoming-auth`: Error sender module location changes; behavior unchanged.

## Impact

- **Code**: `src/routes/responses.ts` (or `src/routes/error-senders.ts` if split change applied first) — reduce ~85 lines of duplicate error handling to ~40 lines. Reduce 3 tools predicates to 1.
- **APIs**: No API changes. Error response bodies remain identical for each format.
- **Dependencies**: No new dependencies.
- **Config**: No config changes.
- **Tests**: Existing error-handling tests pass unchanged. New unit tests for the unified function verify all three formats produce correct output.
