## Context

The llm-gateway is a Fastify-based proxy that translates between three client-facing API surfaces and upstream Chat Completions providers. It already supports optional incoming auth via `gateway_auth_token_env` (implemented in the `gateway-security-health` archived change). The copilot-proxy subsystem adds WebSocket-based model registration and a token-authenticated proxy endpoint.

Three security weaknesses remain:

1. The auth comparison in `registerAuthHook` uses `!==`, which is vulnerable to timing attacks.
2. There is no rate limiting — a single authenticated client can flood upstream providers.
3. The `CopilotProxyTokenStore` grows without bound, allowing memory exhaustion via repeated token issuance.

## Goals / Non-Goals

**Goals:**
- Eliminate timing side channel in auth token validation
- Prevent per-client request flooding of upstream providers
- Prevent memory exhaustion via unbounded token store
- Maintain backward compatibility — rate limiting is opt-in (disabled by default)
- Maintain backward compatibility — token cap has a generous default

**Non-Goals:**
- Implementing user-level or multi-tenant auth — single gateway token remains the auth model
- Rate limiting when auth is disabled — without auth there is no reliable client identity
- Encrypting tokens at rest — they are in-memory only and already hashed
- Implementing a distributed rate limiter — single-process in-memory is sufficient for now
- Changing the copilot-proxy WebSocket protocol or authentication flow

## Decisions

### 1. Use `crypto.timingSafeEqual` for auth comparison

**Decision**: Replace `providedToken !== gatewayAuthToken` with a constant-time comparison using Node.js `crypto.timingSafeEqual`.

**Rationale**: `timingSafeEqual` is the standard Node.js API for comparing secrets without leaking timing information. It requires equal-length `Buffer` inputs, so we pad shorter inputs to the length of the expected token.

**Alternative considered**: Use a third-party library like `bcrypt` for token hashing. Rejected — the gateway token is a shared secret, not a password hash. Adding a hashing round trip would change the auth model and slow down every request. Constant-time comparison achieves the same security goal without changing the auth contract.

### 2. Per-IP sliding-window rate limiting

**Decision**: Implement per-IP rate limiting using an in-memory sliding-window counter, enforced as a Fastify `onRequest` hook registered after the auth hook. The limit is configured as `rate_limit_rpm` (requests per minute per client IP). Default is 0 (disabled).

**Rationale**: Per-IP limiting is the simplest effective rate limiting strategy. A sliding window avoids the burst-at-boundary problem of fixed windows. In-memory counters are sufficient for a single-process gateway. The hook is registered after auth so that unauthenticated requests are rejected before consuming rate-limit budget.

**Alternative considered**: Use `@fastify/rate-limit` plugin. Rejected — it adds a dependency and its configuration surface is larger than needed. A custom hook with a `Map<ip, count>` is ~30 lines and fully under our control.

**Alternative considered**: Per-token rate limiting instead of per-IP. Rejected — multiple clients behind a NAT share an IP but use different tokens; per-token would be fairer but requires auth to always be enabled. Per-IP is the baseline; per-token can be added later.

### 3. Rate limiting only when auth is enabled

**Decision**: Rate limiting is only registered when `gateway_auth_token_env` is configured. When auth is disabled, rate limiting is also disabled.

**Rationale**: Without auth, there is no reliable way to identify clients — `X-Forwarded-For` headers are trivially spoofed. Rate limiting by raw IP without auth gives a false sense of security. The right fix for unauthenticated gateways is to enable auth.

### 4. Bounded CopilotProxyTokenStore

**Decision**: Add `maxTokens` option to `CopilotProxyTokenStore` with a default of 10,000. When `issueToken()` is called and the store is at capacity (after pruning expired tokens), return `undefined` instead of a token. The caller (`POST /api/proxy-token`) responds with HTTP 429.

**Rationale**: 10,000 active tokens is generous for legitimate use (one token per VS Code window, typically < 100). The cap prevents unbounded memory growth from malicious or buggy clients. Pruning expired tokens first ensures that expired slots are always reclaimed before the cap is hit.

**Alternative considered**: Use an LRU eviction policy. Rejected — tokens have explicit TTLs, so expiry-based pruning is semantically correct. LRU would evict valid tokens, which breaks active WebSocket connections.

### 5. Rate limit applies to all POST data endpoints

**Decision**: The rate limit hook applies to `POST /responses`, `POST /v1/responses`, `POST /v1/chat/completions`, `POST /v1/messages`, `POST /v1/messages/count_tokens`, and `POST /api/proxy-token`. It does NOT apply to `GET /healthz`, `GET /models`, `GET /v1/models`, or `GET /models/:model`.

**Rationale**: GET endpoints are read-only metadata that don't consume upstream resources. POST endpoints forward to upstream providers and cost money. The proxy-token endpoint is a lightweight token issuer but needs limiting to prevent the DoS vector described above.

## Risks / Trade-offs

- **Rate limiting is per-IP, not per-user**: Clients behind a shared NAT share a rate limit budget. This is acceptable for the single-gateway-token auth model. If per-user limiting is needed, the auth model must change first.
- **Rate limiting is in-memory only**: Counters are lost on gateway restart. This is acceptable — a restart already resets all in-flight state.
- **`timingSafeEqual` requires equal-length buffers**: We pad the provided token to the expected token's length. If the provided token is longer than expected, we truncate it to the expected length before comparing. This does not weaken security — the comparison still runs in constant time relative to the expected token's length.
- **Token cap default of 10,000 may be too low for large deployments**: Operators can increase the cap via config. The default is chosen to prevent runaway memory growth in typical deployments.
- **Rate limiting disabled when auth is disabled**: Operators who want rate limiting without auth should use an external reverse proxy (e.g., nginx) for rate limiting. This is documented as a deployment recommendation.

## Open Questions

1. Should the rate limit response include `Retry-After` header? (Recommended: yes, for client politeness)
2. Should the token cap be per-IP or global? (Current proposal: global, since proxy tokens are bound to gateway auth)
3. Should rate limiting log warnings before rejecting, or only on rejection? (Current proposal: log on rejection only, to avoid log noise)
