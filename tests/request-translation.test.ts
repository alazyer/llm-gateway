import { describe, expect, it } from "vitest";

import {
  buildChatCompletionRequest,
  normalizeResponseInputToMessages,
  normalizeResponseMessageItem,
} from "../src/translation/request.js";

describe("normalizeResponseMessageItem", () => {
  it("maps developer messages to system and flattens text content", () => {
    expect(
      normalizeResponseMessageItem({
        type: "message",
        role: "developer",
        content: [
          { type: "input_text", text: "Set the tone." },
          { type: "output_text", text: "Return JSON only." },
        ],
      }),
    ).toEqual({
      role: "system",
      content: "Set the tone.\nReturn JSON only.",
    });
  });
});

describe("normalizeResponseInputToMessages", () => {
  it("accepts string, single-item, and array input while prepending instructions", () => {
    expect(normalizeResponseInputToMessages("hello")).toEqual([
      { role: "user", content: "hello" },
    ]);

    expect(
      normalizeResponseInputToMessages(
        {
          type: "message",
          role: "assistant",
          content: "done",
        },
        "Follow the policy.",
      ),
    ).toEqual([
      { role: "system", content: "Follow the policy." },
      { role: "assistant", content: "done" },
    ]);

    expect(
      normalizeResponseInputToMessages([
        {
          type: "message",
          role: "system",
          content: "context",
        },
        {
          type: "message",
          role: "user",
          content: "question",
        },
      ]),
    ).toEqual([
      { role: "system", content: "context" },
      { role: "user", content: "question" },
    ]);
  });

  it("throws explicit errors for unsupported input shapes", () => {
    expect(() =>
      normalizeResponseInputToMessages(42 as never),
    ).toThrowError(
      "input must be a string, a message object, or an array of message objects.",
    );

    expect(() =>
      normalizeResponseInputToMessages([
        {
          type: "tool_call",
          role: "user",
          content: "hello",
        } as never,
      ]),
    ).toThrowError('input[0].type must be "message".');

    expect(() =>
      normalizeResponseInputToMessages([
        {
          type: "message",
          role: "tool" as never,
          content: "hello",
        },
      ]),
    ).toThrowError(
      "input[0].role must be one of: user, assistant, system, developer.",
    );

    expect(() =>
      normalizeResponseInputToMessages([
        {
          type: "message",
          role: "user",
          content: [{ type: "input_audio", audio_url: "..." } as never],
        },
      ]),
    ).toThrowError(
      "input[0].content[0].type must be one of: input_text, output_text, input_image.",
    );
  });
});

