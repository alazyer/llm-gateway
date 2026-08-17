## Why

The web chat surface (`packages/web/pages/chat.vue`) only accepts free-text input — a single `<textarea>` whose trimmed value becomes the entire user message. The backend `POST /api/ai-chat/messages` route hard-codes `messages: [{ role: "user", content: parsed.prompt }]`, so even when the selected upstream model supports vision, users cannot send images. The gateway's `/responses`, `/v1/chat/completions`, and `/v1/messages` translation paths already support multimodal `image_url` content parts end-to-end — only the Web AI Chat UI and its `/api/ai-chat/*` backend route are text-only. Multimodal models are increasingly the default, so the web chat should let users attach images when the active model supports them.

## What Changes

- Add an attachment control to the web chat composer that accepts image files, validates type/size, and previews each attachment as a removable chip with a thumbnail.
- Advertise image input support per model: the model picker disables attachment and shows a hint when the active model does not support image input; when a model switch leaves a pending (unsent) image in the composer, Send is blocked with a clear hint rather than silently discarding the image.
- Extend `POST /api/ai-chat/messages` to accept an optional `attachments` array of `{ id, type, dataUrl }` image parts (base64 data URLs) alongside the existing `prompt`. Bounded to **one image per message, ≤ ~700 KB base64, ≤ ~900 KB total** to fit the default 1 MiB body limit; enforced server-side as a typed `VALIDATION_ERROR` (not a leaked Fastify 413).
- When attachments are present and the routed model supports image input, the route builds a multimodal `ChatMessage` whose `content` is an array of `{ type: "text" }` and `{ type: "image_url", image_url: { url } }` parts, and forwards it to the existing upstream `ChatCompletionsClient` (which already passes content parts through to the OpenAI SDK). The route stays stateless: only the single current message is sent upstream; prior turns (including any persisted images) are display/history-only and never re-sent.
- Reject image input with `VALIDATION_ERROR` (HTTP 400) when the routed model does not support image input — thrown immediately after model resolution, **before** any session or user-message insert, so a rejected image leaves no DB trace except a failed-outcome audit event.
- Persist multimodal user messages so history restores attachments: store a versioned JSON envelope (`{ v:1, text, images }`) in the existing `ai_chat_messages.content` TEXT column (no DDL change) and render text + image thumbnails back in the timeline. Text-only messages store raw text unchanged.
- **Additive** (API contract for `/api/ai-chat/messages`): the request body gains an optional `attachments` field; `prompt` remains required (`min(1)`), so an attachments-only request with no text is still rejected. Backwards-compatible for existing text-only clients.
- Surface multimodal capability on model discovery so the client can gate the attachment UI: `GET /v1/models` OpenAI-format records reflect `input_modalities` truthfully per model instead of the current hard-coded `["text"]` (the Anthropic-format record carries no `input_modalities` field and is unchanged).

## Capabilities

### New Capabilities
- `web-ai-chat-multimodal-input`: Web AI Chat attachment capture, validation, preview, transport, persistence, and model-capability gating for image input.

### Modified Capabilities
- `web-ai-chat-production`: The message-send requirement gains acceptance for image attachments — `POST /api/ai-chat/messages` accepts an optional `attachments` array and forwards multimodal content parts to the upstream model, rejecting them with `VALIDATION_ERROR` when the routed model lacks image-input support.
- `model-chain-discovery`: The model record's `capabilities.input_modalities` is no longer hard-coded to `["text"]`; it reflects whether a configured model supports image input, so clients (including the web chat picker) can gate multimodal UI.

## Impact

- **Frontend**: `packages/web/pages/chat.vue` (composer attachment control, chip previews, timeline rendering of stored image parts), `packages/web/composables/useGatewayApi.ts` (add `attachments` to the stream/non-stream send payloads and to the chat model type's capability shape), `packages/web/middleware/web-chat-validation.ts` (unchanged gating).
- **Backend routes**: `src/routes/ai-chat.ts` (extend `sendMessageBodySchema`, build multimodal `content` parts, validate against model capability, persist and restore parts).
- **Backend discovery**: `src/routes/responses.ts` (`/v1/models` `input_modalities` per model), `src/config.ts` and `src/db` (model config/schema for an image-input capability flag such as `supports_image_input`).
- **Persistence**: `src/db/migrations` (new migration `005-model-image-input` adding `supports_image_input` to the `models` table — registered in `allMigrations`; the `ai_chat_messages` schema is unchanged, multimodal content is stored as a versioned JSON envelope in the existing `content` TEXT column), `src/db/ai-chat-repository.ts` (read/write the message content as parts).
- **Contracts**: `src/contracts.ts` already defines `ChatImageUrlContentPart` / `ChatContentPart`; no new upstream contract types are needed, but a web-chat attachment type is added.
- **Tests**: web composable + chat.vue attachment tests; backend route tests for multimodal send, capability rejection, and history round-trip; model discovery assertion update for `input_modalities`.
- **Operations**: a new migration runs on startup; no new env vars required. Model image-input support is configured via the existing model catalog/admin API.
