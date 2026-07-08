## 1. Constant-Time Auth Comparison

- [ ] 1.1 Replace `providedToken !== gatewayAuthToken` in `src/auth.ts` with `crypto.timingSafeEqual` comparison, handling length mismatches by padding the shorter buffer to match the expected token length
- [ ] 1.2 Add unit tests: valid token accepted, invalid token rejected, tokens of different lengths handled safely, timing is not measurably correlated with prefix match length
- [ ] 1.3 Verify existing auth integration tests still pass

## 2. Rate Limiting

- [ ] 2.1 Add `rate_limit_rpm` field to the YAML schema in `src/config.ts` with Zod validation (non-negative integer, default 0)
- [ ] 2.2 Add `rateLimitRpm` to `AppConfig` interface in `src/config.ts`
- [ ] 2.3 Wire `rateLimitRpm` from YAML parsing into `AppConfig` in `loadYamlConfig()`
- [ ] 2.4 Implement `registerRateLimitHook()` in a new `src/rate-limit.ts` module: in-memory `Map<string, { count: number; windowStart: number }>`, sliding-window per-IP counting, returns 429 with `Retry-After` header when limit exceeded
- [ ] 2.5 Register the rate limit hook in `src/app.ts` after auth hook registration, only when both `gatewayAuthToken` is set and `rateLimitRpm > 0`
- [ ] 2.6 Log a warning on startup if `rateLimitRpm > 0` but auth is disabled
- [ ] 2.7 Add unit tests for the rate limit hook: under-limit pass, over-limit 429, sliding window reset, `Retry-After` header present
- [ ] 2.8 Add integration tests: rate-limited requests to `/responses`, `/v1/chat/completions`, `/v1/messages`, `/api/proxy-token`; GET endpoints not rate-limited

## 3. Bounded Token Store

- [ ] 3.1 Add `maxTokens` option to `CopilotProxyTokenStore` constructor options with default 10,000
- [ ] 3.2 Modify `issueToken()` to check cap after pruning; return `undefined` when at cap
- [ ] 3.3 Update `POST /api/proxy-token` handler in `src/app.ts` to handle `undefined` return with HTTP 429
- [ ] 3.4 Add `copilot_proxy_max_tokens` to the YAML schema in `src/config.ts` with Zod validation (positive integer, default 10000)
- [ ] 3.5 Wire `maxTokens` from YAML config through `CopilotProxyConfig` to the token store constructor
- [ ] 3.6 Add unit tests: issuance under cap succeeds, issuance at cap returns `undefined`, expired tokens pruned before cap check, default cap is 10,000
- [ ] 3.7 Add integration test: `/api/proxy-token` returns 429 when token cap reached

## 4. Documentation

- [ ] 4.1 Update `gateway.config.example.yaml` with `rate_limit_rpm` and `copilot_proxy_max_tokens` fields and comments
- [ ] 4.2 Update `README.md` security section with rate limiting and token cap documentation
