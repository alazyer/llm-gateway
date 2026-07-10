import { describe, expect, it } from "vitest";

import { toGatewayModel } from "./model-registry.js";

function makeModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "gpt-4o",
    name: "GPT-4o",
    family: "gpt-4o",
    vendor: "copilot",
    version: "1",
    maxInputTokens: 128000,
    ...overrides,
  } as unknown as Parameters<typeof toGatewayModel>[0];
}

describe("toGatewayModel", () => {
  it("uses the copilot- prefix by default", () => {
    const model = toGatewayModel(makeModel(), "copilot-");
    expect(model.id).toBe("copilot-gpt-4o");
    expect(model.source).toBe("copilot-");
  });

  it("uses a custom prefix for model ID and source", () => {
    const model = toGatewayModel(makeModel(), "alazyer-");
    expect(model.id).toBe("alazyer-gpt-4o");
    expect(model.source).toBe("alazyer-");
  });

  it("strips the prefix from the native model ID before re-prepending", () => {
    // A model whose id already starts with "copilot-" should not double-prefix
    const model = toGatewayModel(makeModel({ id: "copilot-gpt-4o" }), "copilot-");
    expect(model.id).toBe("copilot-gpt-4o");
    expect(model.native_id).toBe("copilot-gpt-4o");
  });

  it("does not strip a different prefix from native model IDs", () => {
    // normalizeModelId only strips the *current* prefix, not arbitrary other ones.
    // Native Copilot model IDs don't contain "copilot-" — that prefix is added
    // by the extension. If a model ID happens to start with a different prefix,
    // it is left as-is after normalization and the new prefix is prepended.
    const model = toGatewayModel(makeModel({ id: "copilot-gpt-4o" }), "alazyer-");
    expect(model.id).toBe("alazyer-copilot-gpt-4o");
  });

  it("normalizes the model ID by trimming, lowercasing, and replacing invalid chars", () => {
    const model = toGatewayModel(makeModel({ id: "  GPT-4o Mini  " }), "copilot-");
    expect(model.id).toBe("copilot-gpt-4o-mini");
  });

  it("preserves native_id as the original model.id", () => {
    const model = toGatewayModel(makeModel({ id: "GPT-4o" }), "copilot-");
    expect(model.native_id).toBe("GPT-4o");
  });

  it("includes max_tokens when model.maxInputTokens is a finite positive number", () => {
    const model = toGatewayModel(makeModel({ maxInputTokens: 128000 }), "copilot-");
    expect(model.capabilities.max_tokens).toBe(128000);
  });

  it("omits max_tokens when model.maxInputTokens is Infinity", () => {
    const model = toGatewayModel(makeModel({ maxInputTokens: Infinity }), "copilot-");
    expect(model.capabilities.max_tokens).toBeUndefined();
    // Verify the serialized form doesn't contain null (which the gateway would reject)
    const serialized = JSON.parse(JSON.stringify(model));
    expect(serialized.capabilities.max_tokens).toBeUndefined();
  });

  it("omits max_tokens when model.maxInputTokens is NaN", () => {
    const model = toGatewayModel(makeModel({ maxInputTokens: NaN }), "copilot-");
    expect(model.capabilities.max_tokens).toBeUndefined();
  });

  it("omits max_tokens when model.maxInputTokens is zero", () => {
    const model = toGatewayModel(makeModel({ maxInputTokens: 0 }), "copilot-");
    expect(model.capabilities.max_tokens).toBeUndefined();
  });

  it("omits max_tokens when model.maxInputTokens is negative", () => {
    const model = toGatewayModel(makeModel({ maxInputTokens: -1 }), "copilot-");
    expect(model.capabilities.max_tokens).toBeUndefined();
  });
});
