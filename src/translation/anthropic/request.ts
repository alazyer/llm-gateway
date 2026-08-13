import type {
  AnthropicImageBlock,
  AnthropicImageSource,
  AnthropicMessage,
  AnthropicMessageBlock,
  AnthropicMessagesRequest,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicToolResultBlock,
  ChatContentPart,
  ChatCompletionRequest,
  ChatImageUrlContentPart,
  ChatMessage,
  ChatTextContentPart,
  ChatTool,
  ChatToolChoice,
  ChatToolCall,
} from "../../contracts.js";
import { isRecord, expectString, expectNumber, expectBoolean } from "../../shared.js";

function normalizeTextBlock(value: unknown, context: string): AnthropicTextBlock {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object.`);
  }

  if (value.type !== "text") {
    throw new Error(`${context}.type must be "text".`);
  }

  return {
    type: "text",
    text: expectString(value.text, `${context}.text`),
  };
}

function normalizeSystemPrompt(
  system: AnthropicMessagesRequest["system"],
): string | undefined {
  if (system === undefined) {
    return undefined;
  }

  if (typeof system === "string") {
    return system;
  }

  if (!Array.isArray(system)) {
    throw new Error("system must be a string or an array of text blocks.");
  }

  return system
    .map((block, index) => normalizeTextBlock(block, `system[${index}]`).text)
    .join("\n");
}

function normalizeTextBlocks(
  blocks: AnthropicTextBlock[],
  context: string,
): string {
  return blocks
    .map((block, index) => normalizeTextBlock(block, `${context}[${index}]`).text)
    .join("\n");
}

function normalizeToolResultContent(
  block: AnthropicToolResultBlock,
  context: string,
): string {
  if (block.content === undefined) {
    return "";
  }

  const text =
    typeof block.content === "string"
      ? block.content
      : normalizeTextBlocks(block.content, `${context}.content`);

  return text;
}

const SUPPORTED_IMAGE_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

function normalizeImageSource(
  value: unknown,
  context: string,
): AnthropicImageSource {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object.`);
  }

  const sourceType = expectString(value.type, `${context}.type`);
  if (sourceType !== "base64") {
    throw new Error(
      `${context}.type must be "base64" (only base64-encoded image sources are supported).`,
    );
  }

  const mediaType = expectString(value.media_type, `${context}.media_type`);
  if (!SUPPORTED_IMAGE_MEDIA_TYPES.has(mediaType)) {
    throw new Error(
      `${context}.media_type must be one of: ${[...SUPPORTED_IMAGE_MEDIA_TYPES].join(", ")}.`,
    );
  }

  const data = expectString(value.data, `${context}.data`);
  // Best-effort guard: base64 should not contain whitespace or non-base64 chars.
  if (!/^[A-Za-z0-9+/]+=*$/.test(data)) {
    throw new Error(
      `${context}.data must be a base64-encoded string.`,
    );
  }

  return { type: "base64", media_type: mediaType, data };
}

function normalizeImageBlock(
  value: Record<string, unknown>,
  context: string,
): AnthropicImageBlock {
  return {
    type: "image",
    source: normalizeImageSource(value.source, `${context}.source`),
  };
}

function toDataUrl(source: AnthropicImageSource): string {
  return `data:${source.media_type};base64,${source.data}`;
}

function normalizeContentBlock(
  value: unknown,
  context: string,
): AnthropicMessageBlock {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object.`);
  }

  const type = expectString(value.type, `${context}.type`);
  switch (type) {
    case "text":
      return {
        type: "text",
        text: expectString(value.text, `${context}.text`),
      };
    case "image":
      return normalizeImageBlock(value, context);
    case "tool_use": {
      const input = value.input;
      if (!isRecord(input)) {
        throw new Error(`${context}.input must be an object.`);
      }

      return {
        type: "tool_use",
        id: expectString(value.id, `${context}.id`),
        name: expectString(value.name, `${context}.name`),
        input,
      };
    }
    case "tool_result": {
      const normalized: AnthropicToolResultBlock = {
        type: "tool_result",
        tool_use_id: expectString(value.tool_use_id, `${context}.tool_use_id`),
      };

      if (value.content !== undefined) {
        normalized.content =
          typeof value.content === "string"
            ? value.content
            : normalizeToolResultContentArray(value.content, `${context}.content`);
      }

      if (value.is_error !== undefined) {
        normalized.is_error = expectBoolean(value.is_error, `${context}.is_error`);
      }

      return normalized;
    }
    default:
      throw new Error(
        `${context}.type must be one of: text, image, tool_use, tool_result.`,
      );
  }
}

/** @deprecated Use normalizeContentBlock. Kept as a thin alias for callers. */
function normalizeToolUseBlock(
  value: unknown,
  context: string,
): AnthropicMessageBlock {
  return normalizeContentBlock(value, context);
}

function normalizeToolResultContentArray(
  value: unknown,
  context: string,
): AnthropicTextBlock[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context} must be a string or an array of text blocks.`);
  }

  return value.map((block, index) => normalizeTextBlock(block, `${context}[${index}]`));
}

