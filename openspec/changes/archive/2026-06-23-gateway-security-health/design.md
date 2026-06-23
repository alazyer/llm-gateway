## Context

The README clarifies the gateway's primary use case: **enabling Claude Code to work with non-Claude upstream providers** via the `/v1/messages` Anthropic-compatible endpoint. Currently, the gateway ignores all incoming authentication headers (`x-api-key`, `Authorization: Bearer`). Any client that can reach the gateway port can use it — which means upstream API keys are effectively exposed to anyone on the network. The health check returns `{ok: true}` regardless of actual gateway state. And there are no CORS headers, blocking browser-based tooling.

## Goals / Non-Goals

**Goals:**
- Protect the gateway from unauthorized access by validating incoming auth tokens
- Make the health check operationally useful by verifying gateway state
- Enable browser-based tooling to call the gateway via CORS
- Maintain backward compatibility (auth is opt-in, disabled by default)

**Non-Goals:**
- Implementing rate limiting — separate future change
- Adding user-level auth or multi-tenant access control — single gateway token is sufficient for now
- Encrypting the gateway token in config — it's referenced by env var, same pattern as upstream API keys
- Changing upstream auth or retry logic — covered by `robustness-hardening` change

## Decisions

1. **Auth via Fastify hook** — Use a Fastify `onRequest` hook to validate auth before route handlers run. This is cleaner than adding auth checks in every handler and ensures preflight OPTIONS requests are also handled correctly.

2. **Single gateway auth token via env var** — Following the existing pattern (`api_key_env`), the gateway auth token is referenced by `gateway_auth_token_env` in the YAML config and resolved from environment at startup. This avoids putting secrets in config files.

3. **Auth disabled by default** — If `gateway_auth_token_env` is not configured, auth is skipped. This preserves backward compatibility and avoids breaking existing deployments.

4. **Auth skips health/metadata endpoints** — `GET /healthz`, `GET /models`, `GET /v1/models`, and `GET /models/:model` don't require auth. This allows monitoring and discovery without credentials, consistent with common gateway patterns.

5. **Health check model count** — The enhanced health check includes a `models` count field. This is cheap (just check config.models.length) and immediately tells operators if the config loaded correctly.

6. **Health probe opt-in** — Upstream connectivity probing is expensive (network call per health check) and could slow down monitoring. It's opt-in via `health_probe_enabled` config. When enabled, it does a lightweight check (e.g., calling the upstream models endpoint if available, or a minimal completion).

7. **CORS via Fastify @fastify/cors plugin** — Use the well-maintained `@fastify/cors` plugin instead of manual header injection. It handles preflight, origin matching, and all CORS edge cases correctly.

8. **CORS origin from config** — `cors_origin` in YAML can be a string (single origin or `*`) or array of strings. The `@fastify/cors` plugin's `origin` option supports both formats directly.

## Risks / Trade-offs

- **Auth adds a breaking change for unauthenticated clients**: When auth is enabled, any client not sending a token gets 401. This is intentional — the gateway should be protected. But operators must ensure all clients are configured with the token before enabling.
- **Health probe adds latency**: If `health_probe_enabled` is true, `/healthz` takes longer (network round-trip to upstream). This could affect monitoring systems with tight timeout budgets. Mitigated by making it opt-in.
- **@fastify/cors adds a dependency**: The plugin is well-maintained and widely used, but it's a new dependency. It could be replaced with manual headers if dependency bloat is a concern.
- **Preflight requests don't reach upstream**: CORS OPTIONS requests are handled entirely by the gateway (Fastify cors plugin). This is correct behavior — preflight should never be forwarded.
