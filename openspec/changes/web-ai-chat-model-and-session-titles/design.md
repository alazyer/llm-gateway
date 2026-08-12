## Context

The production Web AI Chat backend (`web-ai-chat-production`) and frontend (`web-ai-chat-frontend-production`) are shipped. The chat routes every message to a single model resolved once at route registration (`selectModel(config)` → `config.defaultModel`), and sessions have only `{id, user_id, created_at, updated_at}` — no title. Operators cannot choose a model from the UI, and the session list shows opaque UUID-prefix identifiers. Constraints:

- `POST /api/ai-chat/messages` schema is `{sessionId?, prompt, stream, clientMessageId, context?}` — no `model` field. Model routing is fixed to `config.defaultModel` at startup.
- `ai_chat_sessions` has no `title` or `model` column; the only session mutation is `touchAiChatSession` (updates `updated_at`). There is no PATCH/PUT route for sessions.
- The `ai_chat_messages` table already records `model` per assistant message, so per-message model attribution already exists at persistence time.
- The auth, rate-limit, audit, and typed-failure layers (`VALIDATION_ERROR`, `FORBIDDEN`, etc.) are established and should be reused, not duplicated.

## Goals / Non-Goals

**Goals:**
- Let the operator select a model per session in the chat UI; route each message to that model.
- Persist the selected model on the session so reopening a session restores the picker.
- Give sessions a human-readable title (auto-derived, renameable) so the session list is scannable.
- Reuse the existing model list (`GET /v1/models`) rather than introducing a new list endpoint.
- Keep the change additive: no breaking changes to existing sessions or the SSE lifecycle.

**Non-Goals:**
- Multi-model routing within a single message (mixing models per turn beyond a session-level switch).
- Title auto-derivation via an LLM summarization call (too costly/complex for now; we derive from the first prompt text).
- Per-message model override that diverges from the session's stored model (the session model is the source of truth for an existing session).
- A new chat-scoped model-list endpoint (we reuse `/v1/models`).

## Decisions

1. **Per-session model, set on first send, changeable later.** The session row stores `model`. The first message stamps it; a later message carrying a different `model` updates the session's stored model and routes to the new one. Reopening a session restores the stored model into the picker. Alternative: per-message model (rejected — unpredictable, "active model" isn't a session property); global default (rejected — reopening old sessions routes to a model they weren't created with).

2. **Model resolution precedence: session-wins for existing, client-supplied for new.** Request body carries an optional `model`. If the session exists, the session's stored model is authoritative (and is updated if the client sends a different one). For a new session, the client-supplied model is used, else `config.defaultModel`, else the first active model. Alternative: session-only with a separate PATCH to switch (rejected — more round-trips and a separate UX action for a common operation); stateless per-message (rejected — reopening loses model context).

3. **Unroutable model → `VALIDATION_ERROR` (400).** If the resolved model is not in the active configured models (e.g. deactivated since the session was created), reject with `VALIDATION_ERROR` and a message naming the model. Reuses the existing typed code; no new error surface. Alternative: silent fallback to default (rejected — surprising; user picks A, gets B, and the recorded model diverges); new `MODEL_UNAVAILABLE` code (rejected — adds contract surface for little UX gain, since `VALIDATION_ERROR` already maps to an actionable "pick another model" affordance).

4. **Auto-title from first prompt, renameable via `PATCH /api/ai-chat/sessions/:sessionId`.** New sessions derive a title from the first user prompt (first 60 chars, trimmed, `…`-truncated). The PATCH endpoint validates a 1–120 char title, updates `title` + `updated_at` (so a renamed session reorders to the top), and records a `rename` audit action. RESTful and extensible to future session fields. Alternative: manual-title-only (rejected — the session list is unscannable until the user manually titles everything); dedicated `POST .../rename` (rejected — not extensible).

5. **Model picker reuses `GET /v1/models` (A1), no new list endpoint.** The frontend fetches `/v1/models`, filters to active models for the picker. The endpoint already exists, is auth-gated, and returns the configured models. Alternative: new `GET /api/ai-chat/models` (rejected — duplicates an existing, tested endpoint).

6. **Additive migration `004-ai-chat-model-title.ts`.** `ALTER TABLE ai_chat_sessions ADD COLUMN model TEXT` and `ADD COLUMN title TEXT`, both nullable. Existing rows get NULL; clients render a fallback (e.g. "Session abc12345") when `title` is NULL. No backfill, no downtime — old code ignores the new columns; new code tolerates NULL.

## Risks / Trade-offs

- [Model resolution moves from route-registration scope to per-request scope] → `selectModel(config)` is currently called once at plugin registration. Moving it per-request is a behaviour change but low-risk: the function is pure and cheap. Mitigation: unit-test the resolution precedence explicitly.
- [Stored model can become stale if deactivated] → a session's stored model may reference a model that was later deactivated. We surface this as `VALIDATION_ERROR` (per decision 3) so the user picks another. The assistant message row records the model actually used per-message, so history stays accurate. Mitigation: the picker filters to active models, steering the user toward routable choices.
- [Auto-title from prompt text is crude] → a 60-char truncation of the first prompt is not a summary. It is, however, free (no LLM call), deterministic, and immediately renameable. Mitigation: accept the crudeness for now; a summarization-based title is a later enhancement.
- [PATCH rename reorders the session list] → because rename touches `updated_at`, a renamed session sorts to the top. This matches "recently active" semantics but may surprise users who expect alphabetical stability. Mitigation: documented behaviour; the list is already recency-sorted.
