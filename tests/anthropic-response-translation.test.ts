import { describe, expect, it } from "vitest";

import {
  mapChatFinishReasonToAnthropic,
  translateChatCompletionResponseToAnthropic,
} from "../src/translation/anthropic/response.js";

describe("translateChatCompletionResponseToAnthropic", () => {
  it("maps chat completions text and tool calls into an anthropic message response", () => {
    expect(
      translateChatCompletionResponseToAnthropic(
        {
          id: "chatcmpl-tool-123",
          object: "chat.completion",
          created: 1_710_000_000,
          model: "provider-internal-model",
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: "I'll use a tool.",
                tool_calls: [
                  {
                    id: "toolu_1",
                    type: "function",
                    function: {
                      name: "get_weather",
                      arguments: '{"city":"Paris"}',
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 18,
            completion_tokens: 7,
            total_tokens: 25,
          },
        },
        {
          model: "claude-sonnet-4-5",
        },
      ),
    ).toEqual({
      id: "chatcmpl-tool-123",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-5",
      content: [
        {
          type: "text",
          text: "I'll use a tool.",
        },
        {
          type: "tool_use",
          id: "toolu_1",
          name: "get_weather",
          input: {
            city: "Paris",
          },
        },
      ],
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: {
        input_tokens: 18,
        output_tokens: 7,
      },
    });
  });

  it("defaults usage counts to zero when the upstream response omits them", () => {
    expect(
      translateChatCompletionResponseToAnthropic({
        id: "chatcmpl-text-123",
        object: "chat.completion",
        created: 1_710_000_000,
        model: "provider-internal-model",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Done.",
            },
          },
        ],
      }),
    ).toEqual({
      id: "chatcmpl-text-123",
      type: "message",
      role: "assistant",
      model: "provider-internal-model",
      content: [
        {
          type: "text",
          text: "Done.",
        },
      ],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    });
  });

  it("throws explicit errors when tool call arguments are not valid json objects", () => {
    expect(() =>
      translateChatCompletionResponseToAnthropic({
        id: "chatcmpl-bad",
        object: "chat.completion",
        created: 1_710_000_000,
        model: "provider-internal-model",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "toolu_1",
                  type: "function",
                  function: {
                    name: "get_weather",
                    arguments: '"Paris"',
                  },
                },
              ],
            },
          },
        ],
      }),
    ).toThrowError(
      "tool_calls[0].function.arguments must decode to an object.",
    );
  });
});

describe("mapChatFinishReasonToAnthropic", () => {
  it("maps supported chat finish reasons to anthropic stop reasons", () => {
    expect(mapChatFinishReasonToAnthropic("stop")).toBe("end_turn");
    expect(mapChatFinishReasonToAnthropic("length")).toBe("max_tokens");
    expect(mapChatFinishReasonToAnthropic("tool_calls")).toBe("tool_use");
    expect(mapChatFinishReasonToAnthropic("content_filter")).toBe("refusal");
    expect(mapChatFinishReasonToAnthropic(null)).toBeNull();
  });
});
