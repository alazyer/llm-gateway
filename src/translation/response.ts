import type {
  ChatCompletionChoice,
  ChatCompletionResponse,
  ChatCompletionUsage,
  ChatToolCall,
} from "../contracts.js";
import { isRecord, expectString, expectNumber } from "../shared.js";

export interface ResponseTranslationOptions {
  temperature?: number;
  top_p?: number;
  model?: string;
}

export interface ResponsesUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface ResponsesOutputTextContent {
  type: "output_text";
  text: string;
}

export interface ResponsesOutputMessage {
  id: string;
  type: "message";
  status: "in_progress" | "completed";
  role: "assistant";
  content: ResponsesOutputTextContent[];
}

export interface ResponsesFunctionCallOutput {
  id: string;
  type: "function_call";
  status: "in_progress" | "completed";
  call_id: string;
  name: string;
  arguments: string;
}

export type ResponsesOutputItem = ResponsesOutputMessage | ResponsesFunctionCallOutput;

export interface ResponsesError {
  type: string;
  message: string;
}

export interface ResponsesStyleResponse {
  id: string;
  object: "response";
  created_at: number;
  model: string;
  status: "in_progress" | "completed" | "failed";
  output: ResponsesOutputItem[];
  output_text: string;
  parallel_tool_calls: boolean;
  tool_choice: string;
  temperature?: number;
  top_p?: number;
  usage?: ResponsesUsage;
  error?: ResponsesError;
}

export function normalizeSamplingOptions(
  options: ResponseTranslationOptions,
): ResponseTranslationOptions {
  const normalized: ResponseTranslationOptions = {};

  if (options.temperature !== undefined) {
    normalized.temperature = expectNumber(options.temperature, "temperature");
  }

  if (options.top_p !== undefined) {
    normalized.top_p = expectNumber(options.top_p, "top_p");
  }

   if (options.model !== undefined) {
    normalized.model = expectString(options.model, "model");
  }

  return normalized;
}

export function translateChatCompletionUsage(
  usage: ChatCompletionUsage,
  context = "usage",
): ResponsesUsage {
  if (!isRecord(usage)) {
    throw new Error(`${context} must be an object.`);
  }

  return {
    input_tokens: expectNumber(usage.prompt_tokens, `${context}.prompt_tokens`),
    output_tokens: expectNumber(
      usage.completion_tokens,
      `${context}.completion_tokens`,
    ),
    total_tokens: expectNumber(usage.total_tokens, `${context}.total_tokens`),
  };
}

interface NormalizedChoice {
  text: string;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
}

function normalizeChoice(choice: ChatCompletionChoice, index: number): NormalizedChoice {
  if (!isRecord(choice)) {
    throw new Error(`choices[${index}] must be an object.`);
  }

  const message = choice.message;
  if (!isRecord(message)) {
    throw new Error(`choices[${index}].message must be an object.`);
  }

  const role = expectString(message.role, `choices[${index}].message.role`);
  if (role !== "assistant") {
    throw new Error(`choices[${index}].message.role must be "assistant".`);
  }

  const text =
    message.content === null
      ? ""
      : expectString(message.content, `choices[${index}].message.content`);

  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.filter((tc: unknown) => isRecord(tc))
    : [];

  return {
    text,
    toolCalls,
    finishReason: choice.finish_reason ?? null,
  };
}

export function normalizeAssistantTextsFromChoices(
  choices: ChatCompletionChoice[],
): string[] {
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("choices must be a non-empty array.");
  }

  return choices.map((choice, index) => normalizeChoice(choice, index).text);
}

export function buildResponseOutputMessage(
  responseId: string,
  text: string,
  index: number,
  status: ResponsesOutputMessage["status"],
): ResponsesOutputMessage {
  return {
    id: `${responseId}:output:${index}`,
    type: "message",
    status,
    role: "assistant",
    content: [{ type: "output_text", text }],
  };
}

export function buildResponseFunctionCall(
  responseId: string,
  toolCall: ChatToolCall,
  index: number,
  status: ResponsesFunctionCallOutput["status"],
): ResponsesFunctionCallOutput {
  return {
    id: `${responseId}:output:${index}`,
    type: "function_call",
    status,
    call_id: toolCall.id,
    name: toolCall.function.name,
    arguments: toolCall.function.arguments,
  };
}

function buildOutputItemsFromChoice(
  responseId: string,
  choice: NormalizedChoice,
  startIndex: number,
): ResponsesOutputItem[] {
  const items: ResponsesOutputItem[] = [];
  let outputIndex = startIndex;

  // If there's text content, add a message output item
  if (choice.text.length > 0) {
    items.push(buildResponseOutputMessage(responseId, choice.text, outputIndex, "completed"));
    outputIndex++;
  }

  // Add function_call output items for each tool call
  for (const toolCall of choice.toolCalls) {
    items.push(buildResponseFunctionCall(responseId, toolCall, outputIndex, "completed"));
    outputIndex++;
  }

  // If no text and no tool calls, emit an empty message
  if (items.length === 0) {
    items.push(buildResponseOutputMessage(responseId, "", outputIndex, "completed"));
  }

  return items;
}

export function translateChatCompletionResponse(
  response: ChatCompletionResponse,
  options: ResponseTranslationOptions = {},
): ResponsesStyleResponse {
  if (!isRecord(response)) {
    throw new Error("response must be an object.");
  }

  const id = expectString(response.id, "id");
  const createdAt = expectNumber(response.created, "created");
  const normalizedOptions = normalizeSamplingOptions(options);
  const model = normalizedOptions.model ?? expectString(response.model, "model");

  if (!Array.isArray(response.choices) || response.choices.length === 0) {
    throw new Error("choices must be a non-empty array.");
  }

  const normalizedChoices = response.choices.map((choice, index) =>
    normalizeChoice(choice, index),
  );

  const output: ResponsesOutputItem[] = [];
  const textParts: string[] = [];
  let hasToolCalls = false;
  let outputIndex = 0;

  for (const choice of normalizedChoices) {
    const items = buildOutputItemsFromChoice(id, choice, outputIndex);
    output.push(...items);
    outputIndex += items.length;

    if (choice.text.length > 0) {
      textParts.push(choice.text);
    }

    if (choice.toolCalls.length > 0) {
      hasToolCalls = true;
    }
  }

  const translated: ResponsesStyleResponse = {
    id,
    object: "response",
    created_at: createdAt,
    model,
    status: "completed",
    output,
    output_text: textParts.filter((text) => text.length > 0).join("\n\n"),
    parallel_tool_calls: hasToolCalls,
    tool_choice: hasToolCalls ? "auto" : "none",
  };

  if (normalizedOptions.temperature !== undefined) {
    translated.temperature = normalizedOptions.temperature;
  }

  if (normalizedOptions.top_p !== undefined) {
    translated.top_p = normalizedOptions.top_p;
  }

  if (response.usage !== undefined) {
    translated.usage = translateChatCompletionUsage(response.usage);
  }

  return translated;
}