describe("buildChatCompletionRequest", () => {
  it("builds a chat completions payload from a responses request", () => {
    expect(
      buildChatCompletionRequest({
        model: "gpt-4.1",
        instructions: "Be brief.",
        input: [
          {
            type: "message",
            role: "user",
            content: "hello",
          },
        ],
        stream: true,
        temperature: 0.4,
        top_p: 0.9,
        max_output_tokens: 256,
        metadata: {
          traceId: "abc123",
          turn: 2,
          safe: true,
          nullable: null,
        },
        user: "user-42",
      }),
    ).toEqual({
      model: "gpt-4.1",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "hello" },
      ],
      stream: true,
      temperature: 0.4,
      top_p: 0.9,
      max_completion_tokens: 256,
      metadata: {
        traceId: "abc123",
        turn: 2,
        safe: true,
        nullable: null,
      },
      user: "user-42",
    });
  });

  it("throws explicit errors for invalid request metadata", () => {
    expect(() =>
      buildChatCompletionRequest({
        model: "gpt-4.1",
        metadata: {
          nested: { bad: true } as never,
        },
      }),
    ).toThrowError(
      "metadata.nested must be a string, number, boolean, or null.",
    );
  });

  it("passes tools and tool_choice through to the chat completions format", () => {
    expect(
      buildChatCompletionRequest({
        model: "gpt-4.1",
        input: "list files",
        tools: [
          {
            type: "function",
            name: "shell",
            description: "Run a shell command",
            parameters: { type: "object", properties: { command: { type: "string" } } },
          },
        ],
        tool_choice: "auto",
      }),
    ).toEqual({
      model: "gpt-4.1",
      messages: [{ role: "user", content: "list files" }],
      tools: [
        {
          type: "function",
          function: {
            name: "shell",
            description: "Run a shell command",
            parameters: { type: "object", properties: { command: { type: "string" } } },
          },
        },
      ],
      tool_choice: "auto",
    });
  });

  it("translates function_call input items to assistant tool_calls messages", () => {
    expect(
      buildChatCompletionRequest({
        model: "gpt-4.1",
        input: [
          { type: "message", role: "user", content: "list files" },
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_abc",
            name: "shell",
            arguments: '{"command":"ls"}',
          },
        ],
      }),
    ).toEqual({
      model: "gpt-4.1",
      messages: [
        { role: "user", content: "list files" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_abc",
              type: "function",
              function: { name: "shell", arguments: '{"command":"ls"}' },
            },
          ],
        },
      ],
    });
  });

  it("translates function_call_output input items to tool messages", () => {
    expect(
      buildChatCompletionRequest({
        model: "gpt-4.1",
        input: [
          { type: "message", role: "user", content: "list files" },
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_abc",
            name: "shell",
            arguments: '{"command":"ls"}',
          },
          {
            type: "function_call_output",
            call_id: "call_abc",
            output: "file1.txt\nfile2.txt",
          },
        ],
      }),
    ).toEqual({
      model: "gpt-4.1",
      messages: [
        { role: "user", content: "list files" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_abc",
              type: "function",
              function: { name: "shell", arguments: '{"command":"ls"}' },
            },
          ],
        },
        {
          role: "tool",
          content: "file1.txt\nfile2.txt",
          tool_call_id: "call_abc",
        },
      ],
    });
  });

  it("maps tool_choice values correctly", () => {
    expect(
      buildChatCompletionRequest({
        model: "gpt-4.1",
        input: "hi",
        tool_choice: "none",
      }).tool_choice,
    ).toBe("none");

    expect(
      buildChatCompletionRequest({
        model: "gpt-4.1",
        input: "hi",
        tool_choice: "required",
      }).tool_choice,
    ).toBe("required");

    expect(
      buildChatCompletionRequest({
        model: "gpt-4.1",
        input: "hi",
        tool_choice: { type: "function", name: "shell" },
      }).tool_choice,
    ).toEqual({ type: "function", function: { name: "shell" } });
  });

  it("translates input_image blocks (data URL) into image_url content parts", () => {
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
    expect(
      buildChatCompletionRequest({
        model: "doubao-seed-2.1-pro",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_image", image_url: dataUrl },
              { type: "input_text", text: "你看见了什么？" },
            ],
          },
        ],
      }),
    ).toEqual({
      model: "doubao-seed-2.1-pro",
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: dataUrl } },
            { type: "text", text: "你看见了什么？" },
          ],
        },
      ],
    });
  });

  it("accepts input_image.image_url in OpenAI object form {url, detail}", () => {
    expect(
      buildChatCompletionRequest({
        model: "doubao-seed-2.1-pro",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_image",
                image_url: { url: "https://example.com/a.png", detail: "high" },
              },
              { type: "input_text", text: "describe" },
            ],
          },
        ],
      }).messages,
    ).toEqual([
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "https://example.com/a.png", detail: "high" },
          },
          { type: "text", text: "describe" },
        ],
      },
    ]);
  });

  it("preserves text-only fast path (content stays a string)", () => {
    expect(
      buildChatCompletionRequest({
        model: "gpt-4.1",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "hello" },
              { type: "output_text", text: "world" },
            ],
          },
        ],
      }).messages,
    ).toEqual([{ role: "user", content: "hello\nworld" }]);
  });

  it("rejects input_image blocks in non-user messages", () => {
    expect(() =>
      buildChatCompletionRequest({
        model: "doubao-seed-2.1-pro",
        input: [
          {
            type: "message",
            role: "system",
            content: [
              {
                type: "input_image",
                image_url: "data:image/png;base64,AAA",
              },
              { type: "input_text", text: "system prompt" },
            ],
          },
        ],
      }),
    ).toThrowError(/input_image blocks are only valid in user messages/);
  });

  it("throws explicit errors for malformed input_image blocks", () => {
    expect(() =>
      normalizeResponseInputToMessages([
        {
          type: "message",
          role: "user",
          content: [{ type: "input_image" } as never],
        },
      ]),
    ).toThrowError(/image_url must be a string/);

    expect(() =>
      normalizeResponseInputToMessages([
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_image", image_url: "data:...", detail: "ultra" } as never,
          ],
        },
      ]),
    ).toThrowError(/detail must be one of/);
  });
});
