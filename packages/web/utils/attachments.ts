/**
 * Pure attachment-validation logic for the Web AI Chat composer.
 *
 * Extracted from `chat.vue` so the validation rules (MIME allowlist, per-image
 * size cap, single-image limit) are unit-testable without a DOM. The composer
 * calls `validateImageAttachment` per selected file; a non-null result is the
 * rejection message to surface inline.
 */

export const ALLOWED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

/** ~525 KB raw → ~700 KB base64, sized to fit the default 1 MiB body limit. */
export const MAX_IMAGE_BYTES = 525_000;

export const MAX_ATTACHMENTS = 1;

export interface ImageAttachmentCandidate {
  name: string;
  type: string;
  size: number;
}

/**
 * Validate a single candidate image file against the MIME allowlist and the
 * per-image size cap. Returns a rejection message when invalid, or `null` when
 * the file is acceptable. The single-image-per-message limit is enforced by the
 * caller (it is a count constraint, not a per-file property).
 */
export function validateImageAttachment(
  file: ImageAttachmentCandidate,
  options: { maxBytes?: number; allowedTypes?: readonly string[] } = {},
): string | null {
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
  const allowedTypes = options.allowedTypes ?? ALLOWED_IMAGE_TYPES;

  if (!allowedTypes.includes(file.type)) {
    return `${file.name}: unsupported file type. Use PNG, JPEG, WebP, or GIF.`;
  }
  if (file.size > maxBytes) {
    return `${file.name}: image exceeds the ${Math.round(maxBytes / 1000)} KB limit.`;
  }
  return null;
}

/**
 * Whether a new attachment may be added given the current count and the
 * per-message maximum. The composer uses this to reject a second image.
 */
export function canAddAttachment(currentCount: number, max: number = MAX_ATTACHMENTS): boolean {
  return currentCount < max;
}
