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
      title: "Invalid request",
      message: "Request failed: 400",
      requestId: "req-400",
      retryable: false,
      marksUnavailable: false,
    });
  });

  it("classifies validation_error codes as invalid request payload", () => {
    const error = new GatewayApiError("Payload validation failed", 500, {
      code: "validation_error",
      requestId: "req-validation",
    });

    expect(classifyGatewayError(error)).toEqual({
      title: "Invalid request",
      message: "Payload validation failed",
      requestId: "req-validation",
      retryable: false,
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
      retryable: false,
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
      retryable: false,
      marksUnavailable: true,
    });
  });

  it("maps each backend typed code to a distinct actionable message", () => {
    const codes = [
      "RATE_LIMITED",
      "UPSTREAM_TIMEOUT",
      "UPSTREAM_UNAVAILABLE",
      "VALIDATION_ERROR",
      "UNAUTHORIZED",
      "FORBIDDEN",
    ] as const;

    const seenTitles = new Set<string>();
    const seenMessages = new Set<string>();

    for (const code of codes) {
      const error = new GatewayApiError("upstream detail", 503, {
        code,
        requestId: `req-${code}`,
      });
      const classified = classifyGatewayError(error);

      expect(classified.requestId).toBe(`req-${code}`);
      expect(classified.title.length).toBeGreaterThan(0);
      expect(classified.message.length).toBeGreaterThan(0);
      // Distinct actionable message per code: both title and message unique.
      expect(seenTitles.has(classified.title)).toBe(false);
      expect(seenMessages.has(classified.message)).toBe(false);
      seenTitles.add(classified.title);
      seenMessages.add(classified.message);
    }

    expect(seenTitles.size).toBe(codes.length);
    expect(seenMessages.size).toBe(codes.length);
  });

  it("presents retry guidance for retryable typed failures", () => {
    const retryableCodes = ["RATE_LIMITED", "UPSTREAM_TIMEOUT", "UPSTREAM_UNAVAILABLE"];
    const nonRetryableCodes = ["VALIDATION_ERROR", "UNAUTHORIZED", "FORBIDDEN"];

    for (const code of retryableCodes) {
      const error = new GatewayApiError("detail", 503, { code, requestId: `req-${code}` });
      expect(classifyGatewayError(error).retryable).toBe(true);
    }

    for (const code of nonRetryableCodes) {
      const error = new GatewayApiError("detail", 503, { code, requestId: `req-${code}` });
      expect(classifyGatewayError(error).retryable).toBe(false);
    }
  });

  it("surfaces a distinct actionable message for UPSTREAM_TIMEOUT", () => {
    const error = new GatewayApiError("timed out", 408, {
      code: "UPSTREAM_TIMEOUT",
      requestId: "req-timeout",
    });
    const classified = classifyGatewayError(error);

    expect(classified.title).toBe("Model timeout");
    expect(classified.retryable).toBe(true);
  });

  it("surfaces a distinct actionable message for UPSTREAM_UNAVAILABLE", () => {
    const error = new GatewayApiError("provider down", 503, {
      code: "UPSTREAM_UNAVAILABLE",
      requestId: "req-unavailable",
    });
    const classified = classifyGatewayError(error);

    expect(classified.title).toBe("Model unavailable");
    expect(classified.retryable).toBe(true);
  });

  it("surfaces a distinct actionable message for RATE_LIMITED", () => {
    const error = new GatewayApiError("too many", 429, {
      code: "RATE_LIMITED",
      requestId: "req-rate",
    });
    const classified = classifyGatewayError(error);

    expect(classified.title).toBe("Rate limited");
    expect(classified.retryable).toBe(true);
  });

  it("treats raw network errors as retryable", () => {
    const classified = classifyGatewayError(new Error("connect ECONNREFUSED"));
    expect(classified.title).toBe("Network failure");
    expect(classified.retryable).toBe(true);
  });
});
