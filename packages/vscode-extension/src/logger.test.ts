import { describe, expect, it, vi } from "vitest";

import { ExtensionLogger, normalizeLogLevel, redactSecrets } from "./logger.js";

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

  it("filters messages below the configured log level", () => {
    const appendLine = vi.fn();
    const logger = new ExtensionLogger({
      appendLine,
      show: vi.fn(),
      dispose: vi.fn(),
    } as never, "warn");

    logger.debug("debug metadata");
    logger.info("connected");
    logger.warn("retrying");
    expect(appendLine).toHaveBeenCalledTimes(1);
    expect(appendLine).toHaveBeenCalledWith("[warn] retrying");

    logger.setLevel("debug");
    logger.debug("request cpx_secret123");
    expect(appendLine).toHaveBeenCalledWith("[debug] request <redacted>");
  });

  it("normalizes unsupported log levels to info", () => {
    expect(normalizeLogLevel("debug")).toBe("debug");
    expect(normalizeLogLevel("trace")).toBe("info");
  });
});
