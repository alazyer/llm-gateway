import { describe, expect, it, vi } from "vitest";

import { ExtensionLogger, redactSecrets } from "./logger.js";

describe("ExtensionLogger", () => {
  it("redacts proxy tokens from log lines", () => {
    expect(redactSecrets("token=cpx_secret123 and cpx_other")).toBe(
      "token=<redacted> and <redacted>",
    );
  });

  it("writes redacted output", () => {
    const appendLine = vi.fn();
    const logger = new ExtensionLogger({
      appendLine,
      show: vi.fn(),
      dispose: vi.fn(),
    } as never);

    logger.info("connected with cpx_secret123");
    expect(appendLine).toHaveBeenCalledWith("[info] connected with <redacted>");
  });
});
