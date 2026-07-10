import { describe, expect, it } from "vitest";

import {
  validateExtensionMessage,
  validateModel,
  validateModelCapabilities,
} from "../src/copilot-proxy/validation.js";

const validCapabilities = {
  supports_streaming: true,
  supports_tools: false,
  supports_usage: true,
  supports_progress: false,
};

const validModel = {
  id: "copilot-gpt-4o",
  name: "GPT-4o via Copilot",
  native_id: "gpt-4o",
  source: "copilot-",
  capabilities: validCapabilities,
};

describe("validateModelCapabilities", () => {
  it("returns null for valid capabilities", () => {
    expect(validateModelCapabilities(validCapabilities, "ctx")).toBeNull();
  });

  it("returns null for valid capabilities with optional max_tokens as number", () => {
    expect(
      validateModelCapabilities({ ...validCapabilities, max_tokens: 4096 }, "ctx"),
    ).toBeNull();
  });

  it("returns null for valid capabilities with optional max_tokens as null", () => {
    expect(
      validateModelCapabilities({ ...validCapabilities, max_tokens: null }, "ctx"),
    ).toBeNull();
  });

  it("returns null for valid capabilities with optional max_tokens as undefined", () => {
    expect(
      validateModelCapabilities({ ...validCapabilities, max_tokens: undefined }, "ctx"),
    ).toBeNull();
  });

  it("returns null for valid capabilities with optional concurrent_requests", () => {
    expect(
      validateModelCapabilities({ ...validCapabilities, concurrent_requests: 4 }, "ctx"),
    ).toBeNull();
  });

  it("reports when capabilities is not an object", () => {
    expect(validateModelCapabilities(null, "ctx.capabilities")).toBe(
      "ctx.capabilities is not an object",
    );
  });

  it("reports when capabilities is an array", () => {
    expect(validateModelCapabilities([], "ctx.capabilities")).toBe(
      "ctx.capabilities is not an object",
    );
  });

  it("reports when supports_streaming is not a boolean", () => {
    expect(
      validateModelCapabilities({ ...validCapabilities, supports_streaming: "true" }, "ctx"),
    ).toBe(
      'ctx.supports_streaming is not a boolean (got string: "true")',
    );
  });

  it("reports when supports_tools is not a boolean", () => {
    expect(
      validateModelCapabilities({ ...validCapabilities, supports_tools: 1 }, "ctx"),
    ).toBe(
      "ctx.supports_tools is not a boolean (got number: 1)",
    );
  });

  it("reports when supports_usage is not a boolean", () => {
    expect(
      validateModelCapabilities({ ...validCapabilities, supports_usage: null }, "ctx"),
    ).toBe(
      "ctx.supports_usage is not a boolean (got object: null)",
    );
  });

  it("reports when supports_progress is not a boolean", () => {
    expect(
      validateModelCapabilities({ ...validCapabilities, supports_progress: undefined }, "ctx"),
    ).toBe(
      "ctx.supports_progress is not a boolean (got undefined: undefined)",
    );
  });

  it("reports when max_tokens is a string instead of number/null/undefined", () => {
    expect(
      validateModelCapabilities({ ...validCapabilities, max_tokens: "4096" }, "ctx"),
    ).toBe(
      'ctx.max_tokens is not a number (got string: "4096")',
    );
  });

  it("reports when max_tokens is a boolean", () => {
    expect(
      validateModelCapabilities({ ...validCapabilities, max_tokens: true }, "ctx"),
    ).toBe(
      "ctx.max_tokens is not a number (got boolean: true)",
    );
  });

  it("reports when concurrent_requests is a string", () => {
    expect(
      validateModelCapabilities({ ...validCapabilities, concurrent_requests: "4" }, "ctx"),
    ).toBe(
      'ctx.concurrent_requests is not a number (got string: "4")',
    );
  });
});

