## 1. Shared Utilities Deduplication

- [ ] 1.1 Create `src/shared.ts` with `isRecord`, `expectString`, `expectNumber`, `expectBoolean`, `toErrorMessage`, `formatSseEvent`, `extractDataFrame` — identical implementations to the current inline versions
- [ ] 1.2 Update `src/translation/request.ts` — remove local `isRecord`, `expectString`, `expectNumber`, `expectBoolean`; import from `shared.ts`
- [ ] 1.3 Update `src/translation/response.ts` — remove local `isRecord`, `expectString`, `expectNumber`, `expectBoolean`, `toErrorMessage`; import from `shared.ts`
- [ ] 1.4 Update `src/translation/stream.ts` — remove local `isRecord`, `expectString`, `expectNumber`, `formatSseEvent`, `extractDataFrame`; import from `shared.ts`
- [ ] 1.5 Update `src/translation/anthropic/request.ts` — remove local `isRecord`, `expectString`, `expectNumber`, `expectBoolean`; import from `shared.ts`
- [ ] 1.6 Update `src/translation/anthropic/response.ts` — remove local `isRecord`, `expectString`, `expectNumber`; import from `shared.ts`
- [ ] 1.7 Update `src/translation/anthropic/stream.ts` — remove local `isRecord`, `expectString`, `expectNumber`, `formatSseEvent`, `extractDataFrame`; import from `shared.ts`
- [ ] 1.8 Update `src/routes/responses.ts` — remove local `isRecord`, `toErrorMessage`; import from `shared.ts`
- [ ] 1.9 Run `npm test` and verify all 98 existing tests still pass unchanged

## 2. Upstream Resilience (Timeouts + Retries)

- [ ] 2.1 Add timeout/retry config fields to `gateway.config.example.yaml` and Zod schema in `src/config.ts`: `request_timeout_ms` (default 30000), `max_retries` (default 0), `retry_backoff_base_ms` (default 500)
- [ ] 2.2 Update `ChatCompletionsClient` constructor to accept and pass `timeout` to OpenAI SDK client via `timeout` option
- [ ] 2.3 Add retry logic to `ChatCompletionsClient.createCompletion()` — wrap call with retry loop for 429/502/503, exponential backoff, `max_retries` cap
- [ ] 2.4 Add retry logic to `ChatCompletionsClient.createCompletionStream()` — retry on 429/502/503 for the initial stream creation (before data starts flowing); once stream begins, no retry
- [ ] 2.5 Pass `request_timeout_ms` from config through `AppConfig` → route options → `getClient()` → `ChatCompletionsClient` options
- [ ] 2.6 Add tests for timeout behavior (mock slow upstream, verify 504 response)
- [ ] 2.7 Add tests for retry behavior (mock 429 then 200, mock 502 then 200, mock all retries exhausted)

## 3. Client Disconnect Stream Cleanup

- [ ] 3.1 In `responsesHandler` stream path — listen for `request.raw` `close` event; on close, cancel the upstream `ReadableStream` reader
- [ ] 3.2 In `anthropicMessagesHandler` stream path — same client disconnect detection and upstream cleanup
- [ ] 3.3 In `chatCompletionsHandler` stream path — same client disconnect detection and upstream cleanup
- [ ] 3.4 Add tests for client disconnect during streaming (mock mid-stream disconnect, verify upstream reader is cancelled)

## 4. Request Guardrails (Body Size + Counter Bounds)

- [ ] 4.1 Add `max_body_size_kb` config field to Zod schema in `src/config.ts` (default 1024); add to `AppConfig` interface
- [ ] 4.2 Update `createApp()` in `src/app.ts` to set Fastify `bodyLimit` option from config (convert KB to bytes)
- [ ] 4.3 Add `unknown_field_window_requests` config field to per-model Zod schema (default 1000); add to `GatewayModelConfig`
- [ ] 4.4 In `responses.ts` — add request counter per model; when counter reaches `unknown_field_window_requests`, reset `unknownFieldCounters` for that model
- [ ] 4.5 Add tests for body size limit (send oversized payload, verify 413 response)
- [ ] 4.6 Add tests for counter window reset (send many requests, verify counter resets at threshold)

## 5. Request Tracing (ID Propagation + Latency Logging)

- [ ] 5.1 Update `ChatCompletionsClient` methods to accept optional `requestId` parameter; pass as `X-Request-ID` header via SDK `requestOptions.headers`
- [ ] 5.2 Update `ChatCompletionsClient` constructor to accept `defaultHeaders` option for pre-configured headers
- [ ] 5.3 In `responsesHandler`, `anthropicMessagesHandler`, `chatCompletionsHandler` — pass `request.id` to `getClient()` → client method calls as `requestId`
- [ ] 5.4 Add upstream latency logging in each handler — measure `startTime` before upstream call, log `durationMs` after response/stream start, include `requestId`, `model`, `durationMs`
- [ ] 5.5 Add tests for `X-Request-ID` header propagation (verify header is set on upstream mock calls)
- [ ] 5.6 Add tests for latency logging (verify log output contains `durationMs` field)

## 6. Final Validation

- [ ] 6.1 Run full test suite (`npm test`) and verify all tests pass
- [ ] 6.2 Run `npm run build` and verify TypeScript compilation succeeds
- [ ] 6.3 Validate openspec change: `openspec validate robustness-hardening`
- [ ] 6.4 Update `gateway.config.example.yaml` with all new config fields and their defaults
