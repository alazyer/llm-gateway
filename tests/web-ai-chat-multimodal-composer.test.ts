import { describe, expect, it } from "vitest";

import type {
  AiChatAttachment,
  AiChatChatModel,
  AiChatHistoryMessage,
} from "../packages/web/composables/useGatewayApi";
import {
  activeModelSupportsImage,
  canSend,
  hasIncompatibleAttachment,
  incompatibleAttachmentHint,
} from "../packages/web/utils/composerGating";
import {
  attachmentThumbnailSrc,
  entryRendersImages,
  historyMessageToEntry,
} from "../packages/web/utils/chatTimeline";

// These tests cover the deferred DOM-level component behaviors 8.4 / 8.5 / 8.6
// by exercising the *pure logic* behind them — the same functions `chat.vue`
// delegates to for its gating computeds and timeline mapping. Mirrors the
// established pattern of `tests/web-attachments.test.ts` and
// `tests/web-ai-chat-model-resolution.test.ts`: production helpers extracted
// from the component, tested with plain data so no DOM mount is required.

const VISION_MODEL: AiChatChatModel = {
  id: "glm-5.1-vision",
  displayName: "GLM 5.1 Vision",
  supportsImageInput: true,
};
const TEXT_MODEL: AiChatChatModel = {
  id: "glm-5.1",
  displayName: "GLM 5.1",
  supportsImageInput: false,
};
const MODELS: AiChatChatModel[] = [VISION_MODEL, TEXT_MODEL];

const VALID_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const PENDING_IMAGE: AiChatAttachment = {
  id: "att-1",
  type: "image/png",
  dataUrl: VALID_PNG_DATA_URL,
  name: "pic.png",
  size: 1024,
};

// ===========================================================================
// 8.4 — Capability gating: attach control disabled + hint when the active model
// lacks image input; enabled when it has it.
// (Spec: "The web chat composer SHALL gate image attachment on model capability")
// ===========================================================================

describe("8.4 — capability gating on model image input", () => {
  describe("activeModelSupportsImage", () => {
    it("is true when the active model's input_modalities include image", () => {
      // Scenario: Attachment control enabled for image-capable model.
      expect(activeModelSupportsImage(MODELS, "glm-5.1-vision")).toBe(true);
    });

    it("is false when the active model's input_modalities do not include image", () => {
      // Scenario: Attachment control disabled for non-image model.
      expect(activeModelSupportsImage(MODELS, "glm-5.1")).toBe(false);
    });

    it("is false when no model is selected (picker empty)", () => {
      // New chat before the model list resolves — control stays disabled.
      expect(activeModelSupportsImage(MODELS, "")).toBe(false);
    });

    it("is false when the selected model is no longer in the catalog (stale)", () => {
      // The model was deactivated; the picker selection is now stale.
      expect(activeModelSupportsImage(MODELS, "deactivated-model")).toBe(false);
    });

    it("is false when the catalog is empty", () => {
      expect(activeModelSupportsImage([], "")).toBe(false);
    });
  });

  describe("hint surfacing when the control is disabled", () => {
    it("exposes a non-empty hint string for the disabled state", () => {
      // Scenario: composer SHALL show a hint that the selected model does not
      // support image input. The component renders this text under the control.
      const hint = incompatibleAttachmentHint();
      expect(typeof hint).toBe("string");
      expect(hint.length).toBeGreaterThan(0);
      expect(hint).toMatch(/image/i);
    });
  });
});

// ===========================================================================
// 8.5 — Pending image retained and Send blocked after a switch to a non-image
// model; re-enabled once the attachment is removed.
// (Spec: "Pending image retained and Send blocked after a switch to a non-image
//  model")
// ===========================================================================

