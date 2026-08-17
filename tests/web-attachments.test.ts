import { describe, expect, it } from "vitest";

import {
  ALLOWED_IMAGE_TYPES,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  canAddAttachment,
  validateImageAttachment,
} from "../packages/web/utils/attachments";

describe("validateImageAttachment", () => {
  it("accepts a valid image under the size cap", () => {
    expect(
      validateImageAttachment({ name: "pic.png", type: "image/png", size: 1024 }),
    ).toBeNull();
  });

  it("accepts every allowed MIME type", () => {
    for (const type of ALLOWED_IMAGE_TYPES) {
      expect(
        validateImageAttachment({ name: `f.${type}`, type, size: 1024 }),
      ).toBeNull();
    }
  });

  it("rejects a non-image file with an inline message", () => {
    const message = validateImageAttachment({
      name: "doc.pdf",
      type: "application/pdf",
      size: 1024,
    });
    expect(message).toContain("unsupported file type");
  });

  it("rejects an oversized image with an inline message", () => {
    const message = validateImageAttachment({
      name: "big.png",
      type: "image/png",
      size: MAX_IMAGE_BYTES + 1,
    });
    expect(message).toContain("exceeds");
    expect(message).toContain("big.png");
  });

  it("accepts an image exactly at the size cap", () => {
    expect(
      validateImageAttachment({ name: "edge.png", type: "image/png", size: MAX_IMAGE_BYTES }),
    ).toBeNull();
  });

  it("respects a caller-supplied maxBytes override", () => {
    const message = validateImageAttachment(
      { name: "tiny.png", type: "image/png", size: 2_000 },
      { maxBytes: 1_000 },
    );
    expect(message).toContain("exceeds");
  });
});

describe("canAddAttachment", () => {
  it("allows adding when below the cap", () => {
    expect(canAddAttachment(0)).toBe(true);
  });

  it("blocks adding once the cap is reached", () => {
    expect(canAddAttachment(MAX_ATTACHMENTS)).toBe(false);
  });

  it("respects a caller-supplied cap", () => {
    expect(canAddAttachment(2, 3)).toBe(true);
    expect(canAddAttachment(3, 3)).toBe(false);
  });
});
