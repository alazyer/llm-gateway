## Why

The gateway has three security vulnerabilities that expose upstream API keys and gateway resources to unauthorized or abusive access:

1. **Timing-vulnerable auth comparison** — `src/auth.ts` line 104 uses `providedToken !== gatewayAuthToken` (strict inequality), which leaks token information through response-time side channels. An attacker can systematically guess the token character-by-character by measuring comparison timing.

2. **No rate limiting** — Any client that passes auth (or all clients when auth is disabled) can make unlimited requests to upstream providers. There is no per-client or per-gateway rate limiting, exposing upstream API keys to cost overruns and abuse.

3. **Unbounded copilot-proxy token store** — `CopilotProxyTokenStore` in `src/copilot-proxy/auth.ts` stores issued tokens in an in-memory `Map` with no maximum size. A malicious client can call `POST /api/proxy-token` in a loop to exhaust memory, causing the gateway process to crash (denial of service).

## What Changes

- Replace the timing-vulnerable `!==` comparison in `src/auth.ts` with a constant-time comparison using Node.js `crypto.timingSafeEqual`.
- Add configurable per-IP rate limiting to all POST data endpoints when the gateway auth token is configured. Rate limiting is enforced via a Fastify plugin with sliding-window counters. When auth is disabled, rate limiting is also disabled (no way to identify clients).
- Add a configurable maximum token count to `CopilotProxyTokenStore`. When the maximum is reached, `issueToken()` returns a 429 error instead of issuing a new token. Pruning expired tokens happens before the cap check, so expired slots are always reclaimed first.

## Capabilities

### New Capabilities

- `gateway-auth-hardening`: Constant-time token comparison, per-IP rate limiting on data endpoints, and bounded token store for the copilot-proxy subsystem.

### Modified Capabilities

- `incoming-auth`: Auth comparison SHALL use constant-time equality instead of strict inequality.
- `chat-completions-client-api`: Requests SHALL be subject to per-IP rate limiting when auth is enabled.

## Impact

- **Code**: `src/auth.ts` (constant-time comparison), `src/copilot-proxy/auth.ts` (bounded token store), `src/app.ts` (rate limiting plugin registration), `src/config.ts` (new config fields)
- **APIs**: Auth-protected endpoints return 429 when rate limit is exceeded; `POST /api/proxy-token` returns 429 when token cap is reached
- **Dependencies**: No new dependencies (uses Node.js built-in `crypto.timingSafeEqual`)
- **Config**: New gateway YAML fields: `rate_limit_rpm` (requests per minute per IP, default 0 = disabled), `copilot_proxy_max_tokens` (max active proxy tokens, default 10000)
- **Tests**: Updated auth tests for constant-time path, new rate-limit tests, new token-cap tests
