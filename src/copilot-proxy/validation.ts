import { isRecord } from "../shared.js";

/**
 * Step-by-step validation that returns a specific reason string describing
 * which check failed. Returns `null` when the message is valid.
 * This is used for diagnostic logging — it does NOT change validation logic.
 */
export function validateExtensionMessage(value: unknown): string | null {
  if (!isRecord(value)) {
    return "message is not an object";
  }

  if (typeof value.type !== "string") {
    return "message is missing type field or type is not a string";
  }

  switch (value.type) {
    case "register": {
      if (!Array.isArray(value.models)) {
        return "register message: models is not an array";
      }
      for (let i = 0; i < value.models.length; i++) {
        const modelReason = validateModel(value.models[i], `register message: models[${i}]`);
        if (modelReason !== null) {
          return modelReason;
        }
      }
      if (typeof value.extension_version !== "string") {
        return "register message: extension_version is not a string";
      }
      if (
        value.copilot_status !== "connected" &&
        value.copilot_status !== "disconnected" &&
        value.copilot_status !== "error"
      ) {
        return `register message: invalid copilot_status value (${JSON.stringify(value.copilot_status)})`;
      }
      if (value.copilot_user !== undefined && typeof value.copilot_user !== "string") {
        return "register message: copilot_user is not a string";
      }
      if (value.status_message !== undefined && typeof value.status_message !== "string") {
        return "register message: status_message is not a string";
      }
      return null;
    }
    case "status_update": {
      if (!Array.isArray(value.available_models)) {
        return "status_update message: available_models is not an array";
      }
      for (let i = 0; i < value.available_models.length; i++) {
        const modelReason = validateModel(value.available_models[i], `status_update message: available_models[${i}]`);
        if (modelReason !== null) {
          return modelReason;
        }
      }
      if (
        value.copilot_status !== "connected" &&
        value.copilot_status !== "disconnected" &&
        value.copilot_status !== "error"
      ) {
        return `status_update message: invalid copilot_status value (${JSON.stringify(value.copilot_status)})`;
      }
      if (value.status_message !== undefined && typeof value.status_message !== "string") {
        return "status_update message: status_message is not a string";
      }
      return null;
    }
    case "stream_delta": {
      if (typeof value.id !== "string") {
        return "stream_delta message: id is not a string";
      }
      if (typeof value.content_type !== "string") {
        return "stream_delta message: content_type is not a string";
      }
      if (!["text", "tool_call", "usage", "progress"].includes(value.content_type)) {
        return `stream_delta message: invalid content_type value (${JSON.stringify(value.content_type)})`;
      }
      return null;
    }
    case "stream_done": {
      if (typeof value.id !== "string") {
        return "stream_done message: id is not a string";
      }
      return null;
    }
    case "stream_error": {
      if (typeof value.id !== "string") {
        return "stream_error message: id is not a string";
      }
      if (typeof value.partial !== "boolean") {
        return `stream_error message: partial is not a boolean (got ${typeof value.partial})`;
      }
      if (!isRecord(value.error)) {
        return "stream_error message: error is not an object";
      }
      if (typeof value.error.code !== "string") {
        return "stream_error message: error.code is not a string";
      }
      if (typeof value.error.message !== "string") {
        return "stream_error message: error.message is not a string";
      }
      return null;
    }
    case "pong":
      return null;
    case "disconnect": {
      if (value.reason !== undefined && typeof value.reason !== "string") {
        return "disconnect message: reason is not a string";
      }
      return null;
    }
    default:
      return `unknown message type: ${JSON.stringify(value.type)}`;
  }
}

export function validateModel(value: unknown, context: string): string | null {
  if (!isRecord(value)) {
    return `${context} is not an object`;
  }
  if (typeof value.id !== "string") {
    return `${context}: id is not a string`;
  }
  if (typeof value.name !== "string") {
    return `${context}: name is not a string`;
  }
  if (typeof value.native_id !== "string") {
    return `${context}: native_id is not a string`;
  }
  if (typeof value.source !== "string") {
    return `${context}: source is not a string`;
  }
  return validateModelCapabilities(value.capabilities, `${context}.capabilities`);
}

export function validateModelCapabilities(value: unknown, context: string): string | null {
  if (!isRecord(value)) {
    return `${context} is not an object`;
  }
  if (typeof value.supports_streaming !== "boolean") {
    return `${context}.supports_streaming is not a boolean (got ${typeof value.supports_streaming}: ${JSON.stringify(value.supports_streaming)})`;
  }
  if (typeof value.supports_tools !== "boolean") {
    return `${context}.supports_tools is not a boolean (got ${typeof value.supports_tools}: ${JSON.stringify(value.supports_tools)})`;
  }
  if (typeof value.supports_usage !== "boolean") {
    return `${context}.supports_usage is not a boolean (got ${typeof value.supports_usage}: ${JSON.stringify(value.supports_usage)})`;
  }
  if (typeof value.supports_progress !== "boolean") {
    return `${context}.supports_progress is not a boolean (got ${typeof value.supports_progress}: ${JSON.stringify(value.supports_progress)})`;
  }
  if (
    value.max_tokens !== undefined &&
    value.max_tokens !== null &&
    typeof value.max_tokens !== "number"
  ) {
    return `${context}.max_tokens is not a number (got ${typeof value.max_tokens}: ${JSON.stringify(value.max_tokens)})`;
  }
  if (
    value.concurrent_requests !== undefined &&
    typeof value.concurrent_requests !== "number"
  ) {
    return `${context}.concurrent_requests is not a number (got ${typeof value.concurrent_requests}: ${JSON.stringify(value.concurrent_requests)})`;
  }
  return null;
}