function normalizeMessageContent(
  content: AnthropicMessage["content"],
  context: string,
): AnthropicMessageBlock[] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  if (!Array.isArray(content)) {
    throw new Error(`${context} must be a string or an array of content blocks.`);
  }

  return content.map((block, index) => normalizeContentBlock(block, `${context}[${index}]`));
}

function normalizeAssistantMessage(
  message: AnthropicMessage,
  context: string,
): ChatMessage {
  const blocks = normalizeMessageContent(message.content, `${context}.content`);
  const textParts: string[] = [];
  const toolCalls: ChatToolCall[] = [];

  for (const [index, block] of blocks.entries()) {
    switch (block.type) {
      case "text":
        textParts.push(block.text);
        break;
      case "tool_use":
        toolCalls.push({
          id: block.id,
          type: "function",
          function: {
            name: block.name,
            arguments: JSON.stringify(block.input),
          },
        });
        break;
      case "tool_result":
        throw new Error(
          `${context}.content[${index}] tool_result blocks are not valid in assistant messages.`,
        );
      case "image":
        throw new Error(
          `${context}.content[${index}] image blocks are not valid in assistant messages.`,
        );
    }
  }

  const content = textParts.join("\n");
  return {
    role: "assistant",
    content: content.length > 0 ? content : null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  };
}

function normalizeSystemMessage(
  message: AnthropicMessage,
  context: string,
): ChatMessage {
  const blocks = normalizeMessageContent(message.content, `${context}.content`);
  const textParts: string[] = [];

  for (const [index, block] of blocks.entries()) {
    if (block.type !== "text") {
      throw new Error(
        `${context}.content[${index}] only text blocks are valid in system messages.`,
      );
    }

    textParts.push(block.text);
  }

  return {
    role: "system",
    content: textParts.join("\n"),
  };
}

function imageBlockToChatPart(block: AnthropicImageBlock): ChatImageUrlContentPart {
  return {
    type: "image_url",
    image_url: { url: toDataUrl(block.source) },
  };
}

function normalizeUserMessage(
  message: AnthropicMessage,
  context: string,
): ChatMessage[] {
  const blocks = normalizeMessageContent(message.content, `${context}.content`);
  const translated: ChatMessage[] = [];
  // Buffered user content: parallel arrays so we can emit either a plain string
  // (text-only) or a full ChatContentPart[] when images are present.
  const textParts: string[] = [];
  const contentParts: ChatContentPart[] = [];
  let hasImages = false;

  const flushUser = () => {
    if (textParts.length === 0 && !hasImages) {
      return;
    }

    if (!hasImages) {
      translated.push({
        role: "user",
        content: textParts.join("\n"),
      });
    } else {
      // Finalize parts array, preserving order.
      translated.push({
        role: "user",
        content: [...contentParts],
      });
    }

    textParts.length = 0;
    contentParts.length = 0;
    hasImages = false;
  };

  for (const [index, block] of blocks.entries()) {
    switch (block.type) {
      case "text":
        textParts.push(block.text);
        contentParts.push({ type: "text", text: block.text });
        break;
      case "image":
        hasImages = true;
        contentParts.push(imageBlockToChatPart(block));
        break;
      case "tool_result":
        flushUser();
        translated.push({
          role: "tool",
          tool_call_id: block.tool_use_id,
          content: normalizeToolResultContent(block, `${context}.content[${index}]`),
        });
        break;
      case "tool_use":
        throw new Error(
          `${context}.content[${index}] tool_use blocks are not valid in user messages.`,
        );
    }
  }

  flushUser();
  return translated;
}

function normalizeMessages(messages: AnthropicMessagesRequest["messages"]): ChatMessage[] {
  if (!Array.isArray(messages)) {
    throw new Error("messages must be an array.");
  }

  const normalized: ChatMessage[] = [];

  for (const [index, message] of messages.entries()) {
    if (!isRecord(message)) {
      throw new Error(`messages[${index}] must be an object.`);
    }

    const role = expectString(message.role, `messages[${index}].role`);
    if (role === "user") {
      normalized.push(
        ...normalizeUserMessage(
          message as AnthropicMessage,
          `messages[${index}]`,
        ),
      );
      continue;
    }

    if (role === "assistant") {
      normalized.push(
        normalizeAssistantMessage(
          message as AnthropicMessage,
          `messages[${index}]`,
        ),
      );
      continue;
    }

    if (role === "system") {
      normalized.push(
        normalizeSystemMessage(
          message as AnthropicMessage,
          `messages[${index}]`,
        ),
      );
      continue;
    }

    throw new Error(`messages[${index}].role must be "user", "assistant", or "system".`);
  }

  return normalized;
}

function normalizeTools(tools: AnthropicMessagesRequest["tools"]): ChatTool[] | undefined {
  if (tools === undefined) {
    return undefined;
  }

  if (!Array.isArray(tools)) {
    throw new Error("tools must be an array.");
  }

  return tools.map((tool, index) => normalizeTool(tool, `tools[${index}]`));
}