describe("validateModel", () => {
  it("returns null for a valid model", () => {
    expect(validateModel(validModel, "models[0]")).toBeNull();
  });

  it("reports when model is not an object", () => {
    expect(validateModel(null, "models[0]")).toBe("models[0] is not an object");
  });

  it("reports when model.id is not a string", () => {
    expect(validateModel({ ...validModel, id: 123 }, "models[0]")).toBe(
      "models[0]: id is not a string",
    );
  });

  it("reports when model.name is not a string", () => {
    expect(validateModel({ ...validModel, name: null }, "models[0]")).toBe(
      "models[0]: name is not a string",
    );
  });

  it("reports when model.native_id is not a string", () => {
    expect(validateModel({ ...validModel, native_id: true }, "models[0]")).toBe(
      "models[0]: native_id is not a string",
    );
  });

  it("reports when model.source is not a string", () => {
    expect(validateModel({ ...validModel, source: undefined }, "models[0]")).toBe(
      "models[0]: source is not a string",
    );
  });

  it("reports when model.capabilities is invalid", () => {
    expect(
      validateModel(
        { ...validModel, capabilities: { ...validCapabilities, supports_streaming: "yes" } },
        "models[0]",
      ),
    ).toBe(
      'models[0].capabilities.supports_streaming is not a boolean (got string: "yes")',
    );
  });

  it("reports when model.capabilities is missing", () => {
    expect(
      validateModel(
        { id: "x", name: "x", native_id: "x", source: "x" },
        "models[0]",
      ),
    ).toBe("models[0].capabilities is not an object");
  });
});

