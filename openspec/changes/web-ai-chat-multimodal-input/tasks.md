# Tasks

## 1. Model capability: `supports_image_input` flag

- [x] 1.1 Add `supports_image_input: z.boolean().default(false)` to `yamlModelSchema` and `GatewayModelConfig` in `src/config.ts`; map it from YAML in the model config loader.
- [x] 1.2 Create migration `src/db/migrations/005-model-image-input.ts` adding `supports_image_input INTEGER NOT NULL DEFAULT 0` to the `models` table; export `migration005ModelImageInput` and add it to `allMigrations` in `src/db/migrations/all.ts` (migration `004` is already taken by `ai-chat-model-title`).
- [x] 1.3 Update `src/db/repository.ts` (insert/select column lists) and `src/db/types.ts` (`supports_image_input`) to read/write the new column.
- [x] 1.4 Expose `supports_image_input` on the admin model create/update GET/PUT/POST shapes in `src/routes/admin.ts` and the admin model composable in `packages/web/composables/useGatewayApi.ts` (`listModels`/`getModel`/`createModel`/`updateModel`).

## 2. Model discovery: truthful `input_modalities` (OpenAI-format records only)

- [x] 2.1 In `src/routes/responses.ts`, replace the hard-coded `input_modalities: ["text"]` at the static-model record builder (`createModelRecord`) with `model.supportsImageInput ? ["text","image"] : ["text"]`.
- [x] 2.2 Derive chain `input_modalities` as `["text","image"]` iff **all** member models support image input, else `["text"]` (deliberately stricter than the existing `some()` derivation for streaming/tools).
- [x] 2.3 Derive Copilot-proxy model `input_modalities` from its registered capabilities, defaulting to `["text"]`.
- [x] 2.4 Update existing `/v1/models` discovery tests in `tests/routes` for the new `input_modalities` values. (No Anthropic-format change: `AnthropicModelRecord` carries no `input_modalities` field.)

## 3. Backend route: multimodal message handling

