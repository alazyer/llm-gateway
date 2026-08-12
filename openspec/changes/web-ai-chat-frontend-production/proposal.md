## Why

The `web-ai-chat-production` backend contract is shipped (authenticated `/api/ai-chat/*` routes, SSE lifecycle, persistent history, typed failures, rate limiting), but `packages/web` still runs the legacy quick-validation flow: `chat.vue` calls `/v1/chat/completions` directly, consumes OpenAI-style stream chunks instead of the production SSE lifecycle, has no session persistence or history, and sends no `x-user-id`. The production capability is unreachable from the UI, so requirement "Production flow SHALL replace quick-validation mode" is unsatisfied on the client side.

## What Changes

- Switch `packages/web` chat surface to call production endpoints: `POST /api/ai-chat/messages`, `GET /api/ai-chat/sessions`, `GET /api/ai-chat/sessions/:id/messages`.
- Consume the production SSE event lifecycle (`started`, `delta`, `heartbeat`, `completed`, `error`) instead of OpenAI `choices[].delta.content` frames.
- Inject user identity (`x-user-id`) so the backend 401/403 tenant/user isolation is honored.
- Render stable UX states (idle, sending, streaming, completed, failed) and localized actionable error messaging per typed failure class (`RATE_LIMITED`, `UPSTREAM_TIMEOUT`, `UPSTREAM_UNAVAILABLE`, `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`).
- Restore session history across page refresh/navigation via cursor pagination.
- Remove or redirect the legacy quick-validation operational mode so only the production chat flow remains active in the UI.
- **BREAKING** (UI only): the `webChatValidationEnabled` runtime flag and the validation-only model picker UX are replaced by the production chat experience.

## Capabilities

### New Capabilities
- `web-ai-chat-frontend`: Nuxt web client that drives the production Web AI Chat capability — session list, message timeline, production SSE consumption, stable UX states, localized typed-failure handling, and history restoration.

### Modified Capabilities
- `web-ai-chat-production`: The "Production flow SHALL replace quick-validation mode" requirement gains a frontend-side acceptance path — the legacy quick-validation entry in the UI SHALL resolve to the production chat experience, completing the requirement that was backend-only before.

## Impact

- **Frontend**: `packages/web/pages/chat.vue`, `packages/web/composables/useGatewayApi.ts`, `packages/web/utils/chatErrorClassification.ts`, `packages/web/middleware/web-chat-validation.ts`, `packages/web/app.vue`, `nuxt.config.ts` runtime flags.
- **API contract**: Frontend now depends on `/api/ai-chat/*` contract from `web-ai-chat-production`; no backend changes.
- **Auth**: Frontend must attach `x-user-id` alongside the existing gateway auth token.
- **Operations**: Removes the validation-only mode toggle from the admin UX surface.
