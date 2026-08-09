import { GatewayApiError } from "../composables/useGatewayApi";

export interface GatewayErrorClassification {
  title: string;
  message: string;
  requestId?: string;
  marksUnavailable: boolean;
}

function isInputValidationFailure(error: GatewayApiError): boolean {
  if (error.statusCode === 400 || error.statusCode === 422) {
    return true;
  }

  return error.code === "validation_error"
    || error.code === "invalid_request_error"
    || error.code === "request_invalid";
}

export function classifyGatewayError(error: unknown): GatewayErrorClassification {
  if (error instanceof GatewayApiError) {
    const requestId = error.requestId;

    if (error.statusCode === 401 || error.statusCode === 403) {
      return {
        title: "Authentication failure",
        message: "Your gateway token is missing, expired, or unauthorized. Re-authenticate and retry.",
        requestId,
        marksUnavailable: true,
      };
    }

    if (isInputValidationFailure(error)) {
      return {
        title: "Invalid request payload",
        message: "The validation request was rejected as invalid. Check the model selection and prompt format, then retry.",
        requestId,
        marksUnavailable: false,
      };
    }

    if (error.statusCode === 404 || error.code === "model_unavailable") {
      return {
        title: "Model unavailable",
        message: "The selected model is no longer routable. Refresh model discovery and select another model.",
        requestId,
        marksUnavailable: true,
      };
    }

    if (error.statusCode === 429) {
      return {
        title: "Rate limited",
        message: "The gateway or provider throttled this validation request. Retry after a short wait.",
        requestId,
        marksUnavailable: true,
      };
    }

    if (error.code === "validation_timeout" || error.statusCode === 408) {
      return {
        title: "Validation timeout",
        message: error.message,
        requestId,
        marksUnavailable: true,
      };
    }

    if (error.code === "cancelled_by_user") {
      return {
        title: "Validation interrupted",
        message: "The in-flight validation was stopped before completion.",
        requestId,
        marksUnavailable: false,
      };
    }

    return {
      title: "Service failure",
      message: error.message,
      requestId,
      marksUnavailable: true,
    };
  }

  if (error instanceof Error) {
    return {
      title: "Network failure",
      message: error.message,
      marksUnavailable: true,
    };
  }

  return {
    title: "Unknown failure",
    message: "An unexpected error occurred during model validation.",
    marksUnavailable: true,
  };
}