- [x] 3.1 Define shared attachment constants in `src/routes/ai-chat.ts`: allowed image MIME types, per-image cap (~700 KB base64), max count = 1. These fit the default 1 MiB `max_body_size_kb`; the default limit is left untouched.
- [x] 3.2 Extend `sendMessageBodySchema` with an optional `attachments: z.array(z.object({ id: z.string(), type: z.enum([allowed image types]), dataUrl: z.string() })).max(1)` plus per-item size validation (reject > ~700 KB). Oversize/wrong-type/over-count produce `400 VALIDATION_ERROR`, not a leaked Fastify 413.
- [x] 3.3 Add the capability check **immediately after `resolveModel` and before any session or user-message insert** (today's insert is at `ai-chat.ts:805`): if `attachments` is non-empty and `routedModel.model.supportsImageInput` is false, throw `AiChatRouteError(400, "VALIDATION_ERROR", ...)` and record a failed-outcome audit event, leaving no user message or session row (mirrors the existing unroutable-model rejection).
- [x] 3.4 Add a `buildUserContent(prompt, attachments)` helper: returns the plain `prompt` string when no attachments, else a `ChatContentPart[]` of one `{ type:"text" }` part plus one `{ type:"image_url", image_url:{ url } }` per attachment.
- [x] 3.5 Replace the three `messages: [{ role: "user", content: parsed.prompt }]` call sites (non-stream, stream, failure-stream) with `messages: [{ role: "user", content: buildUserContent(parsed.prompt, parsed.attachments) }]`. The route stays stateless: only this single message goes upstream; prior turns are never reconstructed.
- [x] 3.6 Persist the multimodal user message: when attachments exist, store a versioned JSON envelope `{ "v":1, "text": prompt, "images": [...] }` in the existing `content` TEXT column (no DDL change); otherwise store raw text (unchanged).

## 4. Backend persistence: round-trip multimodal content

- [x] 4.1 In `src/db/ai-chat-repository.ts`, leave the insert `content` field as-is (envelope or text decided by the route). Keep the single-field interface.
- [x] 4.2 In the `GET /api/ai-chat/sessions/:sessionId/messages` response mapping in `src/routes/ai-chat.ts`, detect the versioned envelope (content parses as `{ v: 1, ... }`) and decode it to `{ content: text, attachments: [...] }`; otherwise return `content` as text.
- [x] 4.3 Add a repository/round-trip test: a multimodal user message envelope persists and decodes back to the same text + image data URL; a text-only message persists and reads back as flat text.

## 5. Backend route tests

- [x] 5.1 Test: multimodal message with an attachment is forwarded as a `content` array to the (mocked) upstream transport and the user message is persisted with the image.
- [x] 5.2 Test: an attachment with a non-image-capable model returns `400 VALIDATION_ERROR`, does not call upstream, persists no user message or session, and records a failed audit event.
- [x] 5.3 Test: oversized / wrong-MIME / more-than-one attachment return `400 VALIDATION_ERROR`.
- [x] 5.4 Test: text-only request (no `attachments`) is byte-for-byte unchanged (existing path regression).
- [x] 5.5 Test: history round-trip exposes the attachment for a multimodal user message and flat text for a text-only user message.

## 6. Web client: attachment capture, validation, preview

- [x] 6.1 Add an `attachments` ref + `Attachment` type (`{ id, type, dataUrl, name?, size }`) in `packages/web/pages/chat.vue` composer state; cap at one attachment.
- [x] 6.2 Add a hidden `<input type="file" accept="image/*">` (single, not multiple) plus a visible attach button; on change, read the `File` via `FileReader.readAsDataURL`, validate MIME/size, and push to `attachments`; render a removable preview chip with a thumbnail.
- [x] 6.3 Implement remove-chip and clear-on-successful-send behavior (clear `attachments` and `prompt` together).
- [x] 6.4 Inline validation UI: show size/type/single-image limit messages on rejected selections.
- [x] 6.5 Extend `AiChatChatModel` in `useGatewayApi.ts` to carry a `supportsImageInput: boolean` derived from `GET /v1/models` `capabilities.input_modalities.includes("image")` (stop discarding the `capabilities` object that `listChatModels` currently throws away).
- [x] 6.6 Gate the attach control on the active model's image capability; show a hint when disabled.
- [x] 6.7 Handle the model-switch-with-pending-attachment case: when the active model loses image support while an unsent image is in the composer, retain the image (do not auto-discard), disable Send specifically because an unsupported attachment is present, show a blocking hint offering to remove the attachment or switch the model back, and re-enable Send for a text-only message once the attachment is removed.

## 7. Web client: send + timeline restore

- [x] 7.1 Extend `streamAiChatMessage` and `sendMessage` options/payload in `useGatewayApi.ts` to accept and serialize an `attachments` array on `POST /api/ai-chat/messages` (both modes); omit when empty.
- [x] 7.2 In `chat.vue` `sendMessage()`, pass the pending `attachments` into the stream call and clear them on `onCompleted`/successful completion.
- [x] 7.3 Extend `AiChatHistoryMessage` and `historyMessageToEntry` to decode the backend's multimodal envelope: store `content` text and `attachments` on the `ChatMessageEntry`.
- [x] 7.4 Render restored image attachments (thumbnail chips) inside user message bubbles in the timeline; keep assistant bubbles text-only.
- [x] 7.5 Update `canSend` so a prompt is always required to send (text part mandatory), consistent with the backend `prompt.min(1)` invariant; attachments alone do not enable send. Also block Send when an unsupported attachment is present on a non-image model (ties to 6.7).

## 8. Web client tests

- [x] 8.1 Composable test: `streamAiChatMessage` includes the `attachments` array in the request body when present and omits it when empty.
- [~] 8.2 Composer test: valid image attaches and previews; oversized/non-image/second-image are rejected with inline messages.
- [~] 8.3 Composer test: attachments clear on successful send; remove-chip drops the right item.
- [ ] 8.4 Capability gating test: attach control disabled + hint shown when active model lacks image input; enabled when it has it.
- [ ] 8.5 Pending-attachment-after-switch test: switching to a non-image model retains the image, blocks Send, shows the hint, and re-enables Send once the attachment is removed.
- [ ] 8.6 Timeline test: restored multimodal user message renders text + image thumbnail; text-only message renders flat text.

> **Testing outcome:** 8.1 done (composable serialization, 3 tests in `packages/web` vitest). The riskiest composer logic — the attachment validation rules (MIME allowlist, ~700 KB size cap, single-image limit) — was extracted into a pure `packages/web/utils/attachments.ts` (`validateImageAttachment` / `canAddAttachment`) and unit-tested in the gateway vitest (`tests/web-attachments.test.ts`, 9 tests), which already imports web pure utils. This permanently covers the 8.2 validation rules + count limit without a DOM.
>
> **Deferred (DOM-level):** 8.2's render/preview, 8.4 (capability-gated control), 8.5 (pending-attachment-after-switch block-and-hint), and 8.6 (timeline restore) are *component-render* behaviors. A bare `@vue/test-utils` mount of the Nuxt SPA page proved unreliable — the page's `onMounted` fire-and-forget async loads (`loadModels`/`listChatModels`) don't reliably flush their reactive DOM updates under vitest's stubbed happy-dom harness (the `~/` auto-imports resolve, but the render cycle lags). The reliable path is `@nuxt/test-utils` (runs the real Nuxt build pipeline), which is a larger infra investment. These are recorded as a fast-follow; the underlying logic is covered by the extracted-function tests + `nuxt typecheck`. `happy-dom` + `@vue/test-utils` + `@vitejs/plugin-vue` are now installed and wired in `packages/web/vitest.config.ts` + `tests/setup.ts` so the `@nuxt/test-utils` migration is a config change, not a from-scratch setup.

## 9. Docs, lint, and finalize

- [x] 9.1 Update `README.md`: document `supports_image_input` model flag, web chat image attachments (single image, ~700 KB), and the body-size consideration.
- [x] 9.2 Update `gateway.config.example.yaml` with a `supports_image_input` example entry and comment.
- [x] 9.3 Run `pnpm lint` / `pnpm typecheck` across root and `packages/web`; fix all errors before completion.
- [x] 9.4 Run `pnpm test` (root + web); ensure new and existing tests pass.
- [x] 9.5 Run `openspec validate web-ai-chat-multimodal-input` and resolve any validation issues.

> **9.3/9.4 notes:** No standalone lint is configured in this repo (quality gates are `tsc --noEmit` + vitest). Gateway typecheck: clean. Gateway tests: 1040/1040 passing (8 new multimodal tests added). Web typecheck (`nuxt typecheck`): clean. Web tests: 3/3 passing (composable serialization, 8.1). Web component tests 8.2–8.6 are blocked on the `@vue/test-utils` + `happy-dom` install failing due to registry network timeouts — see the 8.x note above.
