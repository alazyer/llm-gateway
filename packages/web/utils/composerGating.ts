/**
 * Pure composer-capability gating logic for the Web AI Chat.
 *
 * Extracted from `chat.vue`'s computed properties so the rules that gate the
 * attachment control and the Send button are unit-testable without a DOM
 * mount. The component reads its reactive state (`models`, `selectedModelId`,
 * `attachments`, `hasGatewayCredential`) and feeds the plain values into these
 * functions; the functions are pure and deterministic.
 *
 * Behavior mirrored from `chat.vue`:
 * - `activeModelSupportsImage`: the active (selected) model accepts image input.
 * - `hasIncompatibleAttachment`: a pending image is present but the active model
 *   does not support images — Send must be blocked, not silently stripped.
 * - `canSend`: authenticated AND no incompatible attachment. A prompt is always
 *   required to send (the backend enforces `prompt.min(1)`); attachments alone
 *   never enable Send. The prompt-presence check is asserted in `sendMessage`,
 *   so `canSend` reflects only the gating state the composer owns here.
 */

import type { AiChatAttachment, AiChatChatModel } from "../composables/useGatewayApi";

/**
 * Whether the active (selected) model accepts image input. Drives the
 * attachment-control gate. Returns `false` when no model is selected or the
 * selected id is no longer in the catalog (mirrors
 * `model?.inputModalities.includes("image") ?? false`).
 */
export function activeModelSupportsImage(
  models: AiChatChatModel[],
  selectedModelId: string,
): boolean {
  const model = models.find((m) => m.id === selectedModelId);
  return model?.inputModalities.includes("image") ?? false;
}

/**
 * Whether a pending (unsent) image is incompatible with the active model —
 * the composer blocks Send rather than silently stripping the image (the
 * backend would reject it with `VALIDATION_ERROR`). The pending image is
 * retained (not auto-discarded) so the user can switch back.
 */
export function hasIncompatibleAttachment(
  attachments: AiChatAttachment[],
  supportsImage: boolean,
): boolean {
  return attachments.length > 0 && !supportsImage;
}

/**
 * Whether the Send button is enabled. Sending requires authentication and no
 * incompatible attachment. The text `prompt` is always required to send
 * (mandatory text part per the backend `prompt.min(1)` invariant); the prompt
 * presence is checked separately in `sendMessage`, so `canSend` reflects only
 * the gating state owned here.
 */
export function canSend(
  hasGatewayCredential: boolean,
  incompatibleAttachment: boolean,
): boolean {
  return hasGatewayCredential && !incompatibleAttachment;
}

/**
 * The state label surfaced under the composer for the incompatible-attachment
 * case. Kept as a pure helper so the exact hint text is assertion-covered.
 */
export function incompatibleAttachmentHint(): string {
  return "Remove the attachment or switch to an image-capable model to send.";
}
