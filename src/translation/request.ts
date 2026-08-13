import type {
  ChatContentPart,
  ChatCompletionRequest,
  ChatImageUrlContentPart,
  ChatMessage,
  ChatTextContentPart,
  ChatTool,
  ChatToolChoice,
  ResponseContentPart,
  ResponseInput,
  ResponseInputImageContent,
  ResponseInputItem,
  ResponseMessageItem,
  ResponseRequest,
  ResponseRole,
  ResponseTextContent,
  ResponsesFunctionCall,
  ResponsesFunctionCallOutput,
  ResponsesTool,
  ResponsesToolChoice,
} from "../contracts.js";
import { isRecord, expectString, expectNumber, expectBoolean } from "../shared.js";

const SUPPORTED_ROLES = new Set<ResponseRole>([
  "user",
  "assistant",
  "system",
  "developer",
]);
const SUPPORTED_TEXT_CONTENT_TYPES = new Set<ResponseTextContent["type"]>([
  "input_text",
  "output_text",
]);
const SUPPORTED_IMAGE_CONTENT_TYPES = new Set<"input_image">(["input_image"]);
const SUPPORTED_CONTENT_TYPES = new Set<ResponseContentPart["type"]>([
  ...SUPPORTED_TEXT_CONTENT_TYPES,
  ...SUPPORTED_IMAGE_CONTENT_TYPES,
]);

function normalizeRole(role: unknown, context: string): ChatMessage["role"] {
  const value = expectString(role, context);

  if (!SUPPORTED_ROLES.has(value as ResponseRole)) {
    throw new Error(
      `${context} must be one of: user, assistant, system, developer.`,
    );
  }

  switch (value) {
    case "developer":
    case "system":
      return "system";
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    default:
      throw new Error(
        `${context} must be one of: user, assistant, system, developer.`,
      );
  }
}

function normalizeTextContentPart(part: Record<string, unknown>, context: string): ChatTextContentPart {
  if (!SUPPORTED_TEXT_CONTENT_TYPES.has(part.type as ResponseTextContent["type"])) {
    throw new Error(
      `${context}.type must be one of: input_text, output_text, input_image.`,
    );
  }
  return {
    type: "text",
    text: expectString(part.text, `${context}.text`),
  };
}

function normalizeImageContentPart(part: Record<string, unknown>, context: string): ChatImageUrlContentPart {
  // Support both { image_url: "<data-url>" } (Beacon-flavored, per docs)
  // and { image_url: { url: "<url>" } } (OpenAI-standard Responses API).
  let url: unknown = part.image_url;
  let detail: "auto" | "low" | "high" | undefined;
  if (isRecord(url)) {
    detail = (url.detail as "auto" | "low" | "high" | undefined) ?? undefined;
    url = url.url;
  }
  if (typeof url !== "string" || url.length === 0) {
    throw new Error(
      `${context}.image_url must be a string URL or data URL, or an object with a url field.`,
    );
  }
  if (part.detail !== undefined) {
    const d = expectString(part.detail, `${context}.detail`);
    if (d !== "auto" && d !== "low" && d !== "high") {
      throw new Error(
        `${context}.detail must be one of: auto, low, high.`,
      );
    }
    detail = d;
  }
  return {
    type: "image_url",
    image_url: { url, ...(detail !== undefined ? { detail } : {}) },
  };
}

function normalizeContentPart(part: unknown, context: string): ChatContentPart {
  if (!isRecord(part)) {
    throw new Error(
      `${context} must be an object with type and content fields.`,
    );
  }

  const type = expectString(part.type, `${context}.type`);
  if (!SUPPORTED_CONTENT_TYPES.has(type as ResponseContentPart["type"])) {
    throw new Error(
      `${context}.type must be one of: input_text, output_text, input_image.`,
    );
  }

  if (type === "input_image") {
    return normalizeImageContentPart(part, context);
  }

  return normalizeTextContentPart(part, context);
}

function normalizeContent(
  content: unknown,
  context: string,
): ChatMessage["content"] {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    throw new Error(
      `${context} must be a string or an array of content objects.`,
    );
  }

  const parts = content.map((part, index) =>
    normalizeContentPart(part, `${context}[${index}]`),
  );

  // If every part is text, collapse to a single string (preserves existing
  // behavior for text-only conversations and keeps upstream payloads minimal).
  const textParts: string[] = [];
  let hasNonText = false;
  for (const part of parts) {
    if (part.type === "text") {
      textParts.push(part.text);
    } else {
      hasNonText = true;
      break;
    }
  }
  if (!hasNonText) {
    return textParts.join("\n");
  }

  return parts;
}

export function normalizeResponseMessageItem(
  item: ResponseMessageItem,
  context = "input",
): ChatMessage {
  if (!isRecord(item)) {
    throw new Error(`${context} must be a message object.`);
  }

  const type = expectString(item.type, `${context}.type`);
  if (type !== "message") {
    throw new Error(`${context}.type must be "message".`);
  }

  const role = normalizeRole(item.role, `${context}.role`);
  const content = normalizeContent(item.content, `${context}.content`);

  if (role !== "user" && Array.isArray(content)) {
    // Non-user messages (system/assistant) cannot carry multimodal content;
    // they are restricted to plain text by both OpenAI and Anthropic APIs.
    throw new Error(
      `${context}.content: input_image blocks are only valid in user messages.`,
    );
  }

  return { role, content };
}

function normalizeFunctionCallItem(
  item: ResponsesFunctionCall,
  context: string,
): ChatMessage {
  if (!isRecord(item)) {
    throw new Error(`${context} must be an object.`);
  }

  if (item.type !== "function_call") {
    throw new Error(`${context}.type must be "function_call".`);
  }

  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: expectString(item.call_id, `${context}.call_id`),
        type: "function",
        function: {
          name: expectString(item.name, `${context}.name`),
          arguments: expectString(item.arguments, `${context}.arguments`),
        },
      },
    ],
  };
}

