import { describe, expect, it } from "vitest";

import {
  buildChatCompletionRequestFromAnthropic,
  estimateAnthropicInputTokens,
} from "../src/translation/anthropic/request.js";

describe("buildChatCompletionRequestFromAnthropic", () => {
  it("maps anthropic messages, tool definitions, and metadata into chat completions", () => {
    expect(
      buildChatCompletionRequestFromAnthropic({
        model: "claude-sonnet-4-5",
        system: [
          { type: "text", text: "Follow the house style." },
          { type: "text", text: "Keep answers short." },
        ],
        messages: [
          {
            role: "user",
            content: "What is the weather in Paris?",
          },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Let me check." },
              {
                type: "tool_use",
                id: "toolu_1",
                name: "get_weather",
                input: { city: "Paris" },
              },
            ],
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Tool returned:" },
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: "Sunny",
              },
            ],
          },
        ],
        max_tokens: 256,
        temperature: 0.2,
        top_p: 0.9,
        stream: true,
        metadata: {
          traceId: "abc123",
          user_id: "user-42",
          safe: true,
          nested: { ignored: true },
        },
        tools: [
          {
            name: "get_weather",
            description: "Look up a forecast.",
            input_schema: {
              type: "object",
              properties: {
                city: { type: "string" },
              },
              required: ["city"],
            },
          },
        ],
        tool_choice: { type: "tool", name: "get_weather" },
        stop_sequences: ["DONE"],
      }),
    ).toEqual({
      model: "claude-sonnet-4-5",
      messages: [
        {
          role: "system",
          content: "Follow the house style.\nKeep answers short.",
        },
        {
          role: "user",
          content: "What is the weather in Paris?",
        },
        {
          role: "assistant",
          content: "Let me check.",
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
        {
          role: "user",
          content: "Tool returned:",
        },
        {
          role: "tool",
          tool_call_id: "toolu_1",
          content: "Sunny",
        },
      ],
      max_completion_tokens: 256,
      temperature: 0.2,
      top_p: 0.9,
      stream: true,
      user: "user-42",
      metadata: {
        traceId: "abc123",
        user_id: "user-42",
        safe: true,
      },
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Look up a forecast.",
            parameters: {
              type: "object",
              properties: {
                city: { type: "string" },
              },
              required: ["city"],
            },
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: {
          name: "get_weather",
        },
      },
      stop: ["DONE"],
    });
  });

  it("maps tool_choice any to required and wraps errored tool results", () => {
    expect(
      buildChatCompletionRequestFromAnthropic({
        model: "claude-sonnet-4-5",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: [{ type: "text", text: "not found" }],
                is_error: true,
              },
            ],
          },
        ],
        tool_choice: "any",
      }),
    ).toEqual({
      model: "claude-sonnet-4-5",
      messages: [
        {
          role: "tool",
          tool_call_id: "toolu_1",
          content: "not found",
        },
      ],
      tool_choice: "required",
    });
  });

  it("emits separate tool messages for multiple tool_results in one user message", () => {
    expect(
      buildChatCompletionRequestFromAnthropic({
        model: "claude-sonnet-4-5",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_1",
                name: "get_weather",
                input: { city: "Paris" },
              },
              {
                type: "tool_use",
                id: "toolu_2",
                name: "get_weather",
                input: { city: "London" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: "Sunny",
              },
              {
                type: "tool_result",
                tool_use_id: "toolu_2",
                content: "Rainy",
              },
            ],
          },
        ],
      }),
    ).toEqual({
      model: "claude-sonnet-4-5",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "toolu_1",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"city":"Paris"}',
              },
            },
            {
              id: "toolu_2",
              type: "function",
              function: {
                name: "get_weather",
                arguments: '{"city":"London"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "toolu_1",
          content: "Sunny",
        },
        {
          role: "tool",
          tool_call_id: "toolu_2",
          content: "Rainy",
        },
      ],
    });
  });

  it("handles tool_result with no content by using empty string", () => {
    expect(
      buildChatCompletionRequestFromAnthropic({
        model: "claude-sonnet-4-5",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "toolu_1",
                name: "do_something",
                input: {},
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
              },
            ],
          },
        ],
      }),
    ).toEqual({
      model: "claude-sonnet-4-5",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "toolu_1",
              type: "function",
              function: {
                name: "do_something",
                arguments: "{}",
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "toolu_1",
          content: "",
        },
      ],
    });
  });

  it("accepts mid-conversation system messages from Claude", () => {
    expect(
      buildChatCompletionRequestFromAnthropic({
        model: "claude-sonnet-4-5",
        messages: [
          {
            role: "user",
            content: "Initial prompt",
          },
          {
            role: "system",
            content: [
              { type: "text", text: "System reminder one." },
              { type: "text", text: "System reminder two." },
            ],
          },
          {
            role: "user",
            content: "Continue.",
          },
        ],
      }),
    ).toEqual({
      model: "claude-sonnet-4-5",
      messages: [
        {
          role: "user",
          content: "Initial prompt",
        },
        {
          role: "system",
          content: "System reminder one.\nSystem reminder two.",
        },
        {
          role: "user",
          content: "Continue.",
        },
      ],
    });
  });

  it("throws explicit errors for invalid anthropic message shapes", () => {
    expect(() =>
      buildChatCompletionRequestFromAnthropic({
        model: "claude-sonnet-4-5",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: "bad placement",
              },
            ],
          },
        ],
      }),
    ).toThrowError(
      "messages[0].content[0] tool_result blocks are not valid in assistant messages.",
    );

    expect(() =>
      buildChatCompletionRequestFromAnthropic({
        model: "claude-sonnet-4-5",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_use",
                id: "toolu_1",
                name: "get_weather",
                input: {},
              },
            ],
          },
        ],
      }),
    ).toThrowError(
      "messages[0].content[0] tool_use blocks are not valid in user messages.",
    );
  });

  it("translates user image blocks (base64 source) into image_url content parts", () => {
    // 1x1 white PNG (minimal valid PNG bytes, base64).
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    expect(
      buildChatCompletionRequestFromAnthropic({
        model: "doubao-seed-2.1-pro",
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: pngBase64,
                },
              },
              { type: "text", text: "你看见了什么？" },
            ],
          },
        ],
      }),
    ).toEqual({
      model: "doubao-seed-2.1-pro",
      max_completion_tokens: 256,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${pngBase64}` },
            },
            { type: "text", text: "你看见了什么？" },
          ],
        },
      ],
    });
  });

  it("preserves text-only fast path (user content collapses to string)", () => {
    expect(
      buildChatCompletionRequestFromAnthropic({
        model: "claude-sonnet-4-5",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "hello" },
              { type: "text", text: "world" },
            ],
          },
        ],
      }).messages,
    ).toEqual([{ role: "user", content: "hello\nworld" }]);
  });

  it("rejects image blocks in assistant and system messages", () => {
    expect(() =>
      buildChatCompletionRequestFromAnthropic({
        model: "claude-sonnet-4-5",
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "AAA",
                },
              },
            ],
          },
        ],
      }),
    ).toThrowError(/image blocks are not valid in assistant messages/);

    expect(() =>
      buildChatCompletionRequestFromAnthropic({
        model: "claude-sonnet-4-5",
        messages: [
          {
            role: "system",
            content: [
              { type: "text", text: "sys" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "AAA",
                },
              },
            ],
          },
        ],
      }),
    ).toThrowError(/only text blocks are valid in system messages/);
  });

  it("rejects malformed image sources with explicit errors", () => {
    expect(() =>
      buildChatCompletionRequestFromAnthropic({
        model: "claude-sonnet-4-5",
        messages: [
          {
            role: "user",
            content: [{ type: "image", source: { type: "url", url: "..." } } as never],
          },
        ],
      }),
    ).toThrowError(/source.type must be "base64"/);

    expect(() =>
      buildChatCompletionRequestFromAnthropic({
        model: "claude-sonnet-4-5",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/tiff", data: "AAA" },
              },
            ],
          },
        ],
      }),
    ).toThrowError(/media_type must be one of/);
  });
});

describe("estimateAnthropicInputTokens", () => {
  it("estimates tokens from system prompts, messages, and tools", () => {
    expect(
      estimateAnthropicInputTokens({
        model: "claude-sonnet-4-5",
        system: "Be concise.",
        messages: [
          {
            role: "user",
            content: "Hello there",
          },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Calling tool" },
              {
                type: "tool_use",
                id: "toolu_1",
                name: "lookup",
                input: { city: "Paris" },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: "Sunny",
              },
            ],
          },
        ],
        tools: [
          {
            name: "lookup",
            description: "Fetches weather.",
            input_schema: {
              type: "object",
              properties: {
                city: { type: "string" },
              },
            },
          },
        ],
      }),
    ).toBe(57);
  });
});
