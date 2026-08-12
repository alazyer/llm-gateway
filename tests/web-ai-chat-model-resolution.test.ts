import { describe, expect, it } from "vitest";

import {
  resolveSelectedModel,
  type AiChatChatModel,
} from "../packages/web/composables/useGatewayApi";

// Mirror the pagination-helper test pattern (tests/web-ai-chat-history.test.ts):
// pure functions imported from the composable, exercised with plain data.
// `resolveSelectedModel` mirrors the backend's per-request model resolution on
// the client side so the picker reflects what will be sent.

const MODELS: AiChatChatModel[] = [
  { id: "alpha", displayName: "Alpha" },
  { id: "beta", displayName: "Beta" },
  { id: "gamma", displayName: "Gamma" },
];

describe("resolveSelectedModel", () => {
  describe("new session (sessionModel is null)", () => {
    it("keeps the current selection when it is a valid model", () => {
      // New chat, user already had `beta` selected from a previous interaction.
      expect(resolveSelectedModel(MODELS, null, "beta")).toBe("beta");
    });

    it("defaults to the first available model when nothing is selected", () => {
      expect(resolveSelectedModel(MODELS, null, "")).toBe("alpha");
    });

    it("defaults to the first available model when the selection is stale", () => {
      // Selection points at a model that is no longer configured/active.
      expect(resolveSelectedModel(MODELS, null, "delta")).toBe("alpha");
    });
  });

  describe("existing session (sessionModel is set)", () => {
    it("restores the session's stored model when it is still available", () => {
      // Reopening a session whose stored model is `gamma` restores the picker.
      expect(resolveSelectedModel(MODELS, "gamma", "alpha")).toBe("gamma");
    });

    it("keeps the current selection when the stored model is no longer available", () => {
      // Stored model was deactivated since the session was created; the backend
      // will reject an unavailable model, so the client keeps the user's current
      // pick rather than silently snapping to the stale stored id.
      expect(resolveSelectedModel(MODELS, "delta", "beta")).toBe("beta");
    });
  });

  describe("mid-session model switch", () => {
    it("restores the session's stored model when it is valid and the current selection differs", () => {
      // Mid-session, the stored model is authoritative for an existing session:
      // the picker reflects the session's model, not a transient selection. The
      // actual switch is driven by the component setting selectedModelId and the
      // backend updating the session's stored model on the next send.
      expect(resolveSelectedModel(MODELS, "alpha", "gamma")).toBe("alpha");
    });

    it("honors the current selection when the stored model is stale", () => {
      // After switching mid-session to `gamma` and persisting it, a stale view
      // of the stored model (`delta`, now deactivated) yields to the current
      // valid selection.
      expect(resolveSelectedModel(MODELS, "delta", "gamma")).toBe("gamma");
    });

    it("falls back to the first available model when neither stored nor current is valid", () => {
      expect(resolveSelectedModel(MODELS, "delta", "epsilon")).toBe("alpha");
    });
  });

  describe("edge cases", () => {
    it("returns the current selection unchanged when no models are available", () => {
      expect(resolveSelectedModel([], "alpha", "beta")).toBe("beta");
      expect(resolveSelectedModel([], null, "")).toBe("");
    });

    it("treats an empty-string stored model as a new session", () => {
      // Defensive: an empty stored model must not match the "exists" check and
      // must fall through to the current-selection / default path.
      expect(resolveSelectedModel(MODELS, "", "beta")).toBe("beta");
    });
  });
});
