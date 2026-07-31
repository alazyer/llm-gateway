## Why

`src/routes/responses.ts` is a 2,057-line monolithic file that contains all three API surface handlers (Responses, Chat Completions, Anthropic Messages), their shared copilot-proxy integration, request parsing, model metadata construction, stream translation, and error handling. This creates several problems:

1. **Cognitive overload** — Any change requires understanding the entire file. The three handler paths share copilot-proxy logic, model resolution, and error handling, making it hard to reason about one API surface in isolation.

2. **Merge conflicts** — Changes to different API surfaces (e.g., adding a Chat Completions feature and fixing an Anthropic bug) modify the same file, creating unnecessary merge conflicts during parallel development.

3. **Poor discoverability** — Functions like `sendError`, `parseResponseRequest`, and `createModelRecord` are buried in a massive file, making them hard to find and reuse.

4. **Testing friction** — Unit-testing individual concerns (e.g., request parsing, model record creation) requires importing from the monolith, which pulls in everything.

## What Changes

- Extract copilot-proxy integration (model resolution, usage mapping, stream collection/generation) into `src/routes/copilot-proxy-adapter.ts`.
- Extract model metadata types and construction into `src/routes/model-records.ts`.
- Extract request parsing and validation predicates into `src/routes/request-parsers.ts`.
- Extract `RouteError` class and the three error sender functions into `src/routes/error-senders.ts`.
- Extract stream adaptation utilities into `src/routes/stream-helpers.ts`.
- Reduce `src/routes/responses.ts` to thin route registration with handler functions that delegate to extracted modules.

## Capabilities

### New Capabilities

- `responses-route-split`: Decomposition of the monolithic responses route into focused, single-responsibility modules with clear file ownership boundaries.

### Modified Capabilities

- `responses-chatcompletions-translation-bridge`: Translation logic moves from `responses.ts` to `request-parsers.ts` and `stream-helpers.ts` — behavior unchanged.
- `anthropic-chatcompletions-translation-bridge`: Same as above.
- `openai-chat-completions-transport`: Same as above.
- `incoming-auth`: Error sender functions move to `error-senders.ts` — behavior unchanged.
- `shared-utilities`: Stream helpers (`formatSseEvent`, `extractDataFrame`) remain in `src/shared.ts`; new stream utilities (`readableStreamToAsyncIterable`, `createDisconnectAbortSignal`) move to `stream-helpers.ts`.

## Impact

- **Code**: 6 files changed/created in `src/routes/`. No logic changes — pure extraction and re-export.
- **APIs**: No API changes. All routes, request/response shapes, and error formats remain identical.
- **Dependencies**: No new dependencies.
- **Config**: No config changes.
- **Tests**: Existing tests pass unchanged (imports update only). New unit tests can target extracted modules directly.
