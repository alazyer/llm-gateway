## Why

The production Web AI Chat surface (delivered by `web-ai-chat-production` + `web-ai-chat-frontend-production`) routes every message to the gateway's `defaultModel`, with no way for the operator to choose a model. Sessions are also untitled — the session list shows opaque "Session abc12345" identifiers, making history unscannable. Both are core chat affordances that the current contract cannot express: the messages endpoint takes no `model` field, and sessions have no `title` column or rename route.

## What Changes

- Add a per-session model: the client selects a model in the chat UI; the backend routes each message to the session's selected model. The model is set on first send, persisted on the session row, and changeable mid-session.
- Add an optional `model` field to `POST /api/ai-chat/messages`; the backend resolves the model per-request (session-stored model wins for existing sessions; client-supplied model stamps a new session; `config.defaultModel` fallback). An unroutable model is rejected with `VALIDATION_ERROR`.
- Add a `title` column to `ai_chat_sessions`, auto-derived from the first user prompt (first 60 chars, truncated). Add `PATCH /api/ai-chat/sessions/:sessionId` to rename a session.
- Expose `title` and `model` in the `GET /api/ai-chat/sessions` list response.
- Frontend: a model picker in the chat header (populated from the existing `GET /v1/models`, reused — no new list endpoint) and inline-editable session titles in the session list.
- Reuse the existing auth, rate-limit, audit, and typed-failure layers; no new error codes.

## Capabilities

### New Capabilities
- `web-ai-chat-model-selection`: The client selects which configured gateway model a chat session routes to, set on first send and changeable mid-session.
- `web-ai-chat-session-titles`: Sessions carry a human-readable title auto-derived from the first prompt and renameable via a PATCH endpoint.

### Modified Capabilities
- `web-ai-chat-production`: The "production prompt execution" requirement gains an optional `model` request field and per-request model resolution (replacing the single default-model selection at route registration); the "session history" requirement gains `title` and `model` fields in the session list response.

## Impact

- **Backend**: `src/routes/ai-chat.ts` (model field + per-request resolution, auto-title, PATCH rename route, title/model in list response), `src/db/ai-chat-repository.ts` (title/model column reads/writes, rename update), new migration `src/db/migrations/004-ai-chat-model-title.ts` (additive `ALTER TABLE` on `ai_chat_sessions`).
- **API contract**: `POST /api/ai-chat/messages` gains optional `model`; `PATCH /api/ai-chat/sessions/:sessionId` is new; `GET /api/ai-chat/sessions` response gains `title`/`model`.
- **Auth**: PATCH enforces session ownership (reuses `ensureOwnedSession` → 403) and records a `rename` audit action.
- **Frontend**: `packages/web/pages/chat.vue` (model picker, inline title editing), `packages/web/composables/useGatewayApi.ts` (model param on send methods, `renameSession`, `listChatModels`, updated session types).
- **Operations**: additive migration; existing sessions get NULL title/model and render a client-side fallback. No downtime.