describe("validateExtensionMessage", () => {
  // --- Valid messages return null ---

  it("returns null for a valid register message", () => {
    expect(
      validateExtensionMessage({
        type: "register",
        models: [validModel],
        extension_version: "0.1.0",
        copilot_status: "connected",
      }),
    ).toBeNull();
  });

  it("returns null for a valid register message with optional fields", () => {
    expect(
      validateExtensionMessage({
        type: "register",
        models: [validModel],
        extension_version: "0.1.0",
        copilot_status: "connected",
        copilot_user: "user@example.com",
        status_message: "All good",
      }),
    ).toBeNull();
  });

  it("returns null for a valid status_update message", () => {
    expect(
      validateExtensionMessage({
        type: "status_update",
        available_models: [validModel],
        copilot_status: "disconnected",
      }),
    ).toBeNull();
  });

  it("returns null for a valid stream_delta message", () => {
    expect(
      validateExtensionMessage({
        type: "stream_delta",
        id: "abc-123",
        content_type: "text",
      }),
    ).toBeNull();
  });

  it("returns null for a valid stream_done message", () => {
    expect(
      validateExtensionMessage({
        type: "stream_done",
        id: "abc-123",
      }),
    ).toBeNull();
  });

  it("returns null for a valid stream_error message", () => {
    expect(
      validateExtensionMessage({
        type: "stream_error",
        id: "abc-123",
        partial: false,
        error: { code: "rate_limit", message: "Too many requests" },
      }),
    ).toBeNull();
  });

  it("returns null for a valid pong message", () => {
    expect(validateExtensionMessage({ type: "pong" })).toBeNull();
  });

  it("returns null for a valid disconnect message", () => {
    expect(validateExtensionMessage({ type: "disconnect", reason: "bye" })).toBeNull();
  });

  it("returns null for a disconnect message without reason", () => {
    expect(validateExtensionMessage({ type: "disconnect" })).toBeNull();
  });

  // --- Top-level structure failures ---

  it("reports when message is not an object", () => {
    expect(validateExtensionMessage("hello")).toBe("message is not an object");
  });

  it("reports when message is null", () => {
    expect(validateExtensionMessage(null)).toBe("message is not an object");
  });

  it("reports when message is an array", () => {
    expect(validateExtensionMessage([])).toBe("message is not an object");
  });

  it("reports when message is missing type field", () => {
    expect(validateExtensionMessage({ foo: "bar" })).toBe(
      "message is missing type field or type is not a string",
    );
  });

  it("reports when type is not a string", () => {
    expect(validateExtensionMessage({ type: 42 })).toBe(
      "message is missing type field or type is not a string",
    );
  });

  // --- Unknown type ---

  it("reports unknown message type", () => {
    expect(validateExtensionMessage({ type: "unknown_type" })).toBe(
      'unknown message type: "unknown_type"',
    );
  });

  // --- register message failures ---

  it("reports when register models is not an array", () => {
    expect(
      validateExtensionMessage({
        type: "register",
        models: "not-array",
        extension_version: "0.1.0",
        copilot_status: "connected",
      }),
    ).toBe("register message: models is not an array");
  });

  it("reports when register has an invalid model", () => {
    expect(
      validateExtensionMessage({
        type: "register",
        models: [{ ...validModel, id: 123 }],
        extension_version: "0.1.0",
        copilot_status: "connected",
      }),
    ).toBe("register message: models[0]: id is not a string");
  });

  it("reports when register has an invalid model at index > 0", () => {
    expect(
      validateExtensionMessage({
        type: "register",
        models: [validModel, { ...validModel, name: null }],
        extension_version: "0.1.0",
        copilot_status: "connected",
      }),
    ).toBe("register message: models[1]: name is not a string");
  });

  it("reports when register model has invalid capabilities", () => {
    expect(
      validateExtensionMessage({
        type: "register",
        models: [{ ...validModel, capabilities: { ...validCapabilities, supports_streaming: "true" } }],
        extension_version: "0.1.0",
        copilot_status: "connected",
      }),
    ).toBe(
      'register message: models[0].capabilities.supports_streaming is not a boolean (got string: "true")',
    );
  });

  it("reports when register extension_version is not a string", () => {
    expect(
      validateExtensionMessage({
        type: "register",
        models: [validModel],
        extension_version: 1,
        copilot_status: "connected",
      }),
    ).toBe("register message: extension_version is not a string");
  });

  it("reports when register copilot_status is invalid", () => {
    expect(
      validateExtensionMessage({
        type: "register",
        models: [validModel],
        extension_version: "0.1.0",
        copilot_status: "pending",
      }),
    ).toBe('register message: invalid copilot_status value ("pending")');
  });

  it("reports when register copilot_status is missing", () => {
    expect(
      validateExtensionMessage({
        type: "register",
        models: [validModel],
        extension_version: "0.1.0",
      }),
    ).toBe("register message: invalid copilot_status value (undefined)");
  });

  it("reports when register copilot_user is not a string", () => {
    expect(
      validateExtensionMessage({
        type: "register",
        models: [validModel],
        extension_version: "0.1.0",
        copilot_status: "connected",
        copilot_user: 42,
      }),
    ).toBe("register message: copilot_user is not a string");
  });

  it("reports when register status_message is not a string", () => {
    expect(
      validateExtensionMessage({
        type: "register",
        models: [validModel],
        extension_version: "0.1.0",
        copilot_status: "connected",
        status_message: false,
      }),
    ).toBe("register message: status_message is not a string");
  });

  // --- status_update message failures ---

  it("reports when status_update available_models is not an array", () => {
    expect(
      validateExtensionMessage({
        type: "status_update",
        available_models: null,
        copilot_status: "connected",
      }),
    ).toBe("status_update message: available_models is not an array");
  });

  it("reports when status_update has invalid model", () => {
    expect(
      validateExtensionMessage({
        type: "status_update",
        available_models: [{ ...validModel, source: 123 }],
        copilot_status: "connected",
      }),
    ).toBe("status_update message: available_models[0]: source is not a string");
  });

  it("reports when status_update copilot_status is invalid", () => {
    expect(
      validateExtensionMessage({
        type: "status_update",
        available_models: [validModel],
        copilot_status: "unknown",
      }),
    ).toBe('status_update message: invalid copilot_status value ("unknown")');
  });

  it("reports when status_update status_message is not a string", () => {
    expect(
      validateExtensionMessage({
        type: "status_update",
        available_models: [validModel],
        copilot_status: "connected",
        status_message: 99,
      }),
    ).toBe("status_update message: status_message is not a string");
  });

  // --- stream_delta message failures ---

  it("reports when stream_delta id is not a string", () => {
    expect(
      validateExtensionMessage({
        type: "stream_delta",
        id: 123,
        content_type: "text",
      }),
    ).toBe("stream_delta message: id is not a string");
  });

  it("reports when stream_delta content_type is not a string", () => {
    expect(
      validateExtensionMessage({
        type: "stream_delta",
        id: "abc",
        content_type: null,
      }),
    ).toBe("stream_delta message: content_type is not a string");
  });

  it("reports when stream_delta content_type is invalid", () => {
    expect(
      validateExtensionMessage({
        type: "stream_delta",
        id: "abc",
        content_type: "image",
      }),
    ).toBe('stream_delta message: invalid content_type value ("image")');
  });

  // --- stream_done message failures ---

  it("reports when stream_done id is not a string", () => {
    expect(
      validateExtensionMessage({
        type: "stream_done",
        id: null,
      }),
    ).toBe("stream_done message: id is not a string");
  });

  // --- stream_error message failures ---

  it("reports when stream_error id is not a string", () => {
    expect(
      validateExtensionMessage({
        type: "stream_error",
        id: 42,
        partial: false,
        error: { code: "err", message: "fail" },
      }),
    ).toBe("stream_error message: id is not a string");
  });

  it("reports when stream_error partial is not a boolean", () => {
    expect(
      validateExtensionMessage({
        type: "stream_error",
        id: "abc",
        partial: "true",
        error: { code: "err", message: "fail" },
      }),
    ).toBe("stream_error message: partial is not a boolean (got string)");
  });

  it("reports when stream_error error is not an object", () => {
    expect(
      validateExtensionMessage({
        type: "stream_error",
        id: "abc",
        partial: true,
        error: "not-an-object",
      }),
    ).toBe("stream_error message: error is not an object");
  });

  it("reports when stream_error error.code is not a string", () => {
    expect(
      validateExtensionMessage({
        type: "stream_error",
        id: "abc",
        partial: true,
        error: { code: 500, message: "fail" },
      }),
    ).toBe("stream_error message: error.code is not a string");
  });

  it("reports when stream_error error.message is not a string", () => {
    expect(
      validateExtensionMessage({
        type: "stream_error",
        id: "abc",
        partial: true,
        error: { code: "err", message: null },
      }),
    ).toBe("stream_error message: error.message is not a string");
  });

  // --- disconnect message failures ---

  it("reports when disconnect reason is not a string", () => {
    expect(
      validateExtensionMessage({
        type: "disconnect",
        reason: 42,
      }),
    ).toBe("disconnect message: reason is not a string");
  });

  // --- Valid register messages with all copilot_status values ---

  it("returns null for register with copilot_status 'connected'", () => {
    expect(
      validateExtensionMessage({
        type: "register",
        models: [validModel],
        extension_version: "0.1.0",
        copilot_status: "connected",
      }),
    ).toBeNull();
  });

  it("returns null for register with copilot_status 'disconnected'", () => {
    expect(
      validateExtensionMessage({
        type: "register",
        models: [validModel],
        extension_version: "0.1.0",
        copilot_status: "disconnected",
      }),
    ).toBeNull();
  });

  it("returns null for register with copilot_status 'error'", () => {
    expect(
      validateExtensionMessage({
        type: "register",
        models: [validModel],
        extension_version: "0.1.0",
        copilot_status: "error",
      }),
    ).toBeNull();
  });

  // --- All valid stream_delta content_type values ---

  it("returns null for stream_delta with content_type 'text'", () => {
    expect(
      validateExtensionMessage({ type: "stream_delta", id: "x", content_type: "text" }),
    ).toBeNull();
  });

  it("returns null for stream_delta with content_type 'tool_call'", () => {
    expect(
      validateExtensionMessage({ type: "stream_delta", id: "x", content_type: "tool_call" }),
    ).toBeNull();
  });

  it("returns null for stream_delta with content_type 'usage'", () => {
    expect(
      validateExtensionMessage({ type: "stream_delta", id: "x", content_type: "usage" }),
    ).toBeNull();
  });

  it("returns null for stream_delta with content_type 'progress'", () => {
    expect(
      validateExtensionMessage({ type: "stream_delta", id: "x", content_type: "progress" }),
    ).toBeNull();
  });
});
