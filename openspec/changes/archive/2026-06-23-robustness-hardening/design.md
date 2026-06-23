## Context

The llm-gateway is a Fastify-based translation proxy that accepts `/v1/responses`, `/v1/chat/completions`, and `/v1/messages` requests, translates them to OpenAI Chat Completions format, and dispatches upstream via the OpenAI SDK. The current codebase has good input validation and Zod-based config parsing, but lacks resilience under real-world production conditions: no timeouts, no retries, duplicated utilities, unbounded counters, and no distributed tracing support.

## Goals / Non-Goals

**Goals:**
- Make the gateway resilient to slow/hung upstream providers via timeouts and retries
- Prevent resource exhaustion from oversized requests and unbounded counters
- Reduce maintenance risk by deduplicating utility functions
- Enable end-to-end request tracing and latency observability
- Ensure existing 98 tests continue to pass unchanged

**Non-Goals:**
- Adding `/v1/responses` features that aren't currently supported (e.g., `previous_response_id`, `text.format` structured output, built-in tools like `web_search`) — those are separate changes
- Adding rate limiting or authentication — out of scope for this change
- Changing the client-facing API contract — all changes are internal
- Adding CORS headers — separate change if needed
- Adding OpenAPI spec / response schema validation — separate change

## Decisions

1. **Upstream timeouts via OpenAI SDK `timeout` option** — The OpenAI SDK (`openai` npm package) supports a `timeout` option on the client constructor. We'll use this rather than wrapping every call in `AbortController` + `setTimeout`, since the SDK handles it internally. For streaming, we'll also set a `maxDuration` option to limit total stream time.

2. **Retry via wrapper in `ChatCompletionsClient`** — The OpenAI SDK has built-in retry logic (default 2 retries on 429), but we need explicit control. We'll add a configurable retry wrapper in `ChatCompletionsClient` that only retries on 429, 502, 503 with exponential backoff. This is a thin layer over the SDK's error handling.

3. **Client disconnect via Fastify `request.raw` abort signal** — Fastify provides `request.raw` (the Node.js IncomingMessage). We'll listen for `close` events on `request.raw` during streaming to detect client disconnect and abort the upstream `ReadableStream` reader via `reader.cancel()`.

4. **Shared utilities in `src/shared.ts`** — A single module exporting `isRecord`, `expectString`, `expectNumber`, `expectBoolean`, `toErrorMessage`, `formatSseEvent`, `extractDataFrame`. Each consuming module replaces its local definitions with imports. No behavior changes — identical signatures and implementations.

5. **Request body size via Fastify `bodyLimit` option** — Fastify supports a global `bodyLimit` option (in bytes) on the server instance. We'll set this in `createApp()` based on config. Default 1MB (1048576 bytes).

6. **Unknown-field counter bounding via reset-on-access pattern** — Instead of a TTL-based map (which would need a timer), we'll reset each model's counter when the `unknown_field_mode` transitions from `warn` to `enforce` check. Additionally, we'll add a configurable `unknown_field_window_requests` count: after N requests have been processed for a model (regardless of whether they had unknown fields), the counter resets. This bounds the counter's lifetime without requiring timers.

7. **Request ID propagation via OpenAI SDK `defaultHeaders`** — The OpenAI SDK supports `defaultHeaders` on the client constructor. We'll inject `X-Request-ID` as a default header when creating per-request clients. Since the gateway uses a client cache keyed by `baseUrl::apiKey`, we'll instead pass the request ID per-call using the SDK's `requestOptions.headers` parameter on each `create()` call.

8. **Latency logging via timing in route handlers** — We'll wrap the upstream dispatch calls with `Date.now()` measurements (passed via args, not `Date.now()` in implementation — the caller provides timestamps). Log on completion with `requestId`, `model`, `durationMs`.

## Risks / Trade-offs

- **Retry adds latency on transient failures**: A retry on 502/503 with backoff means the client waits longer. This is acceptable because the alternative is a hard failure. Default is 0 retries, so it's opt-in.
- **Timeout kills long-running completions**: If a legitimate complex prompt takes >30s, it will be cut off. The timeout is configurable, so operators can adjust. 30s default is conservative for typical chat use.
- **Client abort signal may not fire on all Fastify versions**: The `request.raw.close` event behavior is well-documented in Node.js HTTP, but Fastify's integration should be tested.
- **Shared utility refactor is purely mechanical**: The risk is minimal since the functions are identical across files, but a mistake in import resolution could cause runtime errors. Full test suite coverage mitigates this.
