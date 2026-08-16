## 1. User Identity and Auth

- [x] 1.1 `x-user-id` is set to the constant `llm-gateway` for now (no real identity source yet); documented as an interim decision in design.md.
- [x] 1.2 Extend `useGatewayApi.ts` to attach `x-user-id: llm-gateway` on all `/api/ai-chat/*` requests alongside the existing gateway auth credential.
- [x] 1.3 Surface an authentication-required UI state when no gateway auth credential is available, blocking chat submission.

## 2. Production API Client

- [x] 2.1 Add `sendMessage` (non-stream) calling `POST /api/ai-chat/messages` and typing the production non-stream response (`sessionId`, `messageId`, `assistantMessage`, `usage`, `model`, `requestId`).
- [x] 2.2 Add `listSessions` calling `GET /api/ai-chat/sessions?cursor=&limit=` and typing the cursor-paginated response.
- [x] 2.3 Add `listSessionMessages` calling `GET /api/ai-chat/sessions/:sessionId/messages` and typing the cursor-paginated response.
- [x] 2.4 Remove or retire the direct `/v1/chat/completions` chat calls (`validateChatPrompt`, `streamValidationChat`) once production paths replace them.

## 3. Production SSE Lifecycle Consumption

- [x] 3.1 Add a production SSE stream client in `useGatewayApi.ts` that parses typed events (`started`, `delta`, `heartbeat`, `completed`, `error`) via callbacks.
- [x] 3.2 Ignore `heartbeat` events for content accumulation while keeping the connection open.
- [x] 3.3 On terminal `error` event, surface `code`, `retryable`, and `requestId` while preserving already-rendered partial `delta` content.
- [x] 3.4 Add composable-level tests with mocked event streams covering success ordering, heartbeat handling, and terminal-error partial preservation.

## 4. Chat UI States and Rendering

- [x] 4.1 Refactor `chat.vue` to drive sending/streaming/completed/failed transitions through the production client and SSE callbacks.
- [x] 4.2 Render partial assistant content and typed error affordance on mid-stream failure.
- [x] 4.3 Replace validation-only copy ("Validate model", validation messaging) with production chat copy reflecting stable states.

## 5. Typed-Failure Classification and Localization

- [x] 5.1 Extend `chatErrorClassification.ts` to map backend typed codes (`RATE_LIMITED`, `UPSTREAM_TIMEOUT`, `UPSTREAM_UNAVAILABLE`, `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`) to localized actionable titles/messages and `retryable` guidance.
- [x] 5.2 Wire the classifier into the chat UI failure rendering for both non-stream and stream `error` paths.
- [x] 5.3 Add tests asserting a distinct actionable message per typed code and retry guidance for retryable failures.

## 6. Session History and Pagination

- [x] 6.1 Load sessions and messages on session open/refresh via the production history endpoints with deterministic rendering.
- [x] 6.2 Implement cursor-based load-more following returned cursors without skipping or duplicating messages.
- [x] 6.3 Add tests verifying history restoration across reload and stable cursor pagination.

## 7. Legacy Mode Removal

- [x] 7.1 Remove the `webChatValidationEnabled` toggle path (or replace with a production chat enablement flag) in `nuxt.config.ts`, `app.vue`, and `middleware/web-chat-validation.ts`.
- [x] 7.2 Remove the validation-only model-picker UX and redirect any legacy quick-validation entry to the production chat surface.
- [x] 7.3 Verify no separate quick-validation operational mode remains active in the UI.

## 8. Acceptance

- [x] 8.1 End-to-end verify a full chat round-trip (send → stream → completed) against the production backend.
- [x] 8.2 End-to-end verify typed failures (rate-limit, timeout, unavailable, mid-stream interruption) render actionable localized messaging.
- [x] 8.3 End-to-end verify history restoration across refresh and stable cursor pagination.
