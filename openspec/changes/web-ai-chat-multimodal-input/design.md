## Context

The LLM Gateway already translates multimodal input end-to-end on its API surfaces: `/responses` (via `ResponseInputImageContent`), `/v1/chat/completions`, and `/v1/messages` (via `AnthropicImageBlock`) all reduce to OpenAI `ChatMessage.content` content-part arrays (`ChatContentPart` = `{ type: "text" } | { type: "image_url", image_url: { url, detail? } }`), and `ChatCompletionsClient.createCompletion`/`createCompletionStream` pass the request object straight through to the OpenAI SDK with no content transformation. So multimodal *transport* is solved upstream of the web chat.

The gap is confined to two places:

1. **Web UI** — `packages/web/pages/chat.vue` composer is a single `<textarea>`; `sendMessage()` trims its value and the composable (`useGatewayApi.ts`) sends only `{ prompt }`. No file input, no preview, no attachment state.
2. **Web AI Chat backend route** — `POST /api/ai-chat/messages` validates `sendMessageBodySchema` with `prompt: z.string().trim().min(1)` and builds `messages: [{ role: "user", content: parsed.prompt }]` in three places (non-stream, stream, and the failure-stream branch). The `ai_chat_messages.content` column is `TEXT NOT NULL` (migration 002) and holds flat text only.

Additionally, model discovery advertises multimodal capability incorrectly: `src/routes/responses.ts` hard-codes `input_modalities: ["text"]` at all four record builders (static model, chain, Copilot, Anthropic). There is no per-model flag for image input, so even if the UI wanted to gate attachments by capability, no truthful signal exists yet.

Constraints carried over from existing specs: per-request model resolution (`web-ai-chat-model-selection`), typed failure classification (`web-ai-chat-production`), cursor pagination, audit redaction (`prompt_redacted`/`response_redacted`), and the SSE lifecycle (`started`/`delta`/`heartbeat`/`completed`/`error`).

## Goals / Non-Goals

**Goals:**
- Let a user attach one or more images in the web chat composer when the active model supports image input, and send them alongside the text prompt.
- Forward multimodal content to the upstream model as OpenAI `image_url` content parts, reusing the existing `ChatCompletionsClient` transport unchanged.
- Persist multimodal user messages so attachments restore from history on reload/session reopen, alongside the existing flat-text behavior.
- Gate the attachment UI on a truthful per-model image-input capability exposed through `GET /v1/models` (`input_modalities`), replacing the hard-coded `["text"]`.
- Reject image input with a typed `VALIDATION_ERROR` when the routed model does not support images, preserving the existing error taxonomy.

**Non-Goals:**
- No support for non-image attachments (audio, video, documents, PDF). Only still images.
- No new attachment storage service / object store — images are carried inline as base64 data URLs in the request body and persisted as content parts in SQLite (same DB column, structured payload). No remote URL fetching, transcription, or OCR.
- No changes to the upstream `ChatCompletionsClient`, the `/responses`, `/v1/chat/completions`, or `/v1/messages` translation paths — they already support image parts.
- No model output of images (output modality stays `["text"]`).
- No automatic multimodal *chain* fan-out semantics beyond "chain supports images iff all members do" (mirrors the existing streaming/tools derivation). Chain-level multimodal routing depth is a non-goal.
- **No multi-turn context to the upstream model.** The route sends exactly one user message to the upstream, as today; prior turns (including any persisted images) are display/history-only and are never re-sent. Reconstructing conversation context is a separate, larger change (token budgeting, context-window truncation) and is explicitly out of scope.
- **No image retention / TTL / redaction mechanism.** Attached images persist inline in the `ai_chat_messages.content` column for the session's lifetime, with no expiry, no redaction, and no admin "this session contains images" affordance. This is a known gap documented as a follow-up change; it is intentionally not built here to keep the change focused.

## Decisions

### Decision 1: Carry attachments as base64 data URLs in the existing JSON request body
The client reads each selected `File` via `FileReader.readAsDataURL`, producing a `data:image/<type>;base64,...` URL. These are sent in a new optional `attachments: [{ id, type, dataUrl }]` array on `POST /api/ai-chat/messages` (both stream and non-stream), exactly as `prompt` is sent today.

- **Why data URLs over multipart/form-data:** the entire current API is JSON-in / SSE-out with a single `Content-Type: application/json`. Introducing multipart would require a parallel parser path on `/api/ai-chat/messages` and complicate the shared `request<T>`/SSE plumbing. Base64 inline stays within the existing JSON envelope and `max_body_size_kb` limit, which already guards the route.
- **Alternative considered:** an upload endpoint returning a URL the chat then references. Rejected for this change — it adds an object-store dependency and a cleanup lifecycle that the non-goal above explicitly excludes. Data URLs keep the change self-contained and reversible.
- **Why `id` is client-supplied:** mirrors `clientMessageId` dedupe semantics and lets the UI reconcile chip previews with server-acknowledged parts without an extra round trip.

