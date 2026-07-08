## Context

The `src/routes/responses.ts` file handles three distinct API surfaces — `/responses` (OpenAI Responses API), `/v1/chat/completions` (OpenAI Chat Completions), and `/v1/messages` (Anthropic Messages API) — along with their shared copilot-proxy integration, model metadata, request parsing, stream translation, and error handling. At 2,057 lines, it is by far the largest file in the project.

The file has a natural internal structure: the first ~1,200 lines define helper functions and types, and the last ~800 lines are the Fastify plugin that registers routes and handlers. Each handler follows the same pattern: parse request → resolve model (copilot or upstream) → validate capabilities → forward request → translate response.

## Goals / Non-Goals

**Goals:**
- Split the monolith into focused modules with clear single responsibilities
- Preserve all existing behavior — this is a pure refactor
- Enable parallel implementation of future changes by providing clear file ownership
- Make individual concerns unit-testable in isolation
- Keep the split stable — extracted modules should have stable boundaries that don't need further subdivision

**Non-Goals:**
- Changing any API behavior, error messages, or response formats
- Changing the directory structure beyond `src/routes/`
- Introducing dependency injection or inversion-of-control patterns
- Merging the three API surfaces into a single generic handler — they have enough differences to justify separate paths
- Reorganizing `src/translation/` or `src/copilot-proxy/` — those modules already have clean boundaries

## Decisions

### 1. Six-module split

**Decision**: Extract five modules from `responses.ts`, leaving it as a thin orchestrator:

| Module | Responsibility | Approximate lines |
|--------|---------------|-------------------|
| `src/routes/responses.ts` | Route registration + thin handler functions | ~200 |
| `src/routes/copilot-proxy-adapter.ts` | Copilot model resolution, usage mapping, request construction, stream collection/generation | ~350 |
| `src/routes/model-records.ts` | ModelRecord/AnthropicModelRecord types, create functions, list functions | ~150 |
| `src/routes/request-parsers.ts` | Parse functions (parseResponseRequest, parseAnthropicMessagesRequest, parseChatCompletionsRequest), validation predicates | ~300 |
| `src/routes/error-senders.ts` | RouteError class, sendError, sendAnthropicError, sendOpenAiError | ~150 |
| `src/routes/stream-helpers.ts` | translateStream, translateAnthropicStream, readableStreamToAsyncIterable, createDisconnectAbortSignal | ~100 |

**Rationale**: Each module maps to a single concern. The line counts are estimates; the key principle is that each module answers one question ("how do we parse requests?", "how do we format errors?", etc.).

**Alternative considered**: Split by API surface (responses-handler.ts, chat-completions-handler.ts, anthropic-handler.ts) with shared utilities. Rejected — the three handlers share too much copilot-proxy and model-resolution logic, which would require cross-handler imports and create a different kind of coupling.

### 2. Re-export from responses.ts for backward compatibility

**Decision**: `responses.ts` re-exports all public symbols from the extracted modules.

**Rationale**: Existing test files import from `../routes/responses.js` or via the app. Re-exports ensure zero breakage during the transition. The re-exports can be removed in a later cleanup once all consumers update their imports.

**Alternative considered**: Update all imports immediately. Rejected — it mixes the refactoring commit with import changes, making the diff noisy and harder to review.

### 3. Keep copilot-proxy adapter in src/routes/

**Decision**: The copilot-proxy adapter module lives in `src/routes/` rather than `src/copilot-proxy/`.

**Rationale**: The adapter is route-level logic (mapping between HTTP request/response and copilot-proxy domain objects). The existing `src/copilot-proxy/` modules handle the WebSocket protocol and connection lifecycle — a different concern. Keeping the adapter in `src/routes/` maintains the existing separation.

### 4. RouteError stays internal to routes

**Decision**: `RouteError` is exported from `error-senders.ts` but not from `src/shared.ts`.

**Rationale**: `RouteError` is specific to HTTP response handling. Other modules that throw errors (e.g., translation functions) use plain `Error`. Only route handlers need `RouteError`, so it belongs in the routes layer.

### 5. No changes to src/translation/ or src/copilot-proxy/

**Decision**: The existing `src/translation/` and `src/copilot-proxy/` modules are not affected by this split.

**Rationale**: They already have clean boundaries. The monolith problem is entirely within `src/routes/responses.ts`.

## Risks / Trade-offs

- **Pure refactor risk**: Any bug introduced during extraction breaks existing functionality. Mitigated by running the full test suite before and after, and by making the change a single focused commit with no logic modifications.
- **Re-exports create two import paths**: During the transition, consumers can import from either `responses.ts` or the new modules. This is temporary — the re-exports are explicitly marked for future removal.
- **Module count increase**: Going from 1 file to 6 increases the number of files to navigate. This is a net positive — each file is focused and quick to understand — but it changes the mental model of the routes layer.
- **Circular dependency risk**: If `copilot-proxy-adapter.ts` needs `error-senders.ts` and vice versa, we have a cycle. The design avoids this by keeping `error-senders.ts` as a leaf module with no imports from other route modules.

## File Ownership Map

This map ensures parallel implementation of other changes won't conflict:

| File | Owned by change |
|------|----------------|
| `src/routes/responses.ts` | This change (thin orchestrator) |
| `src/routes/copilot-proxy-adapter.ts` | This change (new) |
| `src/routes/model-records.ts` | This change (new) |
| `src/routes/request-parsers.ts` | This change (new) |
| `src/routes/error-senders.ts` | This change (new) |
| `src/routes/stream-helpers.ts` | This change (new) |