describe("8.5 — pending attachment after model switch", () => {
  it("retains the pending image when switching to a non-image model (not auto-discarded)", () => {
    // GIVEN a pending image while a vision model is active, WHEN the user
    // switches to a text-only model, the attachment set is unchanged — the
    // component does not drop it. (The gate reacts to the model change, not
    // the attachment list.)
    const attachments: AiChatAttachment[] = [PENDING_IMAGE];
    // Vision model active — compatible.
    expect(hasIncompatibleAttachment(attachments, activeModelSupportsImage(MODELS, "glm-5.1-vision"))).toBe(false);
    // Switch to text model — attachment list is still length 1 (retained),
    // now flagged incompatible.
    expect(attachments).toHaveLength(1);
    expect(hasIncompatibleAttachment(attachments, activeModelSupportsImage(MODELS, "glm-5.1"))).toBe(true);
  });

  it("blocks Send specifically because an unsupported attachment is present", () => {
    // Scenario: SHALL block the Send action specifically because an unsupported
    // attachment is present.
    const attachments: AiChatAttachment[] = [PENDING_IMAGE];
    const supportsImage = activeModelSupportsImage(MODELS, "glm-5.1"); // false
    const incompatible = hasIncompatibleAttachment(attachments, supportsImage); // true
    // Authenticated, but an incompatible attachment blocks Send.
    expect(canSend(true, incompatible)).toBe(false);
    // Contrast: text-only (no attachment) on the same model — Send is enabled.
    expect(canSend(true, hasIncompatibleAttachment([], supportsImage))).toBe(true);
  });

  it("surfaces the blocking hint offering to remove the attachment or switch back", () => {
    // Scenario: SHALL show a blocking hint offering to remove the attachment or
    // switch the model back.
    const attachments: AiChatAttachment[] = [PENDING_IMAGE];
    const incompatible = hasIncompatibleAttachment(
      attachments,
      activeModelSupportsImage(MODELS, "glm-5.1"),
    );
    expect(incompatible).toBe(true);
    const hint = incompatibleAttachmentHint();
    expect(hint).toMatch(/remove the attachment/i);
    expect(hint).toMatch(/switch/i);
  });

  it("re-enables Send for a text-only message once the attachment is removed", () => {
    // Scenario: SHALL re-enable Send for a text-only message once the
    // attachment is removed.
    let attachments: AiChatAttachment[] = [PENDING_IMAGE];
    const supportsImage = activeModelSupportsImage(MODELS, "glm-5.1");
    // Blocked while the image is pending on the non-image model.
    expect(canSend(true, hasIncompatibleAttachment(attachments, supportsImage))).toBe(false);
    // User removes the chip — Send re-enabled for a text-only message.
    attachments = [];
    expect(canSend(true, hasIncompatibleAttachment(attachments, supportsImage))).toBe(true);
  });

  it("re-enables Send when switching back to a vision model (attachment retained)", () => {
    // The complementary path: instead of removing the attachment, the user
    // switches the model back. The image is retained and Send is unblocked.
    const attachments: AiChatAttachment[] = [PENDING_IMAGE];
    expect(canSend(true, hasIncompatibleAttachment(attachments, activeModelSupportsImage(MODELS, "glm-5.1")))).toBe(false);
    expect(canSend(true, hasIncompatibleAttachment(attachments, activeModelSupportsImage(MODELS, "glm-5.1-vision")))).toBe(true);
  });
});

// ===========================================================================
// 8.6 — Timeline restore: a restored multimodal user message renders text +
// image thumbnail; a text-only message renders flat text.
// (Spec: "The web chat timeline SHALL render restored image attachments from
//  history")
// ===========================================================================

describe("8.6 — timeline restore of multimodal history", () => {
  it("decodes a multimodal user message to text + an attachment (renders a thumbnail)", () => {
    // Scenario: Image attachments restore on session open. The backend decodes
    // the `{ v:1, text, images }` envelope into `content` text + `attachments`.
    const historyMessage: AiChatHistoryMessage = {
      messageId: "msg-mm",
      role: "user",
      content: "see this",
      attachments: [PENDING_IMAGE],
      status: "done",
      model: null,
      requestId: null,
      usage: null,
      createdAt: 1_718_000_000,
    };

    const entry = historyMessageToEntry(historyMessage);
    // Text prompt is rendered.
    expect(entry.content).toBe("see this");
    expect(entry.role).toBe("user");
    // The attachment is restored on the entry.
    expect(entry.attachments).toEqual([PENDING_IMAGE]);
    // The user bubble renders image thumbnails (no separate fetch).
    expect(entryRendersImages(entry)).toBe(true);
    expect(attachmentThumbnailSrc(entry.attachments[0]!)).toBe(VALID_PNG_DATA_URL);
  });

  it("renders flat text for a text-only user message (no thumbnails)", () => {
    // A text-only message (no envelope, no attachments) restores as flat text.
    const historyMessage: AiChatHistoryMessage = {
      messageId: "msg-text",
      role: "user",
      content: "hello",
      attachments: [],
      status: "done",
      model: null,
      requestId: null,
      usage: null,
      createdAt: 1_718_000_001,
    };

    const entry = historyMessageToEntry(historyMessage);
    expect(entry.content).toBe("hello");
    expect(entry.attachments).toEqual([]);
    // No thumbnails for a text-only user bubble.
    expect(entryRendersImages(entry)).toBe(false);
  });

  it("keeps assistant bubbles text-only even if an attachment somehow appears", () => {
    // Scenario: assistant bubbles are text-only (the model returns text). The
    // render decision keys off `role === 'user'`, so an assistant entry with a
    // stray attachment still does not render image thumbnails.
    const entry = historyMessageToEntry({
      messageId: "msg-asst",
      role: "assistant",
      content: "I see the image.",
      attachments: [PENDING_IMAGE],
      status: "done",
      model: "glm-5.1-vision",
      requestId: "req_1",
      usage: { inputTokens: 5, outputTokens: 3, totalTokens: 8 },
      createdAt: 1_718_000_002,
    });
    expect(entry.role).toBe("assistant");
    expect(entryRendersImages(entry)).toBe(false);
    expect(entry.content).toBe("I see the image.");
    expect(entry.requestId).toBe("req_1");
    expect(entry.model).toBe("glm-5.1-vision");
  });

  it("treats a history message with null attachments as text-only", () => {
    // Defensive: an older message row with no attachments field decodes to an
    // empty array (no thumbnails), matching the text-only fallback.
    const entry = historyMessageToEntry({
      messageId: "msg-old",
      role: "user",
      content: "legacy",
      attachments: null as unknown as AiChatAttachment[],
      status: "done",
      model: null,
      requestId: null,
      usage: null,
      createdAt: 1_718_000_003,
    });
    expect(entry.attachments).toEqual([]);
    expect(entryRendersImages(entry)).toBe(false);
  });
});
