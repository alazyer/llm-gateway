import type {
  ChatCompletionRequest,
  ChatMessage,
  ChatTool,
  ChatToolChoice,
  ResponseInput,
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

const SUPPORTED_ROLES = new Set<ResponseRole>([
  "user",
  "assistant",
  "system",
  "developer",
]);
const SUPPORTED_CONTENT_TYPES = new Set<ResponseTextContent["type"]>([
  "input_text",
  "output_text",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectString(value: unknown, context: string): string {
  if (typeof value !== "string") {
    throw new Error(`${context} must be a string.`);
  }

  return value;
}

function expectNumber(value: unknown, context: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`${context} must be a number.`);
  }

  return value;
}

function expectBoolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${context} must be a boolean.`);
  }

  return value;
}

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

function normalizeContentPart(part: unknown, context: string): string {
  if (!isRecord(part)) {
    throw new Error(
      `${context} must be an object with type and text properties.`,
    );
  }

  const type = expectString(part.type, `${context}.type`);
  if (!SUPPORTED_CONTENT_TYPES.has(type as ResponseTextContent["type"])) {
    throw new Error(
      `${context}.type must be one of: input_text, output_text.`,
    );
  }

  return expectString(part.text, `${context}.text`);
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
      `${context} must be a string or an array of input_text/output_text objects.`,
    );
  }

  return content
    .map((part, index) => normalizeContentPart(part, `${context}[${index}]`))
    .join("\n");
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

  return {
    role: normalizeRole(item.role, `${context}.role`),
    content: normalizeContent(item.content, `${context}.content`),
  };
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

  return payload;
}