### Decision 2: Model capability is a new boolean `supports_image_input`, surfaced via `input_modalities`
Add `supports_image_input: boolean` (default `false`) to the model config schema (`src/config.ts` `yamlModelSchema` + `GatewayModelConfig`), the DB models table + repository, and the admin model CRUD. In `src/routes/responses.ts`, derive `input_modalities` per record:
- static model: `model.supportsImageInput ? ["text", "image"] : ["text"]`
- chain: `["text", "image"]` iff **all** member models support image input, else `["text"]`. This is deliberately **stricter** than the existing `some()` derivation used for `supports_streaming`/`supports_tool_calls` in `createChainModelRecord`, because a chain that could route a request to a non-vision member mid-conversation would silently drop the image. The cost (a vision-capable primary shadowed by a text-only fallback loses image input) is an acceptable, predictable limitation — the operator simply avoids placing a blind model behind a vision model.
- Copilot proxy model: from its registered capabilities, default `["text"]`.
- Anthropic-format record: unchanged. `AnthropicModelRecord` carries no `input_modalities` field, so there is nothing to derive on the Anthropic list format; only the OpenAI-format `ModelRecord.input_modalities` is populated.

`output_modalities` stays `["text"]` (non-goal).

- **Why a boolean over a richer modality array:** the only new modality is image; `["text"]`/`["text","image"]` is fully captured by a boolean and keeps config/DB churn minimal. If audio/video arrive later, this becomes an enum — a documented forward-compatible extension point.
- **Alternative considered:** reading the upstream `/models` capabilities at runtime. Rejected: upstream capability shape varies by provider and the gateway already treats per-model feature flags (`supports_tools`, `supports_streaming`) as operator-declared config. Consistency wins.

