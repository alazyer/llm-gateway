## 1. Persistence Layer

- [x] 1.1 Add migration `src/db/migrations/004-ai-chat-model-title.ts` that adds nullable `model` and `title` columns to `ai_chat_sessions` (additive `ALTER TABLE`); register it in `src/db/migrations/all.ts`.
- [x] 1.2 Extend `AiChatSessionRow` in `src/db/ai-chat-repository.ts` with `model: string | null` and `title: string | null`.
- [x] 1.3 Update `insertAiChatSession` to accept and persist `model` and `title`.
- [x] 1.4 Add `updateAiChatSessionModel(sessionId, model)` to update a session's stored model (mid-session switch).
- [x] 1.5 Add `renameAiChatSession(sessionId, title, updatedAt)` to update `title` and `updated_at`.
- [x] 1.6 Update `listAiChatSessionsByUser` to select the new columns so the session list response carries `title`/`model`.

## 2. Backend Routes — Model Selection

- [x] 2.1 Add optional `model: z.string()` to `sendMessageBodySchema` in `src/routes/ai-chat.ts`.
- [x] 2.2 Replace route-registration-time `selectModel(config)` with a per-request `resolveModel(config, session, clientModel)` function implementing the precedence: session-stored model wins for existing sessions (updated if client sends a different one); client-supplied model stamps a new session; `config.defaultModel`/first-active fallback.
- [x] 2.3 On new-session creation, stamp the resolved `model` and auto-derived `title` (first 60 chars of prompt, trimmed, `…`-truncated) on the session row.
- [x] 2.4 On existing-session message where the client sends a differing `model`, call `updateAiChatSessionModel` and route to the new model.
- [x] 2.5 If the resolved model is not in the active configured models, return `400 VALIDATION_ERROR` with a message naming the model and persist no assistant message.

## 3. Backend Routes — Session Rename

- [x] 3.1 Add `PATCH /api/ai-chat/sessions/:sessionId` route accepting `{ title }` (1–120 chars, trimmed, non-empty); validate and reject with `400 VALIDATION_ERROR` on invalid input.
- [x] 3.2 Enforce ownership via `ensureOwnedSession` (→ `403 FORBIDDEN` for non-owners); require `x-user-id` (→ `401 UNAUTHORIZED` if absent).
- [x] 3.3 On success, update `title` + `updated_at` via `renameAiChatSession` and return `200 { sessionId, title, updatedAt }`.
- [x] 3.4 Record a `rename` audit event (extend the audit `action` value set and `writeAuditEvent`).

## 4. Backend Routes — Session List Response

- [x] 4.1 Update `GET /api/ai-chat/sessions` response to include `title` and `model` per session (null for pre-existing sessions).

## 5. Backend Tests

- [x] 5.1 Add tests for model resolution: new session stamps model; existing session uses stored model; mid-session switch updates stored model; `config.defaultModel` fallback when no model supplied.
- [x] 5.2 Add test that an unroutable model returns `400 VALIDATION_ERROR` and persists no assistant message.
- [x] 5.3 Add tests for auto-title: first prompt under 60 chars becomes the title; over 60 chars truncates with `…`.
- [x] 5.4 Add tests for PATCH rename: owner success returns `{ sessionId, title, updatedAt }` and reorders the list; non-owner → `403`; invalid title → `400`; `rename` audit event recorded.
- [x] 5.5 Add test that `GET /api/ai-chat/sessions` includes `title` and `model`, with `null` for pre-existing sessions.

## 6. Frontend — API Client

- [x] 6.1 Add `model?: string` to `sendMessage` and `streamAiChatMessage` request options in `useGatewayApi.ts`; pass it through to the request body.
- [x] 6.2 Extend `AiChatSessionSummary` with `title: string | null` and `model: string | null`.
- [x] 6.3 Add `renameSession(sessionId, title)` calling `PATCH /api/ai-chat/sessions/:sessionId`.
- [x] 6.4 Add `listChatModels()` calling `GET /v1/models` and returning active chat-routable models (filtered to active status).

## 7. Frontend — Chat UI

- [x] 7.1 Add a model picker (dropdown) in the chat header, populated from `listChatModels()`; default to the gateway default model on a new chat.
- [x] 7.2 On opening an existing session, restore the session's stored `model` into the picker.
- [x] 7.3 Send the selected model with each message; on `onStarted` for a new session, capture the session id and reflect the routed model.
- [x] 7.4 Render session `title` in the session list (fallback to "Session abc12345" / "New chat" when `title` is null).
- [x] 7.5 Add inline-edit for session titles: double-click/edit affordance turns the title into an input; Enter saves (PATCH), Escape cancels; optimistic update with revert on failure.
- [x] 7.6 After the first message auto-titles a new session, refresh the session list so the derived title appears.

## 8. Frontend Tests

- [x] 8.1 Add tests for a pure model-resolution helper (new-session default, existing-session restoration, mid-session switch) mirroring the pagination-helper test pattern.
- [x] 8.2 Verify typecheck and build pass after the frontend changes.

## 9. Acceptance

- [x] 9.1 End-to-end verify model selection: new session stamps the chosen model; reopening restores it; switching mid-session routes to the new model.
- [x] 9.2 End-to-end verify session titles: new session auto-titles from the first prompt; renaming updates the list and reorders to the top.
- [x] 9.3 End-to-end verify an unroutable model surfaces an actionable `VALIDATION_ERROR` message.
