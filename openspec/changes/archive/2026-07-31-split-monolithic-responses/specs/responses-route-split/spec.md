# responses-route-split Specification

## Purpose
Decomposition of the monolithic `src/routes/responses.ts` into focused, single-responsibility modules. This is a pure structural refactor — no behavior, API, or logic changes.

## Requirements

### Requirement: responses.ts SHALL be a thin route registration module

The `src/routes/responses.ts` file SHALL contain only the Fastify plugin registration, route handler definitions, and minimal handler logic that delegates to extracted modules. It SHALL NOT contain request parsing, model metadata construction, error formatting, or stream adaptation logic directly.

#### Scenario: responses.ts imports from extracted modules
- **WHEN** `src/routes/responses.ts` is inspected
- **THEN** it SHALL import request parsers from `./request-parsers.js`, error senders from `./error-senders.js`, model record functions from `./model-records.js`, copilot-proxy helpers from `./copilot-proxy-adapter.js`, and stream helpers from `./stream-helpers.js`

#### Scenario: responses.ts re-exports public symbols
- **WHEN** a consumer imports a symbol (e.g., `RouteError`, `parseResponseRequest`) from `../routes/responses.js`
- **THEN** the import SHALL resolve to the same symbol that is now defined in the extracted module

### Requirement: Copilot-proxy integration SHALL be isolated in a dedicated module

All copilot-proxy model resolution, usage mapping, request construction, stream collection, and stream generation functions SHALL be extracted to `src/routes/copilot-proxy-adapter.ts`.

#### Scenario: copilot-proxy-adapter exports copilot-specific functions
- **WHEN** `src/routes/copilot-proxy-adapter.ts` is inspected
- **THEN** it SHALL export at minimum: `isCopilotModelName`, `resolveCopilotModel`, `mapCopilotUsage`, `buildCopilotRequest`, `collectCopilotChatCompletion`, `streamCopilotOpenAiChatCompletion`, `streamCopilotAnthropicMessage`, `streamCopilotResponses`

#### Scenario: copilot-proxy functions produce identical behavior
- **WHEN** the extracted copilot-proxy functions are called
- **THEN** they SHALL produce identical results to the original inline functions in `responses.ts`

### Requirement: Model metadata construction SHALL be isolated in a dedicated module

All model record types (`ModelRecord`, `AnthropicModelRecord`) and their creation/listing functions SHALL be extracted to `src/routes/model-records.ts`.

#### Scenario: model-records exports metadata functions
- **WHEN** `src/routes/model-records.ts` is inspected
- **THEN** it SHALL export at minimum: `createModelRecord`, `createCopilotModelRecord`, `createModelsList`, `createAnthropicModelRecord`, `createCopilotAnthropicModelRecord`, `createAnthropicModelsList`

#### Scenario: model metadata output is unchanged
- **WHEN** the extracted model record functions are called with the same inputs
- **THEN** they SHALL return identical objects to the original inline functions

### Requirement: Request parsing SHALL be isolated in a dedicated module

All request parsing functions and validation predicates SHALL be extracted to `src/routes/request-parsers.ts`.

#### Scenario: request-parsers exports parsing functions
- **WHEN** `src/routes/request-parsers.ts` is inspected
- **THEN** it SHALL export at minimum: `parseResponseRequest`, `parseAnthropicMessagesRequest`, `parseChatCompletionsRequest`, and any validation predicates they depend on

#### Scenario: parsed request output is unchanged
- **WHEN** the extracted parse functions are called with the same inputs
- **THEN** they SHALL return identical results to the original inline functions, including throwing the same errors for invalid input

### Requirement: Error handling SHALL be isolated in a dedicated module

The `RouteError` class and all three error sender functions (`sendError`, `sendAnthropicError`, `sendOpenAiError`) SHALL be extracted to `src/routes/error-senders.ts`.

#### Scenario: error-senders exports error types and functions
- **WHEN** `src/routes/error-senders.ts` is inspected
- **THEN** it SHALL export `RouteError`, `sendError`, `sendAnthropicError`, and `sendOpenAiError`

#### Scenario: error responses are unchanged
- **WHEN** the extracted error functions are called with the same error objects
- **THEN** they SHALL produce identical HTTP responses (status code, headers, body) to the original inline functions

### Requirement: Stream adaptation SHALL be isolated in a dedicated module

Stream translation generators and stream utility functions SHALL be extracted to `src/routes/stream-helpers.ts`.

#### Scenario: stream-helpers exports stream utilities
- **WHEN** `src/routes/stream-helpers.ts` is inspected
- **THEN** it SHALL export at minimum: `translateStream`, `translateAnthropicStream`, `readableStreamToAsyncIterable`, `createDisconnectAbortSignal`

#### Scenario: stream output is unchanged
- **WHEN** the extracted stream functions are called with the same inputs
- **THEN** they SHALL produce identical SSE event sequences to the original inline functions

### Requirement: All existing tests SHALL pass without modification

The extraction SHALL be behavior-preserving. All existing integration and unit tests SHALL pass with only import path updates.

#### Scenario: test suite passes after extraction
- **WHEN** `npm test` is run after the extraction
- **THEN** all tests SHALL pass with the same results as before the extraction
