## Why

The llm-gateway is a functional translation proxy but has several robustness gaps that would cause production failures under real-world conditions: upstream calls have no timeouts or retries (a hung provider blocks the request forever), streaming connections aren't cleaned up when clients disconnect, utility validation functions are duplicated across 6 files making maintenance error-prone, request IDs aren't propagated upstream for distributed tracing, and the in-memory unknown-field counter grows unboundedly. These gaps make the gateway fragile under partial failure, slow upstreams, and sustained load.

## What Changes

- Add configurable timeouts and retry logic to the upstream Chat Completions client so requests don't hang indefinitely and transient failures are handled gracefully.
- Add Fastify request body size limits to prevent oversized payloads from exhausting memory.
- Ensure streaming responses are cleaned up when clients disconnect mid-stream (abort upstream reads, release resources).
- Deduplicate shared utility functions (`isRecord`, `expectString`, `expectNumber`, `expectBoolean`, `toErrorMessage`, `formatSseEvent`, `extractDataFrame`) into a single `src/shared.ts` module, eliminating 6 copies across the codebase.
- Propagate gateway request IDs to upstream as `X-Request-ID` headers for end-to-end tracing.
- Bound the `unknownFieldCounters` Map with per-model reset/expiration to prevent unbounded memory growth under sustained load.
- Add a Fastify `onResponse` hook to log upstream latency per request for observability.

## Capabilities

### New Capabilities
- `upstream-resilience`: Configurable timeouts, retry with backoff, and stream abort on client disconnect for the upstream Chat Completions transport.
- `request-guardrails`: Request body size limits and unbounded-memory protections (unknown-field counter expiry, client disconnect cleanup).
- `shared-utilities`: Centralized validation and formatting utilities replacing 6 duplicated copies across translation and stream modules.
- `request-tracing`: Gateway request ID propagation to upstream via `X-Request-ID` header and upstream latency logging.

### Modified Capabilities
- `openai-chat-completions-transport`: Timeout and retry configuration on the SDK-backed transport; request ID header injection.
- `responses-chatcompletions-translation-bridge`: Uses shared utilities instead of inline copies; unknown-field counter bounded.

## Impact

- **Code**: `src/upstream/chat-completions-client.ts`, `src/routes/responses.ts`, `src/translation/request.ts`, `src/translation/response.ts`, `src/translation/stream.ts`, `src/translation/anthropic/request.ts`, `src/translation/anthropic/response.ts`, `src/translation/anthropic/stream.ts`, new `src/shared.ts`, new `src/app.ts` body limit config
- **APIs**: No client-facing API changes; all changes are internal resilience and observability improvements
- **Dependencies**: No new dependencies; uses existing Fastify and OpenAI SDK capabilities
- **Config**: New optional fields in gateway YAML: `request_timeout_ms`, `max_retries`, `retry_backoff_ms`, `max_body_size_kb`; new env vars optional
- **Tests**: Existing 98 tests continue to pass; new tests for timeout/retry/guardrails/tracing
