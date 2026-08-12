import { GatewayApiError } from "../composables/useGatewayApi";

export interface GatewayErrorClassification {
  title: string;
  message: string;
  requestId?: string;
  /** Whether retry guidance should be presented for this failure. */
  retryable: boolean;
  /** Kept for callers that branch on availability; true for failures that
   * indicate the upstream is currently unusable. */
  marksUnavailable: boolean;
}

/**
 * Backend Web AI Chat typed failure codes. Each maps to a distinct, actionable,
 * localized message plus retry guidance (see spec: "Typed failures render
 * actionable localized messages").
 */
type AiChatTypedCode =
  | "RATE_LIMITED"
  | "UPSTREAM_TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN";

interface TypedFailureCopy {
  title: string;
  message: string;
  retryable: boolean;
  marksUnavailable: boolean;
}

const TYPED_FAILURE_COPY: Record<AiChatTypedCode, TypedFailureCopy> = {
  RATE_LIMITED: {
    title: "Rate limited",
    message: "Too many requests were sent. Please wait a moment and retry.",
    retryable: true,
    marksUnavailable: true,
  },
  UPSTREAM_TIMEOUT: {
    title: "Model timeout",
    message: "The model took too long to respond. Please try again.",
    retryable: true,
    marksUnavailable: true,
  },
  UPSTREAM_UNAVAILABLE: {
    title: "Model unavailable",
    message: "The model is currently unavailable. Please retry shortly.",
    retryable: true,
    marksUnavailable: true,
  },
  VALIDATION_ERROR: {
    title: "Invalid request",
    message: "The request could not be processed. Check your input and retry.",
    retryable: false,
    marksUnavailable: false,
  },
  UNAUTHORIZED: {
    title: "Authentication required",
    message: "Your gateway token is missing, expired, or unauthorized. Re-authenticate and retry.",
    retryable: false,
    marksUnavailable: true,
  },
  FORBIDDEN: {
    title: "Access denied",
    message: "You do not have access to this chat session.",
    retryable: false,
    marksUnavailable: true,
  },
};

function isTypedCode(code: string | undefined): code is AiChatTypedCode {
  return !!code && Object.prototype.hasOwnProperty.call(TYPED_FAILURE_COPY, code);
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

    // Backend typed failure codes take precedence — a distinct, actionable,
    // localized message per code, with retry guidance for retryable failures.
    // The localized copy is authoritative so each code renders a distinct
    // message; the raw upstream message is folded in only when it is more
    // specific than the generic localized text.
    if (isTypedCode(error.code)) {
      const copy = TYPED_FAILURE_COPY[error.code];
      const upstreamMessage = error.message;
      const message = upstreamMessage && upstreamMessage !== copy.message && upstreamMessage.length > 0
        ? `${copy.message} (${upstreamMessage})`
        : copy.message;
      return {
        title: copy.title,
        message,
        requestId,
        retryable: copy.retryable,
        marksUnavailable: copy.marksUnavailable,
      };
    }

    // HTTP-status fallbacks for failures that arrive without a typed code
    // (e.g. raw gateway 401/403 before the typed AI Chat layer).
    if (error.statusCode === 401) {
      return {
        ...TYPED_FAILURE_COPY.UNAUTHORIZED,
        message: error.message || TYPED_FAILURE_COPY.UNAUTHORIZED.message,
        requestId,
      };
    }

    if (error.statusCode === 403) {
      return {
        ...TYPED_FAILURE_COPY.FORBIDDEN,
        message: error.message || TYPED_FAILURE_COPY.FORBIDDEN.message,
        requestId,
      };
    }

    if (error.code === "model_unavailable" || error.statusCode === 404) {
      return {
        title: "Model unavailable",
        message: "The selected model is no longer routable. Refresh model discovery and select another model.",
        requestId,
        retryable: false,
        marksUnavailable: true,
      };
    }

    if (error.statusCode === 429) {
      return {
        ...TYPED_FAILURE_COPY.RATE_LIMITED,
        message: error.message || TYPED_FAILURE_COPY.RATE_LIMITED.message,
        requestId,
      };
    }

    if (isInputValidationFailure(error)) {
      return {
        ...TYPED_FAILURE_COPY.VALIDATION_ERROR,
        message: error.message || TYPED_FAILURE_COPY.VALIDATION_ERROR.message,
        requestId,
      };
    }

    if (error.code === "validation_timeout" || error.statusCode === 408) {
      return {
        ...TYPED_FAILURE_COPY.UPSTREAM_TIMEOUT,
        message: error.message || TYPED_FAILURE_COPY.UPSTREAM_TIMEOUT.message,
        requestId,
      };
    }

    if (error.code === "cancelled_by_user") {
      return {
        title: "Chat interrupted",
        message: "The in-flight chat was stopped before completion.",
        requestId,
        retryable: false,
        marksUnavailable: false,
      };
    }

    return {
      title: "Service failure",
      message: error.message,
      requestId,
      retryable: error.retryable ?? false,
      marksUnavailable: true,
    };
  }

  if (error instanceof Error) {
    return {
      title: "Network failure",
      message: error.message,
      retryable: true,
      marksUnavailable: true,
    };
  }

  return {
    title: "Unknown failure",
    message: "An unexpected error occurred during the chat request.",
    retryable: false,
    marksUnavailable: true,
  };
}