function normalizeFunctionCallOutputItem(
  item: ResponsesFunctionCallOutput,
  context: string,
): ChatMessage {
  if (!isRecord(item)) {
    throw new Error(`${context} must be an object.`);
  }

  if (item.type !== "function_call_output") {
    throw new Error(`${context}.type must be "function_call_output".`);
  }

  return {
    role: "tool",
    content: expectString(item.output, `${context}.output`),
    tool_call_id: expectString(item.call_id, `${context}.call_id`),
  };
}

function normalizeResponseInputItem(item: ResponseInputItem, context: string): ChatMessage {
  if (!isRecord(item)) {
    throw new Error(`${context} must be an object.`);
  }

  const type = item.type;
  if (type === "function_call") {
    return normalizeFunctionCallItem(item as ResponsesFunctionCall, context);
  }

  if (type === "function_call_output") {
    return normalizeFunctionCallOutputItem(item as ResponsesFunctionCallOutput, context);
  }

  return normalizeResponseMessageItem(item as ResponseMessageItem, context);
}

export function normalizeResponseInputToMessages(
  input?: ResponseInput,
  instructions?: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [];

  if (instructions !== undefined) {
    messages.push({
      role: "system",
      content: expectString(instructions, "instructions"),
    });
  }

  if (input === undefined) {
    return messages;
  }

  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }

  if (Array.isArray(input)) {
    messages.push(
      ...input.map((item, index) =>
        normalizeResponseInputItem(item, `input[${index}]`),
      ),
    );
    return messages;
  }

  if (isRecord(input)) {
    messages.push(normalizeResponseInputItem(input, "input"));
    return messages;
  }

  throw new Error(
    "input must be a string, a message object, or an array of message objects.",
  );
}

function normalizeMetadata(
  metadata: ResponseRequest["metadata"],
): ChatCompletionRequest["metadata"] {
  if (metadata === undefined) {
    return undefined;
  }

  if (!isRecord(metadata)) {
    throw new Error("metadata must be an object.");
  }

  for (const [key, value] of Object.entries(metadata)) {
    const type = typeof value;
    if (
      value !== null &&
      type !== "string" &&
      type !== "number" &&
      type !== "boolean"
    ) {
      throw new Error(
        `metadata.${key} must be a string, number, boolean, or null.`,
      );
    }
  }

  return metadata;
}

function normalizeTools(tools: ResponsesTool[]): ChatTool[] {
  if (!Array.isArray(tools)) {
    throw new Error("tools must be an array.");
  }

  return tools.map((tool, index) => normalizeTool(tool, `tools[${index}]`));
}

function normalizeTool(tool: ResponsesTool, context: string): ChatTool {
  if (!isRecord(tool)) {
    throw new Error(`${context} must be an object.`);
  }

  const functionDefinition: ChatTool["function"] = {
    name: expectString(tool.name, `${context}.name`),
  };

  if (tool.description !== undefined) {
    functionDefinition.description = expectString(
      tool.description,
      `${context}.description`,
    );
  }

  if (tool.parameters !== undefined) {
    if (!isRecord(tool.parameters)) {
      throw new Error(`${context}.parameters must be an object.`);
    }
    functionDefinition.parameters = tool.parameters;
  }

  return {
    type: "function",
    function: functionDefinition,
  };
}

function normalizeToolChoice(
  toolChoice: ResponsesToolChoice,
): ChatToolChoice {
  if (toolChoice === "auto") {
    return "auto";
  }

  if (toolChoice === "none") {
    return "none";
  }

  if (toolChoice === "required") {
    return "required";
  }

  if (!isRecord(toolChoice)) {
    throw new Error("tool_choice must be a string or an object.");
  }

  if (toolChoice.type !== "function") {
    throw new Error('tool_choice.type must be "function".');
  }

  return {
    type: "function",
    function: {
      name: expectString(toolChoice.name, "tool_choice.name"),
    },
  };
}

export function buildChatCompletionRequest(
  request: ResponseRequest,
): ChatCompletionRequest {
  if (!isRecord(request)) {
    throw new Error("request must be an object.");
  }

  const payload: ChatCompletionRequest = {
    model: expectString(request.model, "model"),
    messages: normalizeResponseInputToMessages(
      request.input,
      request.instructions,
    ),
  };

  if (request.stream !== undefined) {
    payload.stream = expectBoolean(request.stream, "stream");
  }

  if (request.temperature !== undefined) {
    payload.temperature = expectNumber(request.temperature, "temperature");
  }

  if (request.top_p !== undefined) {
    payload.top_p = expectNumber(request.top_p, "top_p");
  }

  if (request.max_output_tokens !== undefined) {
    payload.max_completion_tokens = expectNumber(
      request.max_output_tokens,
      "max_output_tokens",
    );
  }

  if (request.metadata !== undefined) {
    const metadata = normalizeMetadata(request.metadata);
    if (metadata !== undefined) {
      payload.metadata = metadata;
    }
  }

  if (request.user !== undefined) {
    payload.user = expectString(request.user, "user");
  }

  if (request.tools !== undefined) {
    const tools = normalizeTools(request.tools);
    if (tools.length > 0) {
      payload.tools = tools;
    }
  }

  if (request.tool_choice !== undefined) {
    payload.tool_choice = normalizeToolChoice(request.tool_choice);
  }

  if (request.parallel_tool_calls !== undefined) {
    payload.parallel_tool_calls = expectBoolean(request.parallel_tool_calls, "parallel_tool_calls");
  }

  return payload;
}