### Decision 3: Build `content` as a parts array only when attachments exist; keep flat text otherwise
In the route, the capability check runs **immediately after `resolveModel` and before any session or user-message insert** (today's insert at `ai-chat.ts:805`). It reads `routedModel.model.supportsImageInput` directly off the `GatewayModelConfig` that `resolveModel` already returns — the config object already carries the boolean capability flags (`supportsTools`, `supportsStreaming`), so no extra DB lookup is needed. If `attachments` is non-empty and the routed model has `supports_image_input === false`, throw `AiChatRouteError(400, "VALIDATION_ERROR", ...)` and record a failed-outcome audit event — leaving no user message or session row. This mirrors the existing unroutable-model `VALIDATION_ERROR` (also thrown inside `resolveModel`, before insert), so the rejection behavior is consistent and reuses `sendRouteError`/`writeAuditEvent` unchanged.

Then `buildUserContent`:
- No attachments → `content: parsed.prompt` (string), byte-for-byte the current behavior. No change for text-only clients.
- Attachments present → `content: [{ type: "text", text: parsed.prompt }, ...attachments.map(a => ({ type: "image_url", image_url: { url: a.dataUrl } }))]`.

- **Why reject before insert (not persist-then-reject):** a rejected image never touches the DB — consistent with how an unroutable model is rejected before insert, and it keeps rejected base64 payloads out of `ai_chat_messages.content`. The timeline shows no failed-image row; the user just gets a typed error and can switch models.
- **Why reject rather than silently strip images:** stripping would hide a capability mismatch and produce a confusing model response; an explicit `VALIDATION_ERROR` matches the existing precedent of rejecting unsupported `model` values and gives the client an actionable signal to disable attachments.

### Decision 4: Persist multimodal content as a structured JSON payload in the existing `content` TEXT column
Rather than alter the `ai_chat_messages` schema, store a JSON envelope in the existing `NOT NULL TEXT` `content` column for multimodal user messages:
```json
{ "v": 1, "text": "<prompt>", "images": [{ "id": "...", "type": "image/png", "dataUrl": "data:..." }] }
```
Text-only messages keep storing raw text (no envelope), so existing rows and existing text-only clients are untouched. The history read path detects the envelope (`content` starts with `{"v":1,`) and decodes it; otherwise treats `content` as flat text. The timeline renders the text and the image thumbnails/chips.

- **Why not a new column / migration table:** a new `content_parts TEXT` column would require a migration that backfills nothing (old rows stay text-only) and would leave two fields to keep consistent. A versioned JSON envelope in the existing column is forward-compatible (`v`), keeps the repository interface single-field, and avoids touching `ai_chat_messages` DDL.
- **Alternative considered:** a separate `ai_chat_message_attachments` table. Rejected for this change — normalized storage is heavier than the inline use case warrants; the data URLs are already part of the request the user sent and are not expected to be queried/indexed independently.
- **Storage size note:** base64 images inline in SQLite grow the DB. Mitigated by a per-image size cap enforced client- and server-side (see Decision 5) and the existing `max_body_size_kb` route limit. Large-image handling via object storage is an explicit non-goal.

### Decision 5: Bound attachments client- and server-side to fit the default body limit
- Client: accept only `image/*` MIME types, cap at **one image per message**, ≤ ~700 KB base64, ≤ ~900 KB total request. Reject oversized/overset with a clear inline error on the chip.
- Server: validate the same limits in `sendMessageBodySchema` (MIME allowlist, count = 1, per-item and total size), so a non-browser client cannot bypass them. Reuse `VALIDATION_ERROR` (HTTP 400) for all of these — enforcing caps in zod keeps oversize payloads from leaking through as a generic Fastify 413.
- The default `max_body_size_kb` (1024 = 1 MiB) is left untouched so no other route (`/responses`, `/v1/chat/completions`, `/v1/messages`, admin) is affected. If operators need larger images, they raise `max_body_size_kb` and the chat caps proportionally — but out of the box, the chat caps stay within the default limit.

## Risks / Trade-offs

- **[Large base64 payloads inflate request + DB]** → caps fit the default 1 MiB body limit (one image, ≤ ~700 KB base64, ≤ ~900 KB total) and are enforced in `sendMessageBodySchema` as a typed `VALIDATION_ERROR` (Decision 5), so oversize payloads never reach a leaked Fastify 413. Operators raising `max_body_size_kb` would also raise the chat caps proportionally.
- **[Wrong model mid-session silently drops images]** → chain capability uses all-members semantics (Decision 2); for static models the explicit `VALIDATION_ERROR` on mismatch (Decision 3), thrown before any insert, prevents silent image loss. The web picker also disables attachments when the active model lacks support, and a model switch with a pending (unsent) image blocks Send with a clear hint rather than silently stripping (see the `web-ai-chat-multimodal-input` spec scenario).
- **[Inline JSON content envelope is a format change for the `content` column]** → versioned (`v:1`) and only written when attachments exist; the read path falls back to flat text for any unparseable/non-envelope value, so old rows and future text-only writes are safe. Round-trip covered by a repository test.
- **[History response grows with base64 for restored image messages]** → acceptable for the web chat's per-session pagination (limit ≤100, typical 50). Not exposed via the public `/v1/messages` path, so blast radius is the web chat surface only.
- **[Images at rest with no retention/TTL/redaction]** → attached images persist inline in `ai_chat_messages.content` for the session's lifetime with no expiry or redaction. This is a documented known gap; image retention/TTL and a "clear session" affordance are an explicit follow-up change, not built here.
- **[No remote-URL image fetching]** → clients must inline images as data URLs. A malicious user cannot make the gateway fetch arbitrary URLs (no SSRF surface). This is a deliberate non-goal.

## Migration Plan

1. Add `supports_image_input` to the model config schema + DB models table (new migration `005-model-image-input` adding the column `supports_image_input INTEGER NOT NULL DEFAULT 0` to the `models` table; register `migration005ModelImageInput` in `allMigrations` in `src/db/migrations/all.ts`) + repository + admin CRUD, defaulting existing models to text-only. (Migration `004` is already taken by `ai-chat-model-title`.)
2. Ship the route attachment handling and the `content` envelope; existing text-only requests are unaffected (no envelope, no attachments).
3. Ship `input_modalities` derivation in `responses.ts` (OpenAI-format records only — the Anthropic-format record carries no `input_modalities` field).
4. Ship the web composer attachment UI gated on the discovered capability.
5. Operators flip `supports_image_input: true` on models that support vision via the admin model API (no restart beyond normal config reload).

**Rollback:** the feature is additive. Disabling is reversible by setting `supports_image_input: false` on all models (UI hides the attachment control, route rejects attachments). The `content` envelope remains readable harmlessly; no destructive migration is applied.

## Open Questions

None outstanding. Resolved during grilling:

- **Body budget** — the default `max_body_size_kb` is 1024 (1 MiB), applied globally as Fastify's `bodyLimit` in `src/app.ts`. Caps are set to **fit the default limit**: one image per message, ≤ ~700 KB base64, ≤ ~900 KB total per request. The default limit is left untouched so no other route is affected. Caps are enforced in `sendMessageBodySchema` so oversize/wrong-type/over-count attachments produce a typed `VALIDATION_ERROR` rather than a leaked Fastify 413.
- **Anthropic-format model record** — `AnthropicModelRecord` carries no `input_modalities` field at all, so there is nothing to set on the Anthropic list format. Only the OpenAI-format (`ModelRecord`) `input_modalities` is derived.
