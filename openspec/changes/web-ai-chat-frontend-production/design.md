## Context

`packages/web` is a Nuxt app whose chat surface (`pages/chat.vue`) was built for a quick validation flow: it calls `/v1/chat/completions` directly, parses OpenAI-style `choices[].delta.content` stream frames, exposes a model picker to test availability, and has no session persistence or user identity. The `web-ai-chat-production` backend contract (authenticated `/api/ai-chat/*`, typed SSE lifecycle, cursor-paginated history, typed failures, rate limiting) has shipped and is validated by integration tests, but the frontend cannot reach it. Constraints:

- Frontend auth today uses an in-memory gateway token (`utils/authToken.ts`) via `Authorization: Bearer <token>`; the production `/api/ai-chat/*` routes require an additional `x-user-id` header for tenant/user isolation.
- The backend emits a typed SSE lifecycle (`started`, `delta`, `heartbeat`, `completed`, `error`) with a distinct `error` terminal event carrying `code`/`retryable`/`requestId`; the current frontend stream parser is OpenAI-shaped and has no notion of these events.
- `nuxt.config.ts` exposes `webChatValidationEnabled` and `gatewayBaseUrl` as runtime config.

## Goals / Non-Goals

**Goals:**
- Drive the chat UI exclusively from `/api/ai-chat/*` production endpoints.
- Consume and render the production SSE lifecycle, including terminal `error` events and partial content preservation.
- Attach `x-user-id` so backend 401/403 isolation is honored.
- Render stable UX states (idle, sending, streaming, completed, failed) and localized actionable error messaging per typed failure class.
- Restore session history across refresh/navigation via cursor pagination.
- Remove the validation-only operational mode from the UI.

**Non-Goals:**
- Backend changes to `/api/ai-chat/*` (covered by `web-ai-chat-production`).
- New identity provider or auth protocol — reuse the existing gateway token + user identity.
- Provider-specific prompt strategy beyond the existing request fields.
- Mobile-native or offline-first behavior.

## Decisions

1. **New `web-ai-chat-frontend` capability, not modification of an existing frontend spec.** No frontend spec exists today, and the validation-only behavior was never specified as a capability. We introduce a frontend capability spec rather than retroactively spec the removed validation mode. Alternative: spec the removal as a delta on a new validation capability — rejected because there is no existing validation capability spec to delta against.

2. **`x-user-id` set to a constant `llm-gateway` for now, not derived from a login.** The frontend attaches `x-user-id: llm-gateway` on every `/api/ai-chat/*` call, satisfying the backend's required header without introducing a real identity provider. This is an interim choice: all chat sessions belong to one shared user, so cross-user 403 isolation cannot be exercised from the UI yet and sessions are shared across operators. A real identity source is deferred to a later change. Alternative: derive from the gateway token — rejected now because the token does not carry a user id; alternative: prompt the user — rejected as friction.

3. **A dedicated production SSE client in `useGatewayApi.ts`** that parses typed lifecycle events (`started`/`delta`/`heartbeat`/`completed`/`error`) and surfaces them via callbacks, separate from the legacy OpenAI-style `streamValidationChat`. Keeps the production parsing boundary explicit and testable. Alternative: adapt the existing parser in place — rejected because the frame shapes and terminal semantics differ materially.

4. **Typed-failure → UX mapping in `chatErrorClassification.ts`.** Extend the classifier to map backend typed codes (`RATE_LIMITED`, `UPSTREAM_TIMEOUT`, `UPSTREAM_UNAVAILABLE`, `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`) to localized actionable titles/messages and `retryable` guidance. Alternative: inline mapping in the page — rejected to keep classification single-sourced and testable.

5. **History restoration via cursor pagination on session open.** On session open/refresh, fetch `GET /api/ai-chat/sessions` and `GET /api/ai-chat/sessions/:id/messages` and render deterministically; load-more follows returned cursors. Alternative: infinite scroll only — rejected because deterministic cursor stability (no skip/duplicate) is a backend requirement we must honor in the client.

6. **`MODIFIED` delta on `web-ai-chat-production`'s "replace quick-validation mode" requirement** to add the frontend-side acceptance: the legacy quick-validation entry in the UI SHALL resolve to production chat. The requirement text is preserved verbatim with an added scenario covering the client navigation path.

## Risks / Trade-offs

- [User identity is a shared constant, not per-user] → `x-user-id` is hardcoded to `llm-gateway` as an interim measure. All sessions belong to one shared user, so backend cross-user 403 isolation cannot be exercised from the UI and sessions are shared across operators. Mitigation: replace with a real identity source in a later change before any multi-operator rollout.
- [SSE parsing on the client is harder to unit-test than server code] → Add composable-level tests with mocked event streams for the lifecycle and terminal-error paths.
- [Breaking the validation-only toggle] → Operators using `webChatValidationEnabled=false` to hide chat lose that knob; provide the production chat enablement flag as replacement and document the migration.
- [Partial-content UX on mid-stream failure] → Ensure the assistant bubble retains streamed deltas and shows the typed error, matching backend `streamInterrupted` behavior.
