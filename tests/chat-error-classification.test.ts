import { describe, expect, it } from "vitest";
import { GatewayApiError } from "../packages/web/composables/useGatewayApi";
import { classifyGatewayError } from "../packages/web/utils/chatErrorClassification";

describe("classifyGatewayError", () => {
  it("classifies 400 responses as invalid request payload", () => {
    const error = new GatewayApiError("Request failed: 400", 400, {
      code: "bad_request",
      requestId: "req-400",
    });

    expect(classifyGatewayError(error)).toEqual({
      title: "Invalid request payload",
      message: "The validation request was rejected as invalid. Check the model selection and prompt format, then retry.",
      requestId: "req-400",
      marksUnavailable: false,
    });
  });

  it("classifies validation_error codes as invalid request payload", () => {
    const error = new GatewayApiError("Payload validation failed", 500, {
      code: "validation_error",
      requestId: "req-validation",
    });

    expect(classifyGatewayError(error)).toEqual({
      title: "Invalid request payload",
      message: "The validation request was rejected as invalid. Check the model selection and prompt format, then retry.",
      requestId: "req-validation",
      marksUnavailable: false,
    });
  });

  it("keeps model_unavailable behavior unchanged", () => {
    const error = new GatewayApiError("Model not found", 404, {
      code: "model_unavailable",
      requestId: "req-404",
    });

    expect(classifyGatewayError(error)).toEqual({
      title: "Model unavailable",
      message: "The selected model is no longer routable. Refresh model discovery and select another model.",
      requestId: "req-404",
      marksUnavailable: true,
    });
  });

  it("keeps generic failures as service failure", () => {
    const error = new GatewayApiError("Provider crashed", 500, {
      requestId: "req-500",
    });

    expect(classifyGatewayError(error)).toEqual({
      title: "Service failure",
      message: "Provider crashed",
      requestId: "req-500",
      marksUnavailable: true,
    });
  });
});
