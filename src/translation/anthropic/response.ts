import type {
  AnthropicMessageResponse,
  AnthropicStopReason,
  AnthropicToolUseBlock,
  ChatCompletionChoice,
  ChatCompletionResponse,
  ChatToolCall,
} from "../../contracts.js";

interface AnthropicResponseTranslationOptions {
  model?: string;
}

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

function normalizeToolCall(toolCall: ChatToolCall, index: number): AnthropicToolUseBlock {
  if (!isRecord(toolCall)) {
    throw new Error(`tool_calls[${index}] must be an object.`);
  }

  const rawArguments = expectString(
    toolCall.function.arguments,
    `tool_calls[${index}].function.arguments`,
  );

  let parsedInput: unknown;
  try {
    parsedInput = JSON.parse(rawArguments);
  } catch (error) {
    throw new Error(
      `tool_calls[${index}].function.arguments must be valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!isRecord(parsedInput)) {
    throw new Error(`tool_calls[${index}].function.arguments must decode to an object.`);
  }

  return {
    type: "tool_use",
    id: expectString(toolCall.id, `tool_calls[${index}].id`),
    name: expectString(toolCall.function.name, `tool_calls[${index}].function.name`),
    input: parsedInput,
  };
}

function mapFinishReason(finishReason: string | null): AnthropicStopReason | null {
  switch (finishReason) {
    case null:
      return null;
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}

function normalizeChoice(choice: ChatCompletionChoice): {
  text: string;
  toolUses: AnthropicToolUseBlock[];
  stopReason: AnthropicStopReason | null;
} {
  if (!isRecord(choice)) {
    throw new Error("choices[0] must be an object.");
  }

  if (!isRecord(choice.message)) {
    throw new Error("choices[0].message must be an object.");
  }

  if (choice.message.role !== "assistant") {
    throw new Error('choices[0].message.role must be "assistant".');
  }

  const text =
    choice.message.content === null
      ? ""
      : expectString(choice.message.content, "choices[0].message.content");
  const toolUses = (choice.message.tool_calls ?? []).map((toolCall, index) =>
    normalizeToolCall(toolCall, index),
  );

  return {
    text,
    toolUses,
    stopReason: mapFinishReason(choice.finish_reason),
  };
}

export function translateChatCompletionResponseToAnthropic(
  response: ChatCompletionResponse,
  options: AnthropicResponseTranslationOptions = {},
): AnthropicMessageResponse {
  if (!isRecord(response)) {
    throw new Error("response must be an object.");
  }

  const id = expectString(response.id, "id");
  const model =
    options.model ?? expectString(response.model, "model");

  if (!Array.isArray(response.choices) || response.choices.length === 0) {
    throw new Error("choices must be a non-empty array.");
  }

  const normalizedChoice = normalizeChoice(response.choices[0]!);
  const content: AnthropicMessageResponse["content"] = [];

  if (normalizedChoice.text.length > 0) {
    content.push({
      type: "text",
      text: normalizedChoice.text,
    });
  }

  content.push(...normalizedChoice.toolUses);

  return {
    id,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: normalizedChoice.stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: response.usage
        ? expectNumber(response.usage.prompt_tokens, "usage.prompt_tokens")
        : 0,
      output_tokens: response.usage
        ? expectNumber(response.usage.completion_tokens, "usage.completion_tokens")
        : 0,
    },
  };
}

export function mapChatFinishReasonToAnthropic(
  finishReason: string | null,
): AnthropicStopReason | null {
  return mapFinishReason(finishReason);
}