function normalizeTool(value: AnthropicTool, context: string): ChatTool {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object.`);
  }

  const inputSchema = value.input_schema;
  if (inputSchema !== undefined && !isRecord(inputSchema)) {
    throw new Error(`${context}.input_schema must be an object.`);
  }

  const functionDefinition: ChatTool["function"] = {
    name: expectString(value.name, `${context}.name`),
  };

  if (value.description !== undefined) {
    functionDefinition.description = expectString(
      value.description,
      `${context}.description`,
    );
  }

  if (inputSchema !== undefined) {
    functionDefinition.parameters = inputSchema;
  }

  return {
    type: "function",
    function: functionDefinition,
  };
}

function normalizeToolChoice(
  toolChoice: AnthropicMessagesRequest["tool_choice"],
): ChatToolChoice | undefined {
  if (toolChoice === undefined) {
    return undefined;
  }

  if (toolChoice === "auto") {
    return "auto";
  }

  if (toolChoice === "none") {
    return "none";
  }

  if (toolChoice === "any") {
    return "required";
  }

  if (!isRecord(toolChoice)) {
    throw new Error("tool_choice must be a string or an object.");
  }

  if (toolChoice.type !== "tool") {
    throw new Error('tool_choice.type must be "tool".');
  }

  return {
    type: "function",
    function: {
      name: expectString(toolChoice.name, "tool_choice.name"),
    },
  };
}

function normalizeStopSequences(
  stopSequences: AnthropicMessagesRequest["stop_sequences"],
): string[] | undefined {
  if (stopSequences === undefined) {
    return undefined;
  }

  if (!Array.isArray(stopSequences)) {
    throw new Error("stop_sequences must be an array.");
  }

  return stopSequences.map((value, index) =>
    expectString(value, `stop_sequences[${index}]`),
  );
}

export function buildChatCompletionRequestFromAnthropic(
  request: AnthropicMessagesRequest,
): ChatCompletionRequest {
  if (!isRecord(request)) {
    throw new Error("request must be an object.");
  }

  const payload: ChatCompletionRequest = {
    model: expectString(request.model, "model"),
    messages: [],
  };

  const system = normalizeSystemPrompt(request.system);
  if (system !== undefined && system.length > 0) {
    payload.messages.push({
      role: "system",
      content: system,
    });
  }

  payload.messages.push(...normalizeMessages(request.messages));

  if (request.stream !== undefined) {
    payload.stream = expectBoolean(request.stream, "stream");
  }

  if (request.temperature !== undefined) {
    payload.temperature = expectNumber(request.temperature, "temperature");
  }

  if (request.top_p !== undefined) {
    payload.top_p = expectNumber(request.top_p, "top_p");
  }

  if (request.max_tokens !== undefined) {
    payload.max_completion_tokens = expectNumber(request.max_tokens, "max_tokens");
  }

  if (request.metadata !== undefined) {
    if (!isRecord(request.metadata)) {
      throw new Error("metadata must be an object.");
    }

    const normalizedMetadata: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(request.metadata)) {
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        normalizedMetadata[key] = value;
      }
    }

    if (Object.keys(normalizedMetadata).length > 0) {
      payload.metadata = normalizedMetadata;
    }

    const userId = request.metadata.user_id;
    if (typeof userId === "string" && userId.length > 0) {
      payload.user = userId;
    }
  }

  const tools = normalizeTools(request.tools);
  if (tools && tools.length > 0) {
    payload.tools = tools;
  }

  const toolChoice = normalizeToolChoice(request.tool_choice);
  if (toolChoice !== undefined) {
    payload.tool_choice = toolChoice;
  }

  const stop = normalizeStopSequences(request.stop_sequences);
  if (stop && stop.length > 0) {
    payload.stop = stop;
  }

  return payload;
}

function countStringTokens(value: string): number {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 0;
  }

  return Math.max(1, Math.ceil(trimmed.length / 4));
}

function countMessageTokens(message: AnthropicMessage): number {
  const blocks = normalizeMessageContent(message.content, "message.content");
  let total = 0;

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        total += countStringTokens(block.text);
        break;
      case "image":
        // Rough estimate: count base64 characters scaled down. Real vision
        // token counts vary by resolution; this is intentionally conservative
        // so budgets don't silently overrun.
        total += Math.max(1, Math.ceil(block.source.data.length / 4));
        break;
      case "tool_use":
        total += countStringTokens(block.name);
        total += countStringTokens(JSON.stringify(block.input));
        break;
      case "tool_result":
        total += countStringTokens(normalizeToolResultContent(block, "message.content"));
        break;
    }
  }

  return total;
}

export function estimateAnthropicInputTokens(
  request: AnthropicMessagesRequest,
): number {
  let total = 0;

  const system = normalizeSystemPrompt(request.system);
  if (system) {
    total += countStringTokens(system);
  }

  for (const [index, message] of request.messages.entries()) {
    total += countStringTokens(message.role);
    total += countMessageTokens(message);
    total += 4;
    if (index === request.messages.length - 1) {
      total += 2;
    }
  }

  for (const tool of request.tools ?? []) {
    total += countStringTokens(tool.name);
    total += countStringTokens(tool.description ?? "");
    if (tool.input_schema) {
      total += countStringTokens(JSON.stringify(tool.input_schema));
    }
  }

  return total;
}
