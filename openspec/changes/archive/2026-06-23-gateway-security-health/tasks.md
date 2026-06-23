## 1. Incoming Auth

- [ ] 1.1 Add `gateway_auth_token_env` field to Zod schema in `src/config.ts` — optional string, resolved from env like `api_key_env`; add `gatewayAuthToken` to `AppConfig` interface
- [ ] 1.2 Create `src/auth.ts` — Fastify `onRequest` hook that reads `gatewayAuthToken` from config, extracts `x-api-key` or `Authorization: Bearer` from request, validates against configured token, returns 401 on mismatch
- [ ] 1.3 Register auth hook in `src/app.ts` — apply to all routes except `/healthz`, `/models`, `/v1/models`, `/models/:model`, `/v1/models/:model`
- [ ] 1.4 Add error response formats: OpenAI-style for `/v1/chat/completions` and `/responses`, Anthropic-style for `/v1/messages`
- [ ] 1.5 Update `gateway.config.example.yaml` with `gateway_auth_token_env` field and `.env.example` with `GATEWAY_AUTH_TOKEN=replace-me`
- [ ] 1.6 Add tests for auth: valid token, invalid token, missing token, auth disabled (no config)
- [ ] 1.7 Add tests for auth endpoint coverage: POST endpoints require auth, GET endpoints skip auth

## 2. Enhanced Health Check

- [ ] 2.1 Update `/healthz` handler in `src/app.ts` — return `{ok: true, models: config.models.length}` instead of `{ok: true}`
- [ ] 2.2 Add degraded state detection: if `config.models.length === 0`, return `{ok: false, error: "No models configured."}` with 503
- [ ] 2.3 Add `health_probe_enabled` optional boolean field to Zod schema in `src/config.ts` (default false)
- [ ] 2.4 When `health_probe_enabled` is true, attempt a lightweight upstream connectivity check in `/healthz` handler (e.g., fetch upstream `/models` endpoint or small completion)
- [ ] 2.5 Add `upstream: "reachable"` or `upstream: "unreachable"` to health response based on probe result
- [ ] 2.6 Add tests: healthy config returns model count, zero models returns 503, probe enabled + reachable returns reachable, probe enabled + unreachable returns 503

## 3. CORS Support

- [ ] 3.1 Install `@fastify/cors` dependency: `npm install @fastify/cors`
- [ ] 3.2 Add `cors_origin` field to Zod schema in `src/config.ts` — optional, accepts string or array of strings
- [ ] 3.3 Register `@fastify/cors` plugin in `src/app.ts` — configure with `origin` from config's `corsOrigin`, only when configured
- [ ] 3.4 Update `gateway.config.example.yaml` with `cors_origin` example
- [ ] 3.5 Add tests: CORS headers present when configured, preflight OPTIONS handled, no headers when not configured, multiple origins matched correctly

## 4. Final Validation

- [ ] 4.1 Run full test suite (`npm test`) and verify all tests pass
- [ ] 4.2 Run `npm run build` and verify TypeScript compilation succeeds
- [ ] 4.3 Validate openspec change: `openspec validate gateway-security-health`
- [ ] 4.4 Update `gateway.config.example.yaml` and `.env.example` with all new fields
